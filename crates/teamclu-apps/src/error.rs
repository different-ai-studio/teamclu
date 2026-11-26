//! A flow's failure, as an agent acts on it.
//!
//! The CLI contract (docs/specs/2026-11-24-amuxd-app-cli-design.md §2.2–2.3)
//! answers every failure with a stable `code`, a sentence, the next command
//! when there is one, whether retrying can help — and an exit status that
//! says which of a handful of things went wrong. [`ErrorKind`] is that
//! handful; the exit status is a function of it alone.
//!
//! The MCP surface only ever showed the sentence, so `Display` is the
//! sentence and nothing else: what the desktop prints does not change.

use std::fmt;

use serde_json::{json, Value};

use crate::cloud::{explain, CloudError};
use crate::Surface;

/// What went wrong, as far as the caller's next move is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The arguments are wrong — fix them (exit 2).
    Invalid,
    /// No identity, or it expired (exit 3).
    Unauthenticated,
    /// The identity may not do this (exit 4).
    Forbidden,
    /// No such app or object, or the name matches several (exit 5).
    NotFound,
    /// The state does not allow it now: a deploy running, drift, an unclean
    /// checkout, a full quota, not deployed yet (exit 6).
    Conflict,
    /// The platform, the cloud provider or the local daemon failed (exit 7).
    Upstream,
    /// It may or may not have happened — never retry blindly (exit 8).
    Unknown,
}

impl ErrorKind {
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorKind::Invalid => 2,
            ErrorKind::Unauthenticated => 3,
            ErrorKind::Forbidden => 4,
            ErrorKind::NotFound => 5,
            ErrorKind::Conflict => 6,
            ErrorKind::Upstream => 7,
            ErrorKind::Unknown => 8,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Invalid => "invalid",
            ErrorKind::Unauthenticated => "unauthenticated",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Conflict => "conflict",
            ErrorKind::Upstream => "upstream",
            ErrorKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError {
    pub kind: ErrorKind,
    /// Stable, snake_case; the server's own code when the Cloud API said no.
    pub code: String,
    /// One sentence: what was being done and why it failed.
    pub message: String,
    /// The command to run next, when there is one.
    pub next: Option<String>,
    pub retryable: bool,
}

impl OpError {
    pub fn new(kind: ErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
            message: message.into(),
            next: None,
            retryable: false,
        }
    }

    pub fn invalid(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, code, message)
    }

    pub fn not_found(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, code, message)
    }

    pub fn conflict(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Conflict, code, message)
    }

    pub fn upstream(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Upstream, code, message)
    }

    pub fn forbidden(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, code, message)
    }

    pub fn unknown(code: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unknown, code, message)
    }

    /// Whether the sentence mentions `needle` (tests and callers that
    /// still match on wording).
    pub fn contains(&self, needle: &str) -> bool {
        self.message.contains(needle)
    }

    pub fn with_next(mut self, next: impl Into<String>) -> Self {
        self.next = Some(next.into());
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// The local amuxd did not answer.
    pub fn daemon_down(message: impl Into<String>) -> Self {
        Self::upstream("daemon_unreachable", message).with_next("amuxd status")
    }

    /// The local amuxd answered with a failure.
    pub fn daemon_failed(message: impl Into<String>) -> Self {
        Self::upstream("daemon_failed", message)
    }

    /// A failed Cloud API call: the kind from the status, the server's code,
    /// and the sentence [`explain`] has always given.
    pub fn from_cloud(surface: Surface, what: &str, e: &CloudError) -> Self {
        let kind = match e.status {
            0 => ErrorKind::Upstream,
            400 | 422 => ErrorKind::Invalid,
            401 => ErrorKind::Unauthenticated,
            403 => ErrorKind::Forbidden,
            404 => ErrorKind::NotFound,
            409 | 412 | 413 | 423 | 429 => ErrorKind::Conflict,
            _ => ErrorKind::Upstream,
        };
        let code = if !e.code.is_empty() {
            e.code.clone()
        } else if e.status == 0 {
            "cloud_unreachable".to_string()
        } else {
            format!("http_{}", e.status)
        };
        Self {
            kind,
            code,
            message: explain(surface, what, e),
            next: None,
            retryable: matches!(e.status, 0 | 429 | 502 | 503 | 504),
        }
    }

    /// The `error` object of the CLI's `{"v":1,"ok":false,…}` envelope.
    pub fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "message": self.message,
            "next": self.next,
            "retryable": self.retryable,
            "kind": self.kind.as_str(),
            "exit": self.kind.exit_code(),
        })
    }
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OpError {}

/// The sentence alone, for a surface that only ever showed one (the
/// desktop's MCP tools): `?` there keeps answering exactly what it did.
impl From<OpError> for String {
    fn from(e: OpError) -> Self {
        e.message
    }
}

/// A response the flow cannot use — the platform or the daemon answered
/// something it never should. Not the caller's to fix.
impl From<String> for OpError {
    fn from(message: String) -> Self {
        Self::upstream("unexpected_response", message)
    }
}

impl From<&str> for OpError {
    fn from(message: &str) -> Self {
        Self::upstream("unexpected_response", message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_has_its_exit_status() {
        let codes: Vec<i32> = [
            ErrorKind::Invalid,
            ErrorKind::Unauthenticated,
            ErrorKind::Forbidden,
            ErrorKind::NotFound,
            ErrorKind::Conflict,
            ErrorKind::Upstream,
            ErrorKind::Unknown,
        ]
        .iter()
        .map(|k| k.exit_code())
        .collect();
        assert_eq!(codes, vec![2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn a_cloud_failure_keeps_the_server_code_and_the_sentence() {
        let e = CloudError::from_response(
            409,
            br#"{"error":{"code":"app_not_deployed","message":"x"}}"#,
        );
        let op = OpError::from_cloud(Surface::Cli, "Reading logs", &e);
        assert_eq!(op.kind, ErrorKind::Conflict);
        assert_eq!(op.code, "app_not_deployed");
        assert_eq!(op.to_string(), explain(Surface::Cli, "Reading logs", &e));
        assert!(!op.retryable);
    }

    #[test]
    fn statuses_map_to_kinds_and_only_transient_ones_are_retryable() {
        let kind = |status: u16| {
            OpError::from_cloud(Surface::Cli, "x", &CloudError::from_response(status, b"{}"))
        };
        assert_eq!(kind(401).kind, ErrorKind::Unauthenticated);
        assert_eq!(kind(403).kind, ErrorKind::Forbidden);
        assert_eq!(kind(404).kind, ErrorKind::NotFound);
        assert_eq!(kind(422).kind, ErrorKind::Invalid);
        assert_eq!(kind(500).kind, ErrorKind::Upstream);
        assert!(!kind(500).retryable);
        assert!(kind(503).retryable);
        assert_eq!(kind(404).code, "http_404");
        let unreachable = OpError::from_cloud(Surface::Cli, "x", &CloudError::network("dns"));
        assert_eq!(unreachable.code, "cloud_unreachable");
        assert!(unreachable.retryable);
    }

    #[test]
    fn the_envelope_error_names_its_exit_status() {
        let e = OpError::not_found("app_not_found", "No app named \"x\"")
            .with_next("amuxd app list");
        let j = e.to_json();
        assert_eq!(j["code"], "app_not_found");
        assert_eq!(j["exit"], 5);
        assert_eq!(j["next"], "amuxd app list");
    }
}
