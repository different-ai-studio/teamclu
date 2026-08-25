//! The desktop's client for amuxd's control endpoint.
//!
//! amuxd serves one line/JSON protocol on a Unix socket (`run/amuxd.sock`) or,
//! on Windows, a named pipe — `spawn_sock_listener` has an arm for each, and
//! they speak the same words. The desktop only ever learned the Unix half, so
//! every command that needed the daemon answered "amuxd daemon is not available
//! on Windows" (#1049) — a sentence that was never true. The daemon was
//! listening the whole time; nothing here knew how to knock.
//!
//! Two flavours, because the callers genuinely differ: the settings panel does
//! short blocking round-trips, while cron's `prompt-await` waits out a whole
//! agent turn and has to stay async. They share the endpoint and the connect
//! rules, which is the part that was wrong.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where amuxd listens — the same derivation the daemon binds with, from the
/// crate both sides already share for every other amuxd path.
pub fn endpoint() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::control_endpoint(&super::amuxd_home_dir())
}

/// Windows: every pipe instance is busy right now. The daemon creates the next
/// instance immediately after accepting, so the window is short — but it is
/// real, and the documented client behaviour is to wait rather than fail.
#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;

/// How long to keep retrying a busy pipe before giving up.
#[cfg(windows)]
const BUSY_RETRY_BUDGET: Duration = Duration::from_secs(2);

#[cfg(windows)]
const BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(20);

/// An open control connection for blocking round-trips.
#[cfg(unix)]
type BlockingStream = std::os::unix::net::UnixStream;

/// A named pipe opened in byte mode is just a file handle, which is exactly the
/// `Read + Write` the Unix socket gave us.
#[cfg(windows)]
type BlockingStream = std::fs::File;

#[cfg(unix)]
fn connect_blocking(endpoint: &Path) -> Result<BlockingStream, String> {
    let stream = BlockingStream::connect(endpoint)
        .map_err(|e| format!("amuxd not reachable at {}: {e}", endpoint.display()))?;
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|e| format!("amuxd read timeout not settable: {e}"))?;
    Ok(stream)
}

#[cfg(windows)]
fn connect_blocking(endpoint: &Path) -> Result<BlockingStream, String> {
    let deadline = std::time::Instant::now() + BUSY_RETRY_BUDGET;
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(endpoint)
        {
            Ok(file) => return Ok(file),
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(BUSY_RETRY_INTERVAL);
            }
            Err(e) => {
                return Err(format!(
                    "amuxd not reachable at {}: {e}",
                    endpoint.display()
                ))
            }
        }
    }
}

/// Finish the request so the daemon can act on it.
///
/// On unix that means half-closing the write side, which is also what makes the
/// caller's read-to-EOF terminate. A named pipe has no half-close and needs
/// none: the daemon reads a single line, replies, and drops the connection, so
/// EOF arrives from its side either way.
fn finish_request(stream: &mut BlockingStream) -> Result<(), String> {
    stream.flush().map_err(|e| format!("flush failed: {e}"))?;
    #[cfg(unix)]
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|e| format!("shutdown write half failed: {e}"))?;
    Ok(())
}

/// How long to wait on a reply before giving up.
///
/// These calls run inside `#[tauri::command] async fn`s. Without a deadline a
/// wedged daemon parks a runtime worker forever — `list_wecom_chats` makes the
/// daemon do an HTTP call of its own, so "slow" is a normal outcome and "never"
/// is a reachable one. On unix this is a socket timeout; on Windows a named
/// pipe opened as a file has no equivalent, so `spawn_blocking` (below) is what
/// keeps a stuck read off the async runtime there.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Send `request` (terminate the last line with `\n` yourself) and read the
/// whole reply.
///
/// Runs the blocking round-trip on the blocking pool: every caller is an async
/// Tauri command, and before this the same work sat directly on a runtime
/// worker.
pub async fn request(request: &str) -> Result<String, String> {
    let request = request.to_string();
    tokio::task::spawn_blocking(move || request_blocking_at(&endpoint(), &request))
        .await
        .map_err(|e| format!("amuxd control task failed: {e}"))?
}

/// Send `request` and read the reply as JSON.
pub async fn request_json_async<T: serde::de::DeserializeOwned>(line: &str) -> Result<T, String> {
    let body = request(line).await?;
    serde_json::from_str(body.trim())
        .map_err(|e| format!("bad response from amuxd: {e} (body={body:?})"))
}

/// Send `request` without waiting for a reply, off the async runtime.
pub async fn send(request: &str) -> Result<(), String> {
    let request = request.to_string();
    tokio::task::spawn_blocking(move || send_blocking_at(&endpoint(), &request))
        .await
        .map_err(|e| format!("amuxd control task failed: {e}"))?
}

