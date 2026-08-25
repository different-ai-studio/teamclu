//! SyncError — the unified error type for oss_sync.

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(
        "conflict: remote_version={remote_version:?}, remote_cipher_hash={remote_cipher_hash:?}"
    )]
    Conflict {
        remote_version: Option<i32>,
        remote_cipher_hash: Option<String>,
    },

    #[error("auth: {0}")]
    Auth(String),

    #[error("session expired: {0}")]
    SessionExpired(String),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("network: {0}")]
    Network(String),

    #[error("hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("state: {0}")]
    State(String),

    #[error("crypto: {0}")]
    Crypto(String),

    #[error("io: {0}")]
    Io(String),

    #[error("internal: {0}")]
    Internal(String),

    /// FC has no such row (HTTP 404 on a non-batch endpoint). For a version
    /// listing that is not an error at all — a document the cloud has never
    /// seen simply has no versions — so callers get to decide.
    #[error("not found: {0}")]
    NotFound(String),

    /// The FC instance does not implement a batch endpoint (HTTP 404). Signals the
    /// engine to fall back to the per-file path. See engine.rs batch fallback.
    #[error("batch endpoint unsupported (404)")]
    BatchUnsupported,
}

impl From<crate::sync::oss::path_validator::PathValidationError> for SyncError {
    fn from(e: crate::sync::oss::path_validator::PathValidationError) -> Self {
        SyncError::InvalidPath(e.0)
    }
}

impl From<std::io::Error> for SyncError {
    fn from(e: std::io::Error) -> Self {
        SyncError::Io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_reads_as_absence_not_failure() {
        // The message a caller logs when it does treat it as an error.
        assert_eq!(
            SyncError::NotFound("file not found".into()).to_string(),
            "not found: file not found"
        );
    }

    use super::*;
    use crate::sync::oss::path_validator::PathValidationError;

    #[test]
    fn from_path_validation_error() {
        let pve = PathValidationError("bad path".to_string());
        let err = SyncError::from(pve);
        assert!(matches!(err, SyncError::InvalidPath(msg) if msg == "bad path"));
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let err = SyncError::from(io_err);
        assert!(matches!(err, SyncError::Io(msg) if msg.contains("file missing")));
    }

    #[test]
    fn error_display_conflict() {
        let err = SyncError::Conflict {
            remote_version: Some(3),
            remote_cipher_hash: Some("abc".to_string()),
        };
        let s = err.to_string();
        assert!(s.contains("conflict"));
        assert!(s.contains("3"));
    }

    #[test]
    fn error_display_hash_mismatch() {
        let err = SyncError::HashMismatch {
            expected: "aaa".to_string(),
            actual: "bbb".to_string(),
        };
        let s = err.to_string();
        assert!(s.contains("aaa"));
        assert!(s.contains("bbb"));
    }

    #[test]
    fn error_display_batch_unsupported() {
        let s = SyncError::BatchUnsupported.to_string();
        assert!(s.contains("404"));
    }
}
