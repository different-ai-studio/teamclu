//! OSS (FC-mediated, AES-256-GCM) team sync engine, moved from the desktop.
pub mod conflict;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod fc_client;
pub mod manifest;
pub mod path_validator;
pub mod scanner;
pub mod state;

pub use engine::{tick, tick_with_progress};

use serde::{Deserialize, Serialize};

/// Conflict resolution choices (ported from desktop `oss_sync::ConflictChoice`,
/// minus the Tauri coupling).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Keep the remote version (discard local edits).
    KeepRemote,
    /// Keep the local version (will be uploaded on next push).
    KeepLocal,
}

/// Which part of a tick is running. Ordered the way `tick` runs them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    /// Walking `/sync/manifest`. There is no total until it finishes, which is
    /// why this phase reports `total: 0` rather than a fake denominator.
    #[default]
    Checking,
    Pulling,
    Pushing,
    Deleting,
}

/// How far the running tick has got, for a progress indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub done: u32,
    /// `0` means "unknown" — render an indeterminate bar, not 0%.
    pub total: u32,
}

/// Where a tick reports its progress.
///
/// Called from inside the blob transfer loops, so it must be cheap and must not
/// block: the dispatcher's implementation takes a std mutex for the length of a
/// map insert and nothing else. `ProgressSink::none()` is the no-op used by
/// every caller that does not display progress (tests, the CLI).
#[derive(Clone)]
pub struct ProgressSink(std::sync::Arc<dyn Fn(SyncProgress) + Send + Sync>);

impl ProgressSink {
    pub fn new(f: impl Fn(SyncProgress) + Send + Sync + 'static) -> Self {
        Self(std::sync::Arc::new(f))
    }

    pub fn none() -> Self {
        Self(std::sync::Arc::new(|_| {}))
    }

    pub fn report(&self, phase: SyncPhase, done: u32, total: u32) {
        (self.0)(SyncProgress { phase, done, total })
    }
}

impl std::fmt::Debug for ProgressSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProgressSink")
    }
}
