//! Abstraction layer between the HTTP plane and the agent runtime.
//!
//! The HTTP layer never speaks to [`crate::runtime::RuntimeManager`]
//! directly — it goes through the [`RuntimeAdapter`] trait. This keeps
//! three things possible at once:
//!
//! 1. The HTTP routes have a small, testable surface area.
//! 2. The real `RuntimeManager` integration (which is a substantial
//!    refactor on its own) lives behind a single implementation that
//!    can ship in a follow-up PR without touching the routes.
//! 3. Integration tests drive a [`StubRuntimeAdapter`] that emits
//!    synthetic token streams — the exact same SSE pipe end-to-end,
//!    minus the agent process.
//!
//! ### Mental model
//!
//! - A `RuntimeAdapter` owns a pool of *logical sessions*. Each session
//!   has an id, an agent type, and an event broadcaster.
//! - The HTTP plane calls `create_session`, `send_prompt`, `cancel`,
//!   `close_session`. Everything else is observation via the event
//!   stream returned by `subscribe`.
//! - Events are typed [`crate::http::events::SessionEvent`]s, not raw
//!   ACP envelopes. The adapter is responsible for translating.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::adapter::{runtime_envelopes_from_acp_event, RuntimeEnvelope};
use crate::runtime::supervisor::prepare_workspace;
use crate::runtime::RuntimeManager;

use super::errors::HttpError;
use super::events::SessionEvent;

/// Parameters accepted by [`RuntimeAdapter::create_session`].
#[derive(Debug, Clone, Deserialize)]
pub struct CreateSessionParams {
    pub agent_type: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub model: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub metadata: Option<serde_json::Value>,
}

/// Snapshot a created or fetched session — returned by both
/// `create_session` and `get_session`. Pure data; cheap to clone.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub session_id: Uuid,
    pub agent_type: String,
    pub runtime_id: String,
    pub workspace_id: Option<String>,
    pub current_model: Option<String>,
    pub state: SessionState,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_activity: chrono::DateTime<chrono::Utc>,
    pub last_event_seq: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    Cancelling,
    Errored,
    Closed,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptParams {
    pub text: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub attachments: Vec<serde_json::Value>,
    #[serde(default)]
    #[allow(dead_code)]
    pub mentions: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptAck {
    pub prompt_id: Uuid,
    pub turn_id: Uuid,
}

/// Backplane the HTTP layer drives. Implementations:
///
/// - [`StubRuntimeAdapter`]: emits scripted token deltas; used by the
///   integration test suite and as a development placeholder until the
///   real `RuntimeManager` adapter ships.
/// - `RuntimeManagerAdapter` (future): proxies to the existing
///   `Arc<AsyncMutex<RuntimeManager>>` in `daemon/server.rs`.
#[async_trait]
pub trait RuntimeAdapter: Send + Sync {
    /// Whose token created this — used to scope listing/deletion. The
    /// HTTP layer caches the owner; adapters needn't persist it.
    async fn create_session(
        &self,
        owner_token_id: Uuid,
        params: CreateSessionParams,
    ) -> Result<SessionSnapshot, HttpError>;

    async fn get_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError>;

    async fn list_sessions(&self, owner_token_id: Uuid) -> Vec<SessionSnapshot>;

    async fn close_session(&self, session_id: Uuid) -> Result<(), HttpError>;

    async fn send_prompt(
        &self,
        session_id: Uuid,
        params: PromptParams,
    ) -> Result<PromptAck, HttpError>;

    async fn set_model(&self, session_id: Uuid, model_id: String) -> Result<(), HttpError>;

    async fn reply_permission(
        &self,
        session_id: Uuid,
        request_id: String,
        granted: bool,
        option_id: Option<String>,
    ) -> Result<(), HttpError>;

    async fn restart_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError>;

    async fn cancel(&self, session_id: Uuid, turn_id: Option<Uuid>) -> Result<(), HttpError>;

    /// Subscribe to live events for `session_id`. Returns a broadcast
    /// receiver pre-filled with the buffered backlog *after* `since`
    /// (when `since` is provided) plus a "fast-forward" snapshot of
    /// dropped events. Implementations should ensure ordering — the
    /// HTTP layer assumes monotonic `seq`.
    async fn subscribe(
        &self,
        session_id: Uuid,
        since: Option<u64>,
    ) -> Result<SubscriptionHandle, HttpError>;

    /// Bounded replay used by `GET /v1/sessions/:id/events`.
    async fn replay(
        &self,
        session_id: Uuid,
        since: u64,
        limit: usize,
    ) -> Result<ReplayPage, HttpError>;
}

#[async_trait]
pub(crate) trait RuntimeExecutionContextAssembler: Send + Sync {
    async fn assemble(
        &self,
        working_directory: &str,
        workspace_id: Option<&str>,
    ) -> Result<crate::runtime::execution_context::ExecutionContext, String>;
}

#[derive(Debug)]
pub struct SubscriptionHandle {
    /// Events that were buffered and need to be flushed before the live
    /// stream begins. The HTTP layer drains this list first.
    pub backlog: Vec<SessionEvent>,
    /// Live channel. Receiver dropped → adapter unsubscribes.
    pub live: broadcast::Receiver<SessionEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplayPage {
    pub events: Vec<SessionEvent>,
    pub next_cursor: Option<u64>,
    pub window_oldest_seq: Option<u64>,
}

// ── Stub implementation ─────────────────────────────────────────────────────

use super::events::{EventKind, EventRingBuffer};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// In-memory adapter used by tests and for the development preview.
/// Emits a scripted token stream when a prompt is received; otherwise
/// behaves like a real adapter (state machine, backlog buffer, replay
/// window) so the HTTP plane is exercised end-to-end.
pub struct StubRuntimeAdapter {
    inner: Arc<StubInner>,
}

struct StubInner {
    sessions: RwLock<HashMap<Uuid, StubSession>>,
    backlog_cap: usize,
}

struct StubSession {
    snap: SessionSnapshot,
    owner_token_id: Uuid,
    tx: broadcast::Sender<SessionEvent>,
    ring: EventRingBuffer,
    next_seq: u64,
}

impl StubRuntimeAdapter {
    pub fn new(backlog_cap: usize) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(StubInner {
                sessions: RwLock::new(HashMap::new()),
                backlog_cap,
            }),
        })
    }

    fn emit(&self, session_id: Uuid, kind: EventKind, data: serde_json::Value) -> Option<u64> {
        let mut sessions = self.inner.sessions.write();
        let s = sessions.get_mut(&session_id)?;
        s.next_seq += 1;
        let event = SessionEvent::new(session_id, s.next_seq, kind, data);
        s.ring.push(event.clone());
        s.snap.last_event_seq = s.next_seq;
        s.snap.last_activity = chrono::Utc::now();
        let _ = s.tx.send(event);
        Some(s.next_seq)
    }

    fn set_state(&self, session_id: Uuid, new_state: SessionState, reason: Option<&str>) {
        // Update the snapshot's state, then emit a session.state event
        // so subscribers learn about the transition.
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.get_mut(&session_id) {
                s.snap.state = new_state;
            }
        }
        let mut data = serde_json::json!({"state": new_state});
        if let Some(r) = reason {
            data["reason"] = serde_json::Value::String(r.into());
        }
        self.emit(session_id, EventKind::SessionState, data);
    }
}

