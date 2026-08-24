use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::process_util::CommandNoWindow;

/// Tauri event name carrying `SetupProgress` to the first-run wizard UI.
const SETUP_PROGRESS_EVENT: &str = "setup-progress";

/// One installable/checkable prerequisite shown in the first-run wizard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementStatus {
    pub id: String,
    pub title: String,
    pub optional: bool,
    pub present: bool,
    pub version: Option<String>,
    /// What is missing, when we can say something better than "not installed".
    ///
    /// Only cursor sets it today: its doctor `satisfied` is an AND of four
    /// unrelated conditions, one of which is an API key. `present` deliberately
    /// leaves the key out (see [`runtime_installed`]), so this is set even on a
    /// runtime that *is* installed — "here, but not usable yet, and this is
    /// why". `None` means the plain "not installed" reading is correct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
}

/// Rust target triple for the current host (matches the sidecar naming convention).
fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-unknown-{other}"),
    }
}

/// Resolve an executable path, trying a `.exe` suffix on Windows. Mirrors opencode.rs.
fn resolve_exe(path: PathBuf) -> Option<PathBuf> {
    if path.exists() {
        return Some(path);
    }
    if cfg!(windows) {
        let mut with_exe = path.into_os_string();
        with_exe.push(".exe");
        let with_exe = PathBuf::from(with_exe);
        if with_exe.exists() {
            return Some(with_exe);
        }
    }
    None
}

/// Locate the amuxd binary bundled with the app (dev: apps/desktop/binaries; prod: next to exe).
fn locate_bundled_amuxd() -> Option<PathBuf> {
    locate_bundled_sidecar("amuxd")
}

fn locate_bundled_sidecar(base_name: &str) -> Option<PathBuf> {
    let triple = target_triple();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{base_name}-{triple}"));
    if let Some(p) = resolve_exe(dev) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for cand in [format!("{base_name}-{triple}"), base_name.to_string()] {
        if let Some(p) = resolve_exe(dir.join(cand)) {
            return Some(p);
        }
    }
    None
}

/// Run the bundled `amuxd doctor` and return its parsed JSON (opencode/git/amuxd
/// status). amuxd resolves opencode/amuxd by absolute path, so this is accurate
/// even when the app/daemon PATH excludes those dirs.
pub(crate) async fn read_doctor<R: Runtime>(
    app: &AppHandle<R>,
    local_agent: Option<&str>,
) -> Option<serde_json::Value> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    // `local_agent` is no longer passed to the sidecar: `amuxd doctor` reports
    // every runtime in one pass now, so there is nothing left to select. Callers
    // still name the runtime they care about and pick its key out of the result.
    let _ = local_agent;
    let command =
        crate::commands::with_amuxd_brand_env(app.shell().sidecar("amuxd").ok()?.args(["doctor"]));
    let (mut rx, _child) = command.spawn().ok()?;
    let mut buf = String::new();
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Stdout(bytes) = event {
            buf.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    serde_json::from_str(buf.trim()).ok()
}

