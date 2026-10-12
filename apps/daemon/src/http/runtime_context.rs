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
        ResolveError::CallerNotAgentHost => {
            "Only a process of an agent host amuxd spawned can draw the cloud access token"
        }
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

/// Body of `/internal/runtime-context/cloud-token`.
///
/// Both fields are optional. Over the Unix socket the caller is identified by
/// its process tree and the body is only echoed into the audit line; on the
/// Windows TCP route they name the host whose bearer token is being checked.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct CloudTokenRequest {
    #[serde(rename = "hostGenerationId", default)]
    pub host_generation_id: String,
    #[serde(rename = "backendKind", default)]
    pub backend_kind: String,
}

/// How a cloud-token caller was identified — the `via` field of the audit line.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
enum CloudTokenVia {
    /// Unix: the connecting pid descends from a host this daemon spawned.
    UnixSocketAncestry,
    /// Windows: the bearer token amuxd put in the host's environment.
    BearerToken,
}

impl CloudTokenVia {
    fn as_str(self) -> &'static str {
        match self {
            Self::UnixSocketAncestry => "unix_socket_ancestry",
            Self::BearerToken => "bearer_token",
        }
    }
}

/// The daemon's current cloud access token, for the agent host that asks.
///
/// This replaces the `state/cloud-token` file the daemon used to keep for
/// agents (`TC_ACCESS_TOKEN_FILE`). That file was `0600`, which is the wrong
/// boundary: every process of this OS user could read it, not only the hosts
/// amuxd spawned.
///
/// On unix this TCP route issues nothing. The first replacement — present the
/// host's runtime-context token as a bearer — was no better a boundary: that
/// token lives in the host's environment so the skills it runs can use it,
/// and any same-user process can read another process's environment
/// (`sysctl KERN_PROCARGS2`, `/proc/<pid>/environ`). The token is issued over
/// the Unix socket named by `TEAMCLU_RUNTIME_CONTEXT_SOCK` instead, where the
/// kernel tells us the caller's pid and we check its ancestry
/// ([`cloud_token_unix`]). This route stays mounted so a skill still on the
/// old recipe gets an answer that names the new one rather than a 404.
///
/// Windows has no peer-pid socket and keeps the bearer check
/// ([`cloud_token_with_bearer`]).
///
/// What comes back is still the daemon's own GoTrue JWT, good for whatever
/// that identity may do until it expires (~1h). The pi extension redacts it
/// from tool results, so a prompt-injected `curl` cannot print it into a
/// transcript; and every issue is logged with the host generation.
///
/// `Accept: text/plain` returns the bare token, so a skill needs `curl` and
/// nothing else. Anything else gets JSON.
pub async fn cloud_token(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<CloudTokenRequest>>,
) -> Response {
    if !runtime_context_peer_allowed(peer) {
        return problem(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Runtime context cloud-token is loopback-only",
        );
    }
    if cfg!(unix) {
        return problem(
            StatusCode::FORBIDDEN,
            "cloud_token_requires_unix_socket",
            "On this platform the cloud access token is issued only over the Unix socket \
             named by TEAMCLU_RUNTIME_CONTEXT_SOCK, to processes of an agent host amuxd \
             spawned; no bearer token unlocks it over TCP",
        );
    }
    let body = body.map(|Json(b)| b).unwrap_or_default();
    cloud_token_with_bearer(state, headers, body).await
}

