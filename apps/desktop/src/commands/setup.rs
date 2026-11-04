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
    let command = crate::commands::branded_amuxd_sidecar(app, ["doctor"]).ok()?;
    let (mut rx, _child) = command.spawn().ok()?;
    let mut buf = String::new();
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Stdout(bytes) = event {
            buf.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    serde_json::from_str(buf.trim()).ok()
}

/// `blocker` value meaning "the daemon that answered is older than this app,
/// so it cannot report this row at all". Not a runtime problem: nothing the
/// install could do would clear it.
pub(crate) const BLOCKER_DAEMON_OUTDATED: &str = "daemon_outdated";

/// Is this doctor report from a daemon that predates the managed runtime?
///
/// `amuxd doctor` has answered with a top-level `node` row since #1250. A
/// report without one is not "Node is missing" — it is a daemon that cannot
/// answer the question, and reading the two the same way is what let the wizard
/// install a runtime that was already there and then call it "installed but not
/// ready" forever.
///
/// This is a real state in a dev checkout, not a hypothetical: the sidecar is
/// staged once, when `pnpm tauri:dev` starts (`scripts/ensure-amuxd-sidecar.js`
/// via `scripts/tauri-cli.js`), while the Rust host is rebuilt by the watcher on
/// every source change — so a checkout that moves forward under a live session
/// leaves a new app talking to the daemon it launched with. A shipped bundle
/// always carries a matching pair.
fn daemon_predates_managed_runtime(doctor: &serde_json::Value) -> bool {
    !doctor["node"].is_object()
}

/// The `(blocker, found, required)` triple for a managed row the daemon is too
/// old to report. Both managed rows carry the same one: the subject is the
/// daemon, and naming pi's Node here would be inventing a reading nobody took.
fn stale_daemon_blocker(
    daemon_version: Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        Some(BLOCKER_DAEMON_OUTDATED.to_string()),
        daemon_version,
        Some(env!("CARGO_PKG_VERSION").to_string()),
    )
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

    // Whether the answer came from a daemon too old to give one. `bundledVersion`
    // is the responding sidecar's own version — every daemon that has ever
    // shipped reports it, including the ones this catches.
    let stale_daemon = doctor.as_ref().is_some_and(daemon_predates_managed_runtime);
    let daemon_version = text(&amuxd, "bundledVersion");

    let (node_blocker, node_found, node_required) = if stale_daemon {
        stale_daemon_blocker(daemon_version.clone())
    } else {
        (None, None, text(&node, "requiredVersion"))
    };

    // pi's `satisfied` folds in Node and the MCP SDK; the blocker names which
    // half is missing so the wizard's progress copy can be specific.
    let (pi_blocker, pi_found, pi_required) = if stale_daemon {
        stale_daemon_blocker(daemon_version)
    } else {
        let blocker = pi.as_ref().and_then(pi_blocker);
        let (found, required) = pi
            .as_ref()
            .map(|n| pi_blocker_detail(blocker.as_deref(), n))
            .unwrap_or((None, None));
        (blocker, found, required)
    };

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
            blocker: node_blocker,
            blocker_found: node_found,
            blocker_required: node_required,
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

/// Whether a `run_amuxd_install_pi` call ran the install itself or waited on
/// one that was already running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PiInstallRun {
    Ran,
    /// Another caller's install finished while this one waited, and this call
    /// reports its result. That caller restarts amuxd; this one must not, or
    /// every joined call bounces the daemon again.
    Joined,
}

/// One install at a time, and callers that arrive mid-install share its result.
///
/// The frontend checks the runtime each time the daemon comes up, and every
/// install restarts the daemon, so without this one install's restart starts
/// the next; overlapping `npm ci` runs then delete each other's tree and the
/// check never passes (23 concurrent installs on 2026-11-04). `amuxd install-pi`
/// also serializes on a file lock; this gate keeps the app from queueing
/// redundant installs and restarts behind it.
pub(crate) struct SingleFlight {
    finished: std::sync::atomic::AtomicU64,
    last: tokio::sync::Mutex<Option<Result<(), String>>>,
}

