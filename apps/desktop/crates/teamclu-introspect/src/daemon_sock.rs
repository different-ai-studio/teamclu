//! Talk to amuxd over its control socket.
//!
//! `send_channel_message` has two ways to address a chat. Explicit `channel` +
//! `target` it can resolve itself, from the workspace's own channel config. A
//! `reply_token` it cannot: the token is derived from a binding and salted with
//! the device id, and only the daemon holds the registry that maps it back
//! (`channels::reply_token`). So a token-addressed send is forwarded to amuxd
//! rather than resolved here.
//!
//! That is also what makes it work unattended. The rest of this sidecar reaches
//! the desktop app on `--api-port`; a cron run at 3am has no desktop app, but it
//! does have the daemon that started it.
//!
//! This used to be a separate MCP server of its own (`amuxd mcp-server`,
//! registered as `amuxd-send`), which meant two servers, two stdio children and
//! two send tools in front of the model for one job.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// `--sock` when given, else `<amuxd home>/run/amuxd.sock`.
pub fn resolve_sock_path(configured: &str) -> PathBuf {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        return PathBuf::from(trimmed);
    }
    // Not hand-assembled: the fallback used to hardcode `~/.amuxd`, which is
    // the wrong directory on a branded build — the daemon writes its socket
    // under the brand's home, so introspect would look for it somewhere the
    // daemon never puts it.
    teamclu_runtime_env::amuxd_home_from_env()
        .join("run")
        .join("amuxd.sock")
}

#[cfg(unix)]
fn roundtrip(sock_path: &Path, line: &str) -> std::io::Result<String> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(sock_path)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    write_line_read_line(&mut stream, line)
}

/// Named-pipe client: opening the pipe path as a file gives a byte-mode duplex
/// stream. ERROR_PIPE_BUSY (231) means every server instance is taken — retry
/// briefly, the way WaitNamedPipe would.
#[cfg(windows)]
fn roundtrip(sock_path: &Path, line: &str) -> std::io::Result<String> {
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..50 {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(sock_path)
        {
            Ok(mut file) => return write_line_read_line(&mut file, line),
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

/// One line out, one line back. Read byte by byte on the raw stream rather than
/// through a `BufReader`, so the writer half stays alive for the daemon's reply.
fn write_line_read_line<S: Read + Write>(stream: &mut S, line: &str) -> std::io::Result<String> {
    stream.write_all(line.as_bytes())?;
    if !line.ends_with('\n') {
        stream.write_all(b"\n")?;
    }
    stream.flush()?;

    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                out.push(byte[0]);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Forward a token-addressed send to amuxd (`cmd: "mcp-send"`).
///
/// `target` / `channel` stay optional overrides: the token already selects a
/// destination, and these narrow it within that binding.
pub async fn send_via_daemon(
    sock: PathBuf,
    reply_token: String,
    message: Option<String>,
    file_path: Option<String>,
    target: Option<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let mut payload = json!({
        "cmd": "mcp-send",
        // Routing comes from the token. These two are carried because the
        // daemon logs them; an empty value is what a non-session caller has.
        "session_id": "",
        "binding": "",
        "reply_token": reply_token,
    });
    if let Some(m) = message {
        payload["message"] = json!(m);
    }
    if let Some(f) = file_path {
        payload["file_path"] = json!(f);
    }
    if let Some(t) = target {
        payload["target_override"] = json!(t);
    }
    if let Some(c) = channel {
        payload["channel_override"] = json!(c);
    }

    let line = payload.to_string();
    // Blocking socket I/O off the async runtime's worker threads.
    let raw = tokio::task::spawn_blocking(move || roundtrip(&sock, &line))
        .await
        .map_err(|e| format!("send task failed: {e}"))?
        .map_err(|e| format!("amuxd.sock roundtrip failed: {e} — is the daemon running?"))?;

    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("amuxd returned a non-JSON reply ({e}): {raw}"))?;
    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let reason = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("amuxd refused the send: {reason}"));
    }
    Ok(parsed)
}

/// Forward managed skill create/update/get to amuxd (`cmd: "skills-manage"`).
pub async fn skills_manage_via_daemon(sock: PathBuf, payload: Value) -> Result<Value, String> {
    let mut body = payload;
    if body.get("cmd").is_none() {
        body["cmd"] = json!("skills-manage");
    }
    let line = body.to_string();
    let raw = tokio::task::spawn_blocking(move || roundtrip(&sock, &line))
        .await
        .map_err(|e| format!("skills manage task failed: {e}"))?
        .map_err(|e| format!("amuxd.sock roundtrip failed: {e} — is the daemon running?"))?;

    serde_json::from_str(&raw)
        .map_err(|e| format!("amuxd returned a non-JSON reply ({e}): {raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_sock_wins_over_the_derived_one() {
        assert_eq!(
            resolve_sock_path("/tmp/custom.sock"),
            PathBuf::from("/tmp/custom.sock")
        );
        assert_eq!(
            resolve_sock_path("  /tmp/x.sock "),
            PathBuf::from("/tmp/x.sock")
        );
    }

    #[test]
    fn an_empty_sock_falls_back_under_the_amuxd_home() {
        let derived = resolve_sock_path("");
        assert!(
            derived.ends_with("run/amuxd.sock"),
            "got {}",
            derived.display()
        );
    }
}
