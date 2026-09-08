use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

use crate::process_util::CommandNoWindow;

/// Installation commands for each platform
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInstallCommands {
    pub macos: String,
    pub windows: String,
    pub linux: String,
}

/// Information about a single external dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyInfo {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub required: bool,
    pub description: String,
    pub install_commands: PlatformInstallCommands,
    pub affected_features: Vec<String>,
    /// Install priority — lower numbers install first (e.g., Homebrew = 0, others = 1)
    pub priority: u8,
}

/// Event payload emitted during dependency installation
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepInstallProgress {
    pub name: String,
    /// "started" | "installing" | "done" | "failed"
    pub status: String,
    pub output_line: Option<String>,
    pub error: Option<String>,
}

/// Resolve the program to probe for a dependency's `--version` check.
///
/// This used to be `name.to_string()` for everything but opencode, and that is
/// the whole of #1049's "Node is installed but Settings says it isn't": a bare
/// `Command::new("node")` sees only the PATH this process inherited, and on
/// Windows nothing repairs that PATH (`fix_path_env` returns early there), so a
/// Node installed after the app — or by nvm-windows / fnm / scoop, which never
/// touch the machine PATH — is invisible. amuxd answered correctly on the very
/// same machine because it had already learned this and probes well-known
/// directories; the two just never shared the lookup.
///
/// Now they do: `teamclu_binpath` is that shared lookup. `spawn_name` is the
/// fallback rather than the bare name because Rust appends only `.exe` and
/// never consults PATHEXT, so `Command::new("npm")` cannot start `npm.cmd`.
fn probe_program(name: &str) -> String {
    probe_program_in(name, &teamclu_binpath::search_dirs())
}

/// [`probe_program`] against an explicit directory list, so tests do not depend
/// on what the machine running them happens to have installed.
fn probe_program_in(name: &str, dirs: &[PathBuf]) -> String {
    teamclu_binpath::find_with(name, &[], dirs)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| teamclu_binpath::spawn_name(name))
}

/// One external tool the Dependencies page reports on. All-static so a probe
/// can be handed to a blocking task by value.
#[derive(Debug, Clone, Copy)]
struct DependencySpec {
    name: &'static str,
    version_args: &'static [&'static str],
    required: bool,
    description: &'static str,
    affected_features: &'static [&'static str],
    /// Install priority — lower numbers install first (Homebrew = 0, others = 1)
    priority: u8,
}

fn dependency_info(
    spec: &DependencySpec,
    installed: bool,
    version: Option<String>,
) -> DependencyInfo {
    DependencyInfo {
        name: spec.name.to_string(),
        installed,
        version,
        required: spec.required,
        description: spec.description.to_string(),
        install_commands: get_install_commands_map(spec.name).unwrap_or_else(|| {
            PlatformInstallCommands {
                macos: String::new(),
                windows: String::new(),
                linux: String::new(),
            }
        }),
        affected_features: spec
            .affected_features
            .iter()
            .map(|f| f.to_string())
            .collect(),
        priority: spec.priority,
    }
}

/// Check a single dependency by running `cmd --version` (or a variant).
/// Returns a DependencyInfo with installed status and parsed version.
fn check_single_dependency(spec: &DependencySpec) -> DependencyInfo {
    // Finding the file is not always enough to run it: an npm-installed shim
    // starts with `#!/usr/bin/env node`, which needs node itself on the PATH of
    // the child. Same augmentation amuxd spawns its tools with.
    let output = Command::new(probe_program(spec.name))
        .no_window()
        .env("PATH", teamclu_binpath::augmented_path())
        .args(spec.version_args)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let raw = String::from_utf8_lossy(&o.stdout).to_string();
            // Some tools output to stderr (e.g., git on some platforms)
            let raw_stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let combined = if raw.trim().is_empty() {
                raw_stderr
            } else {
                raw
            };
            dependency_info(spec, true, parse_version(&combined))
        }
        _ => dependency_info(spec, false, None),
    }
}