/// Issue the cloud token to the holder of a live host's runtime-context token.
/// The Windows path; see [`cloud_token`] for why unix does not take it.
pub(crate) async fn cloud_token_with_bearer(
    state: HttpState,
    headers: HeaderMap,
    body: CloudTokenRequest,
) -> Response {
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
    if let Err(err) = service.verify_token(bearer, &body.backend_kind, &body.host_generation_id) {
        warn!(
            event = "runtime_context_cloud_token",
            via = CloudTokenVia::BearerToken.as_str(),
            backend_kind = %body.backend_kind,
            host_generation_id = %body.host_generation_id,
            result = err.code(),
            "cloud token refused"
        );
        return problem(
            StatusCode::from_u16(err.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            err.code(),
            session_context_error_message(&err),
        );
    }
    issue_cloud_token(
        &state,
        &headers,
        &body.backend_kind,
        &body.host_generation_id,
        CloudTokenVia::BearerToken,
        None,
    )
    .await
}

/// The cloud-token route on the Unix socket (`http::runtime_context_unix`).
///
/// The caller presents nothing. The kernel gives us its pid; the pid's
/// ancestry (`runtime::proc_tree`) has to reach a host this daemon spawned
/// and registered, still running under the start time it was registered
/// with. That is what a same-user process cannot fake: it can read a host's
/// environment, but it cannot make a host its parent.
///
/// pi starts each bash tool command `detached` (its own session), and a
/// script in it may fork further, so neither session id nor process group
/// would do — only the parent chain survives all of that. What it does not
/// survive is orphaning: a background job left behind after its shell exits
/// is re-parented to pid 1 and loses access, which is the right outcome.
#[cfg(unix)]
pub async fn cloud_token_unix(
    State(state): State<HttpState>,
    axum::Extension(peer): axum::Extension<super::runtime_context_unix::UnixPeer>,
    headers: HeaderMap,
) -> Response {
    let via = CloudTokenVia::UnixSocketAncestry;
    let Some(service) = state.runtime_context.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_context_unavailable",
            "Runtime context service is not configured",
        );
    };
    let resolved = match peer.pid {
        Some(pid) if peer.is_same_user() => service.host_for_peer_pid(pid),
        _ => Err(ResolveError::CallerNotAgentHost),
    };
    let caller = match resolved {
        Ok(caller) => caller,
        Err(err) => {
            warn!(
                event = "runtime_context_cloud_token",
                via = via.as_str(),
                peer_pid = ?peer.pid,
                peer_uid = ?peer.uid,
                result = err.code(),
                "cloud token refused"
            );
            return problem(
                StatusCode::from_u16(err.http_status())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                err.code(),
                session_context_error_message(&err),
            );
        }
    };
    issue_cloud_token(
        &state,
        &headers,
        &caller.backend_kind,
        &caller.host_generation_id,
        via,
        peer.pid.map(|pid| (pid, caller.host_pid)),
    )
    .await
}

