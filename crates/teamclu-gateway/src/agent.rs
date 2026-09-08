use async_trait::async_trait;
use tokio::sync::mpsc;

/// Identifier of an amuxd session that a gateway channel is conversing with.
/// Opaque to the gateway; resolved against amuxd's runtime manager.
pub type AmuxSessionId = String;

/// Describes a model the daemon can drive, returned by `list_models`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelInfo {
    pub provider: String,
    pub model: String,
    pub display_name: String,
}

/// A slash command advertised by the agent via `AgentAvailableCommands`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    /// `None` means the command takes no input; `Some(hint)` means the command
    /// accepts free-form text input described by the hint string.
    pub input_hint: Option<String>,
}

/// Outcome of a single agent turn driven by a gateway message.
#[derive(Debug, Clone)]
pub struct TurnOutcome {
    pub reply_text: String,
    pub completed: bool,
}

/// One of a chat's sessions, returned by `list_sessions`.
///
/// `session_id` is the cloud `sessions.id` — the id `switch_session` takes, and
/// deliberately not the logical ACP id: the ACP id is what identifies the *live*
/// runtime, and a detached session usually has no runtime at all.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    /// Human-readable title from the session row ("WeCom DM: LiangLiang"), with
    /// the detach timestamp older generations carry.
    pub title: String,
    pub is_current: bool,
}

/// Workspace entry returned by `list_workspaces`.
#[derive(Debug, Clone)]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub display_name: String,
    pub is_current: bool,
}

/// Someone seated in the current session, as `/participant` lists them.
///
/// Both descriptive fields are optional because the seat itself is the fact:
/// `session_participants` stores actor ids, and the directory that names them
/// can come back short — a deleted actor leaves a live participant row behind.
/// Such a seat still lists (under a placeholder built by the caller's locale),
/// because a roster that quietly drops rows is worse than one that admits it
/// does not recognise someone.
#[derive(Debug, Clone)]
pub struct ParticipantInfo {
    /// The actor id, which is always known — the only identifier a nameless
    /// seat has left.
    pub actor_id: String,
    pub display_name: Option<String>,
    /// The `actors.actor_type` this participant is: `member`, `agent`, or
    /// `external` (a chat identity the gateway minted for someone who has no
    /// TeamClu account). Carried as a string rather than an enum so a kind this
    /// build has not heard of still lists, labelled by its raw name.
    pub kind: Option<String>,
}

