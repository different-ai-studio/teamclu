//! Async client for amuxd's `prompt-await` command. Used by the cron scheduler
//! to drive one ACP turn per cron run.
//!
//! Connects through `commands::amuxd_control`, which speaks a Unix socket or a
//! Windows named pipe as the platform requires — these three commands used to
//! return "amuxd is not available on Windows" instead, which meant cron could
//! not run a job there at all (#1049). Async rather than blocking on purpose:
//! `prompt-await` waits out an entire agent turn.
//!
//! Spec: docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md §1, §2.

use serde::Serialize;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::commands::amuxd_control;

#[derive(Serialize)]
pub struct PromptAwaitRequest<'a> {
    pub cmd: &'static str,
    pub session_key: &'a str,
    pub message: &'a str,
    /// Human-readable name of the cron job. amuxd uses this to build the
    /// Cloud session title ("Cron: <job_name>") so the desktop UI's "view
    /// session" button on cron records resolves to a labeled chat thread.
    /// Optional — if absent amuxd falls back to "Cron job".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_override: Option<ModelOverride<'a>>,
    /// Backend the job pins, e.g. "opencode" | "claude" | "codex". When `None`
    /// the field is omitted and amuxd falls back to its `default_agent_type`
    /// (the "auto" selection). A pinned backend ensures a Claude-configured job
    /// runs on Claude even when OpenCode is the daemon default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<&'a str>,
    /// Permission mode for this run — `"full_access"` (cron default) or
    /// `"default"`. amuxd falls back to full access when the field is absent,
    /// so an older daemon paired with a newer desktop behaves the same.
    pub permission_mode: &'a str,
    pub timeout_secs: u64,
}

#[derive(Serialize)]
pub struct ModelOverride<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

#[derive(Debug)]
pub struct PromptAwaitResponse {
    pub text: String,
    /// Cloud `sessions.id` (UUID) that the agent's AgentReply was persisted
    /// under. The cron scheduler stamps this into `CronRunRecord.session_id`
    /// so the UI's "view session" button can navigate to it.
    pub session_id: String,
    /// Set when the cloud session was created but the ACP turn itself failed
    /// (e.g. timeout). The scheduler should still record `session_id` and
    /// surface the error, so the user can navigate to the partial conversation.
    pub agent_error: Option<String>,
}

/// Convenience entry point: connect to amuxd's control endpoint and run a
/// `prompt-await` round-trip.
pub async fn prompt_await(req: PromptAwaitRequest<'_>) -> Result<PromptAwaitResponse, String> {
    prompt_await_at(&amuxd_control::endpoint(), req).await
}

/// Test-friendly variant: takes the endpoint explicitly.
pub async fn prompt_await_at(
    sock_path: &Path,
    req: PromptAwaitRequest<'_>,
) -> Result<PromptAwaitResponse, String> {
    let mut stream = amuxd_control::connect_at(sock_path).await?;

    let line = serde_json::to_string(&req).map_err(|e| format!("encode request: {e}"))?;
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

    const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_RESPONSE_BYTES {
            return Err("amuxd response exceeded 16 MB".into());
        }
        match stream.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(format!("amuxd sock IO (read): {e}")),
        }
    }
    let body = String::from_utf8(buf).map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<WireResult>,
    }
    #[derive(serde::Deserialize)]
    struct WireResult {
        #[serde(default)]
        text: String,
        session_id: String,
        /// Set when the cloud session was created but the ACP turn failed
        /// (e.g. model timeout). The client receives both the error message
        /// and the session_id so the run record can still link to the
        /// partial conversation in the chat panel.
        #[serde(default)]
        agent_error: Option<String>,
    }

    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    let r = parsed
        .result
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())?;
    // agent_error means the session was created but the turn itself failed.
    if let Some(ref ae) = r.agent_error {
        return Ok(PromptAwaitResponse {
            text: String::new(),
            session_id: r.session_id,
            agent_error: Some(ae.clone()),
        });
    }
    if r.text.is_empty() {
        return Err("amuxd returned empty text".into());
    }
    Ok(PromptAwaitResponse {
        text: r.text,
        session_id: r.session_id,
        agent_error: None,
    })
}