/// Try to extract a semantic version (X.Y.Z or X.Y) from a version string.
/// Handles common formats like:
///   - "git version 2.43.0"
///   - "gh version 2.40.1 (2024-01-15)"
///   - "v22.1.0"
///   - "node v22.1.0"
fn parse_version(raw: &str) -> Option<String> {
    // Scan for the first digit sequence that looks like a version (X.Y or X.Y.Z)
    let chars: Vec<char> = raw.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Find start of a digit sequence
        if chars[i].is_ascii_digit() {
            let start = i;
            // Consume digits and dots that form a version pattern
            let mut dot_count = 0;
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                if chars[i] == '.' {
                    dot_count += 1;
                }
                i += 1;
            }
            // Must have at least one dot (X.Y) and not end with a dot
            if dot_count >= 1 && !chars[i - 1].eq(&'.') {
                let version: String = chars[start..i].iter().collect();
                return Some(version);
            }
        } else {
            i += 1;
        }
    }

    None
}

/// Get the platform-specific install command for a dependency.
/// Used by both check_dependencies (for display) and install_dependency (for execution).
fn get_install_command(name: &str) -> Option<String> {
    let commands = get_install_commands_map(name)?;
    if cfg!(target_os = "macos") {
        Some(commands.macos)
    } else if cfg!(target_os = "windows") {
        Some(commands.windows)
    } else {
        Some(commands.linux)
    }
}

/// Get PlatformInstallCommands for a dependency by name.
fn get_install_commands_map(name: &str) -> Option<PlatformInstallCommands> {
    match name {
        "brew" => Some(PlatformInstallCommands {
            macos: r#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#.to_string(),
            windows: String::new(),
            linux: String::new(),
        }),
        "gh" => Some(PlatformInstallCommands {
            macos: "brew install gh".to_string(),
            windows: "winget install GitHub.cli".to_string(),
            linux: "sudo apt install -y gh".to_string(),
        }),
        "node" => Some(PlatformInstallCommands {
            macos: "brew install node".to_string(),
            windows: "winget install OpenJS.NodeJS".to_string(),
            linux: "sudo apt install -y nodejs".to_string(),
        }),
        "python3" => Some(PlatformInstallCommands {
            macos: "brew install python3".to_string(),
            windows: "winget install Python.Python.3".to_string(),
            linux: "sudo apt install -y python3".to_string(),
        }),
        // Display-only: the real work is done by the bundled amuxd sidecar in
        // `install_dependency`.
        "pi" => Some(PlatformInstallCommands {
            macos: "amuxd install-pi".to_string(),
            windows: "amuxd install-pi".to_string(),
            linux: "amuxd install-pi".to_string(),
        }),
        _ => None,
    }
}

/// Check if a dependency's install command requires Homebrew on macOS.
fn requires_brew(name: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    matches!(name, "gh" | "python3")
}

/// Installed vs available version of one dependency, for the Dependencies UI.
///
/// Shared by pi even though "available" means the pinned `pi.lock.json`
/// minimum (fixed, offline). The UI only needs "is there something to update to".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyVersions {
    pub installed: Option<String>,
    pub latest: Option<String>,
    /// `None` when `latest` is unknown (mirror unreachable) — the UI must then
    /// keep offering the update rather than claiming either state.
    pub up_to_date: Option<bool>,
    /// The runtime is at the pinned version and still cannot run: pi's MCP SDK
    /// is installed beside the extension by amuxd, not by npm, so a pi the user
    /// installed themselves is current and unusable at the same time.
    ///
    /// Without this the row rendered a green "Up to date" and hid its only
    /// button — which is the button that installs the missing piece — while the
    /// runtime picker said "pi is not installed on this machine".
    #[serde(default)]
    pub needs_repair: bool,
}

