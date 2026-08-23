//! Desktop-managed amuxd lifecycle.
//!
//! Spawns the **bundled** `amuxd` sidecar (no copy into `~/.amuxd/bin`), does not
//! register LaunchAgent/systemd, and stops the child when the desktop exits.
//! See `docs/specs/2026-07-24-desktop-managed-amuxd-design.md`.
//!
//! Lifecycle rules:
//! - One `lifecycle` mutex serializes ensure / shutdown / restart.
//! - `app_exiting` is set on true quit; ensure must not spawn after that.
//! - Exit: SIGTERM Child → wait/reap (true death), then best-effort `amuxd stop`
//!   for artifacts. Never decide liveness only via `kill(pid,0)` (zombies pass).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::process_util::CommandNoWindow;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TICK: Duration = Duration::from_millis(200);
/// Heal / restart can afford a longer wait.
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
/// Cmd+Q: brief grace for SIGTERM before SIGKILL + wait (reap).
const EXIT_CHILD_GRACE: Duration = Duration::from_millis(500);
const INTROSPECT_ENV: &str = "TEAMCLU_INTROSPECT_BIN";
const CURSOR_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CURSOR_BRIDGE_MAIN";
const CLAUDE_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CLAUDE_BRIDGE_MAIN";
const BRAND_SHORT_NAME_ENV: &str = teamclu_runtime_env::BRAND_SHORT_NAME_ENV;
const AMUXD_HOME_ENV: &str = teamclu_runtime_env::AMUXD_HOME_ENV;
/// Read by the teamclu-introspect sidecar (`export_session_link`), which amuxd
/// registers as an MCP server and therefore inherits this from.
const APP_SCHEME_ENV: &str = "TEAMCLU_APP_SCHEME";
const LAUNCHD_LABEL: &str = "cc.ucar.amuxd";

struct SupervisorInner {
    child: Option<tokio::process::Child>,
}

pub struct AmuxdSupervisor {
    /// Serializes ensure / restart end-to-end (including the health wait), so
    /// two concurrent ensures cannot heal-stop each other's fresh child.
    /// `inner` alone is not enough: it is released during the health wait.
    ensure_lock: tokio::sync::Mutex<()>,
    /// Guards the child handle. Held only for short sections so
    /// `shutdown_blocking` (Cmd+Q) can grab it quickly.
    inner: tokio::sync::Mutex<SupervisorInner>,
    /// Set on app Exit / ExitRequested; never cleared. Blocks further spawns.
    app_exiting: AtomicBool,
    /// Ensures Exit + ExitRequested only run the stop path once.
    shutdown_done: AtomicBool,
    /// True only after legacy background service is verified gone.
    migrated_legacy: AtomicBool,
}