impl SingleFlight {
    pub(crate) const fn new() -> Self {
        Self {
            finished: std::sync::atomic::AtomicU64::new(0),
            last: tokio::sync::Mutex::const_new(None),
        }
    }

    /// Run `install`, or — when another one finished while this call waited for
    /// the gate — return that one's result without running.
    pub(crate) async fn run<Fut>(
        &self,
        install: impl FnOnce() -> Fut,
    ) -> (PiInstallRun, Result<(), String>)
    where
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        use std::sync::atomic::Ordering;
        let seen = self.finished.load(Ordering::SeqCst);
        let mut last = self.last.lock().await;
        if self.finished.load(Ordering::SeqCst) != seen {
            if let Some(result) = last.clone() {
                return (PiInstallRun::Joined, result);
            }
        }
        let result = install().await;
        *last = Some(result.clone());
        self.finished.fetch_add(1, Ordering::SeqCst);
        (PiInstallRun::Ran, result)
    }
}

static PI_INSTALL: SingleFlight = SingleFlight::new();

/// Run `amuxd install-pi`, streaming progress through `emit`.
///
/// `emit(status, line, error)` — status is "started" | "running" | "failed" |
/// "done". Idempotent: installs the managed Node.js, then pi and the MCP SDK on
/// it, or repairs whichever piece is missing. Shared by the first-run wizard
/// and the settings Dependencies page so there is one install path, not two.
///
/// Single-flight (see [`SingleFlight`]): a call made while an install runs
/// waits for it and reports its result as [`PiInstallRun::Joined`].
pub(crate) async fn run_amuxd_install_pi<R, F>(
    app: &AppHandle<R>,
    emit: F,
) -> Result<PiInstallRun, String>
where
    R: Runtime,
    F: Fn(&str, Option<String>, Option<String>) + Send + Sync,
{
    let emit = &emit;
    let (run, result) = PI_INSTALL.run(|| spawn_amuxd_install_pi(app, emit)).await;
    if run == PiInstallRun::Joined {
        // This caller saw none of the progress; give its UI the outcome.
        emit("started", None, None);
        match &result {
            Ok(()) => emit("done", None, None),
            Err(e) => emit("failed", None, Some(e.clone())),
        }
    }
    result.map(|()| run)
}

/// How much of stderr to keep for an install that died without reporting its
/// own failure (an older amuxd, a panic). Enough for a Node crash trace: the
/// error sits a few lines above the `Node.js vX` footer.
const STDERR_TAIL_LINES: usize = 60;

/// The `message` of amuxd's `{"event":"error"}` line, if `line` is one. amuxd
/// ends a failed install on it with the whole error chain on one line.
fn install_error_event(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("event")?.as_str()? != "error" {
        return None;
    }
    let message = value.get("message")?.as_str()?.trim();
    (!message.is_empty()).then(|| message.to_string())
}

/// The error a failed `install-pi` is reported with.
///
/// It used to be the last stderr line alone, which for a Node crash is
/// `Node.js v24.20.0` and nothing else (a fresh machine, 2026-11-04). amuxd's
/// own report wins; without one, the stderr tail stands in, whole.
fn install_failure_message(
    reported: Option<&str>,
    stderr_tail: &[String],
    code: Option<i32>,
) -> String {
    if let Some(message) = reported {
        return format!("amuxd install-pi failed: {message}");
    }
    if stderr_tail.is_empty() {
        return format!("amuxd install-pi exited with code {code:?}");
    }
    let tail = stderr_tail.join("\n");
    // `main` prints the same chain anyhow-style; drop its `Error: ` prefix so
    // the message does not read "failed: Error: …".
    let tail = tail.strip_prefix("Error: ").unwrap_or(&tail);
    format!("amuxd install-pi failed: {tail}")
}