/// Installed vs required pi, for the Dependencies page's Update affordance.
///
/// Reads `amuxd doctor`: it reports pi's installed version alongside the
/// version `pi.lock.json` pins, so this answer is offline and cheap.
#[tauri::command]
pub async fn pi_versions<R: Runtime>(app: AppHandle<R>) -> Result<DependencyVersions, String> {
    let doctor = crate::commands::setup::read_doctor(&app)
        .await
        .ok_or_else(|| "amuxd doctor did not answer".to_string())?;
    let pi = &doctor["pi"];
    let installed = pi["version"].as_str().map(str::to_string);
    let latest = pi["requiredVersion"]
        .as_str()
        .map(str::to_string)
        .filter(|v| !v.is_empty());

    // `satisfied` is not the answer here: it folds in Node and the MCP SDK, so
    // a pi that is new enough but missing its SDK would read as "out of date"
    // and the Update button would promise something it cannot fix.
    let up_to_date = match (installed.as_deref(), latest.as_deref()) {
        (Some(have), Some(want)) => Some(teamclu_runtime_env::version::version_ge(have, want)),
        _ => None,
    };
    // ...but `satisfied` is exactly the answer to "would picking pi work", and
    // when the two disagree the row has to say so rather than paint a green
    // check over a runtime that cannot start.
    //
    // Deliberately not narrowed to the MCP SDK, even though that is the only
    // piece a reinstall adds: when Node is what fails, `amuxd install-pi`
    // refuses by name ("the newest one here is 20.20.2 (/usr/local/bin/node)")
    // and that line lands in this row's own progress area — a better answer
    // than a green tick over a runtime the picker will not accept.
    let needs_repair = up_to_date == Some(true) && !pi["satisfied"].as_bool().unwrap_or(false);

    Ok(DependencyVersions {
        installed,
        latest,
        up_to_date,
        needs_repair,
    })
}

/// The tools the page reports on, in display order.
///
/// `node` and `pi` are the managed runtime (#1250): amuxd installs both, so
/// their rows are answered by `amuxd doctor` rather than by probing PATH, and
/// they are the only required rows.
fn dependency_specs() -> Vec<DependencySpec> {
    let mut specs = Vec::with_capacity(5);

    // Homebrew — macOS only, priority 0 so it installs first
    if cfg!(target_os = "macos") {
        specs.push(DependencySpec {
            name: "brew",
            version_args: &["--version"],
            required: false,
            description: "Package manager - needed to install other tools on macOS",
            affected_features: &["Package Management"],
            priority: 0,
        });
    }

    specs.push(DependencySpec {
        name: "gh",
        version_args: &["--version"],
        required: false,
        description: "GitHub CLI - needed for spec-plan, spec-pr, and issue management",
        affected_features: &["spec-plan", "spec-pr", "GitHub Issues"],
        priority: 1,
    });

    specs.push(DependencySpec {
        name: "node",
        version_args: &["--version"],
        required: true,
        description: "Node.js runtime, installed and managed by the app - runs the local AI agent and npx-based MCP servers",
        affected_features: &["Local Agent", "MCP Servers (npx-based)"],
        priority: 1,
    });

    specs.push(DependencySpec {
        name: "python3",
        version_args: &["--version"],
        required: false,
        description: "Python runtime - needed for uvx-based MCP servers and data analysis",
        affected_features: &["MCP Servers (uvx-based)", "Data Analysis"],
        priority: 1,
    });

    // pi — the local agent runtime, installed by the app on the managed Node.
    specs.push(DependencySpec {
        name: "pi",
        version_args: &["--version"],
        required: true,
        description: "Agent runtime for the local AI agent, installed and managed by the app",
        affected_features: &["Local Agent"],
        priority: 1,
    });

    specs
}

/// How long a `check_dependencies` answer is reused before the probes run
/// again. The page re-asks on every mount; nothing about six `--version`
/// answers changes between two mounts seconds apart, except an install this
/// module performs itself — and that path calls [`forget_dependencies`].
const DEPENDENCY_CACHE_TTL: Duration = Duration::from_secs(30);

struct DependencySnapshot {
    checked_at: Instant,
    deps: Vec<DependencyInfo>,
}

static DEPENDENCY_CACHE: Mutex<Option<DependencySnapshot>> = Mutex::new(None);

fn cached_dependencies() -> Option<Vec<DependencyInfo>> {
    let guard = DEPENDENCY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let snapshot = guard.as_ref()?;
    (snapshot.checked_at.elapsed() < DEPENDENCY_CACHE_TTL).then(|| snapshot.deps.clone())
}

