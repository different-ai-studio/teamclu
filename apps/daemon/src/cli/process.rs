use crate::config::DaemonConfig;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct DaemonLockGuard {
    file: File,
}

impl Drop for DaemonLockGuard {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// Send a single-line control command to a running amuxd via its control
/// endpoint (Unix socket on unix, named pipe on Windows).
pub fn send_control(sock_path: &Path, cmd: &str) -> anyhow::Result<()> {
    let mut s = connect_control(sock_path)?;
    s.write_all(format!("{cmd}\n").as_bytes())?;
    Ok(())
}

/// Open a synchronous client connection to the daemon's control endpoint.
#[cfg(unix)]
pub(crate) fn connect_control(sock_path: &Path) -> std::io::Result<UnixStream> {
    UnixStream::connect(sock_path)
}

/// Named-pipe client: opening the pipe path as a file gives a byte-mode
/// duplex stream. ERROR_PIPE_BUSY (231) means every server instance is
/// taken — retry briefly, like WaitNamedPipe would.
#[cfg(windows)]
pub(crate) fn connect_control(sock_path: &Path) -> std::io::Result<File> {
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..50 {
        match OpenOptions::new().read(true).write(true).open(sock_path) {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "amuxd control pipe busy",
    ))
}

/// How long `start` waits for a previous instance to release the singleton
/// lock before giving up. A graceful restart — very common under the launchd
/// `KeepAlive` job, whose async `bootout` overlaps the new `RunAtLoad` start —
/// briefly has the dying instance still holding the flock. Failing fast there
/// makes the new process exit "already running", which `KeepAlive` then
/// respawns into a flapping loop with no HTTP listener up, so the desktop
/// onboarding probe fails and shows "amuxd 启动失败". Waiting it out instead
/// lets the new instance take over once the old one finishes shutting down.
const LOCK_WAIT: Duration = Duration::from_secs(10);
const LOCK_POLL: Duration = Duration::from_millis(100);

pub fn acquire_daemon_lock() -> anyhow::Result<DaemonLockGuard> {
    acquire_daemon_lock_at(&DaemonConfig::lock_path(), LOCK_WAIT)
}

pub(crate) fn acquire_daemon_lock_at(
    path: &Path,
    wait: Duration,
) -> anyhow::Result<DaemonLockGuard> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // lock file is just an flock target; never clobber it
        .open(path)?;

    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(DaemonLockGuard { file }),
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(err)) => return Err(err.into()),
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "amuxd is already running (lock held at {}). Use `amuxd status` or `amuxd stop`.",
                path.display()
            );
        }
        std::thread::sleep(LOCK_POLL);
    }
}

/// Write `std::process::id()` to `DaemonConfig::pid_path()`. Called from
/// `start` so `status` and `stop` can find the running daemon.
pub fn write_pidfile() -> anyhow::Result<()> {
    let path = DaemonConfig::pid_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, std::process::id().to_string())?;
    Ok(())
}

/// Best-effort cleanup; called on SIGTERM/SIGINT. Swallows errors.
pub fn remove_pidfile() {
    let _ = fs::remove_file(DaemonConfig::pid_path());
}

/// Read the recorded pid, or `Ok(None)` if no pidfile exists.
pub(crate) fn read_pidfile_for_service() -> anyhow::Result<Option<(i32, PathBuf)>> {
    read_pidfile()
}

/// Read the recorded pid, or `Ok(None)` if no pidfile exists.
fn read_pidfile() -> anyhow::Result<Option<(i32, PathBuf)>> {
    let path = DaemonConfig::pid_path();
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(&path)?;
    let pid: i32 = body
        .trim()
        .parse()
        .map_err(|e| anyhow::anyhow!("bad pid in {}: {e}", path.display()))?;
    Ok(Some((pid, path)))
}

/// True when the pid exists *and* is not a zombie.
///
/// `kill(pid, 0)` succeeds for zombies on macOS/Linux, which made `amuxd stop`
/// spin until timeout after the daemon had already exited (parent still holding
/// the Child handle). Treat zombies as not alive so stop returns immediately.
#[cfg(unix)]
fn is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    !is_zombie(pid)
}

#[cfg(unix)]
fn is_zombie(pid: i32) -> bool {
    // Linux: /proc/<pid>/stat state field.
    if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
        // Format: "pid (comm) STATE ..." — comm may contain spaces/parens.
        if let Some(close) = stat.rfind(')') {
            let rest = stat[close + 1..].trim_start();
            return rest.starts_with('Z');
        }
    }
    // macOS (and fallback): `ps -o state=` → "Z" / "Z+" etc.
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

