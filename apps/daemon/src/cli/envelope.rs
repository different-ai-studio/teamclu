//! The `amuxd app` output contract, for the smaller agent-facing commands
//! that are one daemon call each (`team sync`, `role`, `channel show|set`).
//!
//! One line of JSON, `{"v":1,"ok":…}`; exit 0 done, 2 arguments, 3 no
//! identity, 4 not allowed, 5 not found, 6 conflict, 7 daemon.

use serde_json::{json, Value};

pub(crate) use super::app::{emit, error_envelope};
use super::daemon_http::LocalDaemonClient;

/// A bad command line or local input, before anything is sent.
#[derive(Debug)]
pub(crate) struct Usage {
    pub code: &'static str,
    pub message: String,
    pub next: Option<String>,
}

pub(crate) fn usage(code: &'static str, message: impl Into<String>, next: Option<&str>) -> Usage {
    Usage {
        code,
        message: message.into(),
        next: next.map(str::to_owned),
    }
}

impl Usage {
    pub(crate) fn envelope(&self) -> Value {
        error_envelope(self.code, &self.message, self.next.as_deref(), 2, false)
    }
}

pub(crate) fn success(data: Value) -> Value {
    json!({ "v": 1, "ok": true, "data": data })
}

pub(crate) fn unreachable(e: impl std::fmt::Display) -> Value {
    error_envelope(
        "daemon_unreachable",
        &format!("the local amuxd did not answer: {e}"),
        Some("amuxd status"),
        7,
        true,
    )
}

/// A daemon HTTP answer as an envelope. `not_found_next` is the command that
/// lists what does exist.
pub(crate) fn http_envelope(
    outcome: anyhow::Result<Result<Value, (u16, String)>>,
    not_found_next: Option<&str>,
) -> Value {
    match outcome {
        Ok(Ok(value)) => success(value),
        // An unclaimed daemon answers team calls with a 422; it is not the
        // caller's arguments but this daemon having no team identity.
        Ok(Err((_, detail))) if detail.contains("not onboarded") => error_envelope(
            "not_onboarded",
            &detail,
            Some("amuxd init <invite-url>"),
            3,
            false,
        ),
        Ok(Err((status, detail))) => {
            let (code, exit, retryable, next) = match status {
                400 | 422 => ("invalid", 2, false, None),
                401 => ("daemon_unauthorized", 3, false, None),
                403 => ("forbidden", 4, false, None),
                404 => ("not_found", 5, false, not_found_next),
                409 => ("conflict", 6, false, None),
                503 => ("daemon_unavailable", 7, true, None),
                _ => ("daemon_error", 7, false, None),
            };
            error_envelope(code, &detail, next, exit, retryable)
        }
        Err(e) => unreachable(e),
    }
}

/// Send one request to the running daemon; its answer as an envelope.
pub(crate) fn call_http(
    label: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    not_found_next: Option<&str>,
) -> anyhow::Result<Value> {
    let rt = tokio::runtime::Runtime::new()?;
    Ok(rt.block_on(async {
        match LocalDaemonClient::connect(label).await {
            Ok(daemon) => http_envelope(daemon.send(method, path, body).await, not_found_next),
            Err(e) => unreachable(e),
        }
    }))
}

/// Send one request to the running daemon and print the answer; the exit
/// status.
pub(crate) fn run_http(
    output: &str,
    label: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    not_found_next: Option<&str>,
) -> anyhow::Result<i32> {
    let envelope = call_http(label, method, path, body, not_found_next)?;
    Ok(emit(output, envelope))
}

/// The workspace root the daemon knows `dir` by: a pi worktree
/// (`<repo>/.worktrees/<id>`) maps back to `<repo>`.
pub(crate) fn workspace_root(dir: &std::path::Path) -> std::path::PathBuf {
    let parts: Vec<_> = dir.iter().collect();
    match parts.iter().position(|c| *c == ".worktrees") {
        Some(idx) => std::path::PathBuf::from_iter(&parts[..idx]),
        None => dir.to_path_buf(),
    }
}

/// The daemon's id for a workspace: `--workspace <dir>`, else the current
/// directory (a pi worktree counts as its workspace).
pub(crate) fn workspace_id(dir: Option<&std::path::Path>) -> Result<String, Usage> {
    let dir = match dir
        .map(std::path::Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok())
    {
        Some(d) => workspace_root(&d),
        None => return Err(usage("no_workspace", "no current directory", None)),
    };
    crate::config::encode_workspace_path(&dir)
        .map_err(|e| usage("no_workspace", e.to_string(), Some("--workspace <dir>")))
}

/// Read a JSON object from a file, or stdin for `-`.
pub(crate) fn read_json_object(path: &str) -> Result<serde_json::Map<String, Value>, Usage> {
    let text = if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
            .map_err(|e| usage("unreadable_file", format!("read stdin: {e}"), None))?;
        s
    } else {
        std::fs::read_to_string(path)
            .map_err(|e| usage("unreadable_file", format!("read {path}: {e}"), None))?
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(usage("invalid_json", "expected a JSON object", None)),
        Err(e) => Err(usage("invalid_json", format!("not JSON: {e}"), None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_the_contract_exits() {
        let exit = |status: u16, detail: &str| {
            http_envelope(Ok(Err((status, detail.into()))), Some("amuxd role ls"))["error"]["exit"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(exit(422, "daemon is not onboarded to a team"), 3);
        assert_eq!(exit(422, "raw_markdown must not be empty"), 2);
        assert_eq!(exit(403, "x"), 4);
        assert_eq!(exit(404, "x"), 5);
        assert_eq!(exit(409, "x"), 6);
        assert_eq!(exit(500, "x"), 7);
        let missing = http_envelope(Ok(Err((404, "x".into()))), Some("amuxd role ls"));
        assert_eq!(missing["error"]["next"], "amuxd role ls");
    }

    #[test]
    fn a_worktree_maps_back_to_its_workspace() {
        assert_eq!(
            workspace_root(std::path::Path::new("/repo/.worktrees/abc")),
            std::path::PathBuf::from("/repo")
        );
        assert_eq!(
            workspace_root(std::path::Path::new("/repo/sub")),
            std::path::PathBuf::from("/repo/sub")
        );
    }
}
