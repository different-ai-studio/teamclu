//! Push a message (optionally with a file) through amuxd's running channel
//! gateway over the control socket (`channel-send`).
//!
//! Used by the introspect API's WeCom send. This lived in
//! `commands/cron/amuxd_client.rs` alongside the cron scheduler's
//! `prompt-await` client; cron moved into amuxd (ADR-0010) and took that
//! client's other half with it.

use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::commands::amuxd_control;

/// One optional attachment, as raw bytes plus the name to show.
pub struct ChannelSendMedia<'a> {
    pub bytes: &'a [u8],
    pub filename: &'a str,
}

/// Send through amuxd, optionally with a file.
///
/// The media path exists so the desktop stopped calling
/// `teamclu_gateway::wecom::*` directly from `introspect_api.rs` (#933): that
/// reached the chat without amuxd knowing and read credentials from the
/// workspace rather than `daemon.toml`. Costs a dependency — with amuxd down
/// this now fails instead of sending — which is the trade the issue accepts,
/// on the grounds that a message nobody can account for is worse than one that
/// visibly did not send.
pub async fn channel_send_media_at(
    sock_path: &Path,
    channel: &str,
    target: &str,
    message: &str,
    media: Option<ChannelSendMedia<'_>>,
) -> Result<(), String> {
    use base64::Engine as _;

    // `channel-send`, not `mcp-send`: this is the app announcing a run, not an
    // agent replying to anyone. The old envelope borrowed the agent path with a
    // placeholder binding, and stopped working the day that path started
    // requiring a real reply token — silently, because delivery is best-effort.
    let mut payload = serde_json::json!({
        "cmd": "channel-send",
        "channel": channel,
        "target": target,
        "message": message,
    });
    if let Some(m) = media {
        payload["media_base64"] =
            serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(m.bytes));
        payload["media_filename"] = serde_json::Value::String(m.filename.to_string());
    }
    amuxd_json_roundtrip(sock_path, &payload).await
}

async fn amuxd_json_roundtrip(sock_path: &Path, payload: &serde_json::Value) -> Result<(), String> {
    amuxd_json_call(sock_path, payload).await.map(|_| ())
}

/// One JSON line out, one JSON line back. `ok: false` becomes `Err`.
async fn amuxd_json_call(
    sock_path: &Path,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut stream = amuxd_control::connect_at(sock_path).await?;

    let line = serde_json::to_string(payload).map_err(|e| format!("encode request: {e}"))?;
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("amuxd sock IO (write): {e}"))?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|e| format!("amuxd sock IO (write nl): {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("amuxd sock IO (flush): {e}"))?;

    const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_RESPONSE_BYTES {
            return Err("amuxd response exceeded 1 MB".into());
        }
        match stream.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(format!("amuxd sock IO (read): {e}")),
        }
    }

    let body = String::from_utf8(buf).map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;
    let parsed: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let reason = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown amuxd error");
        return Err(reason.to_string());
    }
    Ok(parsed)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    /// Spawn a one-shot mock server that accepts one connection, reads one
    /// JSON line, calls `responder` to produce a reply, writes it back, and
    /// closes. Returns the sock path so the test can point the client at it.
    async fn mock_server<F>(responder: F) -> PathBuf
    where
        F: FnOnce(Value) -> String + Send + 'static,
    {
        // macOS sun_path is ~104 bytes; std::env::temp_dir() on macOS is
        // already ~50 chars, so keep the rest minimal.
        let short = &uuid::Uuid::new_v4().simple().to_string()[..12];
        let dir = PathBuf::from("/tmp").join(format!("amx-{short}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let path_clone = path.clone();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let req: Value = serde_json::from_str(line.trim()).unwrap();
            let resp = responder(req);
            let mut stream = reader.into_inner();
            stream.write_all(resp.as_bytes()).await.unwrap();
            stream.write_all(b"\n").await.unwrap();
        });
        path_clone
    }

    // Pins the envelope against the daemon's `channel-send` handler, whose
    // contract is {cmd, channel, target, message} with no reply_token. This
    // test kept asserting the old `mcp-send` shape after the impl moved off it,
    // which is how a red main reached #984.
    #[tokio::test]
    async fn channel_send_uses_the_tokenless_channel_send_command() {
        let sock_path = mock_server(|req| {
            assert_eq!(req["cmd"].as_str(), Some("channel-send"));
            assert_eq!(req["channel"].as_str(), Some("wecom"));
            assert_eq!(req["target"].as_str(), Some("user:alice"));
            assert_eq!(req["message"].as_str(), Some("hello"));
            // The whole reason this is a separate command: a cron announcement
            // has no chat behind it, so it cannot carry mcp-send's reply token.
            assert!(req.get("reply_token").is_none());
            serde_json::json!({ "ok": true, "result": {} }).to_string()
        })
        .await;

        channel_send_media_at(&sock_path, "wecom", "user:alice", "hello", None)
            .await
            .unwrap();
    }
}
