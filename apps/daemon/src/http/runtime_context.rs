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

/// Resolver accepts requests only from loopback peers.
pub(crate) fn runtime_context_peer_allowed(peer: SocketAddr) -> bool {
    peer.ip().is_loopback()
}

pub async fn resolve_runtime_context(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResolveRuntimeContextRequest>,
) -> Response {
    if !runtime_context_peer_allowed(peer) {
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
                StatusCode::from_u16(err.http_status())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
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

/// Body of `/internal/runtime-context/verify`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct VerifyRuntimeCallerRequest {
    #[serde(rename = "hostGenerationId")]
    pub host_generation_id: String,
    #[serde(rename = "backendKind")]
    pub backend_kind: String,
}

/// Is the bearer the live runtime-context token of this host generation?
///
/// Asked by the desktop's introspect API before it lets a `teamclu-introspect`
/// sidecar change anything. amuxd puts the token only in the environment of the
/// agent hosts it spawns, and they pass it only to their introspect child, so
/// "yes" means the call came from inside an agent this daemon runs — not from a
/// copy of the sidecar that some other program on the machine started.
pub async fn verify_runtime_caller(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<VerifyRuntimeCallerRequest>,
) -> Response {
    if !runtime_context_peer_allowed(peer) {
        return problem(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Runtime context verify is loopback-only",
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
    match service.verify_token(bearer, &body.backend_kind, &body.host_generation_id) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => {
            warn!(
                event = "runtime_context_verify",
                backend_kind = %body.backend_kind,
                host_generation_id = %body.host_generation_id,
                result = err.code(),
                "runtime caller verify failed"
            );
            problem(
                StatusCode::from_u16(err.http_status())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                err.code(),
                session_context_error_message(&err),
            )
        }
    }
}

pub async fn session_prompt(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResolveRuntimeContextRequest>,
) -> Response {
    if !runtime_context_peer_allowed(peer) {
        return problem(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Runtime context resolve is loopback-only",
        );
    }
    let Some(context_service) = state.runtime_context.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_context_unavailable",
            "Runtime context service is not configured",
        );
    };
    let Some(prompt_service) = state.session_prompt.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "session_prompt_unavailable",
            "Session prompt service is not configured",
        );
    };
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim();
    let resolved = match context_service.resolve_with_token(bearer, &body) {
        Ok(resolved) => resolved,
        Err(err) => {
            warn!(
                event = "runtime_context_session_prompt",
                backend_kind = %body.backend_kind,
                host_generation_id = %body.host_generation_id,
                backend_session_id = %body.backend_session_id,
                result = err.code(),
                "session prompt resolve failed"
            );
            return problem(
                StatusCode::from_u16(err.http_status())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                err.code(),
                session_context_error_message(&err),
            );
        }
    };
    let response = prompt_service
        .build_for_resolved(&resolved.teamclu_session_id, &resolved.runtime_id)
        .await;
    tracing::info!(
        event = "runtime_context_session_prompt",
        backend_kind = %body.backend_kind,
        host_generation_id = %body.host_generation_id,
        backend_session_id = %body.backend_session_id,
        teamclu_session_id = %response.teamclu_session_id,
        runtime_id = %response.runtime_id,
        participant_count = response.participants.len(),
        result = "built",
        "session prompt built"
    );
    Json(response).into_response()
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SessionAttachRequest {
    #[serde(flatten)]
    pub resolve: ResolveRuntimeContextRequest,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(default)]
    pub message: Option<String>,
}

