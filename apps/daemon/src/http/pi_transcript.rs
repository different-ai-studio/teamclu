//! `GET /v1/pi/transcripts/:session_id` — dump the on-disk pi JSONL.
//!
//! `:session_id` is the TeamClu cloud session id. The handler looks up
//! `runtimes.toml` bindings, fences the path under `state/pi-sessions/`,
//! and returns the parsed JSONL. It does not attach a live host.

use axum::{
    extract::{Path, Query},
    Json,
};
use serde::Deserialize;

use crate::config::{layout, SessionStore};
use crate::runtime::pi_rpc::transcript::{
    export_session, ExportOptions, PiTranscriptBundle, TranscriptError,
};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;

#[derive(Debug, Deserialize)]
pub struct TranscriptQuery {
    #[serde(default, rename = "workspaceId")]
    workspace_id: Option<String>,
    #[serde(default)]
    sanitize: Option<bool>,
}

/// `GET /v1/pi/transcripts/:session_id`
pub async fn get_transcript(
    principal: Principal,
    Path(session_id): Path<String>,
    Query(query): Query<TranscriptQuery>,
) -> Result<Json<PiTranscriptBundle>, HttpError> {
    require_scope(&principal, "sessions:read")?;
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(HttpError::validation("session_id is required"));
    }

    let store = SessionStore::load(&SessionStore::default_path())
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let bindings: Vec<_> = store
        .all_for_session(session_id)
        .into_iter()
        .cloned()
        .collect();
    let root = layout::active_state_dir().join("pi-sessions");
    let opts = ExportOptions {
        sanitize: query.sanitize.unwrap_or(true),
    };
    match export_session(
        session_id,
        &bindings,
        query.workspace_id.as_deref(),
        &root,
        opts,
    ) {
        Ok(bundle) => Ok(Json(bundle)),
        Err(err) => Err(to_http_error(session_id, err)),
    }
}

fn to_http_error(session_id: &str, err: TranscriptError) -> HttpError {
    match err {
        TranscriptError::NoTranscripts | TranscriptError::FileMissing => {
            HttpError::not_found(format!("no local pi session file for {session_id}"))
        }
        TranscriptError::NotPiSession => {
            HttpError::validation(format!("session {session_id} is not a pi backend session"))
        }
        TranscriptError::EscapedPath => {
            HttpError::forbidden("pi session path is outside the pi-sessions directory")
        }
        TranscriptError::InvalidJson { line } => {
            HttpError::validation(format!("pi session JSONL is invalid at line {line}"))
        }
        TranscriptError::Io(detail) => HttpError::internal(detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_404() {
        let err = to_http_error("abc", TranscriptError::NoTranscripts);
        assert_eq!(err.code, crate::http::errors::ErrorCode::NotFound);
    }

    #[test]
    fn escaped_path_is_403() {
        let err = to_http_error("abc", TranscriptError::EscapedPath);
        assert_eq!(err.code, crate::http::errors::ErrorCode::Forbidden);
    }
}