#[tauri::command]
pub async fn setup_list_requirements<R: Runtime>(
    app: AppHandle<R>,
    local_agent: Option<String>,
) -> Result<Vec<RequirementStatus>, String> {
    let doctor = read_doctor(&app, local_agent.as_deref()).await;

    let installed_in_doctor = |key: &str| {
        doctor
            .as_ref()
            .map(|d| runtime_installed(&d[key], key))
            .unwrap_or(false)
    };
    // Which runtime the row reports on. An explicit pick (onboarding's
    // SetupStep, post-install re-probe) is authoritative — cursor and
    // claude-code included: the picker offers them, but every pick that was not
    // "pi" used to fall through to opencode here, so a machine with only Cursor
    // failed its own requirement check and re-ran the wizard on every launch.
    // With no pick — the background probe refreshing the setup-ok cache — any
    // installed runtime satisfies: a machine running pi must not be failed
    // against the build default.
    let picked = local_agent
        .as_deref()
        .map(str::trim)
        .filter(|agent| !agent.is_empty());
    let (runtime_id, runtime_key, runtime_name) = match picked {
        Some(agent) => RUNTIMES
            .iter()
            .find(|(id, _, _)| *id == agent)
            .copied()
            .unwrap_or(RUNTIMES[0]),
        None => RUNTIMES
            .iter()
            .find(|(_, key, _)| installed_in_doctor(key))
            .copied()
            .unwrap_or(RUNTIMES[0]),
    };

    // `present` = no action needed. For opencode that is simply "installed"
    // (amuxd pins no version); pi still has a lock AND requires a supported Node
    // runtime, so there it means "installed, new enough, and runnable".
    // `version` = the installed version, for the UI to show.
    // amuxd: desktop-managed sidecar — satisfied when the bundle includes it.
    let amuxd_version = doctor
        .as_ref()
        .and_then(|d| d["amuxd"]["installedVersion"].as_str())
        .map(|s| s.to_string());

    // The agent-runtime row's status comes from the matching key in the
    // `amuxd doctor` output (doctor reports every runtime in one pass).
    let runtime = doctor.as_ref().map(|d| &d[runtime_key]);
    let runtime_satisfied = runtime
        .map(|n| runtime_installed(n, runtime_key))
        .unwrap_or(false);
    let runtime_version = runtime
        .and_then(|r| r["version"].as_str())
        .map(|s| s.to_string());
    let runtime_title = format!("{runtime_name} runtime");

    Ok(vec![
        RequirementStatus {
            id: "amuxd".into(),
            title: "Agent daemon (amuxd)".into(),
            optional: false,
            // Desktop-managed: the bundled sidecar is the binary we run — no
            // copy into ~/.amuxd/bin is required.
            blocker: None,
            present: locate_bundled_amuxd().is_some(),
            version: amuxd_version.or_else(|| {
                locate_bundled_amuxd().and_then(|p| {
                    std::process::Command::new(&p)
                        .no_window()
                        .arg("--version")
                        .output()
                        .ok()
                        .and_then(|o| {
                            let s = String::from_utf8_lossy(&o.stdout);
                            s.split_whitespace()
                                .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
                                .map(|t| t.to_string())
                        })
                })
            }),
        },
        RequirementStatus {
            id: runtime_id.into(),
            title: runtime_title,
            optional: false,
            present: runtime_satisfied,
            version: runtime_version,
            blocker: (runtime_id == "pi")
                .then(|| runtime.and_then(pi_blocker))
                .flatten(),
        },
    ])
}

/// Every agent runtime the picker offers: `(DaemonLocalAgent id, doctor key, title)`.
///
/// The id is not always the doctor's key for it (`claude-code` vs `claude`).
/// Ordered by preference — the first satisfied entry wins when nothing was
/// explicitly picked.
const RUNTIMES: [(&str, &str, &str); 4] = [
    ("opencode", "opencode", "OpenCode"),
    ("pi", "pi", "Pi"),
    ("cursor", "cursor", "Cursor"),
    ("claude-code", "claude", "Claude Code"),
];

/// Whether the runtime is on this machine, ignoring credentials.
///
/// For every runtime but cursor this is the doctor's `satisfied`. Cursor folds
/// an API key into that flag, and onboarding must not gate on the key: it is
/// entered in Settings, which the user only reaches *after* onboarding, so a
/// key-gated card could never appear during first run — the Cursor option was
/// invisible to everyone, with no explanation. Installed-ness is node + our
/// bridge script + the SDK; the key is a credential, reported via `blocker`.
fn runtime_installed(node: &serde_json::Value, doctor_key: &str) -> bool {
    if doctor_key == "cursor" {
        let flag = |k: &str| node[k].as_bool().unwrap_or(false);
        return flag("nodePresent") && flag("bridgeScriptPresent") && flag("sdkInstalled");
    }
    node["satisfied"].as_bool().unwrap_or(false)
}

/// Which of cursor's four preconditions to name in the UI.
///
/// `cursor.satisfied` is `node && bridge_script && api_key && sdk` (see
/// `apps/daemon/src/cursor_install/mod.rs`), and none of them is "the user
/// installed Cursor" — so reporting a bare "not installed" sent people off to
/// install a CLI that could not have helped. That reading is now handled by
/// `present` itself ([`runtime_installed`]), which leaves the key out, so this
/// names whatever actually stops the runtime from answering — infrastructure
/// first, since supplying a key changes nothing while node is missing.
fn cursor_blocker(node: &serde_json::Value) -> Option<String> {
    let flag = |k: &str| node[k].as_bool().unwrap_or(false);
    if !flag("nodePresent") {
        return Some("node".to_string());
    }
    if !flag("bridgeScriptPresent") || !flag("sdkInstalled") {
        return Some("bridge".to_string());
    }
    if !flag("apiKeyPresent") {
        return Some("api_key".to_string());
    }
    None
}

/// Pi's global npm shim still runs with the host Node binary. Do not let the
/// setup wizard launch its install command until Node meets Pi's declared
/// minimum; otherwise both the guided and self-select paths fail only after a
/// slow npm request.
fn pi_blocker(node: &serde_json::Value) -> Option<String> {
    (!node["nodeSatisfied"].as_bool().unwrap_or(false)).then(|| "node".to_string())
}