pub async fn session_attach(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SessionAttachRequest>,
) -> Response {
    if !runtime_context_peer_allowed(peer) {
        return problem(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Runtime context resolve is loopback-only",
        );
    }
    let Some(context_service) = state.runtime_context.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_context_unavailable",
            "Runtime context service is not configured",
        );
    };
    let Some(attach_service) = state.session_attach.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "session_attach_unavailable",
            "Session attach service is not configured",
        );
    };
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim();
    let resolved = match context_service.resolve_with_token(bearer, &body.resolve) {
        Ok(resolved) => resolved,
        Err(err) => {
            return problem(
                StatusCode::from_u16(err.http_status())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                err.code(),
                session_context_error_message(&err),
            );
        }
    };
    let caption = body.message.as_deref();
    match attach_service
        .attach_file(&resolved, &body.file_path, caption)
        .await
    {
        Ok(out) => Json(out).into_response(),
        Err(err) => problem(
            StatusCode::from_u16(err.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            err.code(),
            &err.message(),
        ),
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{ConnectInfo, State},
        http::{header, HeaderMap, StatusCode},
        Json,
    };
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    #[test]
    fn runtime_context_peer_allowed_accepts_loopback_only() {
        assert!(runtime_context_peer_allowed(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            8787
        )));
        assert!(!runtime_context_peer_allowed(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)),
            8787
        )));
    }

    #[tokio::test]
    async fn resolve_runtime_context_rejects_non_loopback_peer() {
        use crate::config::HttpConfig;
        use crate::http::server::metadata;
        use crate::http::state::HttpState;
        use crate::http::tokens;
        use crate::runtime::context_registry::ResolveRuntimeContextRequest;
        use crate::runtime::context_service::RuntimeContextService;
        use std::sync::Arc;

        let service = Arc::new(RuntimeContextService::new());
        let dir = tempfile::tempdir().unwrap();
        let state = HttpState::new(
            HttpConfig {
                bind: "127.0.0.1:0".into(),
                token_file: Some(dir.path().join("token")),
                ..Default::default()
            },
            tokens::TokenStore::load_or_init(&dir.path().join("token")).unwrap(),
            metadata("actor".into(), "test"),
            crate::http::runtime_adapter::StubRuntimeAdapter::new(8),
            None,
            None,
            crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                None,
            ),
            None,
        )
        .with_runtime_context(service);
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer rtctx_test".parse().unwrap());
        let body = ResolveRuntimeContextRequest {
            backend_session_id: "backend-a".into(),
            host_generation_id: "gen-test".into(),
            backend_kind: "opencode".into(),
        };
        let peer = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)), 4242);
        let response =
            resolve_runtime_context(State(state), ConnectInfo(peer), headers, Json(body)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    fn state_with(
        service: std::sync::Arc<crate::runtime::context_service::RuntimeContextService>,
        dir: &std::path::Path,
    ) -> HttpState {
        use crate::config::HttpConfig;
        use crate::http::server::metadata;
        use crate::http::tokens;

        HttpState::new(
            HttpConfig {
                bind: "127.0.0.1:0".into(),
                token_file: Some(dir.join("token")),
                ..Default::default()
            },
            tokens::TokenStore::load_or_init(&dir.join("token")).unwrap(),
            metadata("actor".into(), "test"),
            crate::http::runtime_adapter::StubRuntimeAdapter::new(8),
            None,
            None,
            crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                None,
            ),
            None,
        )
        .with_runtime_context(service)
    }

    async fn verify(
        state: &HttpState,
        bearer: &str,
        generation: &str,
        backend: &str,
        peer: SocketAddr,
    ) -> StatusCode {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {bearer}").parse().unwrap(),
        );
        let body = VerifyRuntimeCallerRequest {
            host_generation_id: generation.into(),
            backend_kind: backend.into(),
        };
        verify_runtime_caller(State(state.clone()), ConnectInfo(peer), headers, Json(body))
            .await
            .status()
    }

    #[tokio::test]
    async fn verify_runtime_caller_accepts_only_the_live_token_of_that_host() {
        use crate::runtime::context_service::RuntimeContextService;
        use std::sync::Arc;
        use teamclu_runtime_env::session_context::TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV;

        let service = Arc::new(RuntimeContextService::new());
        let token = service
            .env_for_generation(crate::proto::amux::AgentType::Pi, "pi-gen-1")
            .get(TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV)
            .cloned()
            .expect("token");
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(service, dir.path());
        let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4242);

        assert_eq!(
            verify(&state, &token, "pi-gen-1", "pi", loopback).await,
            StatusCode::OK
        );
        // A token amuxd never minted — what a copy of the sidecar started by
        // another program would have to guess.
        assert_eq!(
            verify(&state, "rtctx_invalid", "pi-gen-1", "pi", loopback).await,
            StatusCode::UNAUTHORIZED
        );
        // A real token only speaks for its own host.
        assert_eq!(
            verify(&state, &token, "pi-gen-2", "pi", loopback).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            verify(&state, &token, "pi-gen-1", "opencode", loopback).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            verify(&state, &token, "", "pi", loopback).await,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn verify_runtime_caller_rejects_non_loopback_peer() {
        use crate::runtime::context_service::RuntimeContextService;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let state = state_with(Arc::new(RuntimeContextService::new()), dir.path());
        let remote = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)), 4242);
        assert_eq!(
            verify(&state, "rtctx_any", "pi-gen-1", "pi", remote).await,
            StatusCode::FORBIDDEN
        );
    }
}
