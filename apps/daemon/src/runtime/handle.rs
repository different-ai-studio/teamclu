use std::sync::Arc;

use tokio::sync::{mpsc, Mutex as AsyncMutex};

use super::acp_event_frame::AcpEventFrame;
use super::backend::AcpCommand;
use super::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use super::instruction_delivery::InstructionDelivery;
use crate::proto::amux;

#[derive(Debug, Clone)]
pub struct PendingMessage {
    pub message_id: String, // cloud messages.id, used to update cursor after flush
    pub sender_display: String, // for the prefix prose ("Matt: …")
    pub content: String,
    pub created_at: i64, // unix ts; preserved for ordering after coalescing
}

/// Buffered context from `inject_context` — flushed on the next `send_prompt`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedContextItem {
    pub sender_display: String,
    pub content: String,
}

pub struct RuntimeHandle {
    pub agent_id: String,
    pub acp_session_id: String,
    pub session_id: String,
    /// Cloud agent actor UUID that owns this attachment (daemon routing
    /// identity). Distinct from `agent_id`, which is the 8-char spawn key.
    /// Used to resolve session-addressed commands when multiple attachments
    /// share a session_id (ADR-0004 `(actor, session)`).
    pub owner_actor_id: String,
    pub agent_type: amux::AgentType,
    pub worktree: String,
    pub workspace_id: String,
    /// Stable execution boundary used for backend-host routing.
    pub isolation_domain: IsolationDomainKey,
    /// Fingerprint of the exact process environment used for this attachment.
    pub process_env_revision: ProcessEnvRevision,
    /// OpenCode host generation that owns this attachment's routing state.
    pub host_generation_id: String,
    pub branch: String,
    pub status: amux::AgentStatus,
    pub current_prompt: String,
    pub session_title: String,
    pub last_output_summary: String,
    pub tool_use_count: i32,
    pub started_at: i64,
    /// Wall-clock epoch (seconds) of the last user-driven or agent-driven
    /// activity on this runtime. Set on spawn/resume, bumped on send_prompt
    /// and on every drained ACP event. The idle sweeper (see
    /// `RuntimeManager::evict_idle`) reads this to decide whether to stop
    /// the runtime. Stored as a plain `i64` because the field lives behind
    /// the manager's `AsyncMutex` — no separate locking needed.
    pub last_active_at: i64,
    pub sequence: u64,
    /// Receiver half of the per-agent event channel. Wrapped in `Option` so
    /// the gateway turn-await loop can `.take()` it for the duration of a
    /// single turn — letting the loop sit on `recv().await` without holding
    /// the global `RuntimeManager` mutex. While the receiver is checked out
    /// (i.e. `None` here), `poll_events` skips this agent and events queue
    /// in the channel buffer for the checkout owner to drain.
    pub event_rx: Option<mpsc::Receiver<AcpEventFrame>>,
    pub event_tx: mpsc::Sender<AcpEventFrame>,
    /// Channel to send commands (prompt, cancel, permission) to the ACP thread.
    pub cmd_tx: Option<mpsc::Sender<AcpCommand>>,
    /// Serialises concurrent gateway turns for the *same* agent (e.g. two
    /// rapid-fire inbound DMs in the same wecom chat). Cloneable Arc, held
    /// across the entire turn-await loop. Different agents have different
    /// locks so cross-session traffic stays fully parallel.
    pub turn_lock: Arc<AsyncMutex<()>>,
    /// Messages that arrived on session/live while this runtime was not in
    /// the mention set. Drained into a `[Context: …]` prefix on the next
    /// real send_prompt so the runtime catches up without firing N turns.
    pub pending_silent: Vec<PendingMessage>,
    /// Instructions queued by `inject_context` (workspace system prompt, /ctx).
    pub injected_context: Vec<InjectedContextItem>,
    /// One-shot context that must be prepended to the next prompt even when
    /// session-level injected context is delivered by a native plugin.
    pub next_prompt_context: String,
    /// How static workspace instructions are delivered for this runtime.
    pub instruction_delivery: InstructionDelivery,
    /// Models the local backend reported for this runtime (startup /
    /// `list_models` probe, then cached on the handle). Empty until the live
    /// catalog is advertised — there is no static fallback table.
    pub available_models: Vec<amux::ModelInfo>,
    /// The `messages.id` of the last message this runtime processed (sent or
    /// queued as silent). Used by Task 9 catch-up logic to replay missed
    /// messages on session reopen.
    pub last_processed_message_id: Option<String>,
    /// User `messages.id` that triggered the in-flight ACP turn. Stamped onto
    /// AgentReply emits as `reply_to_message_id` so clients can quote-jump.
    /// Bound when the prompt worker starts the turn (via AcpEventFrame), not at
    /// enqueue time — so queued prompts cannot overwrite an earlier turn.
    /// Cleared on Active→Idle.
    pub pending_reply_to_message_id: Option<String>,
    /// Human member actor whose client receives remote-tool RPC for this runtime.
    pub remote_tool_member_id: String,
    /// Gateway runtimes auto-allow ACP tool permissions; collab runtimes do not.
    pub is_gateway: bool,
    /// Fingerprint of the resolved personal/team/system snapshot used at spawn.
    pub env_fingerprint: Option<String>,
    /// Internal non-serialized snapshot used to decide whether an env refresh
    /// changes effective bindings. Never exposed through RuntimeInfo.
    pub env_snapshot: Option<teamclu_runtime_env::ResolvedEnvSnapshot>,
    pub env_team_id: Option<String>,
    /// Another session on the shared OpenCode host may have dropped MCP; refresh
    /// on the next Idle transition (never detach/resume while Active).
    pub remote_tools_mcp_refresh_pending: bool,
    /// Turn-scoped native skill baseline for unsupported-directory detection.
    pub native_skill_turn_guard: Option<crate::runtime::NativeSkillTurnGuard>,
}