/// Install status of every agent runtime the user can pick from (#881).
///
/// One `amuxd doctor` call covers all four — the daemon reports every runtime
/// in a single pass, concurrently. Probing them one at a time would mean paying
/// for doctor four times (it is slow: it shells out and resolves binaries by
/// absolute path).
///
/// Cursor and Claude Code are reported but not installable — `setup_install`
/// has no arm for them, because they are the user's own tools rather than
/// something this app fetches. The UI offers them only when already present;
/// anything else would be an Install button that cannot install.
///
/// `id` is the `DaemonLocalAgent` value the rest of the stack uses, which is
/// not always the doctor's key for it (`claude-code` vs `claude`).
#[tauri::command]
pub async fn setup_list_agent_runtimes<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<RequirementStatus>, String> {
    let doctor = read_doctor(&app, None).await;
    let status = |id: &str, key: &str, title: &str| {
        let node = doctor.as_ref().map(|d| &d[key]);
        RequirementStatus {
            id: id.to_owned(),
            title: title.to_owned(),
            // `optional: true` marks a runtime the app cannot install, so the
            // frontend can drop it when absent instead of offering a dead action.
            optional: id == "cursor" || id == "claude-code",
            present: node.map(|n| runtime_installed(n, key)).unwrap_or(false),
            version: node
                .and_then(|r| r["version"].as_str())
                .map(|s| s.to_string()),
            // Reported whether or not the runtime is present: a cursor install
            // with no API key is here and pickable, and the UI still has to be
            // able to say what it is waiting on.
            blocker: match id {
                "cursor" => node.and_then(cursor_blocker),
                "pi" => node.and_then(pi_blocker),
                _ => None,
            },
        }
    };
    Ok(RUNTIMES
        .iter()
        .map(|(id, key, title)| status(id, key, title))
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub id: String,
    /// "started" | "running" | "done" | "failed"
    pub status: String,
    pub line: Option<String>,
    pub error: Option<String>,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, p: SetupProgress) {
    let _ = app.emit(SETUP_PROGRESS_EVENT, p);
}

/// Run a bundled `amuxd <args>` to completion; Err on non-zero exit.
async fn run_amuxd_sidecar<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    let command = crate::commands::with_amuxd_brand_env(
        app.shell()
            .sidecar("amuxd")
            .map_err(|e| format!("sidecar amuxd: {e}"))?
            .args(args),
    );
    let (mut rx, _child) = command.spawn().map_err(|e| format!("spawn amuxd: {e}"))?;
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Terminated(p) = event {
            code = Some(p.code.unwrap_or(-1));
        }
    }
    if code != Some(0) {
        return Err(format!("amuxd {} exited with {:?}", args.join(" "), code));
    }
    Ok(())
}

/// Ensure the desktop-managed amuxd sidecar is running. No longer copies into
/// `~/.amuxd/bin` or registers a background service.
async fn install_amuxd<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(
        app,
        SetupProgress {
            id: "amuxd".into(),
            status: "started".into(),
            line: Some("starting managed amuxd".into()),
            error: None,
        },
    );
    match crate::commands::amuxd_supervisor::AmuxdSupervisor::ensure_started(app).await {
        Ok(()) => {
            emit_progress(
                app,
                SetupProgress {
                    id: "amuxd".into(),
                    status: "done".into(),
                    line: None,
                    error: None,
                },
            );
            Ok(())
        }
        Err(e) => {
            emit_progress(
                app,
                SetupProgress {
                    id: "amuxd".into(),
                    status: "failed".into(),
                    line: None,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        }
    }
}

/// Run the bundled `amuxd install-opencode` sidecar, streaming its JSON progress lines.
/// Always installs from the official opencode source — there is no build-config
/// mirror any more, so "install" and "update" both mean "whatever upstream ships".
/// Run `amuxd install-opencode`, streaming progress through `emit`.
///
/// `emit(status, line, error)` — status is "started" | "running" | "failed" |
/// "done". This is the ONE opencode install/update path (official opencode;
/// direct-download on Windows / mirror), shared by the first-run SetupWizard and
/// the settings Dependencies page.
///
/// `force` selects which of the two jobs this call is doing. amuxd pins no
/// opencode version, so without it the call is presence-only and leaves any
/// installed opencode alone (the SetupWizard case); with it the latest release
/// is fetched unconditionally (the "Update" button).
pub(crate) async fn run_amuxd_install_opencode<R, F>(
    app: &AppHandle<R>,
    force: bool,
    emit: F,
) -> Result<(), String>
where
    R: Runtime,
    F: Fn(&str, Option<String>, Option<String>) + Send,
{
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    emit("started", None, None);
    let args: &[&str] = if force {
        &["install-opencode", "--force"]
    } else {
        &["install-opencode"]
    };
    let command = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(args);
    // `_child_guard` must stay alive until `rx` is fully drained: dropping the
    // CommandChild early can terminate the sidecar before install finishes.
    let (mut rx, _child_guard) = command.spawn().map_err(|e| format!("spawn amuxd: {e}"))?;

    // Note: we record failure in `last_err` and only act on it after the event
    // loop ends — Terminated is not guaranteed to be the final event, so we keep
    // draining stdout/stderr after it before deciding success/failure.
    let mut last_err: Option<String> = None;
    // Track the most recent stderr line so a non-zero exit surfaces amuxd's real
    // reason (e.g. an HTTP 404) instead of a bare exit code.
    let mut last_stderr: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit("running", Some(line), None);
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    last_stderr = Some(line.clone());
                    emit("running", Some(line), None);
                }
            }
            CommandEvent::Terminated(payload) if payload.code.unwrap_or(-1) != 0 => {
                last_err = Some(match &last_stderr {
                    Some(s) => format!("amuxd install-opencode failed: {s}"),
                    None => format!("amuxd install-opencode exited with code {:?}", payload.code),
                });
            }
            _ => {}
        }
    }
    if let Some(e) = last_err {
        emit("failed", None, Some(e.clone()));
        return Err(e);
    }
    emit("done", None, None);
    Ok(())
}

