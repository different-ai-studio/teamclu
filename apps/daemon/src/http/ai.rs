//! Local AI proxy: `/v1/ai/teams/{team_id}/*path`.
//!
//! The agent runtime's `provider.team.baseURL` points here rather than straight
//! at a cloud gateway, so the runtime never holds a cloud credential: it
//! presents a daemon session token carrying `ai:invoke`, and the daemon swaps
//! that for the device's cloud access token on the way out.
//!
//! **Why the team id is in the path.** The runtime already has a per-team
//! `provider.team` entry, so it can say which team it is spending from. Letting
//! the daemon infer it instead would attribute a request to whichever team
//! happened to be current, which is a whole class of "charged the wrong team
//! after switching" bugs.
//!
//! **Why this forwards to two different upstreams.** The upstream is resolved
//! per team from the cloud (`workspace-config.llm.baseUrl`), which is exactly
//! the cutover lever: flipping one column moves one team from LiteLLM to the
//! new gateway, and flipping it back is the rollback. If this only ever spoke
//! to the new gateway there would be no way back.
//!
//! **Auth is not optional here.** `http.bind` may be `0.0.0.0`, so this route
//! can be exposed beyond loopback; "it's local" is not a security argument.

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::TryStreamExt;

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

/// Headers that must never be copied from the inbound request to the upstream:
/// hop-by-hop framing, plus the client's own credential (which we replace).
const STRIP_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
];

/// Same idea on the way back: the upstream's framing headers describe its
/// connection, not ours.
const STRIP_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "keep-alive",
];

/// Resolve where this team's AI traffic should go.
///
/// Returns the base URL the request path is appended to. `None` means the team
/// has no managed LLM configured (or the cloud has not answered yet), which is
/// a 404 rather than an error: nothing is broken, the feature is simply off.
async fn resolve_upstream(state: &HttpState, team_id: &str) -> Option<String> {
    use teamclu_runtime_env::ManagedLlmState;
    let resolver = state.managed_llm.as_ref()?;
    match resolver.resolve(team_id).await {
        ManagedLlmState::Enabled(provider) => {
            let base = provider.base_url.trim_end_matches('/').to_string();
            (!base.is_empty()).then_some(base)
        }
        ManagedLlmState::Disabled | ManagedLlmState::Unknown => None,
    }
}

/// `ANY /v1/ai/teams/{team_id}/{*path}`
pub async fn proxy(
    principal: Principal,
    State(state): State<HttpState>,
    Path((team_id, path)): Path<(String, String)>,
    req: Request,
) -> Result<Response, HttpError> {
    require_scope(&principal, "ai:invoke")?;

    let Some(base) = resolve_upstream(&state, &team_id).await else {
        return Err(HttpError::not_found(format!(
            "no managed LLM configured for team {team_id}"
        )));
    };
    let Some(backend) = state.backend.as_ref() else {
        return Err(HttpError::runtime_unavailable(
            "cloud backend not configured",
        ));
    };
    let token = backend.auth_token().await.map_err(|e| {
        HttpError::runtime_unavailable(format!("cloud credential unavailable: {e}"))
    })?;

    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("{base}/{path}{query}");

    let method = req.method().clone();
    let mut forward_headers = HeaderMap::new();
    for (name, value) in req.headers() {
        if STRIP_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        forward_headers.insert(name.clone(), value.clone());
    }
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
        forward_headers.insert(header::AUTHORIZATION, v);
    }

    // Streaming both ways. Buffering the request would cap prompt size at
    // whatever fits in memory; buffering the response would destroy the
    // token-by-token delivery the agent UI is built on.
    let body_stream = req
        .into_body()
        .into_data_stream()
        .map_err(std::io::Error::other);

    let upstream = state
        .http_client
        .request(method, &url)
        .headers(forward_headers)
        .body(reqwest::Body::wrap_stream(body_stream))
        .send()
        .await
        .map_err(|e| HttpError::runtime_unavailable(format!("upstream request failed: {e}")))?;

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = Response::builder().status(status);
    if let Some(headers) = out.headers_mut() {
        for (name, value) in upstream.headers() {
            if STRIP_RESPONSE_HEADERS.contains(&name.as_str()) {
                continue;
            }
            headers.insert(name.clone(), value.clone());
        }
    }

    // Upstream errors pass through verbatim: agent runtimes branch on the
    // provider's own status codes and error bodies.
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    out.body(Body::from_stream(stream))
        .map(IntoResponse::into_response)
        .map_err(|e| HttpError::internal(format!("failed to build proxy response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_callers_credential_before_forwarding() {
        // The runtime's daemon token must never reach the cloud gateway: it is
        // scoped to this daemon, and the gateway would reject it anyway.
        assert!(STRIP_REQUEST_HEADERS.contains(&"authorization"));
    }

    #[test]
    fn strips_hop_by_hop_framing_in_both_directions() {
        for h in ["connection", "transfer-encoding", "content-length"] {
            assert!(STRIP_REQUEST_HEADERS.contains(&h), "request: {h}");
            assert!(STRIP_RESPONSE_HEADERS.contains(&h), "response: {h}");
        }
    }

    #[test]
    fn keeps_content_type_so_json_and_sse_survive() {
        assert!(!STRIP_REQUEST_HEADERS.contains(&"content-type"));
        assert!(!STRIP_RESPONSE_HEADERS.contains(&"content-type"));
    }
}