impl RuntimeHandle {
    pub fn new(
        agent_id: String,
        agent_type: amux::AgentType,
        worktree: String,
        workspace_id: String,
    ) -> Self {
        let (event_tx, event_rx) = mpsc::channel(256);
        let now = chrono::Utc::now().timestamp();
        Self {
            agent_id,
            acp_session_id: String::new(),
            session_id: String::new(),
            owner_actor_id: String::new(),
            agent_type,
            worktree,
            workspace_id,
            isolation_domain: IsolationDomainKey::UnscopedAgent {
                team_id: String::new(),
                actor_id: String::new(),
            },
            process_env_revision: ProcessEnvRevision::from_bindings(
                &std::collections::HashMap::new(),
            ),
            host_generation_id: String::new(),
            branch: String::new(),
            status: amux::AgentStatus::Starting,
            current_prompt: String::new(),
            session_title: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
            started_at: now,
            last_active_at: now,
            sequence: 0,
            event_rx: Some(event_rx),
            event_tx,
            cmd_tx: None,
            turn_lock: Arc::new(AsyncMutex::new(())),
            pending_silent: Vec::new(),
            injected_context: Vec::new(),
            next_prompt_context: String::new(),
            instruction_delivery: InstructionDelivery::BufferedInject,
            last_processed_message_id: None,
            pending_reply_to_message_id: None,
            available_models: Vec::new(),
            remote_tool_member_id: String::new(),
            is_gateway: false,
            env_fingerprint: None,
            env_snapshot: None,
            env_team_id: None,
            remote_tools_mcp_refresh_pending: false,
            native_skill_turn_guard: None,
        }
    }