fn remember_dependencies(deps: &[DependencyInfo]) {
    let mut guard = DEPENDENCY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(DependencySnapshot {
        checked_at: Instant::now(),
        deps: deps.to_vec(),
    });
}

/// Drop the cached answer. Called after anything this module installs, so the
/// next `check_dependencies` sees the new binary rather than a 30-second-old
/// "missing".
pub(crate) fn forget_dependencies() {
    let mut guard = DEPENDENCY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// Run every probe at once on blocking threads and collect them in spec order.
///
/// Each probe is a process spawn that can take hundreds of milliseconds (a
/// shim that boots node, a `brew --version` on a cold disk). Serially that was
/// one to three seconds; concurrently it is the slowest single probe.
async fn probe_dependencies<R: Runtime>(app: &AppHandle<R>) -> Vec<DependencyInfo> {
    let specs = dependency_specs();
    // The managed runtime rows come from `amuxd doctor` (one sidecar run,
    // cached), which knows where it installed Node and pi. Probing PATH for
    // them would answer about the user's own tools, which is not the question.
    let doctor = crate::commands::setup::read_doctor(app).await;
    let managed = |key: &str| -> Option<(bool, Option<String>)> {
        let node = doctor.as_ref()?.get(key)?;
        Some((
            node["satisfied"].as_bool().unwrap_or(false),
            node["version"].as_str().map(str::to_string),
        ))
    };
    let handles: Vec<_> = specs
        .iter()
        .map(|spec| {
            let spec = *spec;
            match spec.name {
                "node" | "pi" => {
                    let (installed, version) = managed(spec.name).unwrap_or((false, None));
                    tokio::task::spawn_blocking(move || dependency_info(&spec, installed, version))
                }
                _ => tokio::task::spawn_blocking(move || check_single_dependency(&spec)),
            }
        })
        .collect();

    let mut deps = Vec::with_capacity(specs.len());
    for (spec, handle) in specs.iter().zip(handles) {
        // A probe that panicked is reported as "not installed" rather than
        // vanishing from the list — the row still has to render.
        deps.push(
            handle
                .await
                .unwrap_or_else(|_| dependency_info(spec, false, None)),
        );
    }

    // Sort by priority (lower first); stable, so spec order holds within a tier.
    deps.sort_by_key(|d| d.priority);
    deps
}

/// Check all external dependencies and return their status.
/// Results are sorted by priority (lower first) for install ordering.
///
/// `async`: a non-`async` Tauri command runs inline in the IPC handler, and on
/// macOS that is the main thread. Six serial process spawns there froze the
/// window for one to three seconds every time the Dependencies page mounted.
/// Now the probes run concurrently on blocking threads, and the answer is
/// cached for [`DEPENDENCY_CACHE_TTL`].
#[tauri::command]
pub async fn check_dependencies<R: Runtime>(app: AppHandle<R>) -> Vec<DependencyInfo> {
    if let Some(cached) = cached_dependencies() {
        return cached;
    }
    let deps = probe_dependencies(&app).await;
    remember_dependencies(&deps);
    deps
}

/// Install a single dependency using the platform's package manager.
/// Streams output via `dep-install-progress` events.
/// Returns true on success, false on failure.
#[tauri::command]
pub async fn install_dependency<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<bool, String> {
    let result = install_dependency_inner(&app, &name).await;
    // Whatever happened, the cached "missing" is no longer trustworthy.
    forget_dependencies();
    result
}

async fn install_dependency_inner<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> Result<bool, String> {
    // The managed runtime: `amuxd install-pi` installs the pinned Node.js and
    // pi on it, idempotently, so either row repairs both.
    if name == "pi" || name == "node" {
        return Ok(install_pi_via_amuxd(app).await);
    }

    // On macOS, if the dependency requires brew and brew is not installed, install brew first
    if requires_brew(name) {
        // Through the same resolver as every other probe: a Dock-launched app
        // can hold a PATH without /opt/homebrew/bin in it, and a bare
        // `Command::new("brew")` there reports "Homebrew is missing" on a
        // machine that has it — then fails the install it was guarding.
        let brew_check = Command::new(probe_program("brew"))
            .no_window()
            .env("PATH", teamclu_binpath::augmented_path())
            .arg("--version")
            .output();
        let brew_installed = matches!(brew_check, Ok(o) if o.status.success());
        if !brew_installed {
            let brew_result = run_install(app, "brew").await;
            if !brew_result {
                return Err(
                    "Failed to install Homebrew, which is required to install this dependency"
                        .to_string(),
                );
            }
        }
    }

    let success = run_install(app, name).await;
    Ok(success)
}

/// Update an already-installed dependency.
///
/// `pi.lock.json` names the runtime versions, and plain `amuxd install-pi`
/// lifts an older install to them, so no force flag exists or is wanted.
///
/// On success the desktop-managed amuxd is restarted, because the running pi
/// hosts still hold the old tree and would otherwise keep serving the
/// pre-update version for the rest of the app's lifetime.
///
/// The restart runs detached: awaiting it would keep the frontend's
/// `updateDependency` promise pending for the whole daemon bounce, so the
/// Dependencies panel stayed stuck on "Updating…" long after the download was
/// done. The download result is what this command reports; a restart failure is
/// emitted separately on the same progress channel.
#[tauri::command]
pub async fn update_dependency<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<bool, String> {
    if name == "pi" || name == "node" {
        let ok = install_pi_via_amuxd(&app).await;
        if ok {
            forget_dependencies();
            // pi needs the bounce too. "pi is spawned per session, so the next
            // spawn picks up the new binary" was wrong: the daemon pools a pi
            // *host* child per isolation key and only respawns when its
            // fingerprint (binary path + mode + env) changes. An in-place
            // upgrade keeps the path, so every live host keeps running the old
            // build while this page reports the new version off disk.
            restart_amuxd_after_update(&app, "pi");
        }
        return Ok(ok);
    }
    Err(format!("No update path available for '{}'", name))
}

/// Bounce the desktop-managed amuxd so an updated runtime is the one actually
/// running. Neither runtime notices a binary replaced underneath it: opencode
/// is held open by a long-lived `serve`, pi by a pooled host child.
///
/// Detached on purpose: awaiting it would keep the frontend's
/// `updateDependency` promise pending for the whole daemon bounce, leaving the
/// Dependencies panel on "Updating…" long after the download finished. The
/// download result is what the command reports; a restart failure is emitted on
/// the same progress channel.
fn restart_amuxd_after_update<R: Runtime>(app: &AppHandle<R>, name: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::commands::amuxd_supervisor::AmuxdSupervisor::restart(&app).await {
            let _ = app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: name.to_string(),
                    status: "failed".to_string(),
                    output_line: None,
                    error: Some(format!(
                        "{name} was updated, but restarting amuxd failed: {e}. Restart the app to use the new version."
                    )),
                },
            );
        }
    });
}