async fn spawn_amuxd_install_pi<R, F>(app: &AppHandle<R>, emit: &F) -> Result<(), String>
where
    R: Runtime,
    F: Fn(&str, Option<String>, Option<String>) + Send + Sync,
{
    use tauri_plugin_shell::process::CommandEvent;

    // Windows: install with amuxd and its pi hosts stopped, or the files they
    // hold keep the install from replacing their tree.
    #[cfg(windows)]
    let was_running =
        crate::commands::amuxd_supervisor::AmuxdSupervisor::pause_for_pi_install(app).await?;

    let result = async {
        emit("started", None, None);
        // `_child_guard` must stay alive until `rx` is drained: dropping the
        // CommandChild early can kill the sidecar mid-install.
        let (mut rx, _child_guard) = crate::commands::branded_amuxd_sidecar(app, ["install-pi"])?
            .spawn()
            .map_err(|e| format!("spawn amuxd: {e}"))?;

        let mut last_err: Option<String> = None;
        let mut reported: Option<String> = None;
        let mut stderr_tail: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(STDERR_TAIL_LINES);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        if let Some(message) = install_error_event(&line) {
                            reported = Some(message);
                        }
                        emit("running", Some(line), None);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        if stderr_tail.len() == STDERR_TAIL_LINES {
                            stderr_tail.pop_front();
                        }
                        stderr_tail.push_back(line.clone());
                        // Forwarded, not just remembered: amuxd narrates a slow
                        // install (registry probes, mirror fallbacks) on stderr, and
                        // holding those back is most of why an install row could sit
                        // on "installing…" with nothing under it. Mirrors the
                        // opencode path, which has always emitted both pipes.
                        emit("running", Some(line), None);
                    }
                }
                CommandEvent::Terminated(payload) if payload.code.unwrap_or(-1) != 0 => {
                    last_err = Some(install_failure_message(
                        reported.as_deref(),
                        stderr_tail.make_contiguous(),
                        payload.code,
                    ));
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
    .await;

    #[cfg(windows)]
    crate::commands::amuxd_supervisor::AmuxdSupervisor::resume_after_pi_install(
        app,
        was_running,
        result.is_ok(),
    )
    .await;
    result
}