impl Default for AmuxdSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl AmuxdSupervisor {
    pub fn new() -> Self {
        Self {
            ensure_lock: tokio::sync::Mutex::new(()),
            inner: tokio::sync::Mutex::new(SupervisorInner { child: None }),
            app_exiting: AtomicBool::new(false),
            shutdown_done: AtomicBool::new(false),
            migrated_legacy: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSupervisorStatus {
    pub running: bool,
    pub healthy: bool,
    pub pid: Option<i32>,
    pub error: Option<String>,
}

fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-unknown-{other}"),
    }
}

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

/// Locate a sidecar next to the desktop exe (prod) or under `apps/desktop/binaries` (dev).
pub fn locate_bundled_sidecar(base_name: &str) -> Option<PathBuf> {
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

fn bundled_amuxd() -> Result<PathBuf, String> {
    locate_bundled_sidecar("amuxd").ok_or_else(|| "bundled amuxd sidecar not found".into())
}

fn bundled_introspect_path() -> Option<PathBuf> {
    locate_bundled_sidecar("teamclu-introspect")
}

/// Candidate paths for a bridge `src/main.mjs`, most-specific first.
///
/// Tauri packs `resources: ["binaries/<bridge>/**/*"]` as
/// `Contents/Resources/binaries/<bridge>/…`. Omitting that layout left
/// `TEAMCLU_*_BRIDGE_MAIN` unset in release, and amuxd fell back to the CI
/// `CARGO_MANIFEST_DIR` path (`/Users/runner/work/…`).
fn bundled_bridge_main_candidates(
    bridge_name: &str,
    exe_dir: &Path,
    manifest_dir: &Path,
) -> Vec<PathBuf> {
    let rel = format!("{bridge_name}/src/main.mjs");
    vec![
        manifest_dir.join("binaries").join(&rel),
        exe_dir.join(&rel),
        exe_dir.join("../Resources").join(&rel),
        exe_dir.join("../Resources/binaries").join(&rel),
    ]
}

fn locate_bundled_bridge_main(bridge_name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    bundled_bridge_main_candidates(bridge_name, dir, manifest)
        .into_iter()
        .find(|p| p.is_file())
}

fn amuxd_dir() -> PathBuf {
    super::amuxd_home_dir()
}

fn amuxd_pid_is_running() -> bool {
    let pid_path = crate::commands::amuxd_run_dir().join("amuxd.pid");
    let Ok(body) = std::fs::read_to_string(&pid_path) else {
        return false;
    };
    let Ok(pid) = body.trim().parse::<i32>() else {
        return false;
    };
    pid_alive(pid)
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // kill(0) is true for zombies — treat Z as dead (same as amuxd stop).
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    !pid_is_zombie(pid)
}

#[cfg(unix)]
fn pid_is_zombie(pid: i32) -> bool {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "state="])
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout)
        .chars()
        .next()
        .is_some_and(|c| c == 'Z')
}

#[cfg(windows)]
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: i32) -> bool {
    false
}

