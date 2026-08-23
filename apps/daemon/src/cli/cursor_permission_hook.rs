//! `amuxd cursor-permission-hook` — the Cursor `preToolUse` gate.
//!
//! Spawned by `@cursor/sdk` once per tool call (see
//! `runtime/cursor_sdk/hooks.rs`). Reads the hook request as JSON on stdin,
//! asks amuxd over `amuxd.sock`, and writes the SDK's response body on stdout:
//!
//! ```json
//! { "permission": "allow" }
//! { "permission": "deny", "user_message": "...", "agent_message": "..." }
//! ```
//!
//! Fail-open by design: any transport problem prints `allow` and exits 0. The
//! daemon is what blocks on the human, so this process can sit for minutes —
//! its ceiling is the `timeout` we write into `hooks.json`.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

/// Longer than the daemon's own resolve timeout so the daemon, not the socket
/// read, is what decides an unanswered request.
const SOCK_TIMEOUT: Duration =
    Duration::from_secs(crate::runtime::cursor_sdk::hooks::HOOK_TIMEOUT_SECS);

pub fn run(sock_path: &Path, worktree: &str) -> anyhow::Result<()> {
    let mut body = String::new();
    std::io::stdin().read_to_string(&mut body)?;
    let response = decide(sock_path, worktree, &body);

    let mut stdout = std::io::stdout();
    writeln!(stdout, "{response}")?;
    stdout.flush()?;
    Ok(())
}

fn allow() -> Value {
    json!({ "permission": "allow" })
}

fn decide(sock_path: &Path, worktree: &str, stdin_body: &str) -> Value {
    let request: Value = match serde_json::from_str(stdin_body.trim()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[amuxd cursor-permission-hook] unparseable request: {e}");
            return allow();
        }
    };

    let payload = json!({
        "cmd": "cursor-permission",
        "worktree": worktree,
        "request": request,
    });

    let raw = match super::sock::sock_roundtrip_with_read_timeout(
        sock_path,
        &payload.to_string(),
        SOCK_TIMEOUT,
    ) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("[amuxd cursor-permission-hook] amuxd.sock failed: {e}");
            return allow();
        }
    };

    parse_reply(&raw)
}

/// `{ "ok": true, "result": { "permission": ... } }` → the hook body. Anything
/// else (malformed, `ok:false`, missing result) allows.
fn parse_reply(raw: &str) -> Value {
    let parsed: Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[amuxd cursor-permission-hook] bad daemon reply: {e}");
            return allow();
        }
    };
    if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        eprintln!("[amuxd cursor-permission-hook] daemon error: {err}");
        return allow();
    }
    match parsed.get("result") {
        Some(result) if result.get("permission").is_some() => result.clone(),
        _ => allow(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reply_passes_a_deny_through() {
        let body =
            parse_reply(r#"{"ok":true,"result":{"permission":"deny","user_message":"nope"}}"#);
        assert_eq!(body["permission"], json!("deny"));
        assert_eq!(body["user_message"], json!("nope"));
    }

    #[test]
    fn parse_reply_fails_open_on_every_bad_shape() {
        for raw in [
            "not json",
            r#"{"ok":false,"error":"boom"}"#,
            r#"{"ok":true}"#,
            r#"{"ok":true,"result":{}}"#,
        ] {
            assert_eq!(parse_reply(raw)["permission"], json!("allow"), "raw={raw}");
        }
    }

    #[test]
    fn unparseable_stdin_fails_open_without_touching_the_socket() {
        let body = decide(Path::new("/nonexistent.sock"), "/w", "}{");
        assert_eq!(body["permission"], json!("allow"));
    }

    #[test]
    fn unreachable_daemon_fails_open() {
        let body = decide(
            Path::new("/nonexistent/amuxd.sock"),
            "/w",
            r#"{"tool_name":"shell","tool_input":{"command":"ls"}}"#,
        );
        assert_eq!(body["permission"], json!("allow"));
    }
}
