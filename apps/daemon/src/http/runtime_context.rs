//! Internal loopback endpoint for backend adapters to resolve TeamClu session context.

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::net::SocketAddr;
use tracing::warn;

use crate::runtime::context_registry::{ResolveError, ResolveRuntimeContextRequest};

use super::state::HttpState;

pub async fn resolve_runtime_context(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResolveRuntimeContextRequest>,
) -> Response {
    if !peer.ip().is_loopback() {
        return problem(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Runtime context resolve is loopback-only",
        );
    }
    let Some(service) = state.runtime_context.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_context_unavailable",
            "Runtime context service is not configured",
        );
    };
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim();
    match service.resolve_with_token(bearer, &body) {
        Ok(resolved) => {
            tracing::info!(
                event = "runtime_context_resolve",
                backend_kind = %body.backend_kind,
                host_generation_id = %body.host_generation_id,
                backend_session_id = %body.backend_session_id,
                teamclu_session_id = %resolved.teamclu_session_id,
                runtime_id = %resolved.runtime_id,
                result = "resolved",
                "runtime context resolved"
            );
            Json(resolved).into_response()
        }
        Err(err) => {
            warn!(
                event = "runtime_context_resolve",
                backend_kind = %body.backend_kind,
                host_generation_id = %body.host_generation_id,
                backend_session_id = %body.backend_session_id,
                result = err.code(),
                "runtime context resolve failed"
            );
            problem(
                StatusCode::from_u16(err.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                err.code(),
                session_context_error_message(&err),
            )
        }
    }
}

fn session_context_error_message(err: &ResolveError) -> &'static str {
    match err {
        ResolveError::InvalidBackendSessionId => "backendSessionId is required",
        ResolveError::InvalidRuntimeContextToken => "Invalid or expired runtime context token",
        ResolveError::SessionContextUnavailable => {
            "Unable to determine the TeamClu session for this tool call"
        }
        ResolveError::StaleHostGeneration => "Host generation mismatch",
    }
}

fn problem(status: StatusCode, code: &str, detail: &str) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": code,
            "detail": detail,
        })),
    )
        .into_response()
}
