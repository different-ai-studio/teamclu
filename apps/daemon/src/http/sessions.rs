//! `/v1/sessions/*` route handlers + SSE stream + idempotency cache.
//!
//! These handlers do not own session state. They translate HTTP into
//! [`RuntimeAdapter`] calls and translate the adapter's
//! [`SessionEvent`] stream into SSE frames. Everything stateful (the
//! session table, ring buffers, broadcast channels) lives in the
//! adapter so the test [`StubRuntimeAdapter`] can stand in for the
//! real `RuntimeManager`-backed adapter without forking handler code.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::stream::{self, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};
use super::events::SessionEvent;
use super::runtime_adapter::{
    CreateSessionParams, PromptAck, PromptParams, ReplayPage, SessionSnapshot,
};
use super::state::HttpState;

// ── Idempotency cache ───────────────────────────────────────────────────────

/// Cached `(prompt_id, turn_id)` so re-submitting the same
/// `Idempotency-Key` returns the same ack instead of creating a
/// duplicate turn. Tied to a session — across sessions the same key is
/// allowed.
#[derive(Default)]
pub struct IdempotencyCache {
    entries: Mutex<HashMap<(Uuid, String), CachedAck>>,
}

struct CachedAck {
    ack: PromptAck,
    inserted_at: Instant,
}

const IDEMPOTENCY_TTL: Duration = Duration::from_secs(600);

impl IdempotencyCache {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn get(&self, session: Uuid, key: &str) -> Option<PromptAck> {
        let mut entries = self.entries.lock();
        let entry = entries.get(&(session, key.to_owned()))?;
        if entry.inserted_at.elapsed() > IDEMPOTENCY_TTL {
            entries.remove(&(session, key.to_owned()));
            return None;
        }
        Some(entry.ack.clone())
    }

    pub fn put(&self, session: Uuid, key: String, ack: PromptAck) {
        let mut entries = self.entries.lock();
        // Evict expired entries lazily on every insert. Keeps the cache
        // bounded without a separate reaper.
        entries.retain(|_, v| v.inserted_at.elapsed() < IDEMPOTENCY_TTL);
        entries.insert(
            (session, key),
            CachedAck {
                ack,
                inserted_at: Instant::now(),
            },
        );
    }
}

// ── Request/response shapes ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    #[serde(flatten)]
    pub snapshot: SessionSnapshot,
    pub stream_url: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct StreamQuery {
    #[serde(default)]
    pub access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub since: Option<u64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct SetModelParams {
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PermissionReplyParams {
    pub granted: bool,
    #[serde(default)]
    pub option_id: Option<String>,
}

// ── Handlers ────────────────────────────────────────────────────────────────

pub async fn create_session(
    principal: Principal,
    State(state): State<HttpState>,
    Json(params): Json<CreateSessionParams>,
) -> Result<(StatusCode, HeaderMap, Json<SessionResponse>), HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_cap(&state, principal.token_id).await?;
    let snap = state
        .runtime
        .create_session(principal.token_id, params)
        .await?;
    let stream_url = format!("/v1/sessions/{}/stream", snap.session_id);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::LOCATION,
        HeaderValue::from_str(&format!("/v1/sessions/{}", snap.session_id)).unwrap(),
    );
    headers.insert(
        "x-session-id",
        HeaderValue::from_str(&snap.session_id.to_string()).unwrap(),
    );
    state
        .session_index
        .record_owner(snap.session_id, principal.token_id);
    Ok((
        StatusCode::CREATED,
        headers,
        Json(SessionResponse {
            snapshot: snap,
            stream_url,
        }),
    ))
}

