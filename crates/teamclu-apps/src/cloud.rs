//! The Cloud API, with the server's own words.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::Surface;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// A Cloud API failure, with what the server actually said.
///
/// App routes answer 409 for a dozen ordinary states — no database, not
/// deployed, over quota, domain taken, DNS not visible yet, a deploy already
/// running — and an agent told "conflict" has nothing to act on. So neither
/// surface's general-purpose client error is used for them.
#[derive(Debug, Clone)]
pub struct CloudError {
    /// 0 when no response arrived at all.
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl CloudError {
    /// No response at all: DNS, connect, TLS, timeout.
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            status: 0,
            code: String::new(),
            message: message.into(),
        }
    }

    /// A non-2xx response, read for `{ error: { code, message } }` and the
    /// flatter shapes older routes answer with.
    pub fn from_response(status: u16, bytes: &[u8]) -> Self {
        let body: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
        let pick = |v: &Value| {
            v.as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let code = pick(&body["error"]["code"])
            .or_else(|| pick(&body["code"]))
            .unwrap_or_default();
        let message = pick(&body["error"]["message"])
            .or_else(|| pick(&body["message"]))
            .or_else(|| pick(&body["error"]))
            .unwrap_or_else(|| String::from_utf8_lossy(bytes).chars().take(300).collect());
        Self {
            status,
            code,
            message,
        }
    }
}

/// One Cloud API request on the surface's own bearer.
///
/// `path` starts at `/v1/…` and carries its query string. `timeout` overrides
/// the implementation's default for the calls the server legitimately takes
/// longer on (create, finalize). A 2xx with an empty body is `Value::Null`.
#[async_trait]
pub trait Cloud: Send + Sync {
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, CloudError>;
}

/// What to do about a failure, when the status or code alone does not say.
fn hint(surface: Surface, e: &CloudError) -> Option<String> {
    match e.code.as_str() {
        "app_has_no_database" => Some(format!(
            "only data_app apps have a database — {} can change the type, which takes effect on the next deploy",
            surface.step("manage_app", "update")
        )),
        "app_not_deployed" => Some(format!(
            "deploy it first ({})",
            surface.step("manage_app", "deploy")
        )),
        "app_storage_quota_exceeded" => Some(format!(
            "the app is over its storage quota — delete files, or raise it with {}",
            surface.step("manage_app_files", "set_quota")
        )),
        "env_key_reserved" => {
            Some("the platform sets this variable itself; use another name".to_string())
        }
        _ => match e.status {
            // Deliberately the same answer the API gives for both: telling "you
            // may not" apart from "it does not exist" would leak which apps
            // exist, so the agent is told it could be either.
            404 => Some(format!(
                "the Cloud API answers 404 both when it does not exist and when {} lacks the permission this needs",
                surface.principal()
            )),
            401 => Some(surface.reauth().to_string()),
            _ => None,
        },
    }
}

/// One sentence for a failed call: what was being done, and the server's reply.
pub fn explain(surface: Surface, what: &str, e: &CloudError) -> String {
    if e.status == 0 {
        return format!(
            "{what} failed: could not reach the Cloud API ({})",
            e.message
        );
    }
    let mut out = format!("{what} failed: HTTP {}", e.status);
    if !e.code.is_empty() {
        out.push(' ');
        out.push_str(&e.code);
    }
    if !e.message.is_empty() {
        out.push_str(": ");
        out.push_str(&e.message);
    }
    if let Some(hint) = hint(surface, e) {
        out.push_str(" — ");
        out.push_str(&hint);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_409_keeps_the_server_s_code_and_message() {
        let e = CloudError::from_response(
            409,
            br#"{"error":{"code":"app_has_no_database","message":"this app type has no database"}}"#,
        );
        assert_eq!(e.code, "app_has_no_database");
        let text = explain(Surface::Mcp, "Listing tables", &e);
        assert!(
            text.contains("409 app_has_no_database: this app type has no database"),
            "{text}"
        );
        assert!(
            text.contains("only data_app apps have a database"),
            "{text}"
        );
    }

    #[test]
    fn a_404_says_it_may_be_a_permission_rather_than_a_missing_app() {
        let e = CloudError::from_response(
            404,
            br#"{"error":{"code":"not_found","message":"app not found"}}"#,
        );
        assert!(explain(Surface::Mcp, "Deleting the app", &e).contains("lacks the permission"));
        assert!(explain(Surface::Cli, "Deleting the app", &e).contains("agent account"));
    }

    #[test]
    fn an_error_body_that_is_not_json_is_still_reported() {
        let e = CloudError::from_response(502, b"<html>Bad Gateway</html>");
        assert_eq!(e.status, 502);
        assert!(e.message.contains("Bad Gateway"), "{}", e.message);
    }

    #[test]
    fn a_hint_names_the_step_the_caller_can_take() {
        let e = CloudError::from_response(
            409,
            br#"{"error":{"code":"app_not_deployed","message":"x"}}"#,
        );
        assert!(explain(Surface::Cli, "Reading logs", &e).contains("`amuxd app deploy`"));
        assert!(explain(Surface::Mcp, "Reading logs", &e).contains("manage_app action \"deploy\""));
    }
}