async fn wait_for_amuxd_stopped(timeout: Duration) {
    let start = std::time::Instant::now();
    while amuxd_pid_is_running() {
        if start.elapsed() >= timeout {
            eprintln!("[amuxd-supervisor] warning: amuxd still running after stop timeout");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// True when GET `/v1/healthz` succeeds (same contract as the frontend probe).
async fn daemon_healthz_ok() -> bool {
    let port_path = crate::commands::amuxd_run_dir().join("amuxd.http.port");
    let Ok(port_str) = std::fs::read_to_string(&port_path) else {
        return false;
    };
    let Ok(port) = port_str.trim().parse::<u16>() else {
        return false;
    };
    let url = format!("http://127.0.0.1:{port}/v1/healthz");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

async fn wait_until_healthy(timeout: Duration, app_exiting: &AtomicBool) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if app_exiting.load(Ordering::SeqCst) {
            return Err("amuxd supervisor is shutting down".into());
        }
        if daemon_healthz_ok().await {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err("amuxd health check timed out (/v1/healthz)".into());
        }
        tokio::time::sleep(HEALTH_TICK).await;
    }
}

/// Blocking variant — only for the sync exit path (`shutdown_blocking`).
fn run_bundled_once(args: &[&str]) -> Result<(), String> {
    let bin = bundled_amuxd()?;
    let out = std::process::Command::new(&bin)
        .no_window()
        .args(args)
        .output()
        .map_err(|e| format!("spawn amuxd {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "amuxd {} exited {:?}: {}",
            args.join(" "),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Async variant for tokio contexts — does not block a runtime worker.
async fn run_bundled_once_async(args: &[&str]) -> Result<(), String> {
    let bin = bundled_amuxd()?;
    let out = tokio::process::Command::new(&bin)
        .no_window()
        .args(args)
        .output()
        .await
        .map_err(|e| format!("spawn amuxd {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "amuxd {} exited {:?}: {}",
            args.join(" "),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Legacy background service still installed or loaded.
fn legacy_service_active() -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            if home
                .join("Library/LaunchAgents")
                .join(format!("{LAUNCHD_LABEL}.plist"))
                .exists()
            {
                return true;
            }
        }
        let uid = unsafe { libc::getuid() };
        std::process::Command::new("launchctl")
            .args(["print", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            if home.join(".config/systemd/user/amuxd.service").exists() {
                return true;
            }
        }
        std::process::Command::new("systemctl")
            .args(["--user", "is-enabled", "amuxd.service"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
            || std::process::Command::new("systemctl")
                .args(["--user", "is-active", "amuxd.service"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("schtasks")
            .args(["/Query", "/TN", "amuxd"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

/// Uninstall legacy service; only marks migrated when verification passes.
/// Fail-closed: if still active after uninstall, return Err (do not start managed).
async fn migrate_legacy_service_if_needed(supervisor: &AmuxdSupervisor) -> Result<(), String> {
    if supervisor.migrated_legacy.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !legacy_service_active() {
        supervisor.migrated_legacy.store(true, Ordering::SeqCst);
        return Ok(());
    }

    eprintln!("[amuxd-supervisor] uninstalling legacy background service");
    if let Err(e) = run_bundled_once_async(&["uninstall-service"]).await {
        eprintln!("[amuxd-supervisor] uninstall-service: {e}");
    }
    // bootout is async on macOS — give launchd a moment, then re-check.
    tokio::time::sleep(Duration::from_millis(400)).await;

    if legacy_service_active() {
        return Err(
            "legacy amuxd background service is still installed/loaded; \
             refuse managed start to avoid dual instances. \
             Run `amuxd uninstall-service` and retry."
                .into(),
        );
    }

    if amuxd_pid_is_running() {
        eprintln!("[amuxd-supervisor] stopping leftover amuxd before managed start");
        let _ = run_bundled_once_async(&["stop"]).await;
        wait_for_amuxd_stopped(STOP_TIMEOUT).await;
    }

    supervisor.migrated_legacy.store(true, Ordering::SeqCst);
    Ok(())
}

fn child_is_alive(child: &mut Option<tokio::process::Child>) -> bool {
    match child.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) | Err(_) => {
                *child = None;
                false
            }
        },
        None => false,
    }
}

/// SIGTERM the managed amuxd (process group when it is the leader).
fn signal_child_stop(child: &tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pid = pid as i32;
        unsafe {
            let pgid = libc::getpgid(pid);
            if pgid == pid {
                let _ = libc::kill(-pid, libc::SIGTERM);
            } else {
                let _ = libc::kill(pid, libc::SIGTERM);
            }
        }
        return;
    }
    let _ = child; // non-unix: rely on start_kill in wait path
}

/// Wait for Child exit (reaps zombies). On timeout, SIGKILL and wait briefly.
/// Returns true when the process was reaped.
fn wait_reap_child(child: &mut tokio::process::Child, grace: Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if start.elapsed() < grace => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) | Err(_) => break,
        }
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pid = pid as i32;
        unsafe {
            let pgid = libc::getpgid(pid);
            if pgid == pid {
                let _ = libc::kill(-pid, libc::SIGKILL);
            }
            let _ = libc::kill(pid, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let kill_deadline = std::time::Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) if std::time::Instant::now() < kill_deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => return false,
        }
    }
}

/// Async wait+reap counterpart of [`wait_reap_child`] for tokio contexts.
async fn wait_reap_child_async(child: &mut tokio::process::Child, grace: Duration) -> bool {
    // wait() reaps; an Err means the child was already collected elsewhere.
    if tokio::time::timeout(grace, child.wait()).await.is_ok() {
        return true;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pid = pid as i32;
        unsafe {
            let pgid = libc::getpgid(pid);
            if pgid == pid {
                let _ = libc::kill(-pid, libc::SIGKILL);
            }
            let _ = libc::kill(pid, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    tokio::time::timeout(Duration::from_millis(500), child.wait())
        .await
        .is_ok()
}

/// Stop amuxd by waiting on our Child first (correct death signal), then
/// best-effort `amuxd stop` for artifacts / external leftovers.
/// Blocking variant — only for the sync exit path (`shutdown_blocking`).
fn stop_with_child_fallback(inner: &mut SupervisorInner, grace: Duration) {
    if let Some(mut child) = inner.child.take() {
        signal_child_stop(&child);
        if !wait_reap_child(&mut child, grace) {
            eprintln!("[amuxd-supervisor] warning: amuxd child did not reap after kill");
        }
    }

    // Artifact cleanup + any unmanaged leftover. With zombie-aware is_alive,
    // this returns quickly when the Child was already reaped.
    match run_bundled_once(&["stop"]) {
        Ok(()) => {}
        Err(e) => eprintln!("[amuxd-supervisor] amuxd stop (cleanup): {e}"),
    }
}

/// Async counterpart of [`stop_with_child_fallback`] — used by ensure /
/// shutdown / restart so tokio workers are not blocked by sleeps.
async fn stop_with_child_fallback_async(inner: &mut SupervisorInner, grace: Duration) {
    if let Some(mut child) = inner.child.take() {
        signal_child_stop(&child);
        if !wait_reap_child_async(&mut child, grace).await {
            eprintln!("[amuxd-supervisor] warning: amuxd child did not reap after kill");
        }
    }
    match run_bundled_once_async(&["stop"]).await {
        Ok(()) => {}
        Err(e) => eprintln!("[amuxd-supervisor] amuxd stop (cleanup): {e}"),
    }
}

/// When the lifecycle lock is contended, signal via pidfile then stop CLI.
fn stop_without_lock() {
    if let Ok(body) = std::fs::read_to_string(crate::commands::amuxd_run_dir().join("amuxd.pid")) {
        if let Ok(pid) = body.trim().parse::<i32>() {
            #[cfg(unix)]
            unsafe {
                let pgid = libc::getpgid(pid);
                if pgid == pid {
                    let _ = libc::kill(-pid, libc::SIGTERM);
                } else {
                    let _ = libc::kill(pid, libc::SIGTERM);
                }
            }
        }
    }
    // Brief pause so a live daemon can exit before stop CLI polls.
    std::thread::sleep(Duration::from_millis(100));
    match run_bundled_once(&["stop"]) {
        Ok(()) => {}
        Err(e) => eprintln!("[amuxd-supervisor] amuxd stop without lock: {e}"),
    }
}

impl AmuxdSupervisor {
    pub async fn ensure_started<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let state = app.state::<AmuxdSupervisor>();
        let _ensure = state.ensure_lock.lock().await;
        Self::ensure_started_locked(&state).await
    }

    /// Body of ensure; caller must hold `ensure_lock` for the whole call so
    /// concurrent ensures / restarts cannot heal-kill each other's child.
    async fn ensure_started_locked(state: &AmuxdSupervisor) -> Result<(), String> {
        if state.app_exiting.load(Ordering::SeqCst) {
            return Err("amuxd supervisor is shutting down".into());
        }

        let mut inner = state.inner.lock().await;
        if state.app_exiting.load(Ordering::SeqCst) {
            return Err("amuxd supervisor is shutting down".into());
        }

        migrate_legacy_service_if_needed(state).await?;

        if child_is_alive(&mut inner.child) && daemon_healthz_ok().await {
            return Ok(());
        }

        // Heal: stop any live/stale instance before (re)spawn.
        stop_with_child_fallback_async(&mut inner, STOP_TIMEOUT).await;

        if state.app_exiting.load(Ordering::SeqCst) {
            return Err("amuxd supervisor is shutting down".into());
        }

        let bin = bundled_amuxd()?;
        // `create(true)` does not create the parent, and on a fresh install
        // `logs/` does not exist until the daemon's own layout pass runs —
        // which happens after this spawn.
        let logs_dir = crate::commands::amuxd_logs_dir();
        let _ = std::fs::create_dir_all(&logs_dir);
        let log_path = logs_dir.join("amuxd.managed.log");
        // The daemon's tracing goes to its own rotating `amuxd.log`; this file
        // only catches panics, pre-init prints and child output. Still cap it —
        // it is append-across-runs and accumulated 76 MB under v1. Rotation
        // happens here (at spawn) because this side owns the writer.
        const MANAGED_LOG_MAX_BYTES: u64 = 32 * 1024 * 1024;
        if std::fs::metadata(&log_path)
            .map(|m| m.len() > MANAGED_LOG_MAX_BYTES)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&log_path, logs_dir.join("amuxd.managed.log.1"));
        }
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();

        let mut cmd = tokio::process::Command::new(&bin);
        // amuxd is a console-subsystem binary and the desktop app is GUI-subsystem
        // (`windows_subsystem = "windows"`), so without this Windows allocates a
        // console window for the daemon that stays up for the whole session — and
        // closing it kills amuxd. The hidden console it gets instead is inherited
        // by amuxd's own children, so opencode/node stay invisible too.
        cmd.no_window();
        cmd.arg("start").stdin(std::process::Stdio::null());
        if let Some(f) = log_file {
            let stderr = f
                .try_clone()
                .map(std::process::Stdio::from)
                .unwrap_or_else(|_| std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::from(f)).stderr(stderr);
        } else {
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
        }
        cmd.kill_on_drop(false);
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        // White-label: personal secrets under ~/.{brand}/secrets and amuxd
        // state under ~/.amuxd-<brand> (official keeps ~/.amuxd).
        let amuxd_home = amuxd_dir();
        cmd.env(BRAND_SHORT_NAME_ENV, super::APP_SHORT_NAME);
        cmd.env(AMUXD_HOME_ENV, &amuxd_home);
        cmd.env(APP_SCHEME_ENV, super::APP_SCHEME);
        if let Some(introspect) = bundled_introspect_path() {
            cmd.env(INTROSPECT_ENV, introspect);
        }
        if let Some(main) = locate_bundled_bridge_main("cursor-bridge") {
            cmd.env(CURSOR_BRIDGE_MAIN_ENV, main);
        }
        if let Some(main) = locate_bundled_bridge_main("claude-bridge") {
            cmd.env(CLAUDE_BRIDGE_MAIN_ENV, main);
        }
        eprintln!(
            "[amuxd-supervisor] spawning managed amuxd: {}",
            bin.display()
        );
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn bundled amuxd start: {e}"))?;
        inner.child = Some(child);
        // Release lifecycle lock during health wait so Cmd+Q is not blocked
        // behind HEALTH_TIMEOUT. app_exiting aborts the wait.
        drop(inner);

        if let Err(e) = wait_until_healthy(HEALTH_TIMEOUT, &state.app_exiting).await {
            let mut inner = state.inner.lock().await;
            stop_with_child_fallback_async(&mut inner, EXIT_CHILD_GRACE).await;
            return Err(e);
        }
        if state.app_exiting.load(Ordering::SeqCst) {
            let mut inner = state.inner.lock().await;
            stop_with_child_fallback_async(&mut inner, EXIT_CHILD_GRACE).await;
            return Err("amuxd supervisor is shutting down".into());
        }
        Ok(())
    }

    /// Mark app exiting and stop amuxd. Safe to call from Exit + ExitRequested.
    /// Must stay fast: once-only, wait on Child (not kill(0) polling).
    pub fn shutdown_blocking(&self) {
        self.app_exiting.store(true, Ordering::SeqCst);
        if self.shutdown_done.swap(true, Ordering::SeqCst) {
            return;
        }

        // Spin briefly for the lifecycle lock; if ensure holds it, stop via pidfile.
        let deadline = std::time::Instant::now() + Duration::from_millis(300);
        loop {
            if let Ok(mut inner) = self.inner.try_lock() {
                stop_with_child_fallback(&mut inner, EXIT_CHILD_GRACE);
                return;
            }
            if std::time::Instant::now() >= deadline {
                eprintln!("[amuxd-supervisor] lifecycle lock busy on exit; stopping without lock");
                stop_without_lock();
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Catch Ctrl+C / SIGTERM so terminal `pnpm tauri:dev` does not orphan amuxd.
    /// Cmd+Q still goes through `RunEvent::Exit`; both share `shutdown_done`.
    /// A second signal while cleanup runs forces process exit.
    pub fn install_signal_handlers<R: Runtime>(app: &AppHandle<R>) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_signal_shutdown_loop(app).await {
                eprintln!("[amuxd-supervisor] signal listener ended: {e}");
            }
        });
    }
}

/// Listen for terminate signals; first → `app.exit(0)`, second → force exit.
async fn run_signal_shutdown_loop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigint =
            signal(SignalKind::interrupt()).map_err(|e| format!("listen SIGINT: {e}"))?;
        let mut sigterm =
            signal(SignalKind::terminate()).map_err(|e| format!("listen SIGTERM: {e}"))?;
        let mut saw_first = false;
        loop {
            tokio::select! {
                _ = sigint.recv() => {}
                _ = sigterm.recv() => {}
            }
            if saw_first {
                eprintln!("[amuxd-supervisor] second terminate signal; forcing exit");
                std::process::exit(1);
            }
            saw_first = true;
            eprintln!("[amuxd-supervisor] terminate signal received; stopping amuxd via app.exit");
            // Normal Tauri exit → RunEvent::Exit → shutdown_blocking.
            app.exit(0);
        }
    }
    #[cfg(windows)]
    {
        let mut saw_first = false;
        loop {
            tokio::signal::ctrl_c()
                .await
                .map_err(|e| format!("listen Ctrl+C: {e}"))?;
            if saw_first {
                eprintln!("[amuxd-supervisor] second Ctrl+C; forcing exit");
                std::process::exit(1);
            }
            saw_first = true;
            eprintln!("[amuxd-supervisor] Ctrl+C received; stopping amuxd via app.exit");
            app.exit(0);
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = app;
        std::future::pending::<()>().await;
        Ok(())
    }
}

impl AmuxdSupervisor {
    pub async fn shutdown<R: Runtime>(app: &AppHandle<R>) {
        let state = app.state::<AmuxdSupervisor>();
        // Temporary stop (explicit stop command): do not set app_exiting /
        // shutdown_done.
        let mut inner = state.inner.lock().await;
        stop_with_child_fallback_async(&mut inner, STOP_TIMEOUT).await;
    }

    pub async fn restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let state = app.state::<AmuxdSupervisor>();
        if state.app_exiting.load(Ordering::SeqCst) {
            return Err("amuxd supervisor is shutting down".into());
        }
        // Hold ensure_lock across stop + start so a concurrent ensure cannot
        // slip in between and race the respawn.
        let _ensure = state.ensure_lock.lock().await;
        {
            let mut inner = state.inner.lock().await;
            stop_with_child_fallback_async(&mut inner, STOP_TIMEOUT).await;
        }
        Self::ensure_started_locked(&state).await
    }

    pub async fn status<R: Runtime>(app: &AppHandle<R>) -> DaemonSupervisorStatus {
        let state = app.state::<AmuxdSupervisor>();
        let mut guard = state.inner.lock().await;
        let running = child_is_alive(&mut guard.child);
        let pid = guard.child.as_ref().and_then(|c| c.id()).map(|p| p as i32);
        let healthy = running && daemon_healthz_ok().await;
        DaemonSupervisorStatus {
            running,
            healthy,
            pid,
            error: None,
        }
    }
}

#[tauri::command]
pub async fn daemon_ensure_running<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    AmuxdSupervisor::ensure_started(&app).await
}

#[tauri::command]
pub async fn daemon_restart_managed<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    AmuxdSupervisor::restart(&app).await
}

#[tauri::command]
pub async fn daemon_stop_managed<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    AmuxdSupervisor::shutdown(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn daemon_supervisor_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DaemonSupervisorStatus, String> {
    Ok(AmuxdSupervisor::status(&app).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_candidates_include_tauri_resources_binaries_layout() {
        let exe_dir = Path::new("/Applications/Copilot 361.app/Contents/MacOS");
        let manifest = Path::new("/tmp/does-not-exist-manifest");
        let cands = bundled_bridge_main_candidates("claude-bridge", exe_dir, manifest);
        assert!(
            cands.iter().any(|p| {
                p.to_string_lossy()
                    .contains("Resources/binaries/claude-bridge/src/main.mjs")
            }),
            "candidates={cands:?}"
        );
    }
}
