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

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TICK: Duration = Duration::from_millis(200);
/// Heal / restart can afford a longer wait.
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
/// Cmd+Q: brief grace for SIGTERM before SIGKILL + wait (reap).
const EXIT_CHILD_GRACE: Duration = Duration::from_millis(500);
const INTROSPECT_ENV: &str = "TEAMCLU_INTROSPECT_BIN";
const CURSOR_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CURSOR_BRIDGE_MAIN";
const CLAUDE_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CLAUDE_BRIDGE_MAIN";
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

/// Inject the same brand env onto std and tokio commands (start/stop/status/…).
trait AmuxdBrandEnv {
    fn set_brand_env(&mut self, key: &str, value: &str);
}

impl AmuxdBrandEnv for std::process::Command {
    fn set_brand_env(&mut self, key: &str, value: &str) {
        self.env(key, value);
    }
}

impl AmuxdBrandEnv for tokio::process::Command {
    fn set_brand_env(&mut self, key: &str, value: &str) {
        self.env(key, value);
    }
}

fn apply_amuxd_brand_env_pairs<C: AmuxdBrandEnv>(cmd: &mut C, pairs: &[(&'static str, String)]) {
    for (key, value) in pairs {
        cmd.set_brand_env(key, value);
    }
}

fn apply_amuxd_brand_env<C: AmuxdBrandEnv>(cmd: &mut C) {
    apply_amuxd_brand_env_pairs(cmd, &super::branded_amuxd_env());
}

fn amuxd_pidfile_path() -> PathBuf {
    crate::commands::amuxd_run_dir().join("amuxd.pid")
}

fn amuxd_lock_path() -> PathBuf {
    crate::commands::amuxd_run_dir().join("amuxd.lock")
}

fn amuxd_pidfile_pid() -> Option<i32> {
    let body = std::fs::read_to_string(amuxd_pidfile_path()).ok()?;
    body.trim().parse::<i32>().ok().filter(|&pid| pid > 0)
}

fn amuxd_pid_is_running() -> bool {
    amuxd_pidfile_pid().is_some_and(pid_alive)
}

fn pidfile_matches_child(child: &Option<tokio::process::Child>) -> bool {
    let Some(c) = child.as_ref() else {
        return false;
    };
    let Some(id) = c.id() else {
        return false;
    };
    amuxd_pidfile_pid() == Some(id as i32)
}

fn managed_log_hint() -> String {
    let path = crate::commands::amuxd_logs_dir().join("amuxd.managed.log");
    let Ok(bytes) = std::fs::read(&path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(4096);
    let tail = String::from_utf8_lossy(&bytes[start..]);
    let tail = tail.trim();
    if tail.is_empty() {
        String::new()
    } else {
        format!("\n--- amuxd.managed.log ---\n{tail}")
    }
}

fn child_exited_before_ready_error() -> String {
    format!(
        "managed amuxd exited before becoming ready; another daemon still holds {}{}",
        amuxd_lock_path().display(),
        managed_log_hint()
    )
}

fn still_running_after_stop_error() -> String {
    let pid = amuxd_pidfile_pid()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "unknown".into());
    format!(
        "amuxd still running after stop timeout (pid {pid} at {}); refuse to spawn",
        amuxd_pidfile_path().display()
    )
}

/// Snapshot: would this state count as a successful restart?
///
/// pidfile must belong to the spawned child. `/healthz` 200 from an old
/// daemon (different pidfile PID) is never success.
fn restart_takeover_ok(
    child_pid: u32,
    child_exited: bool,
    pidfile_pid: Option<i32>,
    healthz_ok: bool,
) -> Result<(), String> {
    if child_exited {
        return Err(child_exited_before_ready_error());
    }
    match pidfile_pid {
        Some(pid) if pid == child_pid as i32 => {}
        Some(other) => {
            return Err(format!(
                "managed amuxd pidfile PID {other} does not match spawned child {child_pid}"
            ));
        }
        None => return Err("managed amuxd pidfile missing after spawn".into()),
    }
    if !healthz_ok {
        return Err("amuxd health check timed out (/v1/healthz)".into());
    }
    Ok(())
}

struct SpawnProbe {
    child_pid: Option<u32>,
    child_exited: bool,
}

fn probe_spawned_child(child: &mut Option<tokio::process::Child>) -> SpawnProbe {
    let Some(c) = child.as_mut() else {
        return SpawnProbe {
            child_pid: None,
            child_exited: true,
        };
    };
    let pid = c.id();
    match c.try_wait() {
        Ok(None) => SpawnProbe {
            child_pid: pid,
            child_exited: false,
        },
        Ok(Some(_)) | Err(_) => {
            *child = None;
            SpawnProbe {
                child_pid: pid,
                child_exited: true,
            }
        }
    }
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

async fn wait_for_amuxd_stopped(timeout: Duration) -> Result<(), String> {
    let start = std::time::Instant::now();
    while amuxd_pid_is_running() {
        if start.elapsed() >= timeout {
            return Err(still_running_after_stop_error());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
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

async fn wait_until_healthy(
    timeout: Duration,
    app_exiting: &AtomicBool,
    inner: &tokio::sync::Mutex<SupervisorInner>,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if app_exiting.load(Ordering::SeqCst) {
            return Err("amuxd supervisor is shutting down".into());
        }
        let probe = {
            let mut guard = inner.lock().await;
            probe_spawned_child(&mut guard.child)
        };
        if probe.child_exited {
            return Err(child_exited_before_ready_error());
        }
        let Some(child_pid) = probe.child_pid else {
            return Err(child_exited_before_ready_error());
        };
        let healthz_ok = daemon_healthz_ok().await;
        if restart_takeover_ok(child_pid, false, amuxd_pidfile_pid(), healthz_ok).is_ok() {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return restart_takeover_ok(child_pid, false, amuxd_pidfile_pid(), healthz_ok);
        }
        tokio::time::sleep(HEALTH_TICK).await;
    }
}

/// Blocking variant — only for the sync exit path (`shutdown_blocking`).
fn run_bundled_once(args: &[&str]) -> Result<(), String> {
    let bin = bundled_amuxd()?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.no_window().args(args);
    apply_amuxd_brand_env(&mut cmd);
    let out = cmd
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
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.no_window().args(args);
    apply_amuxd_brand_env(&mut cmd);
    let out = cmd
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
        wait_for_amuxd_stopped(STOP_TIMEOUT).await?;
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

        if child_is_alive(&mut inner.child)
            && pidfile_matches_child(&inner.child)
            && daemon_healthz_ok().await
        {
            return Ok(());
        }

        // Heal: stop any live/stale instance before (re)spawn. Must actually
        // kill the *branded* daemon — `amuxd stop` without AMUXD_HOME hits
        // ~/.amuxd and leaves ~/.amuxd-<brand> running.
        stop_with_child_fallback_async(&mut inner, STOP_TIMEOUT).await;
        wait_for_amuxd_stopped(STOP_TIMEOUT).await?;

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
        // state under ~/.amuxd-<brand> (official keeps ~/.amuxd). Same helper
        // as stop/status/init so we never hand-write a different env set.
        apply_amuxd_brand_env(&mut cmd);
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

        if let Err(e) = wait_until_healthy(HEALTH_TIMEOUT, &state.app_exiting, &state.inner).await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{branded_amuxd_env_for, APP_SCHEME_ENV};
    use crate::test_home::HomeGuard;

    fn env_lookup<'a>(pairs: &'a [(&'static str, String)], key: &str) -> Option<&'a str> {
        pairs
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }

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

    #[test]
    fn stop_brand_env_uses_branded_home() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = HomeGuard::set(tmp.path());
        let pairs = branded_amuxd_env_for("teamclaw", "TeamClaw", "teamclu");
        let home = env_lookup(&pairs, teamclu_runtime_env::AMUXD_HOME_ENV).unwrap();
        assert!(
            home.ends_with(".amuxd-teamclaw"),
            "AMUXD_HOME should be branded, got {home}"
        );
        assert_eq!(
            env_lookup(&pairs, teamclu_runtime_env::BRAND_SHORT_NAME_ENV),
            Some("teamclaw")
        );
        assert_eq!(env_lookup(&pairs, APP_SCHEME_ENV), Some("teamclu"));
        assert!(pairs
            .iter()
            .any(|(k, _)| *k == teamclu_runtime_env::APP_DISPLAY_NAME_ENV));
    }

    #[cfg(unix)]
    fn capture_brand_env(cmd_kind: &str, pairs: &[(&'static str, String)]) -> String {
        let script = "printf '%s' \"$AMUXD_HOME|$TEAMCLU_BRAND_SHORT_NAME|$TEAMCLU_APP_SCHEME\"";
        match cmd_kind {
            "sync" => {
                let mut cmd = std::process::Command::new("sh");
                cmd.args(["-c", script]);
                apply_amuxd_brand_env_pairs(&mut cmd, pairs);
                let out = cmd.output().expect("sync sh");
                assert!(
                    out.status.success(),
                    "stderr={}",
                    String::from_utf8_lossy(&out.stderr)
                );
                String::from_utf8_lossy(&out.stdout).into_owned()
            }
            "async" => {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    let mut cmd = tokio::process::Command::new("sh");
                    cmd.args(["-c", script]);
                    apply_amuxd_brand_env_pairs(&mut cmd, pairs);
                    let out = cmd.output().await.expect("async sh");
                    assert!(
                        out.status.success(),
                        "stderr={}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                    String::from_utf8_lossy(&out.stdout).into_owned()
                })
            }
            other => panic!("unknown cmd_kind {other}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_uses_branded_home_on_sync_and_async_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = HomeGuard::set(tmp.path());
        let pairs = branded_amuxd_env_for("teamclaw", "TeamClaw", "teamclu");
        let sync_out = capture_brand_env("sync", &pairs);
        let async_out = capture_brand_env("async", &pairs);
        for out in [&sync_out, &async_out] {
            let parts: Vec<&str> = out.split('|').collect();
            assert_eq!(parts.len(), 3, "{out}");
            assert!(
                parts[0].ends_with(".amuxd-teamclaw"),
                "AMUXD_HOME={}",
                parts[0]
            );
            assert_eq!(parts[1], "teamclaw");
            assert_eq!(parts[2], "teamclu");
        }
        assert_eq!(sync_out, async_out);
    }

    #[test]
    fn different_brands_do_not_share_amuxd_home() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = HomeGuard::set(tmp.path());
        let teamclaw = branded_amuxd_env_for("teamclaw", "TeamClaw", "teamclu");
        let other = branded_amuxd_env_for("copilot361", "Copilot361", "copilot361");
        let home_a = env_lookup(&teamclaw, teamclu_runtime_env::AMUXD_HOME_ENV).unwrap();
        let home_b = env_lookup(&other, teamclu_runtime_env::AMUXD_HOME_ENV).unwrap();
        assert_ne!(home_a, home_b);
        assert!(home_a.ends_with(".amuxd-teamclaw"), "{home_a}");
        assert!(home_b.ends_with(".amuxd-copilot361"), "{home_b}");
        // A stop targeted at brand A cannot address brand B's lock/pidfile.
        assert!(!home_a.starts_with(home_b) && !home_b.starts_with(home_a));
    }

    #[test]
    fn lock_conflict_child_exit_is_restart_err_not_healthz_success() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = HomeGuard::set(tmp.path());
        let err = restart_takeover_ok(200, true, Some(100), true).expect_err("must not Ok");
        assert!(err.contains("exited before becoming ready"), "{err}");
        assert!(err.contains("amuxd.lock"), "{err}");
        assert!(
            err.contains("amuxd-") || err.contains("/amuxd/") || err.contains(".amuxd"),
            "lock path should be under branded/official amuxd home: {err}"
        );
    }

    #[test]
    fn pidfile_mismatch_with_healthz_is_not_success() {
        let err = restart_takeover_ok(200, false, Some(100), true)
            .expect_err("old pidfile + healthz 200 must not succeed");
        assert!(err.contains("does not match spawned child 200"), "{err}");
        assert!(err.contains("100"), "{err}");
    }

    #[test]
    fn happy_path_branded_restart_takeover() {
        restart_takeover_ok(200, false, Some(200), true)
            .expect("matching pidfile + live child + healthz must succeed");
    }

    #[tokio::test]
    async fn old_daemon_still_alive_after_stop_is_err_and_does_not_spawn() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = HomeGuard::set(tmp.path());
        let run_dir = crate::commands::amuxd_run_dir();
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(run_dir.join("amuxd.pid"), std::process::id().to_string()).unwrap();

        let err = wait_for_amuxd_stopped(Duration::from_millis(250))
            .await
            .expect_err("live branded pidfile must fail stop wait");
        assert!(err.contains("still running"), "{err}");
        assert!(err.contains("refuse to spawn"), "{err}");
        // Gate used by ensure_started_locked: `wait_for_amuxd_stopped(...).await?`
        // happens before spawn. An Err here is the "do not spawn" proof.
        assert!(matches!(
            wait_for_amuxd_stopped(Duration::from_millis(0)).await,
            Err(_)
        ));
    }
}