/// Install pi for the first-run wizard and the post-login runtime check
/// (`ensureRuntimeReady`), then restart amuxd if it is up.
///
/// The restart is what makes the install take effect: amuxd starts restoring
/// sessions as soon as it is up, so on an upgraded machine its pi hosts are
/// already running the old tree by the time this install replaces it. It is
/// awaited, unlike the Dependencies panel's, because the wizard talks to the
/// daemon right after this returns.
async fn install_pi<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let run = run_amuxd_install_pi(app, |status, line, error| {
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
    .await?;
    // The caller whose install ran owns the restart.
    if run == PiInstallRun::Joined {
        return Ok(());
    }
    crate::commands::amuxd_supervisor::AmuxdSupervisor::restart_if_running(app)
        .await
        .map(|_| ())
        .map_err(|e| format!("pi was installed, but restarting amuxd failed: {e}"))
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

    #[tokio::test]
    async fn calls_made_during_an_install_share_it_instead_of_starting_another() {
        let gate = std::sync::Arc::new(SingleFlight::new());
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (release, released) = tokio::sync::oneshot::channel::<()>();

        let first = {
            let (gate, runs) = (gate.clone(), runs.clone());
            tokio::spawn(async move {
                gate.run(|| async move {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = released.await;
                    Ok(())
                })
                .await
            })
        };
        // Let the first install take the gate before the others arrive.
        while runs.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let (gate, runs) = (gate.clone(), runs.clone());
                tokio::spawn(async move {
                    gate.run(|| async move {
                        runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    })
                    .await
                })
            })
            .collect();
        // Let every waiter reach the gate while the first install still holds it.
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();

        assert_eq!(first.await.unwrap(), (PiInstallRun::Ran, Ok(())));
        for w in waiters {
            assert_eq!(w.await.unwrap(), (PiInstallRun::Joined, Ok(())));
        }
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_joined_call_reports_the_failure_and_a_later_call_retries() {
        let gate = SingleFlight::new();
        assert_eq!(
            gate.run(|| async { Err("boom".to_string()) }).await,
            (PiInstallRun::Ran, Err("boom".to_string()))
        );
        // Nothing in flight any more: the next call runs its own install.
        assert_eq!(
            gate.run(|| async { Ok(()) }).await,
            (PiInstallRun::Ran, Ok(()))
        );
    }

    #[test]
    fn amuxd_s_own_error_report_wins_over_the_stderr_tail() {
        let line = r#"{"event":"error","message":"pi install failed (exit status: 1): Error: boom\n\nNode.js v24.20.0","log":"/x"}"#;
        let reported = install_error_event(line);
        let tail = vec!["Node.js v24.20.0".to_string()];
        let message = install_failure_message(reported.as_deref(), &tail, Some(1));
        assert!(message.contains("Error: boom"), "{message}");
        assert!(message.starts_with("amuxd install-pi failed: pi install failed"));
    }

    #[test]
    fn progress_lines_are_not_mistaken_for_the_error_report() {
        assert_eq!(
            install_error_event(r#"{"event":"output","message":"x"}"#),
            None
        );
        assert_eq!(install_error_event("npm error code E404"), None);
        assert_eq!(
            install_error_event(r#"{"event":"error","message":"  "}"#),
            None
        );
    }

    #[test]
    fn without_a_report_the_whole_stderr_tail_is_kept_not_just_its_last_line() {
        // An older amuxd: the Node crash trace arrives line by line on stderr.
        let tail: Vec<String> = [
            "Error: pi install failed (exit status: 1): node:internal/modules/cjs/loader:1386",
            "Error: Cannot find module '/x/npm-cli.js'",
            "Node.js v24.20.0",
        ]
        .map(String::from)
        .to_vec();
        let message = install_failure_message(None, &tail, Some(1));
        assert!(
            message.contains("Cannot find module '/x/npm-cli.js'"),
            "{message}"
        );
        assert!(
            message.starts_with("amuxd install-pi failed: pi install failed"),
            "{message}"
        );
        assert_eq!(
            install_failure_message(None, &[], Some(3)),
            "amuxd install-pi exited with code Some(3)"
        );
    }

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
    fn a_doctor_with_no_node_row_reads_as_a_daemon_too_old_to_answer() {
        // The pre-#1250 report: it knows about opencode and a `pi` it calls
        // satisfied, and has no top-level `node` row at all. Read as "Node is
        // missing" this sends the wizard into install → still missing → "the
        // runtime was installed but does not report as ready", forever.
        let old = serde_json::json!({
            "amuxd": { "present": true, "bundledVersion": "0.4.1-beta.40", "satisfied": true },
            "opencode": { "present": true, "version": "1.18.18", "satisfied": true },
            "pi": pi_doctor(true, true, true),
            "git": { "present": true },
        });
        assert!(daemon_predates_managed_runtime(&old));

        let (blocker, found, required) = stale_daemon_blocker(Some("0.4.1-beta.40".into()));
        assert_eq!(blocker.as_deref(), Some("daemon_outdated"));
        assert_eq!(found.as_deref(), Some("0.4.1-beta.40"));
        assert_eq!(
            required.as_deref(),
            Some(env!("CARGO_PKG_VERSION")),
            "required is the app's version — what the daemon has to match",
        );
    }

    #[test]
    fn a_current_doctor_is_not_read_as_stale() {
        let current = serde_json::json!({
            "amuxd": { "present": true, "bundledVersion": env!("CARGO_PKG_VERSION") },
            "node": { "present": false, "satisfied": false, "requiredVersion": "24.20.0" },
            "pi": pi_doctor(true, true, true),
            "git": { "present": true },
        });
        // `node` is there and says "not installed" — that is a runtime the
        // install can actually fix, and it must not be blamed on the daemon.
        assert!(!daemon_predates_managed_runtime(&current));
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
