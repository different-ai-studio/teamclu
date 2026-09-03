use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

use crate::process_util::CommandNoWindow;

/// What `agents.local_agent` defaults to when it has never been set, and what
/// the frontend reports when the daemon cannot be reached. Mirrors the daemon's
/// own default (`LOCAL_AGENT_CANDIDATES[0]`).
const DEFAULT_LOCAL_AGENT: &str = "opencode";

/// Which runtime this machine runs, falling back to the daemon's own default.
fn active_runtime(local_agent: Option<&str>) -> &str {
    local_agent
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or(DEFAULT_LOCAL_AGENT)
}

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

/// A tool's own install directory, searched before the well-known ones.
///
/// Both installers hardcode a home-relative path that is on nobody's PATH.
fn own_dirs(name: &str) -> Vec<PathBuf> {
    // Through the crate, not `dirs::home_dir()` directly: the desktop and the
    // crate pin different `dirs` majors, and resolving home twice through two
    // of them is the split-brain this lookup was moved to a crate to avoid.
    let Some(home) = teamclu_binpath::home_dir() else {
        return Vec::new();
    };
    match name {
        "opencode" => vec![home.join(".opencode").join("bin")],
        "pi" => vec![home.join(".pi").join("bin")],
        _ => Vec::new(),
    }
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
    teamclu_binpath::find_with(name, &own_dirs(name), dirs)
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

/// The Node row, answered by the resolver the runtimes themselves use.
///
/// Deliberately not the generic `node --version` probe: that runs whatever
/// `node` PATH resolves to, and a developer machine routinely holds several
/// Nodes (nvm, fnm and `n` all coexist happily). This row read "20.20.2" — an
/// abandoned nvm still symlinked at `/usr/local/bin/node` — on a machine whose
/// terminal, and whose pi install, ran v24.18.0. Two answers to one question is
/// the shape of #1049; there is one answer now.
fn check_node_dependency(spec: &DependencySpec) -> DependencyInfo {
    let choice = teamclu_runtime_env::node::resolve_node(teamclu_runtime_env::node::PI_MIN_VERSION);
    dependency_info(spec, choice.is_some(), choice.map(|c| c.version))
}

/// Check a single dependency by running `cmd --version` (or a variant).
/// Returns a DependencyInfo with installed status and parsed version.
fn check_single_dependency(spec: &DependencySpec) -> DependencyInfo {
    if spec.name == "node" {
        return check_node_dependency(spec);
    }

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
        // opencode is installed/updated via the bundled `amuxd install-opencode`
        // (same path as the first-run SetupWizard) — this string is display-only;
        // the real install is handled specially in `install_dependency`.
        "opencode" => Some(PlatformInstallCommands {
            macos: "amuxd install-opencode".to_string(),
            windows: "amuxd install-opencode".to_string(),
            linux: "amuxd install-opencode".to_string(),
        }),
        // Same deal as opencode: display-only, with the real work done by the
        // bundled sidecar in `install_dependency`.
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
    matches!(name, "gh" | "node" | "python3")
}

/// Installed vs available version of one dependency, for the Dependencies UI.
///
/// Shared by opencode and pi even though "available" means different things:
/// opencode's comes off the mirror manifest (a moving target, network), pi's is
/// the minimum `pi.lock.json` pins (fixed, offline). The UI only needs "is
/// there something to update to", which both answer.
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

/// Ask the bundled amuxd what the newest opencode available is. Hits the
/// network (the mirror manifest), so this is a separate command from
/// `check_dependencies`, which must stay fast and offline.
#[tauri::command]
pub async fn opencode_versions<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DependencyVersions, String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    let (mut rx, _child) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["opencode-versions"])
        .spawn()
        .map_err(|e| format!("spawn amuxd: {e}"))?;
    let mut buf = String::new();
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Stdout(bytes) = event {
            buf.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    serde_json::from_str(buf.trim()).map_err(|e| format!("parse amuxd opencode-versions: {e}"))
}

