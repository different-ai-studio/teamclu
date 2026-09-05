use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

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
    /// Set by pi, whose doctor `satisfied` is an AND of several unrelated
    /// conditions — Node version and the MCP SDK installed beside the
    /// extension. `present` deliberately leaves partial installs visible, so
    /// this is set even on a runtime
    /// that *is* installed — "here, but not usable yet, and this is why".
    /// `None` means the plain "not installed" reading is correct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
    /// What the blocker actually found, when naming it is the difference
    /// between an answer and a wild goose chase: `20.20.2 (/usr/local/bin/node)`
    /// for a node that exists but is too old. The reported case spent a support
    /// round trip on "node missing" shown next to a row reading 20.20.2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker_found: Option<String>,
    /// What the blocker needs — pi's minimum Node, the pinned MCP SDK.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker_required: Option<String>,
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

/// How long one `amuxd doctor` answer may be reused.
///
/// Deliberately short. This is not a cache in the "avoid work" sense — it exists
/// because a cold first launch asks three times inside the same second
/// (`AuthGate`'s background probe, plus the setup screen's runtime scan and
/// requirement probe), and every one of those spawns the sidecar, which in turn
/// spawns `git`/`node`/`pi --version`. On Windows each of
/// those is a `.cmd` shim through `cmd.exe` under a real-time virus scanner, so
/// the duplicate runs are most of what "scanning for runtimes" spends.
const DOCTOR_CACHE_TTL: Duration = Duration::from_secs(3);

type DoctorCache = tokio::sync::Mutex<Option<(Instant, serde_json::Value)>>;
static DOCTOR_CACHE: OnceLock<DoctorCache> = OnceLock::new();

fn doctor_cache() -> &'static DoctorCache {
    DOCTOR_CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Forget the cached answer. An install exists precisely to change what doctor
/// would say, so anything less than this would report the machine as it was
/// before the install that just finished.
///
/// Awaits the lock rather than trying it: a doctor run in flight holds it for
/// its whole duration, and clearing "if convenient" would leave that run's
/// pre-install answer in the cache.
pub(crate) async fn invalidate_doctor_cache() {
    *doctor_cache().lock().await = None;
}

/// Run the bundled `amuxd doctor` and return its parsed JSON: `amuxd`, the
/// managed `node`, the managed `pi` runtime and `git`. amuxd answers from its
/// own install paths, so this is accurate even when the app/daemon PATH is
/// empty.
///
/// Callers that arrive together are coalesced: the lock is held across the
/// sidecar run, so the second and third caller wait for the first and then read
/// its result instead of spawning their own.
pub(crate) async fn read_doctor<R: Runtime>(app: &AppHandle<R>) -> Option<serde_json::Value> {
    let mut cache = doctor_cache().lock().await;
    if let Some((measured_at, value)) = cache.as_ref() {
        if measured_at.elapsed() < DOCTOR_CACHE_TTL {
            return Some(value.clone());
        }
    }
    // A failed run is not cached: it is usually a spawn error, and repeating it
    // costs less than pinning "we could not tell" for the next few seconds.
    let value = run_doctor(app).await?;
    *cache = Some((Instant::now(), value.clone()));
    Some(value)
}

async fn run_doctor<R: Runtime>(app: &AppHandle<R>) -> Option<serde_json::Value> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
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