pub async fn list_sessions(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<Vec<SessionSnapshot>>, HttpError> {
    require_scope(&principal, "sessions:read")?;
    let sessions = state.runtime.list_sessions(principal.token_id).await;
    Ok(Json(sessions))
}

pub async fn get_session(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SessionSnapshot>, HttpError> {
    require_scope(&principal, "sessions:read")?;
    enforce_session_owner(&state, &principal, id)?;
    let snap = state.runtime.get_session(id).await?;
    Ok(Json(snap))
}

pub async fn delete_session(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_owner(&state, &principal, id)?;
    state.runtime.close_session(id).await?;
    state.session_index.forget(id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn send_prompt(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(params): Json<PromptParams>,
) -> Result<(StatusCode, Json<PromptAck>), HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_owner(&state, &principal, id)?;
    if params.text.trim().is_empty() {
        return Err(HttpError::validation("text must not be empty"));
    }
    if params.text.len() > state.config.max_body_bytes {
        return Err(HttpError::validation("text exceeds max_body_bytes"));
    }
    let idem_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty() && s.len() <= 128);

    if let Some(key) = idem_key.as_ref() {
        if let Some(cached) = state.idempotency.get(id, key) {
            return Ok((StatusCode::ACCEPTED, Json(cached)));
        }
    }

    let ack = state.runtime.send_prompt(id, params).await?;

    if let Some(key) = idem_key {
        state.idempotency.put(id, key, ack.clone());
    }

    Ok((StatusCode::ACCEPTED, Json(ack)))
}

#[derive(Debug, Deserialize)]
pub struct CancelParams {
    #[serde(default)]
    pub turn_id: Option<Uuid>,
}

pub async fn cancel(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
    Json(params): Json<CancelParams>,
) -> Result<StatusCode, HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_owner(&state, &principal, id)?;
    state.runtime.cancel(id, params.turn_id).await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn set_model(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
    Json(body): Json<SetModelParams>,
) -> Result<StatusCode, HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_owner(&state, &principal, id)?;
    state.runtime.set_model(id, body.model_id).await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn reply_permission(
    principal: Principal,
    State(state): State<HttpState>,
    Path((id, request_id)): Path<(Uuid, String)>,
    Json(body): Json<PermissionReplyParams>,
) -> Result<StatusCode, HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_owner(&state, &principal, id)?;
    state
        .runtime
        .reply_permission(id, request_id, body.granted, body.option_id)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn restart(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SessionSnapshot>, HttpError> {
    require_scope(&principal, "sessions:write")?;
    enforce_session_owner(&state, &principal, id)?;
    let snapshot = state.runtime.restart_session(id).await?;
    Ok(Json(snapshot))
}

pub async fn replay_events(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<ReplayPage>, HttpError> {
    require_scope(&principal, "events:read")?;
    enforce_session_owner(&state, &principal, id)?;
    let since = q.since.unwrap_or(0);
    let limit = q.limit.unwrap_or(200);
    let page = state.runtime.replay(id, since, limit).await?;
    Ok(Json(page))
}

// ── SSE ─────────────────────────────────────────────────────────────────────

/// `GET /v1/sessions/:id/stream`
pub async fn stream(
    principal: Principal,
    State(state): State<HttpState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    require_scope(&principal, "events:read")?;
    enforce_session_owner(&state, &principal, id)?;
    let last_event_id: Option<u64> = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    let sub = state.runtime.subscribe(id, last_event_id).await?;
    let heartbeat = state.config.heartbeat_interval;

    let response = build_sse_response(sub.backlog, sub.live, heartbeat, state.shutdown.triggered());
    Ok(response)
}

fn build_sse_response(
    backlog: Vec<SessionEvent>,
    live: tokio::sync::broadcast::Receiver<SessionEvent>,
    heartbeat: Duration,
    // Ends the stream at daemon shutdown (see `ShutdownSignal`).
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Response {
    // 1. Flush backlog first
    let backlog_stream = stream::iter(
        backlog
            .into_iter()
            .map(|e| Ok::<_, std::io::Error>(e.encode_sse().into_bytes())),
    );

    // 2. Live events
    let live_stream = BroadcastStream::new(live).filter_map(|res| async move {
        match res {
            Ok(ev) => Some(Ok::<_, std::io::Error>(ev.encode_sse().into_bytes())),
            Err(_) => None, // slow subscriber lag — drop and continue
        }
    });

    // 3. Heartbeat ticks interleaved with live (keeps idle connections
    // warm + lets the server notice TCP-level disconnects).
    let hb_stream = {
        let interval = tokio::time::interval(heartbeat);
        let s = tokio_stream::wrappers::IntervalStream::new(interval);
        s.map(|_| Ok::<_, std::io::Error>(b":hb\n\n".to_vec()))
    };

    let live_with_hb = futures::stream::select(live_stream, hb_stream);
    let combined = backlog_stream.chain(live_with_hb).take_until(shutdown);

    let body = Body::from_stream(combined);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-accel-buffering", "no")
        .header(header::CONNECTION, "keep-alive")
        .body(body)
        .unwrap()
        .into_response()
}

// ── Caps and ownership ──────────────────────────────────────────────────────

/// Tracks token_id → set of session_ids it created. Used by both the
/// session cap enforcer and the `enforce_session_owner` guard so callers
/// can only manipulate sessions their token minted (or, for shared
/// scenarios, sessions later transferred to them — out of scope here).
#[derive(Default)]
pub struct SessionOwnerIndex {
    inner: Mutex<HashMap<Uuid, Uuid>>, // session_id → owner_token_id
}

impl SessionOwnerIndex {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn record_owner(&self, session_id: Uuid, owner_token_id: Uuid) {
        self.inner.lock().insert(session_id, owner_token_id);
    }

    pub fn owner_of(&self, session_id: Uuid) -> Option<Uuid> {
        self.inner.lock().get(&session_id).copied()
    }

    pub fn count_owned_by(&self, owner_token_id: Uuid) -> usize {
        self.inner
            .lock()
            .values()
            .filter(|v| **v == owner_token_id)
            .count()
    }

    pub fn forget(&self, session_id: Uuid) {
        self.inner.lock().remove(&session_id);
    }
}

async fn enforce_session_cap(state: &HttpState, owner: Uuid) -> Result<(), HttpError> {
    let cap = state.config.max_sessions_per_token as usize;
    if state.session_index.count_owned_by(owner) >= cap {
        return Err(HttpError::new(
            ErrorCode::Conflict,
            format!("max_sessions_per_token={cap} reached"),
        ));
    }
    Ok(())
}

fn enforce_session_owner(
    state: &HttpState,
    principal: &Principal,
    session_id: Uuid,
) -> Result<(), HttpError> {
    if principal.scopes.iter().any(|s| s == "admin") {
        return Ok(());
    }
    match state.session_index.owner_of(session_id) {
        Some(owner) if owner == principal.token_id => Ok(()),
        Some(_) => Err(HttpError::forbidden("session belongs to a different token")),
        None => Err(HttpError::session_not_found(&session_id.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_cache_returns_same_ack() {
        let cache = IdempotencyCache::new();
        let s = Uuid::new_v4();
        let ack = PromptAck {
            prompt_id: Uuid::new_v4(),
            turn_id: Uuid::new_v4(),
        };
        cache.put(s, "k1".into(), ack.clone());
        let got = cache.get(s, "k1").unwrap();
        assert_eq!(got.prompt_id, ack.prompt_id);
        assert!(cache.get(s, "missing").is_none());
        assert!(cache.get(Uuid::new_v4(), "k1").is_none());
    }

    #[test]
    fn owner_index_isolation() {
        let idx = SessionOwnerIndex::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let s1 = Uuid::new_v4();
        idx.record_owner(s1, a);
        assert_eq!(idx.owner_of(s1), Some(a));
        assert_eq!(idx.count_owned_by(a), 1);
        assert_eq!(idx.count_owned_by(b), 0);
        idx.forget(s1);
        assert!(idx.owner_of(s1).is_none());
    }
}