/// Installed vs required pi, for the same Update affordance opencode has.
///
/// Reads `amuxd doctor` rather than adding a sidecar subcommand: doctor already
/// reports pi's installed version alongside the version `pi.lock.json` requires,
/// and unlike opencode there is no mirror to ask — the target is pinned, so this
/// answer is offline and cheap.
#[tauri::command]
pub async fn pi_versions<R: Runtime>(app: AppHandle<R>) -> Result<DependencyVersions, String> {
    // `None`, not `Some("pi")`: `read_doctor` discards the argument (doctor
    // reports every runtime in one pass), so naming one only made the call look
    // targeted. The key below is what selects pi.
    let doctor = crate::commands::setup::read_doctor(&app, None)
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
/// `active_runtime` is the runtime this machine is configured to run
/// (`agents.local_agent`, as the daemon reports it). It decides which of the
/// two agent runtimes is *required*: before this, opencode was required
/// unconditionally, so every machine set up to run pi was told it was missing
/// something it does not need — a red "Required" row with nothing wrong.
fn dependency_specs(active_runtime: &str) -> Vec<DependencySpec> {
    let mut specs = Vec::with_capacity(6);

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
        required: false,
        description: "Node.js runtime - needed to run some MCP servers (via npx)",
        affected_features: &["MCP Servers (npx-based)"],
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

    // opencode — required only when it is the runtime this machine actually
    // runs. Install/update goes through `amuxd install-opencode`.
    specs.push(DependencySpec {
        name: "opencode",
        version_args: &["--version"],
        required: active_runtime == "opencode",
        description: "Agent runtime for the local AI agent",
        affected_features: &["Local Agent"],
        priority: 1,
    });

    // pi — the other runtime this app can install. Same rule as opencode: the
    // one this machine runs is the one that is required. Both are always listed
    // so either can be installed, upgraded or repaired from here.
    specs.push(DependencySpec {
        name: "pi",
        version_args: &["--version"],
        required: active_runtime == "pi",
        description: "Agent runtime for the local AI agent",
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
    runtime: String,
    checked_at: Instant,
    deps: Vec<DependencyInfo>,
}

static DEPENDENCY_CACHE: Mutex<Option<DependencySnapshot>> = Mutex::new(None);

fn cached_dependencies(runtime: &str) -> Option<Vec<DependencyInfo>> {
    let guard = DEPENDENCY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let snapshot = guard.as_ref()?;
    (snapshot.runtime == runtime && snapshot.checked_at.elapsed() < DEPENDENCY_CACHE_TTL)
        .then(|| snapshot.deps.clone())
}

fn remember_dependencies(runtime: &str, deps: &[DependencyInfo]) {
    let mut guard = DEPENDENCY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(DependencySnapshot {
        runtime: runtime.to_string(),
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
async fn probe_dependencies(active_runtime: &str) -> Vec<DependencyInfo> {
    let specs = dependency_specs(active_runtime);
    let handles: Vec<_> = specs
        .iter()
        .map(|spec| {
            let spec = *spec;
            tokio::task::spawn_blocking(move || check_single_dependency(&spec))
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
/// `local_agent` is the runtime this machine is configured to run — see
/// [`dependency_specs`]. `None` keeps the old conservative answer, which is
/// also what the frontend falls back to when the daemon cannot be asked.
///
/// `async`: a non-`async` Tauri command runs inline in the IPC handler, and on
/// macOS that is the main thread. Six serial process spawns there froze the
/// window for one to three seconds every time the Dependencies page mounted.
/// Now the probes run concurrently on blocking threads, and the answer is
/// cached for [`DEPENDENCY_CACHE_TTL`].
#[tauri::command]
pub async fn check_dependencies(local_agent: Option<String>) -> Vec<DependencyInfo> {
    let runtime = active_runtime(local_agent.as_deref()).to_string();
    if let Some(cached) = cached_dependencies(&runtime) {
        return cached;
    }
    let deps = probe_dependencies(&runtime).await;
    remember_dependencies(&runtime, &deps);
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
    // opencode is installed via the same `amuxd install-opencode` path as the
    // first-run SetupWizard. Not forced: this is the "it's missing" case.
    if name == "opencode" {
        return Ok(install_opencode_via_amuxd(app, false).await);
    }
    // pi likewise — `amuxd install-pi` is idempotent, so the same call installs
    // it or lifts it to the version `pi.lock.json` pins.
    if name == "pi" {
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
/// opencode takes `amuxd install-opencode --force`, because amuxd pins no
/// version and "update" means "fetch whatever upstream ships now". pi is the
/// opposite: `pi.lock.json` names the version, and plain `amuxd install-pi`
/// already lifts an older install to it, so no force flag exists or is wanted.
///
/// On success the desktop-managed amuxd is restarted, because the running
/// `opencode serve` still holds the old binary and would otherwise keep serving
/// the pre-update version for the rest of the app's lifetime.
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
    if name == "opencode" {
        let ok = install_opencode_via_amuxd(&app, true).await;
        if ok {
            forget_dependencies();
            restart_amuxd_after_update(&app, "opencode");
        }
        return Ok(ok);
    }
    if name == "pi" {
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

/// Install-or-update opencode via the bundled `amuxd install-opencode`, bridging
/// its progress onto `dep-install-progress` events (the settings Dependencies UI
/// contract). Shares the exact install path used by the first-run SetupWizard.
/// `force` re-fetches the latest release even when opencode is already present.
async fn install_opencode_via_amuxd<R: Runtime>(app: &AppHandle<R>, force: bool) -> bool {
    let emit_app = app.clone();
    let result = crate::commands::setup::run_amuxd_install_opencode(
        app,
        force,
        move |status, line, error| {
            // amuxd emits "running"; the deps UI expects "installing".
            let status = if status == "running" {
                "installing"
            } else {
                status
            };
            let _ = emit_app.emit(
                "dep-install-progress",
                DepInstallProgress {
                    name: "opencode".to_string(),
                    status: status.to_string(),
                    output_line: line,
                    error,
                },
            );
        },
    )
    .await;
    result.is_ok()
}

/// Install-or-upgrade pi via the bundled `amuxd install-pi`, bridging its
/// progress onto `dep-install-progress` the same way opencode does.
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

    /// The runtimes' own installers hardcode a home-relative directory that is
    /// on nobody's PATH, so it has to be searched before the shared list.
    #[test]
    fn a_runtimes_own_directory_beats_the_well_known_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let well_known = tmp.path().join("well-known");
        touch(&well_known, if cfg!(windows) { "pi.exe" } else { "pi" });

        let got = probe_program_in("pi", std::slice::from_ref(&well_known));
        let own = teamclu_binpath::home_dir()
            .map(|h| h.join(".pi").join("bin"))
            .and_then(|dir| teamclu_binpath::find_with("pi", &[dir], &[]));
        match own {
            // A real pi install on this machine outranks the fixture.
            Some(p) => assert_eq!(got, p.to_string_lossy()),
            None => assert_eq!(
                got,
                well_known
                    .join(if cfg!(windows) { "pi.exe" } else { "pi" })
                    .to_string_lossy()
            ),
        }
    }

    /// The required-flag decision alone. Going through `check_dependencies`
    /// would probe six real programs per case — 18 subprocess spawns for three
    /// assertions about pure logic, and a hang on any machine with a wedged
    /// `--version`.
    fn required_names(local_agent: Option<&str>) -> Vec<&'static str> {
        let active = active_runtime(local_agent);
        ["opencode", "pi"]
            .into_iter()
            .filter(|name| *name == active)
            .collect()
    }

    /// A machine set up to run pi was told opencode was "Required" and missing.
    /// Which runtime is required is the machine's runtime choice, not a constant.
    #[test]
    fn only_the_configured_runtime_is_required() {
        assert_eq!(required_names(Some("opencode")), vec!["opencode"]);
        assert_eq!(required_names(Some("pi")), vec!["pi"]);
    }

    /// The daemon may be down or never asked; fall back to the same default it
    /// uses rather than requiring both runtimes or neither.
    #[test]
    fn an_unknown_runtime_falls_back_to_the_daemons_default() {
        assert_eq!(required_names(None), vec![DEFAULT_LOCAL_AGENT]);
    }

    /// cursor and claude-code are the user's own tools — this page cannot
    /// install either, so neither opencode nor pi is required for them.
    #[test]
    fn a_runtime_this_page_cannot_install_requires_neither() {
        assert!(required_names(Some("cursor")).is_empty());
        assert!(required_names(Some("claude-code")).is_empty());
    }

    /// Both runtimes must be offerable from the Dependencies page — pi was
    /// missing entirely, so a pi machine had no way to see or repair it.
    #[test]
    fn both_agent_runtimes_have_an_install_path() {
        for runtime in ["opencode", "pi"] {
            assert!(
                get_install_commands_map(runtime).is_some(),
                "{runtime} needs install commands for the UI to render"
            );
        }
    }
}