/// Eagerly create the cloud session for a cron run via amuxd's
/// `cron-prepare-session` command, returning the cloud `sessions.id`. This is
/// fast (no ACP runtime spawn / turn), so the scheduler can stamp `session_id`
/// into the run record — and the desktop UI can navigate to the session —
/// within a second or two of "Run Now". The subsequent `prompt-await` for the
/// same `session_key` reuses this session.
pub async fn prepare_cron_session(
    session_key: &str,
    job_name: Option<&str>,
) -> Result<String, String> {
    prepare_cron_session_at(&amuxd_control::endpoint(), session_key, job_name).await
}

pub async fn prepare_cron_session_at(
    sock_path: &Path,
    session_key: &str,
    job_name: Option<&str>,
) -> Result<String, String> {
    let mut req = serde_json::json!({
        "cmd": "cron-prepare-session",
        "session_key": session_key,
    });
    if let Some(name) = job_name.filter(|s| !s.is_empty()) {
        req["job_name"] = serde_json::Value::String(name.to_string());
    }

    let mut stream = amuxd_control::connect_at(sock_path).await?;
    let line = serde_json::to_string(&req).map_err(|e| format!("encode request: {e}"))?;
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

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<WireResult>,
    }
    #[derive(serde::Deserialize)]
    struct WireResult {
        session_id: String,
    }

    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    parsed
        .result
        .map(|r| r.session_id)
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())
}

/// Send a proactive message through amuxd's running channel gateway.
/// `target` must use the daemon dispatch shape: `user:<id>` or `chat:<id>`.
pub async fn channel_send(channel: &str, target: &str, message: &str) -> Result<(), String> {
    channel_send_at(&amuxd_control::endpoint(), channel, target, message).await
}

pub async fn channel_send_at(
    sock_path: &Path,
    channel: &str,
    target: &str,
    message: &str,
) -> Result<(), String> {
    // `channel-send`, not `mcp-send`: this is the app announcing a run, not an
    // agent replying to anyone. The old envelope borrowed the agent path with a
    // placeholder binding, and stopped working the day that path started
    // requiring a real reply token — silently, because delivery is best-effort.
    let payload = serde_json::json!({
        "cmd": "channel-send",
        "channel": channel,
        "target": target,
        "message": message,
    });
    amuxd_json_roundtrip(sock_path, &payload).await
}