    /// Copy cloud actor id from the resolved env snapshot when present.
    pub fn stamp_owner_actor_from_env(&mut self) {
        if !self.owner_actor_id.is_empty() {
            return;
        }
        if let Some(actor) = self
            .env_snapshot
            .as_ref()
            .and_then(|snap| snap.bindings.get("actor_id"))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            self.owner_actor_id = actor.to_string();
        }
    }

    pub fn next_sequence(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    /// Stamp `last_active_at` to now. Called by `RuntimeManager` on every
    /// send_prompt and on each drained ACP event.
    pub fn bump_activity(&mut self) {
        self.last_active_at = chrono::Utc::now().timestamp();
    }

    /// Build a `RuntimeInfo` for this agent.
    ///
    /// `available_models` is read from `self` — filled from the backend's
    /// startup / `list_models` probe. `current_model` and `available_commands`
    /// are passed in by the caller (`RuntimeManager`) which tracks them in its
    /// own caches. Pass empty Vec / empty String for unset.
    pub fn to_proto_info(
        &self,
        current_model: String,
        available_commands: Vec<amux::AcpAvailableCommand>,
    ) -> amux::RuntimeInfo {
        amux::RuntimeInfo {
            runtime_id: self.agent_id.clone(),
            agent_type: self.agent_type as i32,
            worktree: self.worktree.clone(),
            branch: self.branch.clone(),
            status: self.status as i32,
            started_at: self.started_at,
            current_prompt: self.current_prompt.clone(),
            workspace_id: self.workspace_id.clone(),
            session_title: self.session_title.clone(),
            last_output_summary: self.last_output_summary.clone(),
            tool_use_count: self.tool_use_count,
            available_models: self.available_models.clone(),
            current_model,
            // Lifecycle fields — still a placeholder (`Active`); the manager
            // does not yet distinguish finer states on the wire.
            state: amux::RuntimeLifecycle::Active as i32,
            stage: String::new(),
            error_code: String::new(),
            error_message: String::new(),
            failed_stage: String::new(),
            available_commands,
        }
    }

    /// Send a prompt to the ACP agent via the command channel.
    pub async fn send_prompt(
        &self,
        text: &str,
        attachment_urls: Vec<String>,
        requester_actor_id: Option<String>,
        reply_to_message_id: Option<String>,
    ) -> crate::error::Result<()> {
        if let Some(ref tx) = self.cmd_tx {
            tx.send(AcpCommand::Prompt {
                acp_session_id: self.acp_session_id.clone(),
                text: text.to_string(),
                attachment_urls,
                requester_actor_id,
                reply_to_message_id,
            })
            .await
            .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
        } else {
            Err(crate::error::AmuxError::Agent(
                "no ACP command channel".into(),
            ))
        }
    }

    /// Cancel the current turn via ACP.
    pub async fn cancel(&self) -> crate::error::Result<()> {
        if let Some(ref tx) = self.cmd_tx {
            tx.send(AcpCommand::Cancel {
                acp_session_id: self.acp_session_id.clone(),
            })
            .await
            .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
        } else {
            Err(crate::error::AmuxError::Agent(
                "no ACP command channel".into(),
            ))
        }
    }

    /// Resolve a pending permission request via ACP.
    pub async fn answer_question(
        &self,
        request_id: &str,
        answers_json: &str,
        reject: bool,
    ) -> crate::error::Result<()> {
        if let Some(ref tx) = self.cmd_tx {
            tx.send(AcpCommand::AnswerQuestion {
                request_id: request_id.to_string(),
                answers_json: answers_json.to_string(),
                reject,
            })
            .await
            .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
        } else {
            Err(crate::error::AmuxError::Agent(
                "agent has no ACP command channel".into(),
            ))
        }
    }

    pub async fn resolve_permission(
        &self,
        request_id: &str,
        granted: bool,
        option_id: Option<String>,
    ) -> crate::error::Result<()> {
        if let Some(ref tx) = self.cmd_tx {
            tx.send(AcpCommand::ResolvePermission {
                request_id: request_id.to_string(),
                granted,
                option_id,
            })
            .await
            .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
        } else {
            Err(crate::error::AmuxError::Agent(
                "no ACP command channel".into(),
            ))
        }
    }

    /// Shut down the ACP agent gracefully.
    pub async fn shutdown(&mut self) {
        if let Some(ref tx) = self.cmd_tx {
            if !self.acp_session_id.is_empty() {
                let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
                if tx
                    .send(AcpCommand::DetachSession {
                        acp_session_id: self.acp_session_id.clone(),
                        ack: Some(ack_tx),
                    })
                    .await
                    .is_ok()
                    && tokio::time::timeout(std::time::Duration::from_secs(5), ack_rx)
                        .await
                        .is_err()
                {
                    tracing::warn!(
                        acp_session_id = %self.acp_session_id,
                        "timed out waiting for runtime detach acknowledgement"
                    );
                }
            }
        }
    }

    /// Drain pending_silent into a single `[Context: …]` prefix string.
    /// Returns (prefix_text, drained_message_ids). prefix_text is empty
    /// when the queue was empty, in which case caller should not prepend.
    pub fn flush_pending_silent(&mut self) -> (String, Vec<String>) {
        if self.pending_silent.is_empty() {
            return (String::new(), Vec::new());
        }
        let mut sorted = std::mem::take(&mut self.pending_silent);
        sorted.sort_by_key(|m| m.created_at);
        let ids: Vec<String> = sorted.iter().map(|m| m.message_id.clone()).collect();

        let mut text = String::from(
            "[Context — messages received in this session while you were not mentioned. Read for context but do not reply to them. Reply only to the user prompt that follows.]\n",
        );
        for m in &sorted {
            text.push_str(&format!("{}: {}\n", m.sender_display, m.content));
        }
        text.push_str("[End context]\n\n");
        (text, ids)
    }

    pub fn push_injected_context(&mut self, sender_display: &str, content: &str) {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return;
        }
        let sender = sender_display.trim();
        if !sender.is_empty() {
            self.injected_context
                .retain(|item| item.sender_display != sender);
        }
        self.injected_context.push(InjectedContextItem {
            sender_display: sender.to_string(),
            content: trimmed.to_string(),
        });
    }

    pub fn flush_injected_context(&mut self) -> (String, Vec<InjectedContextItem>) {
        if self.injected_context.is_empty() {
            return (String::new(), Vec::new());
        }
        let drained = std::mem::take(&mut self.injected_context);
        let mut text = String::from(
            "[TeamClu Instructions — follow for all replies in this session. \
Do not acknowledge separately. Reply only to the user prompt that follows.]\n",
        );
        for item in &drained {
            if !item.sender_display.is_empty() {
                text.push_str(&format!("[{}] ", item.sender_display));
            }
            text.push_str(&item.content);
            text.push('\n');
        }
        text.push('\n');
        (text, drained)
    }
}