/// The first-run wizard's rows: the bundled daemon, the amuxd-managed Node,
/// the managed pi runtime, and git (optional). All from one `amuxd doctor`.
///
/// There is no runtime to pick any more (#1250): the wizard installs what is
/// missing and moves on, so this reports state rather than options.
#[tauri::command]
pub async fn setup_list_requirements<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<RequirementStatus>, String> {
    let doctor = read_doctor(&app).await;
    let row = |key: &str| doctor.as_ref().map(|d| d[key].clone());
    let text = |node: &Option<serde_json::Value>, key: &str| {
        node.as_ref()
            .and_then(|n| n[key].as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let flag = |node: &Option<serde_json::Value>, key: &str| {
        node.as_ref()
            .and_then(|n| n[key].as_bool())
            .unwrap_or(false)
    };

    let amuxd = row("amuxd");
    let node = row("node");
    let pi = row("pi");
    let git = row("git");

    // amuxd: desktop-managed sidecar — satisfied when the bundle includes it.
    let amuxd_version = text(&amuxd, "installedVersion").or_else(|| {
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
    });

    // pi's `satisfied` folds in Node and the MCP SDK; the blocker names which
    // half is missing so the wizard's progress copy can be specific.
    let pi_blocker = pi.as_ref().and_then(pi_blocker);
    let (pi_found, pi_required) = pi
        .as_ref()
        .map(|n| pi_blocker_detail(pi_blocker.as_deref(), n))
        .unwrap_or((None, None));

    Ok(vec![
        RequirementStatus {
            id: "amuxd".into(),
            title: "Agent daemon (amuxd)".into(),
            optional: false,
            present: locate_bundled_amuxd().is_some(),
            version: amuxd_version,
            blocker: None,
            blocker_found: None,
            blocker_required: None,
        },
        RequirementStatus {
            id: "node".into(),
            title: "Node.js (managed)".into(),
            optional: false,
            present: flag(&node, "satisfied"),
            version: text(&node, "version"),
            blocker: None,
            blocker_found: None,
            blocker_required: text(&node, "requiredVersion"),
        },
        RequirementStatus {
            id: "pi".into(),
            title: "Pi runtime".into(),
            optional: false,
            present: flag(&pi, "satisfied"),
            version: text(&pi, "version"),
            blocker: pi_blocker,
            blocker_found: pi_found,
            blocker_required: pi_required,
        },
        RequirementStatus {
            id: "git".into(),
            title: "git".into(),
            optional: true,
            present: flag(&git, "present"),
            version: text(&git, "version"),
            blocker: None,
            blocker_found: None,
            blocker_required: None,
        },
    ])
}

/// Which of pi's three preconditions to name in the UI.
///
/// `pi.satisfied` is `pi_version && node && mcp_sdk`, and only the first of
/// those is "the user installed pi" — so a bare "pi is not installed" was a
/// false statement on a machine that had pi, and pointed at the one thing that
/// was already done. Node comes first: installing the SDK changes nothing while
/// npm cannot run.
///
/// Node is split in two because the fixes are different. `node` means there is
/// no Node here at all; `node_outdated` means there is one and it is too old,
/// which on a machine with several Nodes is the answer that saves the user from
/// hunting for a version they already have.
fn pi_blocker(node: &serde_json::Value) -> Option<String> {
    let flag = |k: &str| node[k].as_bool().unwrap_or(false);
    if !flag("nodeSatisfied") {
        return Some(if flag("nodePresent") {
            "node_outdated".to_string()
        } else {
            "node".to_string()
        });
    }
    // The MCP SDK is installed beside the pi extension, by us, not by the user
    // — so a pi installed from a terminal (or an install whose SDK step failed)
    // leaves pi present, current, and still unable to start a session.
    if !flag("mcpSdkSatisfied") {
        return Some("mcp_sdk".to_string());
    }
    None
}

/// The "found" / "required" pair that goes with [`pi_blocker`]'s answer.
fn pi_blocker_detail(
    blocker: Option<&str>,
    node: &serde_json::Value,
) -> (Option<String>, Option<String>) {
    let text = |k: &str| {
        node[k]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    match blocker {
        Some("node_outdated") => {
            let found = match (text("nodeVersion"), text("nodePath")) {
                (Some(v), Some(path)) => Some(format!("{} ({path})", v.trim_start_matches('v'))),
                (Some(v), None) => Some(v),
                _ => None,
            };
            (found, text("requiredNodeVersion"))
        }
        Some("node") => (None, text("requiredNodeVersion")),
        Some("mcp_sdk") => (text("mcpSdkVersion"), text("requiredMcpSdkVersion")),
        _ => (None, None),
    }
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

/// Run `amuxd install-pi`, streaming progress through `emit`.
///
/// `emit(status, line, error)` — status is "started" | "running" | "failed" |
/// "done". Idempotent: installs the managed Node.js, then pi and the MCP SDK on
/// it, or repairs whichever piece is missing. Shared by the first-run wizard
/// and the settings Dependencies page so there is one install path, not two.
pub(crate) async fn run_amuxd_install_pi<R, F>(app: &AppHandle<R>, emit: F) -> Result<(), String>
where
    R: Runtime,
    F: Fn(&str, Option<String>, Option<String>) + Send,
{
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    emit("started", None, None);
    // `_child_guard` must stay alive until `rx` is drained: dropping the
    // CommandChild early can kill the sidecar mid-install.
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
                    emit("running", Some(line), None);
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    last_stderr = Some(line.clone());
                    // Forwarded, not just remembered: amuxd narrates a slow
                    // install (registry probes, mirror fallbacks) on stderr, and
                    // holding those back is most of why an install row could sit
                    // on "installing…" with nothing under it. Mirrors the
                    // opencode path, which has always emitted both pipes.
                    emit("running", Some(line), None);
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
        emit("failed", None, Some(e.clone()));
        return Err(e);
    }
    emit("done", None, None);
    Ok(())
}

async fn install_pi<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    run_amuxd_install_pi(app, |status, line, error| {
        emit_progress(
            app,
            SetupProgress {
                id: "pi".into(),
                status: status.into(),
                line,
                error,
            },
        );
    })
    .await
}

/// Restart the desktop-managed amuxd so it re-reads `daemon.toml`.
#[tauri::command]
pub async fn restart_local_daemon<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::commands::amuxd_supervisor::AmuxdSupervisor::restart(&app).await
}

#[tauri::command]
pub async fn setup_install<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let result = match id.as_str() {
        "amuxd" => install_amuxd(&app).await,
        // One managed runtime: Node.js is installed by the same `amuxd
        // install-pi` that installs pi on it, so both ids repair it.
        "node" | "pi" => install_pi(&app).await,
        other => Err(format!("unknown requirement: {other}")),
    };
    // Also on failure: a half-finished install still moves the machine, and the
    // re-probe that follows must see it rather than the cached "before".
    invalidate_doctor_cache().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_has_dash() {
        assert!(target_triple().contains('-'));
    }

    fn pi_doctor(node_present: bool, node_ok: bool, sdk_ok: bool) -> serde_json::Value {
        serde_json::json!({
            "present": true,
            "version": "0.84.4",
            "requiredVersion": "0.84.2",
            "nodePresent": node_present,
            "nodeVersion": node_present.then_some("v20.20.2"),
            "nodePath": node_present.then_some("/usr/local/bin/node"),
            "nodeSatisfied": node_ok,
            "requiredNodeVersion": "22.19.0",
            "mcpSdkSatisfied": sdk_ok,
            "mcpSdkVersion": serde_json::Value::Null,
            "requiredMcpSdkVersion": "1.30.0",
            "satisfied": node_ok && sdk_ok,
        })
    }

    #[test]
    fn a_node_that_is_present_but_too_old_is_not_reported_as_missing() {
        // The reported machine: three Nodes installed, the one we resolve is an
        // abandoned nvm 20 — and the UI said "node missing" beside a
        // Dependencies row reading 20.20.2.
        let doctor = pi_doctor(true, false, true);
        assert_eq!(pi_blocker(&doctor).as_deref(), Some("node_outdated"));
        let (found, required) = pi_blocker_detail(Some("node_outdated"), &doctor);
        assert_eq!(found.as_deref(), Some("20.20.2 (/usr/local/bin/node)"));
        assert_eq!(required.as_deref(), Some("22.19.0"));
    }

    #[test]
    fn no_node_at_all_still_reads_as_missing() {
        let doctor = pi_doctor(false, false, true);
        assert_eq!(pi_blocker(&doctor).as_deref(), Some("node"));
        let (found, required) = pi_blocker_detail(Some("node"), &doctor);
        assert_eq!(found, None, "nothing was found — do not invent a version");
        assert_eq!(required.as_deref(), Some("22.19.0"));
    }

    #[test]
    fn a_pi_whose_mcp_sdk_is_missing_says_so_instead_of_not_installed() {
        // pi installed by hand in a terminal never gets the SDK, which amuxd
        // installs beside the extension. Dependencies called it "Up to date";
        // the runtime picker called it "not installed on this machine". Both
        // were reading a different half of the same doctor report.
        let doctor = pi_doctor(true, true, false);
        assert_eq!(pi_blocker(&doctor).as_deref(), Some("mcp_sdk"));
        let (found, required) = pi_blocker_detail(Some("mcp_sdk"), &doctor);
        assert_eq!(found, None);
        assert_eq!(required.as_deref(), Some("1.30.0"));
    }

    #[test]
    fn node_is_named_before_the_sdk() {
        // Installing the SDK runs npm, which runs on node: naming the SDK first
        // would send the user at a step that cannot succeed yet.
        assert_eq!(
            pi_blocker(&pi_doctor(true, false, false)).as_deref(),
            Some("node_outdated")
        );
    }

    #[test]
    fn a_ready_pi_has_no_blocker() {
        assert_eq!(pi_blocker(&pi_doctor(true, true, true)), None);
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