/// Send `request` (terminate the last line with `\n` yourself) and read the
/// whole reply. Blocking; prefer [`request`] from async code.
pub fn request_blocking(request: &str) -> Result<String, String> {
    request_blocking_at(&endpoint(), request)
}

/// [`request_blocking`] against an explicit endpoint, so tests can point at a
/// server they control.
pub fn request_blocking_at(endpoint: &Path, request: &str) -> Result<String, String> {
    let mut stream = connect_blocking(endpoint)?;
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    finish_request(&mut stream)?;
    let mut buf = String::new();
    stream
        .read_to_string(&mut buf)
        .map_err(|e| format!("read failed: {e}"))?;
    Ok(buf)
}

/// Send `request` and read the reply as JSON.
pub fn request_json<T: serde::de::DeserializeOwned>(request: &str) -> Result<T, String> {
    let body = request_blocking(request)?;
    serde_json::from_str(body.trim())
        .map_err(|e| format!("bad response from amuxd: {e} (body={body:?})"))
}

/// Send `request` without waiting for a reply — for the commands the daemon
/// acts on but does not answer (`channel-save`, `gateway-model`, `channel-reload`).
pub fn send_blocking(request: &str) -> Result<(), String> {
    send_blocking_at(&endpoint(), request)
}

/// [`send_blocking`] against an explicit endpoint.
pub fn send_blocking_at(endpoint: &Path, request: &str) -> Result<(), String> {
    let mut stream = connect_blocking(endpoint)?;
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    finish_request(&mut stream)
}

/// An open control connection for async callers.
#[cfg(unix)]
pub type AsyncStream = tokio::net::UnixStream;

#[cfg(windows)]
pub type AsyncStream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Async connect to an explicit endpoint. Taking it as a parameter is what lets
/// the cron tests point at a socket they control.
#[cfg(unix)]
pub async fn connect_at(endpoint: &Path) -> Result<AsyncStream, String> {
    AsyncStream::connect(endpoint)
        .await
        .map_err(|e| format!("amuxd unreachable at {}: {e}", endpoint.display()))
}

#[cfg(windows)]
pub async fn connect_at(endpoint: &Path) -> Result<AsyncStream, String> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let deadline = std::time::Instant::now() + BUSY_RETRY_BUDGET;
    loop {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => return Ok(client),
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && std::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(BUSY_RETRY_INTERVAL).await;
            }
            Err(e) => return Err(format!("amuxd unreachable at {}: {e}", endpoint.display())),
        }
    }
}

/// Async connect to the running daemon.
pub async fn connect() -> Result<AsyncStream, String> {
    connect_at(&endpoint()).await
}

// Unix-only: the mock server is a `UnixListener`. The Windows arm of this
// module is exercised by the compile gate in CI (`desktop-windows`) and on a
// real machine; there is no in-process way to stand up a named pipe server that
// would prove anything the daemon's own listener does not.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader as StdBufReader};
    use std::os::unix::net::UnixListener;

    /// One-shot server: accepts a connection, reads one line, optionally writes
    /// `reply`, then closes. Returns the endpoint and a handle carrying the
    /// request it saw.
    fn mock_server(reply: Option<&'static str>) -> (PathBuf, std::thread::JoinHandle<String>) {
        // macOS sun_path is ~104 bytes, so keep this short (same reason the
        // cron client's tests build their path this way). The counter keeps two
        // tests running in parallel off each other's socket.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("amxc-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = StdBufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if let Some(reply) = reply {
                let mut stream = reader.into_inner();
                stream.write_all(reply.as_bytes()).unwrap();
            }
            line
        });
        (path, handle)
    }

    #[test]
    fn a_request_reaches_the_daemon_and_the_reply_comes_back() {
        let (path, server) = mock_server(Some(r#"{"ok":true}"#));
        let body = request_blocking_at(&path, "channel-status\n").unwrap();
        assert_eq!(server.join().unwrap(), "channel-status\n");
        assert_eq!(body.trim(), r#"{"ok":true}"#);
    }

    /// The half-close is what lets a read-to-EOF finish, so a reply-less
    /// command still has to complete rather than hang on the read.
    #[test]
    fn a_fire_and_forget_command_is_delivered() {
        let (path, server) = mock_server(None);
        send_blocking_at(&path, "channel-reload\n").unwrap();
        assert_eq!(server.join().unwrap(), "channel-reload\n");
    }

    #[test]
    fn a_dead_daemon_is_an_error_not_a_hang() {
        let missing = std::env::temp_dir().join("amxc-nothing-here.sock");
        let err = request_blocking_at(&missing, "channel-status\n").unwrap_err();
        assert!(err.contains("not reachable"), "unexpected error: {err}");
    }
}