/// Install-or-upgrade the managed runtime via the bundled `amuxd install-pi`,
/// bridging its progress onto `dep-install-progress`.
async fn install_pi_via_amuxd<R: Runtime>(app: &AppHandle<R>) -> bool {
    let emit_app = app.clone();
    crate::commands::setup::run_amuxd_install_pi(app, move |status, line, error| {
        // amuxd emits "running"; the deps UI expects "installing".
        let status = if status == "running" {
            "installing"
        } else {
            status
        };
        let _ = emit_app.emit(
            "dep-install-progress",
            DepInstallProgress {
                name: "pi".to_string(),
                status: status.to_string(),
                output_line: line,
                error,
            },
        );
    })
    .await
    .is_ok()
}

/// Execute the actual install command and stream output via events.
async fn run_install<R: Runtime>(app: &AppHandle<R>, name: &str) -> bool {
    let install_cmd = match get_install_command(name) {
        Some(cmd) if !cmd.is_empty() => cmd,
        _ => {
            let _ = app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: name.to_string(),
                    status: "failed".to_string(),
                    output_line: None,
                    error: Some(format!(
                        "No install command available for '{}' on this platform",
                        name
                    )),
                },
            );
            return false;
        }
    };

    // Emit started event
    let _ = app.emit(
        "dep-install-progress",
        DepInstallProgress {
            name: name.to_string(),
            status: "started".to_string(),
            output_line: None,
            error: None,
        },
    );

    // Spawn the install process via shell
    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "/bin/bash"
    };
    let shell_args: Vec<&str> = if cfg!(target_os = "windows") {
        vec!["/C", &install_cmd]
    } else {
        vec!["-c", &install_cmd]
    };

    let child = AsyncCommand::new(shell)
        .no_window()
        .args(&shell_args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: name.to_string(),
                    status: "failed".to_string(),
                    output_line: None,
                    error: Some(format!("Failed to spawn install process: {}", e)),
                },
            );
            return false;
        }
    };

    // Stream stdout
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_clone = app.clone();
    let name_owned = name.to_string();

    let stdout_handle = tokio::spawn({
        let app = app_clone.clone();
        let name = name_owned.clone();
        async move {
            if let Some(stdout) = stdout {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app.emit(
                        "dep-install-progress",
                        DepInstallProgress {
                            name: name.clone(),
                            status: "installing".to_string(),
                            output_line: Some(line),
                            error: None,
                        },
                    );
                }
            }
        }
    });

    let stderr_handle = tokio::spawn({
        let app = app_clone;
        let name = name_owned.clone();
        async move {
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app.emit(
                        "dep-install-progress",
                        DepInstallProgress {
                            name: name.clone(),
                            status: "installing".to_string(),
                            output_line: Some(line),
                            error: None,
                        },
                    );
                }
            }
        }
    });

    // Wait for streams to finish
    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    // Wait for process to exit
    let exit_status = child.wait().await;
    let success = matches!(exit_status, Ok(s) if s.success());

    if success {
        let _ = app.emit(
            "dep-install-progress",
            DepInstallProgress {
                name: name_owned,
                status: "done".to_string(),
                output_line: None,
                error: None,
            },
        );
    } else {
        let error_msg = match exit_status {
            Ok(s) => format!("Process exited with code: {}", s.code().unwrap_or(-1)),
            Err(e) => format!("Failed to wait for process: {}", e),
        };
        let _ = app.emit(
            "dep-install-progress",
            DepInstallProgress {
                name: name_owned,
                status: "failed".to_string(),
                output_line: None,
                error: Some(error_msg),
            },
        );
    }

    success
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &std::path::Path, file: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(file);
        std::fs::write(&path, "").unwrap();
        path
    }

    /// #1049: a Node that is installed but not on this process's PATH read as
    /// "not installed" in Settings while onboarding — which asks amuxd, and
    /// amuxd probes well-known directories — said it was fine.
    #[test]
    fn a_tool_outside_path_is_still_found() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let node = touch(&dir, if cfg!(windows) { "node.exe" } else { "node" });
        assert_eq!(probe_program_in("node", &[dir]), node.to_string_lossy());
    }

    #[test]
    fn a_tool_found_nowhere_falls_back_to_the_bare_name() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(probe_program_in("gh", &[tmp.path().to_path_buf()]), "gh");
    }

    /// Rust appends `.exe` and never consults PATHEXT, and npm ships no
    /// `npm.exe` — only `npm.cmd`. The bare name can never start it.
    #[test]
    fn npm_falls_back_to_its_windows_shim_name() {
        let tmp = tempfile::tempdir().unwrap();
        let got = probe_program_in("npm", &[tmp.path().to_path_buf()]);
        assert_eq!(got, if cfg!(windows) { "npm.cmd" } else { "npm" });
    }

    /// The managed runtime is what the local agent needs; everything else on
    /// the page is a convenience.
    #[test]
    fn only_the_managed_runtime_rows_are_required() {
        let required: Vec<&str> = dependency_specs()
            .iter()
            .filter(|s| s.required)
            .map(|s| s.name)
            .collect();
        assert_eq!(required, vec!["node", "pi"]);
    }

    /// pi must be offerable from the Dependencies page so a broken runtime can
    /// be repaired from Settings.
    #[test]
    fn pi_has_an_install_path() {
        assert!(
            get_install_commands_map("pi").is_some(),
            "pi needs install commands for the UI to render"
        );
    }
}
