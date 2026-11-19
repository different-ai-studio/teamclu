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
}

impl From<std::io::Error> for SyncError {
    fn from(e: std::io::Error) -> Self {
        SyncError::Io(e.to_string())
    }
}