/// Abstraction over amuxd's in-process agent runtime. Channels call this
/// instead of POSTing to opencode's HTTP server.
#[async_trait]
pub trait AgentHandle: Send + Sync + 'static {
    /// Create a new agent-backed session for a freshly-bound gateway conversation.
    /// Returns the amuxd session id to persist on the gateway's `Binding`.
    async fn create_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
    ) -> Result<AmuxSessionId, AgentError>;

    /// Send a user prompt and wait for the agent's reply text. Equivalent to
    /// v1's `prompt_async` + SSE polling, but synchronous and in-process.
    ///
    /// `timeout` is the channel's idle patience, from
    /// [`ChannelCaps::turn_timeout_secs`](crate::driver::ChannelCaps): how long
    /// the turn may stay silent (no ACP event) before the gateway stops
    /// waiting. A mail round trip and an IM bubble have nothing in common, and
    /// the value used to be a constant in the daemon that no channel could
    /// influence.
    async fn send_prompt(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
        timeout: std::time::Duration,
    ) -> Result<TurnOutcome, AgentError>;

    /// Same as `send_prompt`, but reports the reply as it grows so channels
    /// with editable message bubbles can show progress mid-turn.
    ///
    /// `on_update` receives the **cumulative** reply text, not deltas — the
    /// WeCom stream msgtype replaces a bubble's content by re-sending the
    /// same id, so callers want the whole text every time. Updates are
    /// best-effort and throttled: a slow or dropped receiver never fails the
    /// turn, and intermediate updates may be skipped. The returned
    /// `TurnOutcome` is always authoritative — send it as the final,
    /// finished bubble regardless of what arrived on the channel.
    ///
    /// The default impl ignores `on_update` and delegates to `send_prompt`,
    /// so channels without progressive rendering need no changes.
    async fn send_prompt_streamed(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
        on_update: mpsc::Sender<String>,
        timeout: std::time::Duration,
    ) -> Result<TurnOutcome, AgentError> {
        let _ = on_update;
        self.send_prompt(session, sender_display, text, timeout)
            .await
    }

    /// Inject context without triggering a reply (v1 `noReply: true`).
    /// Kept on the trait for future use; not called by v1-of-port channels.
    async fn inject_context(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<(), AgentError>;

    /// Cancel any in-flight turn on this session. Used by /stop.
    async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AgentError>;

    /// Drop the runtime context for this session — next send_prompt re-spawns
    /// a fresh agent under the same logical id. Used by /reset.
    async fn reset_session(&self, session: &AmuxSessionId) -> Result<(), AgentError>;

    /// Start a genuinely new conversation: the next message must land in a NEW
    /// session, not just a fresh runtime under the old one. Used by /new.
    ///
    /// Distinct from [`reset_session`] because a gateway session is pinned to
    /// its chat by `sessions.binding`; resetting only the runtime leaves the
    /// same session row, history, and session-list entry in place, which is
    /// not what "start a new session" means to the person typing it.
    ///
    /// Returns whether the chat was actually detached — i.e. whether the next
    /// message really does open a new session. `false` means only the runtime
    /// was reset (backend too old to expose the detach endpoint, unknown id, a
    /// channel whose sessions are not gateway-bound), and the caller MUST say
    /// so instead of announcing a new session that does not exist. Reporting
    /// success unconditionally is what made a failed `/new` indistinguishable
    /// from a working one.
    ///
    /// The default impl falls back to [`reset_session`], so a channel whose
    /// backend cannot mint a new session still gets a cleared context.
    async fn start_new_session(&self, session: &AmuxSessionId) -> Result<bool, AgentError> {
        self.reset_session(session).await?;
        Ok(false)
    }

    /// List the models the daemon can actually drive for this session, most
    /// recently used first. Session-scoped because the catalog comes from the live
    /// backend running in *this* session's workspace — model ids are
    /// backend-local, so there is no device-wide answer. Used by /model (no arg).
    async fn list_models(&self, session: &AmuxSessionId) -> Result<Vec<ModelInfo>, AgentError>;

    /// The `provider/model` this session is currently running on, if known.
    /// `None` when nothing is pinned and no runtime has reported a model yet.
    async fn current_model(&self, session: &AmuxSessionId) -> Result<Option<String>, AgentError> {
        let _ = session;
        Ok(None)
    }

    /// Pin a model for this session. Restarts the underlying agent —
    /// conversation context is lost. Used by /model X.
    async fn set_model(
        &self,
        session: &AmuxSessionId,
        provider: &str,
        model: &str,
    ) -> Result<(), AgentError>;

    /// Return the slash commands the running agent has currently advertised.
    /// Returns an empty vec if the session hasn't spawned yet or the agent
    /// hasn't reported commands. Used by `commands::dispatch` for agent-first priority.
    async fn available_commands(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AgentCommand>, AgentError>;

    /// Forward a slash command to the agent. Only call after confirming
    /// via `available_commands` that the agent knows this command.
    /// Behaves like `send_prompt` — returns the agent's reply text.
    async fn send_slash_command(
        &self,
        session: &AmuxSessionId,
        name: &str,
        input: Option<&str>,
    ) -> Result<TurnOutcome, AgentError>;

    /// This chat's own sessions, newest first: the one it is talking to now,
    /// plus the earlier generations `/new` pushed aside. Persisted — not the
    /// in-memory runtime map, which forgets everything on daemon restart and
    /// holds at most the live session.
    async fn list_sessions(
        &self,
        active_session: &AmuxSessionId,
    ) -> Result<Vec<SessionInfo>, AgentError>;

    /// Make one of this chat's earlier sessions current again, so the next
    /// message continues there instead of in `active_session`.
    ///
    /// `Ok(false)` means the target is not a session of this chat — a stale
    /// number from an old listing, say — and nothing was switched. The default
    /// impl declines everything, for handles with no persistent session store.
    async fn switch_session(
        &self,
        _active_session: &AmuxSessionId,
        _target_session_id: &str,
    ) -> Result<bool, AgentError> {
        Ok(false)
    }

    /// List workspaces known to the daemon.
    async fn list_workspaces(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<WorkspaceInfo>, AgentError>;

    /// Set workspace for this session. Restarts the underlying agent —
    /// conversation context is lost (same semantics as `set_model`).
    async fn set_workspace(
        &self,
        session: &AmuxSessionId,
        workspace_id: &str,
    ) -> Result<(), AgentError>;

    /// List workspace skills available to the session.
    /// Returns `(slash_name, description)` pairs, alphabetically sorted.
    async fn list_skills(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<(String, String)>, AgentError>;

    /// Everyone seated in this session — the people and agents a message here
    /// reaches. Used by `/participant`.
    ///
    /// The default impl answers "nobody listed" so a handle with no participant
    /// store (tests, a channel whose sessions are not cloud-backed) degrades to
    /// an empty roster instead of failing the command.
    async fn list_participants(
        &self,
        _session: &AmuxSessionId,
    ) -> Result<Vec<ParticipantInfo>, AgentError> {
        Ok(Vec::new())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("agent session creation failed: {0}")]
    Create(String),
    #[error("agent send failed: {0}")]
    Send(String),
    #[error("agent turn timed out waiting for a reply — please retry")]
    Timeout,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("internal error: {0}")]
    Internal(String),
}