/// Hand out the backend's current access token to an already-identified host,
/// in the shape the `Accept` header asks for, and log the issue.
async fn issue_cloud_token(
    state: &HttpState,
    headers: &HeaderMap,
    backend_kind: &str,
    host_generation_id: &str,
    via: CloudTokenVia,
    peer_and_host_pid: Option<(u32, u32)>,
) -> Response {
    let Some(backend) = state.backend.clone() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_backend_unavailable",
            "No cloud backend to issue a token from",
        );
    };
    let peer_pid = peer_and_host_pid.map(|(peer, _)| peer);
    let host_pid = peer_and_host_pid.map(|(_, host)| host);
    let token = match backend.auth_token().await {
        Ok(token) => token,
        Err(err) => {
            warn!(
                event = "runtime_context_cloud_token",
                via = via.as_str(),
                backend_kind,
                host_generation_id,
                peer_pid = ?peer_pid,
                host_pid = ?host_pid,
                error = ?err,
                result = "refresh_failed",
                "cloud token could not be refreshed"
            );
            return problem(
                StatusCode::BAD_GATEWAY,
                "cloud_token_unavailable",
                "Cloud access token could not be refreshed",
            );
        }
    };
    tracing::info!(
        event = "runtime_context_cloud_token",
        via = via.as_str(),
        backend_kind,
        host_generation_id,
        peer_pid = ?peer_pid,
        host_pid = ?host_pid,
        result = "issued",
        "cloud token issued to agent host"
    );
    let wants_text = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').any(|m| m.trim().starts_with("text/plain")))
        .unwrap_or(false);
    if wants_text {
        return (
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            token,
        )
            .into_response();
    }
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({
            "accessToken": token,
            "expiresAtEpoch": backend.cached_credential_expiry_epoch(),
            "actorId": backend.actor_id(),
            "teamId": backend.team_id(),
        })),
    )
        .into_response()
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

    /// The Windows path, called directly: on unix the TCP route refuses
    /// before reaching it (see `the_tcp_route_issues_nothing_on_unix`).
    async fn bearer_call(
        state: &HttpState,
        bearer: &str,
        generation: &str,
        backend: &str,
        accept: Option<&str>,
    ) -> (StatusCode, String) {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {bearer}").parse().unwrap(),
        );
        if let Some(accept) = accept {
            headers.insert(header::ACCEPT, accept.parse().unwrap());
        }
        let body = CloudTokenRequest {
            host_generation_id: generation.into(),
            backend_kind: backend.into(),
        };
        let response = cloud_token_with_bearer(state.clone(), headers, body).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    fn mock_backend() -> std::sync::Arc<dyn crate::backend::Backend> {
        std::sync::Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-1", "actor-1",
        ))
    }

    #[tokio::test]
    async fn with_a_bearer_the_token_is_issued_only_to_a_live_host_of_this_daemon() {
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
        let state = state_with(service, dir.path()).with_backend(Some(mock_backend()));

        // The live token of this host → the backend's current access token,
        // with the identity it speaks for.
        let (status, body) = bearer_call(&state, &token, "pi-gen-1", "pi", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["accessToken"], "mock-token");
        assert_eq!(json["teamId"], "team-1");
        assert_eq!(json["actorId"], "actor-1");

        // `Accept: text/plain` → the bare token, for a skill that has `curl`
        // and nothing else.
        let (status, body) =
            bearer_call(&state, &token, "pi-gen-1", "pi", Some("text/plain")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "mock-token");

        // A token amuxd never minted.
        let (status, body) = bearer_call(&state, "rtctx_invalid", "pi-gen-1", "pi", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!body.contains("mock-token"));
        // A real token only speaks for its own host and backend.
        assert_eq!(
            bearer_call(&state, &token, "pi-gen-2", "pi", None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            bearer_call(&state, &token, "pi-gen-1", "opencode", None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn the_tcp_route_is_loopback_only_and_issues_nothing_on_unix() {
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
        let state = state_with(service, dir.path()).with_backend(Some(mock_backend()));
        let call = |peer: SocketAddr| {
            let state = state.clone();
            let token = token.clone();
            async move {
                let mut headers = HeaderMap::new();
                headers.insert(
                    header::AUTHORIZATION,
                    format!("Bearer {token}").parse().unwrap(),
                );
                headers.insert(header::ACCEPT, "text/plain".parse().unwrap());
                let body = CloudTokenRequest {
                    host_generation_id: "pi-gen-1".into(),
                    backend_kind: "pi".into(),
                };
                let response =
                    cloud_token(State(state), ConnectInfo(peer), headers, Some(Json(body))).await;
                let status = response.status();
                let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                (status, String::from_utf8_lossy(&bytes).into_owned())
            }
        };

        let remote = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)), 4242);
        assert_eq!(call(remote).await.0, StatusCode::FORBIDDEN);

        // The genuine live token of a live host, over loopback: exactly what
        // a same-user process gets by reading the host's environment.
        let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4242);
        let (status, body) = call(loopback).await;
        if cfg!(unix) {
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert!(body.contains("cloud_token_requires_unix_socket"), "{body}");
            assert!(!body.contains("mock-token"));
        } else {
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body, "mock-token");
        }
    }

    #[cfg(unix)]
    async fn unix_call(
        state: &HttpState,
        peer: super::super::runtime_context_unix::UnixPeer,
    ) -> (StatusCode, String) {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, "text/plain".parse().unwrap());
        let response = cloud_token_unix(State(state.clone()), axum::Extension(peer), headers).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn over_the_socket_only_a_descendant_of_a_registered_host_is_served() {
        use super::super::runtime_context_unix::UnixPeer;
        use crate::runtime::context_registry::HostProcess;
        use crate::runtime::context_service::RuntimeContextService;
        use crate::runtime::proc_tree::process_info;
        use std::sync::Arc;

        let service = Arc::new(RuntimeContextService::new());
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(Arc::clone(&service), dir.path()).with_backend(Some(mock_backend()));
        // SAFETY: getuid has no preconditions.
        let me_uid = unsafe { libc::getuid() };
        let me = std::process::id();
        let me_peer = UnixPeer {
            pid: Some(me),
            uid: Some(me_uid),
        };

        // Nothing registered: our own process is just another same-user process.
        let (status, body) = unix_call(&state, me_peer).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert!(body.contains("caller_not_an_agent_host"), "{body}");

        // Register this process as a host → it (and anything it spawns) is served.
        let start_time = process_info(me).expect("own info").start_time;
        service.register_host_process(
            crate::proto::amux::AgentType::Pi,
            "pi-gen-1",
            HostProcess {
                pid: me,
                start_time,
            },
        );
        let (status, body) = unix_call(&state, me_peer).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, "mock-token");

        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let child_peer = UnixPeer {
            pid: Some(child.id()),
            uid: Some(me_uid),
        };
        let (status, body) = unix_call(&state, child_peer).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        child.kill().unwrap();
        child.wait().unwrap();

        // pid 1 is nobody's child; a peer the kernel could not identify, or
        // one belonging to another user, is refused the same way.
        let init = UnixPeer {
            pid: Some(1),
            uid: Some(me_uid),
        };
        assert_eq!(unix_call(&state, init).await.0, StatusCode::UNAUTHORIZED);
        let unknown = UnixPeer {
            pid: None,
            uid: Some(me_uid),
        };
        assert_eq!(unix_call(&state, unknown).await.0, StatusCode::UNAUTHORIZED);
        let other_user = UnixPeer {
            pid: Some(me),
            uid: Some(me_uid.wrapping_add(1)),
        };
        assert_eq!(
            unix_call(&state, other_user).await.0,
            StatusCode::UNAUTHORIZED
        );

        // Gone with the generation.
        service.clear_generation(crate::proto::amux::AgentType::Pi, "pi-gen-1");
        assert_eq!(unix_call(&state, me_peer).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn cloud_token_without_a_cloud_backend_is_unavailable_not_forged() {
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
        let (status, body) = bearer_call(&state, &token, "pi-gen-1", "pi", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
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