#[cfg(test)]
impl RuntimeHandle {
    pub fn test_dummy() -> Self {
        let (event_tx, event_rx) = tokio::sync::mpsc::channel(1);
        Self {
            agent_id: String::new(),
            acp_session_id: String::new(),
            session_id: String::new(),
            owner_actor_id: String::new(),
            agent_type: crate::proto::amux::AgentType::ClaudeCode,
            worktree: String::new(),
            workspace_id: String::new(),
            isolation_domain: IsolationDomainKey::UnscopedAgent {
                team_id: String::new(),
                actor_id: String::new(),
            },
            process_env_revision: ProcessEnvRevision::from_bindings(
                &std::collections::HashMap::new(),
            ),
            host_generation_id: String::new(),
            branch: String::new(),
            status: crate::proto::amux::AgentStatus::Starting,
            current_prompt: String::new(),
            session_title: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
            started_at: 0,
            last_active_at: 0,
            sequence: 0,
            event_rx: Some(event_rx),
            event_tx,
            cmd_tx: None,
            turn_lock: Arc::new(AsyncMutex::new(())),
            pending_silent: Vec::new(),
            injected_context: Vec::new(),
            next_prompt_context: String::new(),
            instruction_delivery: InstructionDelivery::BufferedInject,
            last_processed_message_id: None,
            pending_reply_to_message_id: None,
            available_models: Vec::new(),
            remote_tool_member_id: String::new(),
            is_gateway: false,
            env_fingerprint: None,
            env_snapshot: None,
            env_team_id: None,
            remote_tools_mcp_refresh_pending: false,
            native_skill_turn_guard: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_waits_for_detach_acknowledgement() {
        let mut handle = RuntimeHandle::test_dummy();
        handle.host_generation_id = "gen-a".into();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(1);
        handle.cmd_tx = Some(cmd_tx);
        handle.acp_session_id = "session-a".to_string();
        let backend = tokio::spawn(async move {
            let AcpCommand::DetachSession {
                acp_session_id,
                ack,
            } = cmd_rx.recv().await.unwrap()
            else {
                panic!("expected detach command");
            };
            assert_eq!(acp_session_id, "session-a");
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            ack.unwrap().send(()).unwrap();
        });

        let started = std::time::Instant::now();
        handle.shutdown().await;
        assert!(started.elapsed() >= std::time::Duration::from_millis(20));
        backend.await.unwrap();
    }

    #[test]
    fn flush_injected_context_drains_into_prefix() {
        let mut h = RuntimeHandle::test_dummy();
        h.push_injected_context("system", "请使用中文回答");
        let (text, drained) = h.flush_injected_context();
        assert_eq!(drained.len(), 1);
        assert!(text.contains("TeamClu Instructions"));
        assert!(text.contains("[system] 请使用中文回答"));
        assert!(h.injected_context.is_empty());
    }

    #[test]
    fn push_injected_context_replaces_same_sender() {
        let mut h = RuntimeHandle::test_dummy();
        h.push_injected_context("system", "first");
        h.push_injected_context("system", "second");
        assert_eq!(h.injected_context.len(), 1);
        assert_eq!(h.injected_context[0].content, "second");
    }

    #[test]
    fn flush_pending_silent_returns_empty_when_queue_empty() {
        let mut h = RuntimeHandle::test_dummy();
        let (text, ids) = h.flush_pending_silent();
        assert!(text.is_empty());
        assert!(ids.is_empty());
    }

    #[test]
    fn flush_pending_silent_orders_by_timestamp_and_drains() {
        let mut h = RuntimeHandle::test_dummy();
        h.pending_silent.push(PendingMessage {
            message_id: "m2".into(),
            sender_display: "Bob".into(),
            content: "second".into(),
            created_at: 200,
        });
        h.pending_silent.push(PendingMessage {
            message_id: "m1".into(),
            sender_display: "Ann".into(),
            content: "first".into(),
            created_at: 100,
        });
        let (text, ids) = h.flush_pending_silent();
        assert!(text.contains("Ann: first\nBob: second"));
        assert_eq!(ids, vec!["m1".to_string(), "m2".to_string()]);
        assert!(h.pending_silent.is_empty());
    }
}
