//! The local amuxd's side of an app: where its checkout is, what it declares,
//! seeding, building.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::redact::{redact_deploy_secrets, redact_url_credentials};

/// A daemon call that failed.
#[derive(Debug, Clone)]
pub struct DaemonError {
    /// The daemon is not there at all, as opposed to there and refusing. The
    /// web app's test is "the request never got a status"; implementations
    /// draw the same line on their own error type.
    pub unreachable: bool,
    /// The daemon's own words — the `detail` of its problem body when it
    /// answered with one. Not yet redacted; [`daemon_error_text`] does that.
    pub message: String,
}

impl DaemonError {
    pub fn unreachable(message: impl Into<String>) -> Self {
        Self {
            unreachable: true,
            message: message.into(),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            unreachable: false,
            message: message.into(),
        }
    }
}

pub const DAEMON_DOWN: &str =
    "The local amuxd is not running, so nothing could be written on this machine.";

/// amuxd's `/v1/apps/*` endpoints (`apps/daemon/src/http/apps.rs`), one method
/// each. Bodies and replies are those endpoints' camelCase JSON, unchanged.
#[async_trait]
pub trait LocalDaemon: Send + Sync {
    /// `GET /v1/apps/local` — every app this machine holds a checkout for, as
    /// `(app_id, workdir)`.
    async fn local_apps(&self, team_id: &str) -> Result<Vec<(String, String)>, DaemonError>;

    /// `GET /v1/apps/:id/workdir` — `{ workdir, deviceName, hostFacts }`.
    async fn workdir(&self, app_id: &str, team_id: &str) -> Result<Value, DaemonError>;

    /// `GET /v1/apps/:id/manifest` — the checkout's declaration and revision.
    async fn manifest(&self, app_id: &str, team_id: &str) -> Result<Value, DaemonError>;

    /// `POST /v1/apps/seed`.
    async fn seed(&self, body: &Value, timeout: Duration) -> Result<Value, DaemonError>;

    /// `POST /v1/apps/build`.
    async fn build(&self, body: &Value, timeout: Duration) -> Result<Value, DaemonError>;

    /// `POST /v1/apps/inspect-dir`.
    async fn inspect_dir(&self, path: &str) -> Result<Value, DaemonError>;

    /// `POST /v1/apps/:id/bind-workdir`.
    async fn bind_workdir(
        &self,
        app_id: &str,
        team_id: &str,
        dir: &str,
    ) -> Result<Value, DaemonError>;

    /// The actor this machine's daemon is — the owner of its workspace rows.
    async fn actor_id(&self) -> Option<String>;
}

/// What the daemon said, as a sentence: secrets removed, and the one failure
/// whose cause is invisible explained.
pub fn daemon_error_text(e: &DaemonError) -> String {
    let text = redact_url_credentials(&redact_deploy_secrets(&e.message));
    // Mirrors `mapSeedErrorReason`: git was asked nothing and printed nothing,
    // because it is the machine's credential helper that is waiting — often on
    // a window that has nowhere to appear.
    if text.contains("git clone timed out") {
        return format!(
            "{text} — usually this machine's git credential helper is waiting for a login prompt that cannot appear. Clone the repository once in a terminal, then retry."
        );
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clone_timeout_says_what_is_really_waiting() {
        let text = daemon_error_text(&DaemonError::failed("git clone timed out after 300s"));
        assert!(text.contains("credential helper"), "{text}");
    }

    #[test]
    fn repo_credentials_never_reach_a_reply() {
        let text = daemon_error_text(&DaemonError::failed(
            "clone of https://bob:ghp_secret@github.com/x/y.git failed",
        ));
        assert!(!text.contains("ghp_secret"), "{text}");
        assert!(text.contains("github.com/x/y.git"), "{text}");
    }
}