#[async_trait]
impl RuntimeAdapter for StubRuntimeAdapter {
    async fn create_session(
        &self,
        owner_token_id: Uuid,
        params: CreateSessionParams,
    ) -> Result<SessionSnapshot, HttpError> {
        let session_id = Uuid::new_v4();
        let now = chrono::Utc::now();
        let (tx, _rx) = broadcast::channel::<SessionEvent>(256);
        let snap = SessionSnapshot {
            session_id,
            agent_type: params.agent_type.clone(),
            runtime_id: format!("stub-rt-{}", &session_id.to_string()[..8]),
            workspace_id: params.workspace_id.clone(),
            current_model: params.model.clone(),
            state: SessionState::Idle,
            created_at: now,
            last_activity: now,
            last_event_seq: 0,
        };
        {
            let mut sessions = self.inner.sessions.write();
            sessions.insert(
                session_id,
                StubSession {
                    snap: snap.clone(),
                    owner_token_id,
                    tx,
                    ring: EventRingBuffer::new(self.inner.backlog_cap),
                    next_seq: 0,
                },
            );
        }
        self.emit(
            session_id,
            EventKind::SessionCreated,
            serde_json::json!({
                "session_id": session_id,
                "agent_type": params.agent_type,
            }),
        );

        if let Some(prompt) = params.initial_prompt {
            self.send_prompt(
                session_id,
                PromptParams {
                    text: prompt,
                    attachments: vec![],
                    mentions: vec![],
                    metadata: None,
                },
            )
            .await?;
        }

        Ok(snap)
    }