/// OpenProcess + GetExitCodeProcess == STILL_ACTIVE. PROCESS_QUERY_LIMITED_INFORMATION
/// succeeds across elevation boundaries that full query rights would not.
#[cfg(windows)]
pub(crate) fn pid_is_alive(pid: i32) -> bool {
    is_alive(pid)
}

#[cfg(unix)]
pub(crate) fn pid_is_alive(pid: i32) -> bool {
    is_alive(pid)
}

/// OpenProcess + GetExitCodeProcess == STILL_ACTIVE. PROCESS_QUERY_LIMITED_INFORMATION
/// succeeds across elevation boundaries that full query rights would not.
#[cfg(windows)]
fn is_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return false;
    }
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

pub fn run_status() -> anyhow::Result<()> {
    match read_pidfile()? {
        None => {
            println!(
                "amuxd: not running (no pidfile at {}).",
                DaemonConfig::pid_path().display()
            );
        }
        Some((pid, path)) => {
            if is_alive(pid) {
                println!("amuxd: running (pid {})", pid);
            } else {
                println!("amuxd: stale pidfile — recorded pid {pid} is not alive.");
                println!("       Removing {}.", path.display());
                let _ = fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

pub fn run_stop() -> anyhow::Result<()> {
    match read_pidfile()? {
        None => {
            println!("amuxd: not running (no pidfile).");
            finalize_stop();
            return Ok(());
        }
        Some((pid, path)) if !is_alive(pid) => {
            println!("amuxd: recorded pid {pid} is not alive; clearing stale state.");
            let _ = fs::remove_file(&path);
            finalize_stop();
            return Ok(());
        }
        Some((pid, _path)) => {
            request_graceful_stop(pid)?;

            // Keep this short: desktop Cmd+Q runs `amuxd stop` on the UI thread.
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if !is_alive(pid) {
                    finalize_stop();
                    println!("amuxd: stopped.");
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(50));
            }

            // Last resort: managed child trees first (their process groups),
            // then the daemon itself (its own process group when it is leader).
            println!("amuxd: still running after 3s; force-stopping managed trees then daemon…");
            reap_managed_agent_trees();
            force_stop_daemon(pid);
            let force_deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < force_deadline && is_alive(pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            finalize_stop();
            if is_alive(pid) {
                anyhow::bail!(
                    "amuxd pid {pid} still alive after force stop; check process manually"
                );
            }
            println!("amuxd: force-stopped.");
            Ok(())
        }
    }
}

/// Remove pid / sock / http.port so the next `amuxd start` is not confused by
/// stale discovery files. Does **not** remove `amuxd.lock` (flock target).
pub fn cleanup_runtime_artifacts() {
    let _ = fs::remove_file(DaemonConfig::pid_path());
    #[cfg(unix)]
    {
        let _ = fs::remove_file(DaemonConfig::sock_path());
    }
    let _ = fs::remove_file(DaemonConfig::http_port_path());
}

/// Kill leftover `opencode serve` process group (and best-effort MCP) so a
/// prior crashed/hard-killed daemon cannot block the next start.
pub fn reap_managed_agent_trees() {
    crate::runtime::opencode_http::process_registry::ServeProcessRegistry::default().reap_all();
    #[cfg(unix)]
    {
        // Read compatibility for the pre-registry single-PGID file. New serve
        // generations only write opencode-pgids.json.
        reap_opencode_pgid_file();
        reap_remote_tools_mcp_best_effort();
    }
    #[cfg(windows)]
    {
        // Read compatibility for the pre-registry single-PID file.
        reap_opencode_pid_file_windows();
    }
}

/// Reap process groups left by a previously hard-killed daemon.
///
/// The caller must hold the daemon singleton lock so this cannot signal serve
/// generations owned by another live daemon.
pub fn prepare_daemon_start() {
    reap_managed_agent_trees();
}

fn finalize_stop() {
    reap_managed_agent_trees();
    cleanup_runtime_artifacts();
}

#[cfg(unix)]
fn cmdline_of(pid: i32) -> Option<String> {
    fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|s| s.replace('\0', " "))
        .or_else(|| read_macos_cmdline(pid))
}

#[cfg(unix)]
fn looks_like_opencode_serve(cmdline: &str) -> bool {
    let lower = cmdline.to_ascii_lowercase();
    lower.contains("opencode") && lower.contains("serve")
}

/// True when any live member of `pgid` has a cmdline that looks like part of
/// the managed opencode serve tree (the serve leader or an MCP child it
/// spawned). Guards group-kill against PGID reuse when the leader is gone.
#[cfg(unix)]
fn group_has_managed_member(pgid: i32) -> bool {
    let Ok(out) = std::process::Command::new("pgrep")
        .args(["-g", &pgid.to_string()])
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<i32>().ok())
        .any(|pid| {
            cmdline_of(pid).is_some_and(|cmd| {
                let lower = cmd.to_ascii_lowercase();
                looks_like_opencode_serve(&cmd) || lower.contains("remote-tools-mcp")
            })
        })
}

#[cfg(unix)]
fn reap_opencode_pgid_file() {
    let path = DaemonConfig::opencode_serve_pgid_path();
    let Ok(body) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(pgid) = body.trim().parse::<i32>() else {
        let _ = fs::remove_file(&path);
        return;
    };
    if pgid <= 1 {
        let _ = fs::remove_file(&path);
        return;
    }
    // Identity check before signaling the whole group (PID/PGID reuse safety).
    match cmdline_of(pgid) {
        Some(cmd) if looks_like_opencode_serve(&cmd) => {}
        Some(cmd) => {
            println!("amuxd: refusing to reap pgid {pgid}: cmdline is not opencode serve ({cmd})");
            let _ = fs::remove_file(&path);
            return;
        }
        None if !is_alive(pgid) => {
            // Leader is dead, but MCP children in the same group may survive
            // (e.g. the daemon reaped the leader before the group finished
            // dying). Only reap when a surviving member is verifiably ours.
            if !(process_group_alive(pgid) && group_has_managed_member(pgid)) {
                let _ = fs::remove_file(&path);
                return;
            }
            println!("amuxd: opencode serve leader {pgid} is gone but group members remain");
        }
        None => {
            println!("amuxd: refusing to reap pgid {pgid}: cannot verify process identity");
            let _ = fs::remove_file(&path);
            return;
        }
    }
    println!("amuxd: reaping opencode serve process group {pgid}…");
    kill_process_group(pgid, libc::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && process_group_alive(pgid) {
        std::thread::sleep(Duration::from_millis(50));
    }
    if process_group_alive(pgid) {
        // Re-check identity before SIGKILL.
        if cmdline_of(pgid)
            .as_deref()
            .is_some_and(looks_like_opencode_serve)
            || !is_alive(pgid)
        {
            kill_process_group(pgid, libc::SIGKILL);
        }
    }
    let _ = fs::remove_file(&path);
}

/// MCP children that escaped the serve PG still hold our sock path in argv.
#[cfg(unix)]
fn reap_remote_tools_mcp_best_effort() {
    let sock = DaemonConfig::sock_path();
    let sock_s = sock.to_string_lossy();
    let Ok(output) = std::process::Command::new("pgrep")
        .args(["-f", "remote-tools-mcp"])
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(pid) = line.trim().parse::<i32>() else {
            continue;
        };
        if pid <= 1 || !is_alive(pid) {
            continue;
        }
        let Some(cmdline) = cmdline_of(pid) else {
            continue;
        };
        let lower = cmdline.to_ascii_lowercase();
        // Require both the MCP subcommand and our sock — avoid killing unrelated MCP.
        if !lower.contains("remote-tools-mcp") || !cmdline.contains(sock_s.as_ref()) {
            continue;
        }
        if !(lower.contains("amuxd") || lower.contains("teamclu")) {
            continue;
        }
        println!("amuxd: reaping leftover remote-tools-mcp pid {pid}…");
        unsafe {
            let _ = libc::kill(pid, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(100));
        if is_alive(pid) {
            unsafe {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
fn read_macos_cmdline(pid: i32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn reap_opencode_pid_file_windows() {
    use crate::process_util::CommandNoWindow;
    let path = DaemonConfig::opencode_serve_pgid_path();
    let Ok(body) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(pid) = body.trim().parse::<i32>() else {
        let _ = fs::remove_file(&path);
        return;
    };
    if pid <= 0 || !is_alive(pid) {
        let _ = fs::remove_file(&path);
        return;
    }
    // Verify image name looks like opencode before taskkill /T.
    let verified = std::process::Command::new("tasklist")
        .no_window()
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).to_ascii_lowercase();
            if s.contains("opencode") {
                Some(())
            } else {
                None
            }
        });
    if verified.is_none() {
        println!("amuxd: refusing to taskkill pid {pid}: not an opencode process");
        let _ = fs::remove_file(&path);
        return;
    }
    println!("amuxd: taskkill /T opencode tree pid {pid}…");
    let _ = std::process::Command::new("taskkill")
        .no_window()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    let _ = fs::remove_file(&path);
}

#[cfg(unix)]
fn kill_process_group(pgid: i32, sig: i32) {
    if pgid <= 1 {
        return;
    }
    unsafe {
        let _ = libc::kill(-pgid, sig);
    }
}

#[cfg(unix)]
fn process_group_alive(pgid: i32) -> bool {
    // kill(-pgid, 0) succeeds if any member of the group is alive.
    if pgid <= 1 {
        return false;
    }
    unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(unix)]
fn force_stop_daemon(pid: i32) {
    unsafe {
        let pgid = libc::getpgid(pid);
        // Only group-kill when the daemon is its own process-group leader
        // (desktop-managed spawn sets this). Otherwise kill the pid alone —
        // never signal a shared shell/session group.
        if pgid == pid {
            println!("amuxd: SIGKILL process group {pgid}…");
            let _ = libc::kill(-pid, libc::SIGKILL);
        }
        let _ = libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn force_stop_daemon(pid: i32) {
    use crate::process_util::CommandNoWindow;

    let _ = std::process::Command::new("taskkill")
        .no_window()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(unix)]
fn request_graceful_stop(pid: i32) -> anyhow::Result<()> {
    println!("amuxd: sending SIGTERM to pid {pid}…");
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let err = std::io::Error::last_os_error();
        anyhow::bail!("kill({pid}, SIGTERM) failed: {err}");
    }
    Ok(())
}

/// Windows has no SIGTERM. Ask the daemon to exit via its own control
/// command (handled as SockCommand::Shutdown in the main loop).
#[cfg(windows)]
fn request_graceful_stop(pid: i32) -> anyhow::Result<()> {
    let _ = pid;
    println!("amuxd: sending shutdown command…");
    if let Err(e) = send_control(&DaemonConfig::sock_path(), "shutdown") {
        anyhow::bail!("control pipe unavailable ({e})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn daemon_start_preparation_reaps_a_leftover_registered_group() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;

        let _home_guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_home = std::env::var_os("HOME");
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        let binary = home.path().join("opencode");
        std::fs::write(&binary, "#!/bin/sh\nsleep 30\n").unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();

        let mut child = std::process::Command::new(&binary)
            .arg("serve")
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id();
        crate::runtime::opencode_http::process_registry::ServeProcessRegistry::default()
            .register("previous-daemon", pgid)
            .unwrap();
        prepare_daemon_start();

        // Reap the test-owned leader before checking the process group. On
        // Linux, dropping Child without wait leaves a zombie for the duration
        // of the test process, and kill(-pgid, 0) reports zombies as alive.
        let _ = child.wait();

        assert!(
            !process_group_alive(i32::try_from(pgid).unwrap()),
            "start preparation must reap the previous daemon's serve group"
        );
        assert!(
            crate::runtime::opencode_http::process_registry::ServeProcessRegistry::default()
                .snapshot()
                .is_empty(),
            "reaped groups must be removed from the registry"
        );

        match previous_home {
            Some(home) => unsafe { std::env::set_var("HOME", home) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[test]
    fn daemon_lock_is_exclusive_until_guard_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        // wait=0 ⇒ fail fast when contended (the historical behavior).
        let first =
            acquire_daemon_lock_at(&lock_path, Duration::ZERO).expect("first lock should succeed");
        let second = acquire_daemon_lock_at(&lock_path, Duration::ZERO);
        assert!(second.is_err(), "second lock should be rejected");

        drop(first);

        acquire_daemon_lock_at(&lock_path, Duration::ZERO)
            .expect("lock should be available after guard drop");
    }

    #[test]
    fn daemon_lock_waits_for_a_releasing_holder() {
        // Regression: a graceful restart races the dying instance's lock. The
        // new acquirer must poll and take over once the holder releases, not
        // bail "already running" the way the old non-blocking flock did.
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        let held = acquire_daemon_lock_at(&lock_path, Duration::ZERO).expect("hold lock");

        let release_path = lock_path.clone();
        let waiter = std::thread::spawn(move || {
            // Generous window; the holder releases well within it.
            acquire_daemon_lock_at(&release_path, Duration::from_secs(5))
        });

        // Let the waiter start polling, then release the lock.
        std::thread::sleep(Duration::from_millis(300));
        drop(held);

        waiter
            .join()
            .expect("waiter thread panicked")
            .expect("waiter should acquire the lock once it is released");
    }

    #[test]
    fn daemon_lock_times_out_when_holder_never_releases() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("amuxd.lock");

        let _held = acquire_daemon_lock_at(&lock_path, Duration::ZERO).expect("hold lock");
        let start = Instant::now();
        let contended = acquire_daemon_lock_at(&lock_path, Duration::from_millis(300));
        assert!(contended.is_err(), "should give up once the wait elapses");
        assert!(
            start.elapsed() >= Duration::from_millis(300),
            "should have waited out the full window before failing"
        );
    }
}