async fn amuxd_json_roundtrip(sock_path: &Path, payload: &serde_json::Value) -> Result<(), String> {
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

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    }

    let body = String::from_utf8(buf).map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;
    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    Ok(())
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

    #[tokio::test]
    async fn encodes_minimal_request_and_parses_ok_response() {
        let sock_path = mock_server(|req| {
            // Verify the request shape.
            assert_eq!(req["cmd"].as_str(), Some("prompt-await"));
            assert_eq!(req["session_key"].as_str(), Some("cron/j1/r1"));
            assert_eq!(req["message"].as_str(), Some("hi"));
            assert_eq!(req["timeout_secs"].as_u64(), Some(300));
            assert!(req.get("job_name").is_none());
            assert!(req.get("working_directory").is_none());
            assert!(req.get("model_override").is_none());
            serde_json::json!({
                "ok": true,
                "result": { "text": "hello back", "session_id": "sid-1" }
            })
            .to_string()
        })
        .await;

        let resp = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                workspace_root: None,
                model_override: None,
                agent_type: None,
                permission_mode: crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap();

        assert_eq!(resp.text, "hello back");
        assert_eq!(resp.session_id, "sid-1");
    }

    #[tokio::test]
    async fn omits_agent_type_when_none() {
        let sock_path = mock_server(|req| {
            assert!(
                req.get("agent_type").is_none(),
                "agent_type must be omitted for the 'auto' selection so amuxd \
                 falls back to default_agent_type; got: {req}"
            );
            serde_json::json!({
                "ok": true,
                "result": { "text": "ok", "session_id": "sid-auto" }
            })
            .to_string()
        })
        .await;

        prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                workspace_root: None,
                model_override: None,
                agent_type: None,
                permission_mode: crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn includes_optional_fields_when_set() {
        let sock_path = mock_server(|req| {
            assert_eq!(req["job_name"].as_str(), Some("Nightly digest"));
            assert_eq!(
                req["working_directory"].as_str(),
                Some("/repo/.worktrees/cron-j1-r1")
            );
            assert_eq!(req["workspace_root"].as_str(), Some("/repo"));
            assert_eq!(
                req["model_override"]["provider"].as_str(),
                Some("anthropic")
            );
            assert_eq!(req["model_override"]["model"].as_str(), Some("sonnet"));
            assert_eq!(req["agent_type"].as_str(), Some("claude"));
            assert_eq!(req["permission_mode"].as_str(), Some("default"));
            serde_json::json!({
                "ok": true,
                "result": { "text": "ok", "session_id": "sid-2" }
            })
            .to_string()
        })
        .await;

        prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: Some("Nightly digest"),
                working_directory: Some("/repo/.worktrees/cron-j1-r1"),
                workspace_root: Some("/repo"),
                model_override: Some(ModelOverride {
                    provider: "anthropic",
                    model: "sonnet",
                }),
                agent_type: Some("claude"),
                permission_mode: "default",
                timeout_secs: 300,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn surfaces_amuxd_error_passthrough() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({ "ok": false, "error": "no local agent runtime" }).to_string()
        })
        .await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                workspace_root: None,
                model_override: None,
                agent_type: None,
                permission_mode: crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("no local agent runtime"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_empty_text() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({
                "ok": true,
                "result": { "text": "", "session_id": "sid-3" }
            })
            .to_string()
        })
        .await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                workspace_root: None,
                model_override: None,
                agent_type: None,
                permission_mode: crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("empty text"), "got: {err}");
    }

    #[tokio::test]
    async fn surfaces_connect_failure_when_sock_missing() {
        let nowhere = PathBuf::from("/tmp/this-sock-does-not-exist-xyz");
        let err = prompt_await_at(
            &nowhere,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                workspace_root: None,
                model_override: None,
                agent_type: None,
                permission_mode: crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("amuxd unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_bad_response_shape() {
        let sock_path = mock_server(|_req| {
            // ok:true but missing result.
            serde_json::json!({ "ok": true }).to_string()
        })
        .await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                job_name: None,
                working_directory: None,
                workspace_root: None,
                model_override: None,
                agent_type: None,
                permission_mode: crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE,
                timeout_secs: 300,
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("missing result"), "got: {err}");
    }

    #[tokio::test]
    async fn prepare_cron_session_sends_request_and_parses_session_id() {
        let sock_path = mock_server(|req| {
            assert_eq!(req["cmd"].as_str(), Some("cron-prepare-session"));
            assert_eq!(req["session_key"].as_str(), Some("cron/j1/r1"));
            assert_eq!(req["job_name"].as_str(), Some("Nightly digest"));
            serde_json::json!({
                "ok": true,
                "result": { "session_id": "sid-prepared" }
            })
            .to_string()
        })
        .await;

        let sid = prepare_cron_session_at(&sock_path, "cron/j1/r1", Some("Nightly digest"))
            .await
            .unwrap();
        assert_eq!(sid, "sid-prepared");
    }

    #[tokio::test]
    async fn prepare_cron_session_omits_empty_job_name() {
        let sock_path = mock_server(|req| {
            assert!(
                req.get("job_name").is_none(),
                "empty job_name must be omitted; got: {req}"
            );
            serde_json::json!({ "ok": true, "result": { "session_id": "sid-2" } }).to_string()
        })
        .await;

        prepare_cron_session_at(&sock_path, "cron/j1/r1", Some(""))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn prepare_cron_session_surfaces_error() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({ "ok": false, "error": "no team_id" }).to_string()
        })
        .await;

        let err = prepare_cron_session_at(&sock_path, "cron/j1/r1", None)
            .await
            .unwrap_err();
        assert!(err.contains("no team_id"), "got: {err}");
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

        channel_send_at(&sock_path, "wecom", "user:alice", "hello")
            .await
            .unwrap();
    }
}