    async fn get_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError> {
        self.inner
            .sessions
            .read()
            .get(&session_id)
            .map(|s| s.snap.clone())
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))
    }

    async fn list_sessions(&self, owner_token_id: Uuid) -> Vec<SessionSnapshot> {
        self.inner
            .sessions
            .read()
            .values()
            .filter(|s| s.owner_token_id == owner_token_id)
            .map(|s| s.snap.clone())
            .collect()
    }

    async fn close_session(&self, session_id: Uuid) -> Result<(), HttpError> {
        {
            let exists = self.inner.sessions.read().contains_key(&session_id);
            if !exists {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
        }
        self.set_state(session_id, SessionState::Closed, Some("explicit_close"));
        self.emit(
            session_id,
            EventKind::SessionClosed,
            serde_json::json!({"reason": "explicit_close"}),
        );
        Ok(())
    }

    async fn send_prompt(
        &self,
        session_id: Uuid,
        params: PromptParams,
    ) -> Result<PromptAck, HttpError> {
        {
            let sessions = self.inner.sessions.read();
            let s = sessions
                .get(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            if matches!(s.snap.state, SessionState::Running) {
                return Err(HttpError::new(
                    super::errors::ErrorCode::SessionBusy,
                    "session is already processing a prompt",
                ));
            }
            if matches!(s.snap.state, SessionState::Closed) {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
        }

        let prompt_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let ack = PromptAck { prompt_id, turn_id };

        self.emit(
            session_id,
            EventKind::PromptAccepted,
            serde_json::json!({
                "prompt_id": prompt_id,
                "text": params.text,
                "at": chrono::Utc::now(),
            }),
        );
        self.set_state(session_id, SessionState::Running, None);
        self.emit(
            session_id,
            EventKind::TurnStarted,
            serde_json::json!({"turn_id": turn_id, "prompt_id": prompt_id}),
        );

        // Scripted token stream — runs in background so the HTTP
        // handler can return 202 immediately.
        let adapter = self.clone();
        let text = params.text;
        tokio::spawn(async move {
            for (idx, ch) in text.chars().enumerate() {
                adapter.emit(
                    session_id,
                    EventKind::TokenDelta,
                    serde_json::json!({
                        "turn_id": turn_id,
                        "index": idx as u64,
                        "text": ch.to_string(),
                    }),
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            adapter.emit(
                session_id,
                EventKind::MessageCompleted,
                serde_json::json!({
                    "turn_id": turn_id,
                    "role": "assistant",
                    "content": text,
                    "usage": {"input": text.len(), "output": text.len()},
                }),
            );
            adapter.emit(
                session_id,
                EventKind::TurnFinished,
                serde_json::json!({"turn_id": turn_id, "reason": "stop"}),
            );
            adapter.set_state(session_id, SessionState::Idle, None);
        });

        Ok(ack)
    }

    async fn set_model(&self, session_id: Uuid, model_id: String) -> Result<(), HttpError> {
        let mut sessions = self.inner.sessions.write();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        session.snap.current_model = Some(model_id);
        session.snap.last_activity = chrono::Utc::now();
        Ok(())
    }

    async fn reply_permission(
        &self,
        session_id: Uuid,
        _request_id: String,
        _granted: bool,
        _option_id: Option<String>,
    ) -> Result<(), HttpError> {
        let exists = self.inner.sessions.read().contains_key(&session_id);
        if !exists {
            return Err(HttpError::session_not_found(&session_id.to_string()));
        }
        Ok(())
    }

    async fn restart_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError> {
        let mut sessions = self.inner.sessions.write();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        session.snap.state = SessionState::Idle;
        session.snap.last_activity = chrono::Utc::now();
        Ok(session.snap.clone())
    }

    async fn cancel(&self, session_id: Uuid, turn_id: Option<Uuid>) -> Result<(), HttpError> {
        {
            let exists = self.inner.sessions.read().contains_key(&session_id);
            if !exists {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
        }
        self.set_state(session_id, SessionState::Cancelling, None);
        self.emit(
            session_id,
            EventKind::TurnFinished,
            serde_json::json!({"turn_id": turn_id, "reason": "cancel"}),
        );
        self.set_state(session_id, SessionState::Idle, None);
        Ok(())
    }

    async fn subscribe(
        &self,
        session_id: Uuid,
        since: Option<u64>,
    ) -> Result<SubscriptionHandle, HttpError> {
        let sessions = self.inner.sessions.read();
        let s = sessions
            .get(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        let oldest = s.ring.oldest_seq();
        if let Some(since) = since {
            if let Some(oldest) = oldest {
                if since + 1 < oldest {
                    return Err(HttpError::new(
                        super::errors::ErrorCode::EventGone,
                        format!(
                            "Last-Event-ID {since} is below window {oldest}; refetch session snapshot before reconnecting"
                        ),
                    ));
                }
            }
        }
        let backlog: Vec<_> = match since {
            Some(s_) => s.ring.replay_after(s_).cloned().collect(),
            None => s.ring.snapshot(),
        };
        let live = s.tx.subscribe();
        Ok(SubscriptionHandle { backlog, live })
    }

    async fn replay(
        &self,
        session_id: Uuid,
        since: u64,
        limit: usize,
    ) -> Result<ReplayPage, HttpError> {
        let sessions = self.inner.sessions.read();
        let s = sessions
            .get(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        let limit = limit.clamp(1, 500);
        let events = s.ring.replay_after_limited(since, limit);
        let next_cursor = events.last().map(|e| e.seq);
        Ok(ReplayPage {
            events,
            next_cursor,
            window_oldest_seq: s.ring.oldest_seq(),
        })
    }
}

// Stub needs Clone to capture itself into the spawned token-emitter
// task. Cloning shares the Arc<StubInner> so all clones observe the
// same session map.
impl Clone for StubRuntimeAdapter {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

// ── RuntimeManager facade ───────────────────────────────────────────────────

pub struct RuntimeManagerAdapter {
    manager: Arc<tokio::sync::Mutex<RuntimeManager>>,
    sessions: Arc<RwLock<HashMap<Uuid, ManagedSession>>>,
    backlog_cap: usize,
    refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    execution_context_assembler: Option<Arc<dyn RuntimeExecutionContextAssembler>>,
}

struct ManagedSession {
    snapshot: SessionSnapshot,
    owner_token_id: Uuid,
    workspace_id: Option<String>,
    runtime_id: String,
    event_tx: broadcast::Sender<SessionEvent>,
    ring: EventRingBuffer,
    next_seq: u64,
    active_turn_id: Option<Uuid>,
    buffered_output: String,
}

impl RuntimeManagerAdapter {
    pub fn new(
        manager: Arc<tokio::sync::Mutex<RuntimeManager>>,
        backlog_cap: usize,
        refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    ) -> Arc<Self> {
        Self::new_with_execution_context_assembler(manager, backlog_cap, refresh, None)
    }

    pub(crate) fn new_with_execution_context_assembler(
        manager: Arc<tokio::sync::Mutex<RuntimeManager>>,
        backlog_cap: usize,
        refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
        execution_context_assembler: Option<Arc<dyn RuntimeExecutionContextAssembler>>,
    ) -> Arc<Self> {
        let adapter = Arc::new(Self {
            manager,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            backlog_cap,
            refresh,
            execution_context_assembler,
        });
        Self::spawn_event_pump(&adapter);
        adapter
    }

    fn spawn_event_pump(this: &Arc<Self>) {
        let adapter = Arc::clone(this);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(10));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                // Only drain runtimes this HTTP adapter actually owns (have an
                // active SSE session). Events for runtimes driven by the MQTT
                // collaboration path (desktop chat) MUST stay queued for the
                // daemon main loop's `poll_events()` → `forward_agent_event`
                // → `session/live` publish. Draining them here would silently
                // discard them in `process_runtime_event` (no HTTP session →
                // early return), starving the desktop of agent replies.
                let owned: std::collections::HashSet<String> = adapter
                    .sessions
                    .read()
                    .values()
                    .map(|s| s.runtime_id.clone())
                    .collect();
                if owned.is_empty() {
                    continue;
                }
                let drained = {
                    let mut manager = adapter.manager.lock().await;
                    manager.poll_events_for(&owned)
                };
                for (runtime_id, frame) in drained {
                    let skip_child = {
                        let manager = adapter.manager.lock().await;
                        manager
                            .get_handle(&runtime_id)
                            .map(|h| {
                                !frame.acp_session_id.is_empty()
                                    && frame.acp_session_id != h.acp_session_id
                            })
                            .unwrap_or(false)
                    };
                    if skip_child {
                        continue;
                    }
                    adapter.process_runtime_event(&runtime_id, frame.event);
                }
            }
        });
    }

    async fn assemble_execution_context(
        &self,
        worktree: &str,
        workspace_id: Option<&str>,
    ) -> Result<crate::runtime::execution_context::ExecutionContext, HttpError> {
        let context_assembler = self.execution_context_assembler.as_ref().ok_or_else(|| {
            HttpError::internal("runtime execution context assembler unavailable")
        })?;
        // Legacy HTTP callers may encode the path directly in workspace_id.
        // That value is not a cloud workspace UUID; resolve its canonical
        // identity from the decoded execution path instead.
        let workspace_id_hint =
            workspace_id.filter(|id| crate::config::decode_workspace_path(id).is_err());
        context_assembler
            .assemble(worktree, workspace_id_hint)
            .await
            .map_err(|e| HttpError::internal(format!("assemble runtime context: {e}")))
    }

    async fn spawn_runtime(
        &self,
        session_id: Uuid,
        agent_type: amux::AgentType,
        workspace_id: Option<String>,
        model: Option<String>,
        initial_prompt: Option<String>,
    ) -> Result<String, HttpError> {
        #[cfg(test)]
        {
            // The attachment key is the session (ADR-0004).
            let runtime_id = session_id.to_string();
            let mut manager = self.manager.lock().await;
            manager.add_test_runtime(&runtime_id);
            let startup_prompt = initial_prompt.clone();
            let event_tx = if let Some(handle) = manager.get_handle_mut(&runtime_id) {
                handle.agent_type = agent_type;
                handle.workspace_id = workspace_id.clone().unwrap_or_default();
                handle.current_prompt = startup_prompt.clone().unwrap_or_default();
                Some(handle.event_tx.clone())
            } else {
                None
            };
            if let Some(model_id) = model {
                manager.set_current_model(&runtime_id, &model_id);
            }
            if let (Some(event_tx), Some(text)) = (event_tx, startup_prompt) {
                tokio::spawn(async move {
                    let _ = event_tx
                        .send(AcpEventFrame::new(
                            "acp-test",
                            amux::AcpEvent {
                                event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                                    text,
                                    is_complete: true,
                                })),
                                model: String::new(),
                            },
                        ))
                        .await;
                });
            }
            return Ok(runtime_id);
        }

        #[cfg(not(test))]
        {
            self.spawn_runtime_with_resolved_context(
                session_id,
                agent_type,
                workspace_id,
                model,
                initial_prompt,
            )
            .await
        }
    }

    pub(crate) async fn spawn_runtime_with_resolved_context(
        &self,
        session_id: Uuid,
        agent_type: amux::AgentType,
        workspace_id: Option<String>,
        model: Option<String>,
        initial_prompt: Option<String>,
    ) -> Result<String, HttpError> {
        let context = self
            .resolve_spawn_execution_context(workspace_id.as_deref())
            .await?;
        self.spawn_runtime_in_context(
            session_id,
            agent_type,
            workspace_id,
            model,
            initial_prompt,
            context,
        )
        .await
    }

    async fn resolve_spawn_execution_context(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<crate::runtime::execution_context::ExecutionContext, HttpError> {
        let path_hint = workspace_id
            .filter(|id| !id.trim().is_empty())
            .and_then(|id| {
                crate::config::decode_workspace_path(id)
                    .ok()
                    .or_else(|| std::path::Path::new(id).is_dir().then(|| id.into()))
            });
        let cloud_workspace_id = workspace_id
            .filter(|id| !id.trim().is_empty())
            .filter(|_| path_hint.is_none());
        self.assemble_execution_context(
            path_hint
                .as_deref()
                .map(|path| path.to_string_lossy())
                .as_deref()
                .unwrap_or(""),
            cloud_workspace_id,
        )
        .await
    }

    async fn spawn_runtime_in_worktree(
        &self,
        session_id: Uuid,
        agent_type: amux::AgentType,
        workspace_id: Option<String>,
        model: Option<String>,
        initial_prompt: Option<String>,
        worktree: &str,
    ) -> Result<String, HttpError> {
        let context = self
            .assemble_execution_context(worktree, workspace_id.as_deref())
            .await?;
        self.spawn_runtime_in_context(
            session_id,
            agent_type,
            workspace_id,
            model,
            initial_prompt,
            context,
        )
        .await
    }

    async fn spawn_runtime_in_context(
        &self,
        session_id: Uuid,
        agent_type: amux::AgentType,
        workspace_id: Option<String>,
        model: Option<String>,
        initial_prompt: Option<String>,
        context: crate::runtime::execution_context::ExecutionContext,
    ) -> Result<String, HttpError> {
        let worktree = context.working_directory.to_string_lossy().into_owned();
        if let Some(ref refresh) = self.refresh {
            crate::runtime::refresh::refresh_watch::suppress_for_workspace_path(
                refresh,
                std::path::Path::new(&worktree),
                &crate::runtime::refresh::INTERNAL_PREPARE_KINDS,
                crate::runtime::refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
        prepare_workspace(std::path::Path::new(&worktree)).map_err(|e| {
            HttpError::internal(format!("prepare workspace for runtime spawn: {e}"))
        })?;
        let mut manager = self.manager.lock().await;
        manager
            .start_runtime_with_model(
                agent_type,
                initial_prompt.as_deref().unwrap_or(""),
                workspace_id.as_deref().unwrap_or(""),
                None,
                &session_id.to_string(),
                model,
                None,
                None,
                false,
                context,
            )
            .await
            .map_err(|e| HttpError::internal(format!("spawn runtime: {e}")))
    }

    fn emit(&self, session_id: Uuid, event: SessionEvent) {
        let mut sessions = self.sessions.write();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.snapshot.last_event_seq = event.seq;
            session.snapshot.last_activity = chrono::Utc::now();
            session.ring.push(event.clone());
            let _ = session.event_tx.send(event);
        }
    }

    fn emit_next(&self, session_id: Uuid, event: RuntimeEnvelope) {
        let session_event = {
            let mut sessions = self.sessions.write();
            let Some(session) = sessions.get_mut(&session_id) else {
                return;
            };
            session.next_seq += 1;
            let event = translate_runtime_event(session.next_seq, session_id, event);
            session.snapshot.last_event_seq = event.seq;
            session.snapshot.last_activity = chrono::Utc::now();
            session.ring.push(event.clone());
            let _ = session.event_tx.send(event.clone());
            event
        };
        let _ = session_event;
    }

    fn set_state(&self, session_id: Uuid, new_state: SessionState, reason: Option<&str>) {
        let event = {
            let mut sessions = self.sessions.write();
            let Some(session) = sessions.get_mut(&session_id) else {
                return;
            };
            session.snapshot.state = new_state;
            session.next_seq += 1;
            let mut data = serde_json::json!({ "state": new_state });
            if let Some(reason) = reason {
                data["reason"] = serde_json::Value::String(reason.to_string());
            }
            let event =
                SessionEvent::new(session_id, session.next_seq, EventKind::SessionState, data);
            session.snapshot.last_event_seq = event.seq;
            session.snapshot.last_activity = chrono::Utc::now();
            session.ring.push(event.clone());
            let _ = session.event_tx.send(event.clone());
            event
        };
        let _ = event;
    }

    fn session_id_for_runtime(&self, runtime_id: &str) -> Option<Uuid> {
        self.sessions
            .read()
            .iter()
            .find_map(|(session_id, session)| {
                (session.runtime_id == runtime_id).then_some(*session_id)
            })
    }

    fn process_runtime_event(&self, runtime_id: &str, event: amux::AcpEvent) {
        let Some(session_id) = self.session_id_for_runtime(runtime_id) else {
            return;
        };

        for envelope in runtime_envelopes_from_acp_event(&event) {
            match envelope {
                RuntimeEnvelope::TokenDelta { text } => {
                    {
                        let mut sessions = self.sessions.write();
                        if let Some(session) = sessions.get_mut(&session_id) {
                            session.buffered_output.push_str(&text);
                        }
                    }
                    self.emit_next(session_id, RuntimeEnvelope::TokenDelta { text });
                }
                RuntimeEnvelope::ToolCall { tool_name, args } => {
                    self.emit_next(session_id, RuntimeEnvelope::ToolCall { tool_name, args });
                }
                RuntimeEnvelope::ToolResult {
                    tool_id,
                    success,
                    summary,
                } => {
                    self.emit_next(
                        session_id,
                        RuntimeEnvelope::ToolResult {
                            tool_id,
                            success,
                            summary,
                        },
                    );
                }
                RuntimeEnvelope::MessageCompleted {
                    message_id,
                    content,
                } => {
                    let turn_id = {
                        let mut sessions = self.sessions.write();
                        let Some(session) = sessions.get_mut(&session_id) else {
                            return;
                        };
                        if session.buffered_output.is_empty() {
                            session.buffered_output = content.clone();
                        }
                        session.active_turn_id.take()
                    };
                    self.emit_next(
                        session_id,
                        RuntimeEnvelope::MessageCompleted {
                            message_id,
                            content,
                        },
                    );
                    if let Some(turn_id) = turn_id {
                        self.emit_next(session_id, RuntimeEnvelope::TurnFinished { turn_id });
                        self.set_state(session_id, SessionState::Idle, None);
                    }
                }
                RuntimeEnvelope::SessionError { message, details } => {
                    self.emit_next(
                        session_id,
                        RuntimeEnvelope::SessionError { message, details },
                    );
                    self.set_state(session_id, SessionState::Errored, Some("runtime_error"));
                }
                RuntimeEnvelope::StatusChanged { status } => match status {
                    amux::AgentStatus::Idle => {
                        let pending = {
                            let mut sessions = self.sessions.write();
                            let Some(session) = sessions.get_mut(&session_id) else {
                                return;
                            };
                            session.active_turn_id.take().map(|turn_id| {
                                (turn_id, std::mem::take(&mut session.buffered_output))
                            })
                        };
                        if let Some((turn_id, content)) = pending {
                            self.emit_next(
                                session_id,
                                RuntimeEnvelope::MessageCompleted {
                                    message_id: Uuid::new_v4(),
                                    content,
                                },
                            );
                            self.emit_next(session_id, RuntimeEnvelope::TurnFinished { turn_id });
                        }
                        self.set_state(session_id, SessionState::Idle, None);
                    }
                    amux::AgentStatus::Active | amux::AgentStatus::Starting => {
                        self.set_state(session_id, SessionState::Running, None);
                    }
                    amux::AgentStatus::Stopped => {
                        self.set_state(session_id, SessionState::Closed, Some("runtime_stopped"));
                    }
                    _ => {}
                },
                RuntimeEnvelope::TurnFinished { turn_id } => {
                    self.emit_next(session_id, RuntimeEnvelope::TurnFinished { turn_id });
                    self.set_state(session_id, SessionState::Idle, None);
                }
            }
        }
    }

    fn insert_managed_session(
        &self,
        owner_token_id: Uuid,
        session_id: Uuid,
        params: &CreateSessionParams,
        runtime_id: String,
    ) -> SessionSnapshot {
        let now = chrono::Utc::now();
        let (event_tx, _event_rx) = broadcast::channel::<SessionEvent>(256);
        let snapshot = SessionSnapshot {
            session_id,
            agent_type: params.agent_type.clone(),
            runtime_id: runtime_id.clone(),
            workspace_id: params.workspace_id.clone(),
            current_model: params.model.clone(),
            state: SessionState::Idle,
            created_at: now,
            last_activity: now,
            last_event_seq: 0,
        };
        {
            let mut sessions = self.sessions.write();
            sessions.insert(
                session_id,
                ManagedSession {
                    snapshot: snapshot.clone(),
                    owner_token_id,
                    workspace_id: params.workspace_id.clone(),
                    runtime_id,
                    event_tx,
                    ring: EventRingBuffer::new(self.backlog_cap),
                    next_seq: 0,
                    active_turn_id: None,
                    buffered_output: String::new(),
                },
            );
        }
        self.emit(
            session_id,
            SessionEvent::new(
                session_id,
                1,
                EventKind::SessionCreated,
                serde_json::json!({
                    "session_id": session_id,
                    "agent_type": params.agent_type,
                }),
            ),
        );
        {
            let mut sessions = self.sessions.write();
            if let Some(session) = sessions.get_mut(&session_id) {
                session.next_seq = 1;
            }
        }
        snapshot
    }
}

/// Parse the wire `agent_type` for the local HTTP API.
///
/// Must stay in step with `daemon::runtime_resolution::agent_type_from_name`,
/// which is the same mapping for the MQTT path. It cannot simply delegate: the
/// integration-test harness (`tests/support/crate_modules.rs`) stitches together
/// a subset of the crate that deliberately excludes `daemon`, so `http` may not
/// reach into it. The duplication is why this table had drifted to
/// `opencode | codex | claude*` — accepting codex, which has no backend at all,
/// while rejecting cursor and pi with a 400. Two of the four runtimes the daemon
/// can actually run were unreachable over local HTTP.
fn parse_agent_type(agent_type: &str) -> Result<amux::AgentType, HttpError> {
    match agent_type.trim() {
        "opencode" => Ok(amux::AgentType::Opencode),
        "pi" => Ok(amux::AgentType::Pi),
        "cursor" => Ok(amux::AgentType::Cursor),
        "claude" | "claude_code" | "claude-code" => Ok(amux::AgentType::ClaudeCode),
        // Kept for back-compat with callers that still send it. There is no codex
        // backend, so `resolve_requested_agent_type` reroutes it to whatever this
        // daemon actually runs.
        "codex" => Ok(amux::AgentType::Codex),
        other => Err(HttpError::new(
            super::errors::ErrorCode::BadRequest,
            format!("unsupported agent_type: {other}"),
        )),
    }
}

fn translate_runtime_event(seq: u64, session_id: Uuid, event: RuntimeEnvelope) -> SessionEvent {
    match event {
        RuntimeEnvelope::TokenDelta { text } => SessionEvent::new(
            session_id,
            seq,
            EventKind::TokenDelta,
            serde_json::json!({ "text": text }),
        ),
        RuntimeEnvelope::ToolCall { tool_name, args } => SessionEvent::new(
            session_id,
            seq,
            EventKind::ToolCall,
            serde_json::json!({ "tool_name": tool_name, "args": args }),
        ),
        RuntimeEnvelope::ToolResult {
            tool_id,
            success,
            summary,
        } => SessionEvent::new(
            session_id,
            seq,
            EventKind::ToolResult,
            serde_json::json!({ "tool_id": tool_id, "success": success, "summary": summary }),
        ),
        RuntimeEnvelope::MessageCompleted {
            message_id,
            content,
        } => SessionEvent::new(
            session_id,
            seq,
            EventKind::MessageCompleted,
            serde_json::json!({ "message_id": message_id, "content": content }),
        ),
        RuntimeEnvelope::TurnFinished { turn_id } => SessionEvent::new(
            session_id,
            seq,
            EventKind::TurnFinished,
            serde_json::json!({ "turn_id": turn_id }),
        ),
        RuntimeEnvelope::SessionError { message, details } => SessionEvent::new(
            session_id,
            seq,
            EventKind::SessionError,
            serde_json::json!({ "message": message, "details": details }),
        ),
        RuntimeEnvelope::StatusChanged { status } => SessionEvent::new(
            session_id,
            seq,
            EventKind::SessionState,
            serde_json::json!({ "state": format!("{status:?}") }),
        ),
    }
}

#[async_trait]
impl RuntimeAdapter for RuntimeManagerAdapter {
    async fn create_session(
        &self,
        owner_token_id: Uuid,
        params: CreateSessionParams,
    ) -> Result<SessionSnapshot, HttpError> {
        let session_id = Uuid::new_v4();
        let agent_type = parse_agent_type(&params.agent_type)?;
        let runtime_id = self
            .spawn_runtime(
                session_id,
                agent_type,
                params.workspace_id.clone(),
                params.model.clone(),
                None,
            )
            .await?;
        let snapshot = self.insert_managed_session(owner_token_id, session_id, &params, runtime_id);

        if let Some(prompt) = params.initial_prompt {
            self.send_prompt(
                session_id,
                PromptParams {
                    text: prompt,
                    attachments: vec![],
                    mentions: vec![],
                    metadata: None,
                },
            )
            .await?;
        }

        Ok(snapshot)
    }

    async fn get_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError> {
        self.sessions
            .read()
            .get(&session_id)
            .map(|session| session.snapshot.clone())
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))
    }

    async fn list_sessions(&self, owner_token_id: Uuid) -> Vec<SessionSnapshot> {
        self.sessions
            .read()
            .values()
            .filter(|session| session.owner_token_id == owner_token_id)
            .map(|session| session.snapshot.clone())
            .collect()
    }

    async fn close_session(&self, session_id: Uuid) -> Result<(), HttpError> {
        let runtime_id = {
            let sessions = self.sessions.read();
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            session.runtime_id.clone()
        };
        {
            let mut manager = self.manager.lock().await;
            let _ = manager.stop_runtime(&runtime_id).await;
        }
        self.set_state(session_id, SessionState::Closed, Some("explicit_close"));
        self.emit(session_id, {
            let mut sessions = self.sessions.write();
            let session = sessions.get_mut(&session_id).expect("session exists");
            session.next_seq += 1;
            SessionEvent::new(
                session_id,
                session.next_seq,
                EventKind::SessionClosed,
                serde_json::json!({ "reason": "explicit_close" }),
            )
        });
        Ok(())
    }

    async fn send_prompt(
        &self,
        session_id: Uuid,
        params: PromptParams,
    ) -> Result<PromptAck, HttpError> {
        let runtime_id = {
            let mut sessions = self.sessions.write();
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            if matches!(session.snapshot.state, SessionState::Running) {
                return Err(HttpError::new(
                    super::errors::ErrorCode::SessionBusy,
                    "session is already processing a prompt",
                ));
            }
            if matches!(session.snapshot.state, SessionState::Closed) {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
            session.runtime_id.clone()
        };

        let prompt_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        {
            let mut sessions = self.sessions.write();
            if let Some(session) = sessions.get_mut(&session_id) {
                session.active_turn_id = Some(turn_id);
                session.buffered_output.clear();
            }
        }

        let attachment_urls = params
            .attachments
            .into_iter()
            .filter_map(|attachment| attachment.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let mut manager = self.manager.lock().await;
        let dispatch = manager
            .send_prompt(&runtime_id, &params.text, attachment_urls)
            .await;
        drop(manager);
        if let Err(e) = dispatch {
            let mut sessions = self.sessions.write();
            if let Some(session) = sessions.get_mut(&session_id) {
                session.active_turn_id = None;
                session.buffered_output.clear();
            }
            return Err(HttpError::internal(format!("dispatch prompt: {e}")));
        }

        self.emit(session_id, {
            let mut sessions = self.sessions.write();
            let session = sessions.get_mut(&session_id).expect("session exists");
            session.next_seq += 1;
            SessionEvent::new(
                session_id,
                session.next_seq,
                EventKind::PromptAccepted,
                serde_json::json!({
                    "prompt_id": prompt_id,
                    "text": params.text,
                    "at": chrono::Utc::now(),
                }),
            )
        });
        self.set_state(session_id, SessionState::Running, None);
        self.emit(session_id, {
            let mut sessions = self.sessions.write();
            let session = sessions.get_mut(&session_id).expect("session exists");
            session.next_seq += 1;
            SessionEvent::new(
                session_id,
                session.next_seq,
                EventKind::TurnStarted,
                serde_json::json!({ "turn_id": turn_id, "prompt_id": prompt_id }),
            )
        });

        Ok(PromptAck { prompt_id, turn_id })
    }

    async fn set_model(&self, session_id: Uuid, model_id: String) -> Result<(), HttpError> {
        let runtime_id = {
            let mut sessions = self.sessions.write();
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            session.snapshot.current_model = Some(model_id.clone());
            session.snapshot.last_activity = chrono::Utc::now();
            session.runtime_id.clone()
        };

        let mut manager = self.manager.lock().await;
        manager
            .set_model(&runtime_id, &model_id)
            .await
            .map_err(|e| HttpError::internal(format!("set runtime model: {e}")))
    }

    async fn reply_permission(
        &self,
        session_id: Uuid,
        request_id: String,
        granted: bool,
        option_id: Option<String>,
    ) -> Result<(), HttpError> {
        let runtime_id = {
            let sessions = self.sessions.read();
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            session.runtime_id.clone()
        };

        let mut manager = self.manager.lock().await;
        manager
            .reply_permission(&runtime_id, &request_id, granted, option_id)
            .await
            .map_err(|e| HttpError::internal(format!("reply permission: {e}")))
    }

    async fn restart_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError> {
        let (agent_type, workspace_id, current_model, runtime_id) = {
            let sessions = self.sessions.read();
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            (
                parse_agent_type(&session.snapshot.agent_type)?,
                session.workspace_id.clone(),
                session.snapshot.current_model.clone(),
                session.runtime_id.clone(),
            )
        };

        {
            let mut manager = self.manager.lock().await;
            manager
                .restart_session(&runtime_id)
                .await
                .map_err(|e| HttpError::internal(format!("restart runtime: {e}")))?;
        }

        let new_runtime_id = self
            .spawn_runtime(
                session_id,
                agent_type,
                workspace_id.clone(),
                current_model.clone(),
                None,
            )
            .await?;

        let mut sessions = self.sessions.write();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        session.runtime_id = new_runtime_id.clone();
        session.snapshot.runtime_id = new_runtime_id;
        session.snapshot.workspace_id = workspace_id;
        session.snapshot.current_model = current_model;
        session.snapshot.state = SessionState::Idle;
        session.snapshot.last_activity = chrono::Utc::now();
        session.active_turn_id = None;
        session.buffered_output.clear();
        Ok(session.snapshot.clone())
    }

    async fn cancel(&self, session_id: Uuid, turn_id: Option<Uuid>) -> Result<(), HttpError> {
        let (runtime_id, resolved_turn_id) = {
            let mut sessions = self.sessions.write();
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            let resolved_turn_id = turn_id
                .or(session.active_turn_id)
                .unwrap_or_else(Uuid::new_v4);
            session.active_turn_id = None;
            session.buffered_output.clear();
            (session.runtime_id.clone(), resolved_turn_id)
        };
        {
            let mut manager = self.manager.lock().await;
            manager
                .cancel_agent(&runtime_id)
                .await
                .map_err(|e| HttpError::internal(format!("cancel prompt: {e}")))?;
        }
        self.set_state(session_id, SessionState::Cancelling, None);
        self.emit_next(
            session_id,
            RuntimeEnvelope::TurnFinished {
                turn_id: resolved_turn_id,
            },
        );
        self.set_state(session_id, SessionState::Idle, Some("cancelled"));
        Ok(())
    }

    async fn subscribe(
        &self,
        session_id: Uuid,
        since: Option<u64>,
    ) -> Result<SubscriptionHandle, HttpError> {
        let sessions = self.sessions.read();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        if let Some(since) = since {
            if let Some(oldest) = session.ring.oldest_seq() {
                if since + 1 < oldest {
                    return Err(HttpError::new(
                        super::errors::ErrorCode::EventGone,
                        format!(
                            "Last-Event-ID {since} is below window {oldest}; refetch session snapshot before reconnecting"
                        ),
                    ));
                }
            }
        }
        let backlog = match since {
            Some(seq) => session.ring.replay_after(seq).cloned().collect(),
            None => session.ring.snapshot(),
        };
        let live = session.event_tx.subscribe();
        Ok(SubscriptionHandle { backlog, live })
    }

    async fn replay(
        &self,
        session_id: Uuid,
        since: u64,
        limit: usize,
    ) -> Result<ReplayPage, HttpError> {
        let sessions = self.sessions.read();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        let limit = limit.clamp(1, 500);
        let events = session.ring.replay_after_limited(since, limit);
        let next_cursor = events.last().map(|event| event.seq);
        Ok(ReplayPage {
            events,
            next_cursor,
            window_oldest_seq: session.ring.oldest_seq(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    struct CapturingContextAssembler {
        captured: Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>,
    }

    struct CloudResolvingContextAssembler {
        captured: Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>,
        workspace_path: std::path::PathBuf,
    }

    #[async_trait]
    impl RuntimeExecutionContextAssembler for CloudResolvingContextAssembler {
        async fn assemble(
            &self,
            working_directory: &str,
            workspace_id: Option<&str>,
        ) -> Result<crate::runtime::execution_context::ExecutionContext, String> {
            self.captured.lock().unwrap().push((
                working_directory.to_string(),
                workspace_id.map(str::to_string),
            ));
            if !working_directory.is_empty() {
                return Err("cloud workspace must be resolved before choosing its path".into());
            }
            let resolved_id = match workspace_id {
                Some("cloud-workspace-uuid") => "cloud-workspace-uuid",
                None => "default-cloud-workspace",
                Some(_) => return Err("unexpected cloud workspace".into()),
            };
            Ok(crate::runtime::execution_context::ExecutionContext {
                isolation_domain: crate::runtime::execution_context::IsolationDomainKey::Workspace(
                    resolved_id.into(),
                ),
                workspace: None,
                working_directory: self.workspace_path.clone(),
                spawn_env: crate::runtime::SpawnRuntimeEnv {
                    extra_env: HashMap::from([("TEAMCLU_ACTOR_ID".into(), "actor-a".into())]),
                    ..crate::runtime::SpawnRuntimeEnv::default()
                },
            })
        }
    }

    #[async_trait]
    impl RuntimeExecutionContextAssembler for CapturingContextAssembler {
        async fn assemble(
            &self,
            working_directory: &str,
            workspace_id: Option<&str>,
        ) -> Result<crate::runtime::execution_context::ExecutionContext, String> {
            self.captured.lock().unwrap().push((
                working_directory.to_string(),
                workspace_id.map(str::to_string),
            ));
            Ok(crate::runtime::execution_context::ExecutionContext {
                isolation_domain: crate::runtime::execution_context::IsolationDomainKey::Workspace(
                    workspace_id.unwrap_or("ws-from-path").to_string(),
                ),
                workspace: None,
                working_directory: working_directory.into(),
                spawn_env: crate::runtime::SpawnRuntimeEnv {
                    extra_env: HashMap::from([("TEAMCLU_ACTOR_ID".into(), "actor-a".into())]),
                    ..crate::runtime::SpawnRuntimeEnv::default()
                },
            })
        }
    }

    fn test_manager_adapter(backlog_cap: usize) -> Arc<RuntimeManagerAdapter> {
        Arc::new(RuntimeManagerAdapter {
            manager: Arc::new(tokio::sync::Mutex::new(RuntimeManager::new(
                std::collections::HashMap::new(),
                None,
            ))),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            backlog_cap,
            refresh: None,
            execution_context_assembler: None,
        })
    }

    #[tokio::test]
    async fn runtime_adapter_requires_and_forwards_full_execution_context() {
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let adapter = RuntimeManagerAdapter::new_with_execution_context_assembler(
            Arc::new(tokio::sync::Mutex::new(RuntimeManager::new(
                std::collections::HashMap::new(),
                None,
            ))),
            16,
            None,
            Some(Arc::new(CapturingContextAssembler {
                captured: captured.clone(),
            })),
        );

        let context = adapter
            .assemble_execution_context("/tmp/ws-a", Some("ws-a"))
            .await
            .unwrap();

        assert_eq!(
            context.isolation_domain,
            crate::runtime::execution_context::IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(
            captured.lock().unwrap().as_slice(),
            &[("/tmp/ws-a".into(), Some("ws-a".into()))]
        );

        let missing = match test_manager_adapter(16)
            .assemble_execution_context("/tmp/ws-a", Some("ws-a"))
            .await
        {
            Ok(_) => panic!("missing assembler should fail"),
            Err(error) => error,
        };
        assert!(
            missing
                .to_string()
                .contains("execution context assembler unavailable"),
            "got {missing}"
        );
    }

    #[tokio::test]
    async fn runtime_adapter_spawn_propagates_workspace_attach_context() {
        let captures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut manager = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        let attach_captures = crate::runtime::test_support::install_capturing_backend(&mut manager);
        let adapter = RuntimeManagerAdapter::new_with_execution_context_assembler(
            Arc::new(tokio::sync::Mutex::new(manager)),
            16,
            None,
            Some(Arc::new(CapturingContextAssembler { captured: captures })),
        );
        let workspace = tempfile::tempdir().unwrap();

        adapter
            .spawn_runtime_in_worktree(
                Uuid::new_v4(),
                amux::AgentType::Opencode,
                Some("ws-a".into()),
                None,
                None,
                workspace.path().to_string_lossy().as_ref(),
            )
            .await
            .unwrap();

        let captures = attach_captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].domain,
            crate::runtime::execution_context::IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(captures[0].working_directory, workspace.path());
        assert_eq!(
            captures[0].process_env_revision,
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(
                &captures[0].extra_env
            )
        );
    }

    #[tokio::test]
    async fn http_cloud_workspace_uuid_spawns_in_resolved_on_disk_path() {
        let workspace = tempfile::tempdir().unwrap();
        let assembler_captures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut manager = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        let attach_captures = crate::runtime::test_support::install_capturing_backend(&mut manager);
        let adapter = RuntimeManagerAdapter::new_with_execution_context_assembler(
            Arc::new(tokio::sync::Mutex::new(manager)),
            16,
            None,
            Some(Arc::new(CloudResolvingContextAssembler {
                captured: assembler_captures.clone(),
                workspace_path: workspace.path().to_path_buf(),
            })),
        );

        adapter
            .spawn_runtime_with_resolved_context(
                Uuid::new_v4(),
                amux::AgentType::Opencode,
                Some("cloud-workspace-uuid".into()),
                None,
                None,
            )
            .await
            .unwrap();

        assert_eq!(
            assembler_captures.lock().unwrap().as_slice(),
            &[("".into(), Some("cloud-workspace-uuid".into()))]
        );
        let captures = attach_captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].working_directory, workspace.path());
        assert_eq!(
            captures[0].domain,
            crate::runtime::execution_context::IsolationDomainKey::Workspace(
                "cloud-workspace-uuid".into()
            )
        );
    }

    #[tokio::test]
    async fn http_without_workspace_id_spawns_in_cloud_default_workspace_path() {
        let workspace = tempfile::tempdir().unwrap();
        let assembler_captures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut manager = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        let attach_captures = crate::runtime::test_support::install_capturing_backend(&mut manager);
        let adapter = RuntimeManagerAdapter::new_with_execution_context_assembler(
            Arc::new(tokio::sync::Mutex::new(manager)),
            16,
            None,
            Some(Arc::new(CloudResolvingContextAssembler {
                captured: assembler_captures.clone(),
                workspace_path: workspace.path().to_path_buf(),
            })),
        );

        adapter
            .spawn_runtime_with_resolved_context(
                Uuid::new_v4(),
                amux::AgentType::Opencode,
                None,
                None,
                None,
            )
            .await
            .unwrap();

        assert_eq!(
            assembler_captures.lock().unwrap().as_slice(),
            &[("".into(), None)]
        );
        let captures = attach_captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].working_directory, workspace.path());
        assert_eq!(
            captures[0].domain,
            crate::runtime::execution_context::IsolationDomainKey::Workspace(
                "default-cloud-workspace".into()
            )
        );
    }

    #[tokio::test]
    async fn stub_session_full_flow() {
        let adapter = StubRuntimeAdapter::new(256);
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "stub".into(),
                    workspace_id: None,
                    model: None,
                    initial_prompt: None,
                    metadata: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(snap.state, SessionState::Idle);

        let mut sub = adapter.subscribe(snap.session_id, None).await.unwrap();
        // Backlog contains the session.created event.
        assert!(sub
            .backlog
            .iter()
            .any(|e| e.kind == EventKind::SessionCreated));

        let ack = adapter
            .send_prompt(
                snap.session_id,
                PromptParams {
                    text: "hi".into(),
                    attachments: vec![],
                    mentions: vec![],
                    metadata: None,
                },
            )
            .await
            .unwrap();
        // Receive a few live events; should observe turn finishing.
        let mut saw_turn_finished = false;
        for _ in 0..40 {
            match tokio::time::timeout(Duration::from_millis(200), sub.live.recv()).await {
                Ok(Ok(ev)) => {
                    if ev.kind == EventKind::TurnFinished {
                        saw_turn_finished = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(saw_turn_finished, "stub should finish a turn promptly");
        assert!(!ack.turn_id.is_nil());
    }

    #[tokio::test]
    async fn subscribe_below_window_returns_gone() {
        let adapter = StubRuntimeAdapter::new(2);
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "stub".into(),
                    workspace_id: None,
                    model: None,
                    initial_prompt: None,
                    metadata: None,
                },
            )
            .await
            .unwrap();
        // Force the ring buffer past `session.created` (which is seq 1).
        for _ in 0..5 {
            adapter.emit(
                snap.session_id,
                EventKind::TokenDelta,
                serde_json::json!({}),
            );
        }
        let err = adapter
            .subscribe(snap.session_id, Some(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, super::super::errors::ErrorCode::EventGone);
    }

    #[tokio::test]
    async fn runtime_manager_adapter_initial_prompt_executes_once() {
        let adapter = RuntimeManagerAdapter::new(
            Arc::new(tokio::sync::Mutex::new(RuntimeManager::new(
                std::collections::HashMap::new(),
                None,
            ))),
            256,
            None,
        );
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "opencode".into(),
                    workspace_id: Some("ws-1".into()),
                    model: None,
                    initial_prompt: Some("hello once".into()),
                    metadata: None,
                },
            )
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;

        let page = adapter.replay(snap.session_id, 0, 100).await.unwrap();
        let completed = page
            .events
            .iter()
            .filter(|event| event.kind == EventKind::MessageCompleted)
            .count();
        let finished = page
            .events
            .iter()
            .filter(|event| event.kind == EventKind::TurnFinished)
            .count();

        assert_eq!(completed, 1, "initial prompt should complete exactly once");
        assert_eq!(finished, 1, "initial prompt should finish exactly once");
    }

    #[tokio::test]
    async fn runtime_manager_adapter_rolls_back_failed_dispatch() {
        let adapter = test_manager_adapter(256);
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "opencode".into(),
                    workspace_id: Some("ws-1".into()),
                    model: None,
                    initial_prompt: None,
                    metadata: None,
                },
            )
            .await
            .unwrap();

        {
            let mut manager = adapter.manager.lock().await;
            manager.fail_next_send_for(&snap.runtime_id, "boom");
        }

        let err = adapter
            .send_prompt(
                snap.session_id,
                PromptParams {
                    text: "should fail".into(),
                    attachments: vec![],
                    mentions: vec![],
                    metadata: None,
                },
            )
            .await
            .unwrap_err();

        assert_eq!(err.code, super::super::errors::ErrorCode::Internal);
        let current = adapter.get_session(snap.session_id).await.unwrap();
        assert_eq!(current.state, SessionState::Idle);

        let page = adapter.replay(snap.session_id, 0, 100).await.unwrap();
        assert_eq!(
            page.events
                .iter()
                .filter(|event| event.kind == EventKind::PromptAccepted)
                .count(),
            0
        );
        assert_eq!(
            page.events
                .iter()
                .filter(|event| event.kind == EventKind::TurnStarted)
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn runtime_manager_adapter_cancel_clears_pending_turn_before_idle() {
        let adapter = test_manager_adapter(256);
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "opencode".into(),
                    workspace_id: Some("ws-1".into()),
                    model: None,
                    initial_prompt: None,
                    metadata: None,
                },
            )
            .await
            .unwrap();

        let (_cmd_tx, mut cmd_rx) = mpsc::channel(1);
        let turn_id = Uuid::new_v4();
        {
            let mut manager = adapter.manager.lock().await;
            let handle = manager.get_handle_mut(&snap.runtime_id).unwrap();
            handle.cmd_tx = Some(_cmd_tx);
        }
        {
            let mut sessions = adapter.sessions.write();
            let session = sessions.get_mut(&snap.session_id).unwrap();
            session.snapshot.state = SessionState::Running;
            session.active_turn_id = Some(turn_id);
            session.buffered_output = "partial".into();
        }

        adapter
            .cancel(snap.session_id, Some(turn_id))
            .await
            .unwrap();
        let _ = cmd_rx.recv().await;

        adapter.process_runtime_event(
            &snap.runtime_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::StatusChange(
                    amux::AcpStatusChange {
                        old_status: amux::AgentStatus::Active as i32,
                        new_status: amux::AgentStatus::Idle as i32,
                    },
                )),
                model: String::new(),
            },
        );

        let page = adapter.replay(snap.session_id, 0, 100).await.unwrap();
        assert_eq!(
            page.events
                .iter()
                .filter(|event| event.kind == EventKind::TurnFinished)
                .count(),
            1
        );
        assert_eq!(
            page.events
                .iter()
                .filter(|event| event.kind == EventKind::MessageCompleted)
                .count(),
            0
        );
    }

    #[test]
    fn parse_agent_type_accepts_every_runnable_backend() {
        // cursor and pi used to 400 here while codex — which has no backend at
        // all — was accepted, because this function kept its own stale table
        // instead of asking the resolver.
        for (name, expected) in [
            ("opencode", amux::AgentType::Opencode),
            ("pi", amux::AgentType::Pi),
            ("cursor", amux::AgentType::Cursor),
            ("claude", amux::AgentType::ClaudeCode),
            ("claude-code", amux::AgentType::ClaudeCode),
            ("claude_code", amux::AgentType::ClaudeCode),
        ] {
            assert_eq!(
                parse_agent_type(name).expect(name),
                expected,
                "{name} should parse"
            );
        }
    }

    #[test]
    fn parse_agent_type_rejects_unknown_names() {
        assert!(parse_agent_type("nope").is_err());
        assert!(parse_agent_type("").is_err());
    }
}