async fn install_opencode<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // Setup wizard: install only when absent — never disturb the user's opencode.
    run_amuxd_install_opencode(app, false, |status, line, error| {
        emit_progress(
            app,
            SetupProgress {
                id: "opencode".into(),
                status: status.into(),
                line,
                error,
            },
        );
    })
    .await
}

/// Run the bundled `amuxd install-pi` sidecar, streaming its JSON progress lines
/// under the "pi" requirement id. Idempotent (installs or upgrades to the pinned
/// `pi.lock.json` minimum), mirroring the opencode install path.
async fn install_pi<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    emit_progress(
        app,
        SetupProgress {
            id: "pi".into(),
            status: "started".into(),
            line: None,
            error: None,
        },
    );
    let (mut rx, _child_guard) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["install-pi"])
        .spawn()
        .map_err(|e| format!("spawn amuxd: {e}"))?;

    let mut last_err: Option<String> = None;
    let mut last_stderr: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit_progress(
                        app,
                        SetupProgress {
                            id: "pi".into(),
                            status: "running".into(),
                            line: Some(line),
                            error: None,
                        },
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    last_stderr = Some(line.clone());
                    // Forwarded, not just remembered: amuxd narrates a slow
                    // install (registry probes, mirror fallbacks) on stderr, and
                    // holding those back is most of why this row could sit on
                    // "installing…" with nothing under it. Mirrors the opencode
                    // path, which has always emitted both pipes.
                    emit_progress(
                        app,
                        SetupProgress {
                            id: "pi".into(),
                            status: "running".into(),
                            line: Some(line),
                            error: None,
                        },
                    );
                }
            }
            CommandEvent::Terminated(payload) if payload.code.unwrap_or(-1) != 0 => {
                last_err = Some(match &last_stderr {
                    Some(s) => format!("amuxd install-pi failed: {s}"),
                    None => format!("amuxd install-pi exited with code {:?}", payload.code),
                });
            }
            _ => {}
        }
    }
    if let Some(e) = last_err {
        emit_progress(
            app,
            SetupProgress {
                id: "pi".into(),
                status: "failed".into(),
                line: None,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }
    emit_progress(
        app,
        SetupProgress {
            id: "pi".into(),
            status: "done".into(),
            line: None,
            error: None,
        },
    );
    Ok(())
}

/// Restart the desktop-managed amuxd so it re-reads `daemon.toml`.
#[tauri::command]
pub async fn restart_local_daemon<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::commands::amuxd_supervisor::AmuxdSupervisor::restart(&app).await
}

#[tauri::command]
pub async fn setup_install<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    match id.as_str() {
        "amuxd" => install_amuxd(&app).await,
        "opencode" => install_opencode(&app).await,
        "pi" => install_pi(&app).await,
        other => Err(format!("unknown requirement: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_has_dash() {
        assert!(target_triple().contains('-'));
    }

    #[test]
    fn resolve_exe_finds_plain_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("amuxd-some-triple");
        assert!(resolve_exe(p.clone()).is_none());
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(resolve_exe(p.clone()), Some(p));
    }
}
