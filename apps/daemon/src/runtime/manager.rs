use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tracing::{info, warn};
use uuid::Uuid;

use super::agent_runtime_state::PerAgentRuntimeState;
use super::backend::{agent_type_for_local_agent, create_backend, AcpCommand, AcpStartupMetadata, AgentBackend};
use super::builtin_commands::builtin_commands;
use super::execution_context::{ExecutionContext, IsolationDomainKey, ProcessEnvRevision};
use super::handle::RuntimeHandle;
use super::refresh::RuntimeRefreshCoordinator;

use crate::backend::Backend;
use crate::config::DeviceModelCatalog;
use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::permission_policy::PermissionPolicy;
use crate::runtime::turn_aggregator::TurnAggregator;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunchConfig {
    pub binary: String,
    pub args: Vec<String>,
    pub backend_type: &'static str,
}

impl AgentLaunchConfig {
    pub fn new(binary: impl Into<String>, args: Vec<String>, backend_type: &'static str) -> Self {
        Self {
            binary: binary.into(),
            args,
            backend_type,
        }
    }
}

/// Prefix `create_gateway_session_with_model` stamps onto the `workspace_id`
/// of every gateway/cron runtime (`gateway:<binding>`). It is the only marker
/// of "this runtime is unattended" that survives to disk, so the resume path
/// reads it back to restore full access — see [`is_gateway_workspace_id`].
pub const GATEWAY_WORKSPACE_ID_PREFIX: &str = "gateway:";

/// Whether a stored `workspace_id` belongs to a gateway/cron runtime.
pub fn is_gateway_workspace_id(workspace_id: &str) -> bool {
    workspace_id.starts_with(GATEWAY_WORKSPACE_ID_PREFIX)
}

/// Restore the unattended shape onto an env assembled for a *resume*.
///
/// The env builders produce a desktop-shaped runtime (`is_gateway: false`,
/// which [`SpawnRuntimeEnv::permission_policy`] reads as "ask"). Resuming is
/// not a policy change, but `attach()` replaces the session's route with
/// whatever it is handed — so without this a resumed gateway/cron session
/// quietly starts asking for approvals nobody is there to answer.
pub fn restore_gateway_shape_for_resume(env: &mut SpawnRuntimeEnv, workspace_id: &str) {
    if is_gateway_workspace_id(workspace_id) {
        env.is_gateway = true;
    }
}

/// Environment bundle passed when spawning an ACP-backed agent runtime.
#[derive(Debug, Clone, Default)]
pub struct SpawnRuntimeEnv {
    pub extra_env: HashMap<String, String>,
    /// Non-secret resolution metadata retained for diagnostics. Runtime
    /// backends still receive `extra_env` during the compatibility phase.
    pub resolved_env: Option<teamclu_runtime_env::ResolvedEnvSnapshot>,
    pub env_team_id: Option<String>,
    /// When true, all keys in `extra_env` override the ACP host process environment.
    pub force_env_override: bool,
    /// Original `opencode.json` before MCP placeholder resolve; restored when the
    /// last runtime on this worktree stops.
    pub opencode_json_original: Option<String>,
    /// Gateway sessions auto-allow tool permissions and use gateway MCP wiring.
    /// Remote-tools collab runtimes may also carry an MCP config but must stay
    /// `is_gateway = false` so permission + MCP repair paths behave correctly.
    pub is_gateway: bool,
    /// Explicit permission policy for this runtime. `None` derives it from
    /// `is_gateway` (gateway ⇒ full access), which is what every caller that
    /// predates the field expects. Cron sets it explicitly so a job can be
    /// switched back to "ask" without losing the gateway MCP wiring.
    pub permission: Option<PermissionPolicy>,
}

impl SpawnRuntimeEnv {
    /// The policy the backend should run under: explicit when set, otherwise
    /// derived from `is_gateway`.
    pub fn permission_policy(&self) -> PermissionPolicy {
        self.permission.unwrap_or(if self.is_gateway {
            PermissionPolicy::Full
        } else {
            PermissionPolicy::Ask
        })
    }
}

/// Per-agent runtime state checked out of `RuntimeManager` for the duration
/// of a single gateway turn. Owning the receiver here lets the turn-await
/// loop sit on `event_rx.recv().await` without holding the global manager
/// mutex, so concurrent turns on *different* agents stay parallel.
pub struct CheckedOutTurn {
    pub agent_id: String,
    pub event_rx: mpsc::Receiver<AcpEventFrame>,
}

/// Translate a legacy gateway-facing short model name ("sonnet", "opus",
/// "haiku") to a full model id. Returns `None` for unknown short names so
/// callers can fall through to passing the input verbatim (supports full ids
/// like "claude-sonnet-4-6" without a separate validation branch).
pub fn model_id_for_short_name(short: &str) -> Option<String> {
    match short {
        "sonnet" => Some("claude-sonnet-4-6".to_string()),
        "opus" => Some("claude-opus-4-7".to_string()),
        "haiku" => Some("claude-haiku-4-5".to_string()),
        _ => None,
    }
}

/// Resolve the initial ACP model id to apply for a gateway/cron session,
/// given the backend that will actually run and the caller's
/// `(provider, model)` override.
///
/// The ACP model-id shape differs per backend, so the `provider` segment must
/// be handled differently:
///
/// - **Claude Code**: model ids are bare (e.g. `claude-sonnet-4-6`). Short
///   names (`sonnet`/`opus`/`haiku`) map to full ids; `provider` is irrelevant
///   because the claude-code binary is anthropic-only.
/// - **OpenCode / Codex**: the ACP model id is itself `provider/model`
///   (e.g. `scnet/MiniMax-M2.5`), so we re-join the segments. The previous
///   behavior passed only the bare `model`, producing an id the agent could
///   not match — it silently fell back to its default model. Re-joining fixes
///   that. When `provider` is empty we pass `model` through unchanged.
pub fn resolve_initial_model(agent_type: amux::AgentType, provider: &str, model: &str) -> String {
    match agent_type {
        amux::AgentType::ClaudeCode => {
            model_id_for_short_name(model).unwrap_or_else(|| model.to_string())
        }
        _ => {
            if provider.is_empty() {
                model.to_string()
            } else {
                format!("{provider}/{model}")
            }
        }
    }
}

pub struct RuntimeManager {
    agents: HashMap<String, RuntimeHandle>,
    pub aggregators: std::collections::HashMap<String, TurnAggregator>,
    launch_configs: HashMap<amux::AgentType, AgentLaunchConfig>,
    /// Local agent backend selected by daemon config `agents.local_agent`
    /// (`opencode` / `pi` / `cursor` / `claude-code` via `dyn AgentBackend`).
    pub(super) agent_backend: Arc<AsyncMutex<Box<dyn AgentBackend>>>,
    /// The agent type `agents.local_agent` resolved to — the same value
    /// [`create_backend`] dispatched on when building `agent_backend`.
    ///
    /// Recorded rather than re-derived because `launch_configs` cannot answer
    /// the question: ClaudeCode and Pi entries are inserted unconditionally, so
    /// "is this key present" says nothing about what was configured. See
    /// [`Self::default_agent_type`].
    default_agent_type: amux::AgentType,
    /// Per-worktree MCP resolve snapshots; restored when the last agent on the worktree stops.
    opencode_snapshots: HashMap<String, opencode_snapshot::WorktreeOpencodeSnapshot>,
    /// Daemon-side mirror of per-agent ACP state (current model + last-announced
    /// slash commands) used to populate `RuntimeInfo`. See `agent_runtime_state`.
    agent_state: PerAgentRuntimeState,
    /// Last-known model catalog per (backend, worktree) for this device. The
    /// catalog belongs to the one global `opencode serve` / pi / cursor child,
    /// not to any single binding — see `config::model_catalog` for why storing
    /// it per-handle produced sessions that could never leave 连接中.
    model_catalog: DeviceModelCatalog,
    /// Where [`Self::model_catalog`] is persisted (same test-isolation split as
    /// the model catalog path).
    model_catalog_path: PathBuf,
    backend: Option<Arc<dyn Backend>>,
    /// agent_ids that were stopped by the idle sweeper and still need their
    /// terminal `runtime/{id}/state` publish + retain clear. Drained by the
    /// main event loop via `drain_evicted`. Manual `stop_runtime` calls go
    /// through the RPC handler which publishes directly, so they do NOT
    /// enter this buffer.
    evicted_pending_publish: Vec<String>,
    /// Set on every mutation of `agents`; drained by the main loop, which
    /// republishes the actor snapshot. See `mark_actor_state_dirty`.
    actor_state_dirty: bool,
    refresh_coordinator: Option<Arc<RuntimeRefreshCoordinator>>,
    /// Maps backend session ids to TeamClu cloud sessions for MCP adapters.
    context_service: Option<Arc<super::context_service::RuntimeContextService>>,
    /// Test-only: records the last body sent per agent_id via send_prompt_raw.
    #[cfg(test)]
    last_sent: HashMap<String, String>,
    #[cfg(test)]
    send_failures: HashMap<String, String>,
    #[cfg(test)]
    permission_log: Vec<(String, bool)>,
}

// Permission-response routing lives in `manager/permission.rs` as a child
// module so it can reach the private `agents` map directly.
mod permission;
// OpenCode opencode.json snapshot/restore lives in `manager/opencode_snapshot.rs`.
mod opencode_snapshot;
// Read-only agent lookups (by session_id / runtime key / acp session uuid).
mod lookup;
// Workspace-scoped runtime queries (active handles / stop-all for a workspace).
mod workspace_query;
// Idle-runtime eviction (idle sweeper + drain buffer).
mod eviction;
// ACP event draining (poll_events / poll_events_for).
mod poll;
// Agent turn cancellation + session restart.
mod cancel;
// Model switching (set_model / maybe_apply_model / send_set_model).
mod model_apply;

impl RuntimeManager {
    pub fn attach_refresh_coordinator(&mut self, coordinator: Arc<RuntimeRefreshCoordinator>) {
        crate::runtime::refresh::set_global_coordinator(Arc::clone(&coordinator));
        self.refresh_coordinator = Some(coordinator);
    }

    pub fn attach_context_service(&mut self, service: Arc<super::context_service::RuntimeContextService>) {
        self.context_service = Some(service);
    }

    pub async fn wire_context_service_to_backend(&self) {
        let Some(service) = self.context_service.as_ref() else {
            return;
        };
        self.agent_backend
            .lock()
            .await
            .attach_context_service(Arc::clone(service));
    }

    /// Shared OpenCode host pool used by chat and workspace services.
    pub async fn opencode_host_pool(
        &self,
    ) -> Option<Arc<crate::runtime::opencode_http::host_pool::OpenCodeHostPool>> {
        self.agent_backend.lock().await.opencode_host_pool()
    }

    pub fn agent_backend_handle(&self) -> Arc<AsyncMutex<Box<dyn AgentBackend>>> {
        Arc::clone(&self.agent_backend)
    }

    pub fn new(
        launch_configs: HashMap<amux::AgentType, AgentLaunchConfig>,
        backend: Option<Arc<dyn Backend>>,
    ) -> Self {
        Self::with_local_agent("opencode", launch_configs, backend)
    }

    /// Like [`Self::new`] but selects the local agent backend from the daemon
    /// config's `agents.local_agent` ("opencode" default | "pi").
    pub fn with_local_agent(
        local_agent: &str,
        launch_configs: HashMap<amux::AgentType, AgentLaunchConfig>,
        backend: Option<Arc<dyn Backend>>,
    ) -> Self {
        // Tests must never write into the developer's real `~/.amuxd`, but
        // should still exercise the record-and-save path, so give each manager
        // its own throwaway file instead of stubbing the store out.
        #[cfg(test)]
        #[cfg(test)]
        let model_catalog_path = std::env::temp_dir()
            .join("amuxd-test-model-catalog")
            .join(format!("{}.toml", Uuid::new_v4()));
        #[cfg(not(test))]
        let model_catalog_path = DeviceModelCatalog::default_path();
        Self {
            agents: HashMap::new(),
            aggregators: std::collections::HashMap::new(),
            launch_configs,
            agent_backend: Arc::new(AsyncMutex::new(create_backend(local_agent))),
            default_agent_type: agent_type_for_local_agent(local_agent),
            opencode_snapshots: HashMap::new(),
            agent_state: PerAgentRuntimeState::new(),
            model_catalog: DeviceModelCatalog::load(&model_catalog_path),
            model_catalog_path,
            backend,
            refresh_coordinator: None,
            context_service: None,
            evicted_pending_publish: Vec::new(),
            actor_state_dirty: false,
            #[cfg(test)]
            last_sent: HashMap::new(),
            #[cfg(test)]
            send_failures: HashMap::new(),
            #[cfg(test)]
            permission_log: Vec::new(),
        }
    }

    pub fn default_launch_configs() -> HashMap<amux::AgentType, AgentLaunchConfig> {
        HashMap::from([(
            amux::AgentType::ClaudeCode,
            AgentLaunchConfig::new("claude", Vec::new(), "claude"),
        )])
    }

    /// Agent type used for sessions where the caller doesn't specify one — the
    /// gateway path (WeCom/Discord/Feishu/…), cron, the MRU lookup, and the
    /// model-catalog probe.
    ///
    /// This is simply what `agents.local_agent` selected, which is what
    /// single-agent mode means. It used to be inferred by probing
    /// `launch_configs` for Opencode, then Codex, then falling back to
    /// ClaudeCode — which had no branch for Pi or Cursor, so a pi or cursor
    /// daemon reported ClaudeCode here. That fed `launch_config_for` and made
    /// the catalog probe check for the `claude` binary, failing before it ever
    /// reached the real backend, and made `recent_models` read the MRU under the
    /// wrong backend key.
    pub fn default_agent_type(&self) -> amux::AgentType {
        self.default_agent_type
    }

    /// Backend id for the configured local agent (`"opencode"` / `"pi"` /
    /// `"cursor"` / `"claude"`) — the key both `ModelMru` and
    /// `DeviceModelCatalog` are partitioned by.
    pub fn local_backend_type(&self) -> &'static str {
        self.launch_config_for(self.default_agent_type())
            .backend_type
    }

    pub fn launch_config_for(&self, agent_type: amux::AgentType) -> AgentLaunchConfig {
        if let Some(cfg) = self.launch_configs.get(&agent_type).cloned() {
            return cfg;
        }
        // Every AgentType we can be asked to resolve must have its own entry in
        // `launch_configs` (populated in daemon/server.rs). Silently falling back
        // to ClaudeCode's binary here previously caused pi to spawn the `claude`
        // binary when its own entry was momentarily missing — so a missing entry
        // is now a loud bug signal, not a quiet substitution.
        tracing::error!(
            ?agent_type,
            "no launch_configs entry for this agent type; falling back to claude-code config — this is a bug, add the missing entry in daemon/server.rs"
        );
        self.launch_configs
            .get(&amux::AgentType::ClaudeCode)
            .cloned()
            .unwrap_or_else(|| AgentLaunchConfig::new("claude", Vec::new(), "claude"))
    }

    /// Pre-warm shared ACP hosts so the first `runtimeStart` only pays for
    /// `session/new`, not process spawn + `initialize`.
    pub async fn prewarm_agent_backend(&mut self) {
        self.agent_backend
            .lock()
            .await
            .prewarm(&self.launch_configs)
            .await;
    }

    /// Pre-warm shared ACP hosts using a real session env so the fingerprint
    /// matches the first `attach_session` for that env — collapsing the first
    /// `runtimeStart` from "process spawn + initialize + session/new" (20s+
    /// cold) down to just `session/new`. Empty-env `prewarm_agent_backend` never
    /// matched a team session's env, so it left the first real session cold.
    pub async fn prewarm_agent_backend_with_env(
        &mut self,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        self.agent_backend
            .lock()
            .await
            .prewarm_with_env(
                &self.launch_configs,
                extra_env,
                force_env_override,
                worktree,
            )
            .await;
    }

    pub async fn prewarm_agent_backend_for_workspace(
        &mut self,
        workspace_id: &str,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: &str,
    ) {
        let revision = ProcessEnvRevision::from_bindings(&extra_env);
        self.agent_backend
            .lock()
            .await
            .prewarm_workspace(
                &self.launch_configs,
                IsolationDomainKey::Workspace(workspace_id.to_string()),
                revision,
                extra_env,
                force_env_override,
                worktree,
            )
            .await;
    }

    /// Records the latest slash-command list for an agent. Callers feed this
    /// from translated `AvailableCommands` events (e.g. messaging path /
    /// backend event translators) so `to_proto_info` can include them in
    /// retained state.
    pub fn set_available_commands(
        &mut self,
        agent_id: &str,
        commands: Vec<amux::AcpAvailableCommand>,
    ) {
        self.agent_state.set_commands(agent_id, commands);
    }

    /// Return the slash commands last reported by `agent_id`, or an empty vec.
    pub fn get_available_commands(&self, agent_id: &str) -> Vec<amux::AcpAvailableCommand> {
        self.agent_state.commands(agent_id)
    }

    /// Records that an agent's session is now running on `model_id`.
    /// Caller is responsible for actually invoking set_model on the backend;
    /// this only updates the tracking map.
    ///
    /// Doubles as the single write point for the device MRU: every surface
    /// that settles on a model — desktop picker, gateway `/model`, cron, and
    /// the resolution done at attach — funnels through here, so recording at
    /// this one spot keeps the shared list honest without scattering writes.
    ///
    /// Recorded under the runtime's backend, since model ids only mean
    /// anything within one. A runtime that has
    /// already been dropped from `agents` falls back to the daemon default,
    /// which is the backend it would have been running on.
    pub fn set_current_model(&mut self, agent_id: &str, model_id: &str) {
        // Whether this is a real change, decided *before* `set_model` overwrites
        // it. Attach-time resolution re-applies the same value on every runtime
        // start, so without this the cloud write below would fire once per
        // spawn with nothing new to say.
        let changed = self.agent_state.model(agent_id).map(String::as_str) != Some(model_id);

        self.agent_state.set_model(agent_id, model_id);
        if changed {
            self.persist_participant_model(agent_id, model_id);
        }
    }

    /// Mirror a settled model onto `session_participants.model` (ADR-0005),
    /// which is the authoritative answer to "what model does this session run
    /// on" and the one every client reads (ADR-0007).
    ///
    /// Fire-and-forget on purpose. The cursor write in `messaging.rs` can await
    /// its backend call because it already sits in an async handler; this is a
    /// sync method reached from six call sites, several of them on the runtime
    /// start path. Blocking any of them on a cloud round trip to persist a
    /// display value would trade a correct field for a slower spawn.
    ///
    /// Skipped when there is no backend (tests, offline daemon) or when the
    /// attachment carries no session / actor to address the row by —
    /// `owner_actor_id` is stamped by the env snapshot and back-filled in
    /// `runtime_lifecycle`, so it is briefly empty on a cold attach.
    fn persist_participant_model(&self, runtime_id: &str, model_id: &str) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some((session_id, actor_id, model)) =
            self.participant_model_write(runtime_id, model_id)
        else {
            return;
        };

        tokio::spawn(async move {
            if let Err(e) = backend
                .update_participant_model(&session_id, &actor_id, &model)
                .await
            {
                // A stale display value is not worth failing anything over; the
                // next model change re-attempts it.
                warn!(?e, session_id, "update_participant_model failed");
            }
        });
    }

    /// The `(session, actor, model)` a participant-model write would target, or
    /// `None` when this runtime cannot address a row.
    ///
    /// Split out from the spawn above so the decision is testable without
    /// waiting on a detached task — the addressing is the part that has a
    /// wrong answer available (see `owner_actor_id` vs `agent_id`), the spawn
    /// is glue.
    fn participant_model_write(
        &self,
        runtime_id: &str,
        model_id: &str,
    ) -> Option<(String, String, String)> {
        let handle = self.agents.get(runtime_id)?;
        let session_id = handle.session_id.trim();
        // The cloud row is keyed by the *actor*, not by `agent_id` — that one is
        // the 8-char spawn key and means nothing to Supabase.
        let actor_id = handle.owner_actor_id.trim();
        let model = model_id.trim();
        if session_id.is_empty() || actor_id.is_empty() || model.is_empty() {
            return None;
        }
        Some((
            session_id.to_string(),
            actor_id.to_string(),
            model.to_string(),
        ))
    }

    /// Canonical backend id (`"opencode"` / `"pi"`) a runtime runs on.
    fn backend_id_for_runtime(&self, agent_id: &str) -> &'static str {
        let agent_type = self
            .agents
            .get(agent_id)
            .map(|h| h.agent_type)
            .unwrap_or_else(|| self.default_agent_type());
        self.launch_config_for(agent_type).backend_type
    }

    /// Returns the model id last recorded for `agent_id`, if any.
    pub fn current_model(&self, agent_id: &str) -> Option<&String> {
        self.agent_state.model(agent_id)
    }

    /// Returns a mutable reference to the per-agent `TurnAggregator`, if any.
    /// Inserted on `start_runtime` / `resume_agent` and removed on `stop_runtime`.
    pub fn aggregator_mut(&mut self, agent_id: &str) -> Option<&mut TurnAggregator> {
        self.aggregators.get_mut(agent_id)
    }

    /// Read-only access for the publish path to read `current_turn_id`
    /// without needing a mutable borrow.
    pub fn aggregator(&self, agent_id: &str) -> Option<&TurnAggregator> {
        self.aggregators.get(agent_id)
    }

    fn uses_deferred_initial_prompt(agent_type: amux::AgentType) -> bool {
        matches!(
            agent_type,
            amux::AgentType::Opencode | amux::AgentType::Pi
        )
    }

    fn validate_managed_session_metadata(
        agent_type: amux::AgentType,
        startup: &AcpStartupMetadata,
        teamclu_session_id: &str,
    ) -> crate::error::Result<()> {
        if !Self::uses_deferred_initial_prompt(agent_type) {
            return Ok(());
        }
        if startup.host_generation_id.trim().is_empty()
            || startup.acp_session_id.trim().is_empty()
            || teamclu_session_id.trim().is_empty()
        {
            return Err(crate::error::AmuxError::Agent(
                "session context metadata incomplete for managed runtime".into(),
            ));
        }
        Ok(())
    }

    fn register_attached_session_context(
        &self,
        agent_type: amux::AgentType,
        startup: &AcpStartupMetadata,
        teamclu_session_id: &str,
        runtime_id: &str,
    ) {
        if let Some(service) = self.context_service.as_ref() {
            service.register_attached_session(
                agent_type,
                &startup.host_generation_id,
                &startup.acp_session_id,
                teamclu_session_id,
                runtime_id,
            );
        }
    }

    async fn send_deferred_initial_prompt(
        &self,
        agent_type: amux::AgentType,
        cmd_tx: &mpsc::Sender<AcpCommand>,
        startup: &AcpStartupMetadata,
        prompt: &str,
    ) -> crate::error::Result<()> {
        if !Self::uses_deferred_initial_prompt(agent_type) || prompt.is_empty() {
            return Ok(());
        }
        cmd_tx
            .send(AcpCommand::Prompt {
                acp_session_id: startup.acp_session_id.clone(),
                text: prompt.to_string(),
                attachment_urls: Vec::new(),
                requester_actor_id: None,
                reply_to_message_id: None,
            })
            .await
            .map_err(|_| {
                if let Some(service) = self.context_service.as_ref() {
                    service.unregister_backend_session(
                        agent_type,
                        &startup.host_generation_id,
                        &startup.acp_session_id,
                    );
                }
                crate::error::AmuxError::Agent("failed to enqueue initial prompt".into())
            })
    }

    async fn detach_backend_session(cmd_tx: &mpsc::Sender<AcpCommand>, acp_session_id: &str) {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        if cmd_tx
            .send(AcpCommand::DetachSession {
                acp_session_id: acp_session_id.to_string(),
                ack: Some(ack_tx),
            })
            .await
            .is_ok()
            && tokio::time::timeout(std::time::Duration::from_secs(5), ack_rx)
                .await
                .is_err()
        {
            tracing::warn!(
                acp_session_id,
                "timed out waiting for runtime detach acknowledgement"
            );
        }
    }

    async fn finalize_attached_session(
        &self,
        agent_type: amux::AgentType,
        startup: &AcpStartupMetadata,
        teamclu_session_id: &str,
        runtime_id: &str,
        cmd_tx: &mpsc::Sender<AcpCommand>,
        prompt: &str,
    ) -> crate::error::Result<()> {
        if let Err(err) = Self::validate_managed_session_metadata(agent_type, startup, teamclu_session_id) {
            Self::detach_backend_session(cmd_tx, &startup.acp_session_id).await;
            return Err(err);
        }
        self.register_attached_session_context(agent_type, startup, teamclu_session_id, runtime_id);
        if let Err(err) = self
            .send_deferred_initial_prompt(agent_type, cmd_tx, startup, prompt)
            .await
        {
            Self::detach_backend_session(cmd_tx, &startup.acp_session_id).await;
            return Err(err);
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn start_runtime(
        &mut self,
        agent_type: amux::AgentType,
        prompt: &str,
        workspace_id: &str,
        remote_workspace_id: Option<&str>,
        session_id: &str,
        context: ExecutionContext,
    ) -> crate::error::Result<String> {
        self.start_runtime_with_model(
            agent_type,
            prompt,
            workspace_id,
            remote_workspace_id,
            session_id,
            None,
            None,
            None,
            false,
            context,
        )
        .await
    }

    /// Variant of `start_runtime` that pins the initial ACP model. Used by
    /// `create_gateway_session_with_model` to honour a per-session
    /// `set_model` override the gateway recorded before the first prompt.
    /// `initial_model_override` is a full model id (e.g. "claude-sonnet-4-6"),
    /// not a short name — callers map short names via `model_id_for_short_name`.
    /// `mcp_config_path`, when `Some`, is forwarded as `--mcp-config <path>`
    /// to the spawned claude-code so it can call amuxd's `send` tool.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_runtime_with_model(
        &mut self,
        agent_type: amux::AgentType,
        prompt: &str,
        workspace_id: &str,
        remote_workspace_id: Option<&str>,
        session_id: &str,
        initial_model_override: Option<String>,
        mcp_config_path: Option<PathBuf>,
        resume_acp_session_id: Option<String>,
        forbid_new_session_fallback: bool,
        context: ExecutionContext,
    ) -> crate::error::Result<String> {
        // An attachment is an attachment *to a session* (ADR-0004). The map is
        // keyed by that session, so a spawn without one has no identity — it
        // would collide with every other sessionless spawn under "".
        if session_id.trim().is_empty() {
            return Err(crate::error::AmuxError::Agent(
                "session_id is required to attach a runtime".into(),
            ));
        }
        // The key IS the session. There is no per-spawn id: that id was minted
        // fresh on every start, published nowhere, and stale the moment it was
        // written down — which is what made a cancel land on a dead runtime.
        let agent_id = session_id.to_string();
        if self.agents.contains_key(&agent_id) {
            return Err(crate::error::AmuxError::Agent(format!(
                "session {agent_id} already has an attachment on this daemon"
            )));
        }
        let ExecutionContext {
            isolation_domain,
            workspace: _,
            working_directory,
            spawn_env: runtime_env,
        } = context;
        let worktree = working_directory.to_string_lossy().into_owned();
        let process_env_revision = ProcessEnvRevision::from_bindings(&runtime_env.extra_env);
        let permission = runtime_env.permission_policy();
        let SpawnRuntimeEnv {
            extra_env,
            resolved_env,
            env_team_id,
            force_env_override,
            opencode_json_original,
            is_gateway,
            permission: _,
        } = runtime_env;
        self.register_opencode_snapshot(&worktree, opencode_json_original, &extra_env);
        let mut handle = RuntimeHandle::new(
            agent_id.clone(),
            agent_type,
            worktree.clone(),
            workspace_id.into(),
        );
        handle.isolation_domain = isolation_domain.clone();
        handle.process_env_revision = process_env_revision.clone();
        handle.current_prompt = prompt.into();
        handle.env_fingerprint = resolved_env
            .as_ref()
            .map(|snapshot| snapshot.fingerprint.clone());
        handle.env_snapshot = resolved_env;
        handle.env_team_id = env_team_id;
        handle.stamp_owner_actor_from_env();
        handle.session_id = session_id.to_string();
        // No static fallback: models come only from the live serve catalog
        // captured at attach time. Empty until the runtime advertises them.
        handle.available_models = Vec::new();
        handle.is_gateway = is_gateway;

        let launch = self.launch_config_for(agent_type);
        let resume_requested = resume_acp_session_id.is_some();
        let attach_prompt = if Self::uses_deferred_initial_prompt(agent_type) {
            String::new()
        } else {
            prompt.to_string()
        };
        let (cmd_tx, mut startup) = self
            .agent_backend
            .lock()
            .await
            .attach_session(
                agent_type,
                &launch,
                isolation_domain,
                process_env_revision,
                extra_env,
                force_env_override,
                worktree.clone(),
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override.clone(),
                // No device MRU: every entry point pins a model when it is
                // created, so attach has nothing left to infer from (ADR-0007).
                Vec::new(),
                attach_prompt,
                handle.event_tx.clone(),
                permission,
                forbid_new_session_fallback,
                session_id.to_string(),
            )
            .await?;

        self.finalize_attached_session(
            agent_type,
            &startup,
            session_id,
            &agent_id,
            &cmd_tx,
            prompt,
        )
        .await?;

        handle.cmd_tx = Some(cmd_tx);
        handle.host_generation_id = startup.host_generation_id.clone();
        handle.route_lease = startup.route_lease.take();

        self.agents.insert(agent_id.clone(), handle);
        self.mark_actor_state_dirty();
        self.aggregators
            .insert(agent_id.clone(), TurnAggregator::new());

        self.record_catalog(&worktree, &startup.available_models);
        if let Some(h) = self.agents.get_mut(&agent_id) {
            h.available_models = startup.available_models;
            h.acp_session_id = startup.acp_session_id.clone();
            h.status = amux::AgentStatus::Active;
        }
        if resume_requested {
            info!(
                agent_id,
                worktree,
                backend_session_id = %startup.acp_session_id,
                "agent attached via shared ACP host (ACP resume requested)"
            );
        } else {
            info!(
                agent_id,
                worktree,
                backend_session_id = %startup.acp_session_id,
                "agent attached via shared ACP host"
            );
        }
        if let Some(model_id) = startup.initial_model {
            self.set_current_model(&agent_id, &model_id);
        }

        self.seed_cursor_from_prior_runtime(&agent_id, Some(session_id))
            .await;

        Ok(agent_id)
    }

    /// Carry forward the `last_processed_message_id` cursor from a prior
    /// runtime row for the same `(agent_id, session_id)` pair. Without
    /// this, a fresh ACP backend session always lands on a brand-new
    /// `agent_runtimes` row (the upsert conflict key is
    /// `(agent_id, backend_session_id)`), so `catchup_runtime` would
    /// replay the entire session history on every daemon restart. We pull
    /// the latest row and seed the in-memory handle so catchup only
    /// replays truly-new messages.
    ///
    /// No-op when there is no backend client, no session id, no prior
    /// row, or the prior row's cursor is empty. Errors are logged and
    /// swallowed — the worst case on failure is a redundant replay, not a
    /// missed message.
    pub(crate) async fn seed_cursor_from_prior_runtime(
        &mut self,
        agent_id: &str,
        remote_session_id: Option<&str>,
    ) {
        let Some(sb) = self.backend.as_ref() else {
            return;
        };
        let Some(session_id) = remote_session_id else {
            return;
        };
        match sb.fetch_session_cursor(session_id, sb.actor_id()).await {
            Ok(Some(cursor)) => {
                if let Some(h) = self.agents.get_mut(agent_id) {
                    info!(
                        agent_id,
                        session_id,
                        cursor = %cursor,
                        "seeded last_processed_message_id from the participant row",
                    );
                    h.last_processed_message_id = Some(cursor);
                }
            }
            Ok(None) => {}
            Err(e) => warn!(agent_id, session_id, "fetch_session_cursor failed: {e}"),
        }
    }

    /// Re-attach to a session whose backend conversation already exists.
    /// `session_id` is both the map key and the handle's session — there is no
    /// second identity to keep in sync.
    pub async fn resume_agent(
        &mut self,
        session_id: &str,
        acp_session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        remote_workspace_id: Option<&str>,
        prompt: &str,
        mcp_config_path: Option<std::path::PathBuf>,
        forbid_new_session_fallback: bool,
        context: ExecutionContext,
    ) -> crate::error::Result<String> {
        let ExecutionContext {
            isolation_domain,
            workspace: _,
            working_directory,
            spawn_env: runtime_env,
        } = context;
        let worktree = working_directory.to_string_lossy().into_owned();
        let process_env_revision = ProcessEnvRevision::from_bindings(&runtime_env.extra_env);
        let permission = runtime_env.permission_policy();
        let SpawnRuntimeEnv {
            extra_env,
            resolved_env,
            env_team_id,
            force_env_override,
            opencode_json_original,
            is_gateway,
            permission: _,
        } = runtime_env;
        self.register_opencode_snapshot(&worktree, opencode_json_original, &extra_env);

        let mut handle = RuntimeHandle::new(
            session_id.to_string(),
            agent_type,
            worktree.clone(),
            workspace_id.into(),
        );
        handle.isolation_domain = isolation_domain.clone();
        handle.process_env_revision = process_env_revision.clone();
        handle.env_fingerprint = resolved_env
            .as_ref()
            .map(|snapshot| snapshot.fingerprint.clone());
        handle.env_snapshot = resolved_env;
        handle.env_team_id = env_team_id;
        handle.stamp_owner_actor_from_env();
        handle.session_id = session_id.to_string();
        handle.is_gateway = is_gateway;

        let launch = self.launch_config_for(agent_type);
        let attach_prompt = if Self::uses_deferred_initial_prompt(agent_type) {
            String::new()
        } else {
            prompt.to_string()
        };
        let (cmd_tx, mut startup) = self
            .agent_backend
            .lock()
            .await
            .attach_session(
                agent_type,
                &launch,
                isolation_domain,
                process_env_revision,
                extra_env,
                force_env_override,
                worktree.clone(),
                Some(acp_session_id.to_string()),
                mcp_config_path,
                None,
                // No device MRU: every entry point pins a model when it is
                // created, so attach has nothing left to infer from (ADR-0007).
                Vec::new(),
                attach_prompt,
                handle.event_tx.clone(),
                permission,
                forbid_new_session_fallback,
                session_id.to_string(),
            )
            .await?;

        self.finalize_attached_session(
            agent_type,
            &startup,
            session_id,
            session_id,
            &cmd_tx,
            prompt,
        )
        .await?;

        handle.cmd_tx = Some(cmd_tx);
        handle.host_generation_id = startup.host_generation_id.clone();
        handle.route_lease = startup.route_lease.take();
        handle.current_prompt = prompt.to_string();
        // No static fallback: models come only from the live serve catalog
        // captured at attach time. Empty until the runtime advertises them.
        handle.available_models = Vec::new();

        info!(session_id, worktree, "agent resumed via shared ACP host");
        self.agents.insert(session_id.to_string(), handle);
        self.mark_actor_state_dirty();
        self.aggregators
            .insert(session_id.to_string(), TurnAggregator::new());

        let new_acp_sid = startup.acp_session_id.clone();
        self.record_catalog(&worktree, &startup.available_models);
        if let Some(h) = self.agents.get_mut(session_id) {
            h.available_models = startup.available_models;
            h.acp_session_id = new_acp_sid.clone();
            h.status = amux::AgentStatus::Active;
        }
        if let Some(model_id) = startup.initial_model {
            self.set_current_model(session_id, &model_id);
        }

        self.seed_cursor_from_prior_runtime(session_id, Some(session_id))
            .await;

        Ok(new_acp_sid)
    }

    pub async fn stop_runtime(&mut self, agent_id: &str) -> Option<RuntimeHandle> {
        if let Some(mut handle) = self.agents.remove(agent_id) {
            self.mark_actor_state_dirty();
            self.aggregators.remove(agent_id);
            self.agent_state.remove(agent_id);
            if let Some(service) = self.context_service.as_ref() {
                service.unregister_backend_session(
                    handle.agent_type,
                    &handle.host_generation_id,
                    &handle.acp_session_id,
                );
            }
            self.release_opencode_snapshot(&handle.worktree);
            handle.status = amux::AgentStatus::Stopped;
            handle.shutdown().await;
            // Best-effort cleanup of legacy ambient stamp files left from pre-Phase-2
            // builds. Managed runtimes no longer write active-session-id.
            if !handle.session_id.is_empty() && !handle.worktree.is_empty() {
                teamclu_runtime_env::clear_active_session_id_if_matches(
                    std::path::Path::new(&handle.worktree),
                    &handle.session_id,
                );
            }
            info!(agent_id, "agent stopped");
            Some(handle)
        } else {
            None
        }
    }

    /// Model catalog for a workspace directory (cron catalog UI).
    /// Probe the configured local backend for its live model catalog. The
    /// backend trait dispatches to opencode (serve `/config/providers`) or pi
    /// (`get_available_models`, spawning a child if none is live).
    pub async fn probe_catalog_models(
        &mut self,
        workspace_path: &std::path::Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let models = self
            .agent_backend
            .lock()
            .await
            .model_catalog(workspace_path)
            .await?;
        self.record_catalog(&workspace_path.to_string_lossy(), &models);
        Ok(models)
    }

    pub async fn probe_catalog_models_with_context(
        &mut self,
        context: crate::runtime::execution_context::ExecutionContext,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let workspace_path = context.working_directory;
        let revision = ProcessEnvRevision::from_bindings(&context.spawn_env.extra_env);
        let models = self
            .agent_backend
            .lock()
            .await
            .model_catalog_for_context(
                &workspace_path,
                context.isolation_domain,
                revision,
                context.spawn_env.extra_env,
            )
            .await?;
        self.record_catalog(&workspace_path.to_string_lossy(), &models);
        Ok(models)
    }

    /// Live-probe a workspace catalog without holding the outer `agents`
    /// mutex across slow backend I/O (attach/detach only contend on the
    /// backend lock, not the whole manager).
    pub async fn probe_default_workspace_catalog(
        agents: Arc<AsyncMutex<Self>>,
        context: crate::runtime::execution_context::ExecutionContext,
    ) -> Vec<amux::ModelInfo> {
        let workspace_path = context.working_directory.clone();
        let backend = {
            let guard = agents.lock().await;
            guard.agent_backend_handle()
        };
        let probe_result = {
            let mut backend_guard = backend.lock().await;
            let revision = ProcessEnvRevision::from_bindings(&context.spawn_env.extra_env);
            backend_guard
                .model_catalog_for_context(
                    &workspace_path,
                    context.isolation_domain,
                    revision,
                    context.spawn_env.extra_env,
                )
                .await
        };
        match probe_result {
            Ok(models) => {
                let mut guard = agents.lock().await;
                guard.record_catalog(&workspace_path.to_string_lossy(), &models);
                models
            }
            Err(e) => {
                tracing::warn!(
                    worktree = %workspace_path.display(),
                    error = %e,
                    "default workspace catalog probe failed; publishing empty list"
                );
                Vec::new()
            }
        }
    }

    /// Remember `worktree`'s catalog for this device and persist it.
    ///
    /// Called from every path that learns a real catalog (both attach paths and
    /// the explicit probe). Empty lists are ignored by
    /// [`DeviceModelCatalog::record`], so a failed probe cannot erase a good one.
    fn record_catalog(&mut self, worktree: &str, models: &[amux::ModelInfo]) {
        let backend = self.local_backend_type();
        if !self.model_catalog.record(backend, worktree, models) {
            return;
        }
        if let Err(e) = self.model_catalog.save(&self.model_catalog_path) {
            tracing::warn!(error = %e, "failed to persist model catalog");
        }
    }

    /// This device's last-known catalog for `worktree` under the configured
    /// backend (falling back to any worktree that same backend has served).
    /// Used to fill `RuntimeInfo.available_models` for bindings that never ran
    /// an attach of their own.
    pub fn catalog_for_worktree(&self, worktree: &str) -> Vec<amux::ModelInfo> {
        self.model_catalog
            .models_for_or_any(self.local_backend_type(), worktree)
    }

    /// Fill `info.available_models` from the device catalog when the binding
    /// itself has none.
    ///
    /// Every `RuntimeInfo` leaving this daemon goes through here. Without it,
    /// an idle binding — or a historical `SessionStore` row replayed by
    /// `publish_all_agent_states` — advertises an empty catalog, and clients
    /// read that as "no models", which pins the session's pill at 连接中.
    pub fn fill_catalog(&self, info: &mut amux::RuntimeInfo) {
        if !info.available_models.is_empty() {
            return;
        }
        info.available_models = self.catalog_for_worktree(&info.worktree);
    }

    /// Every agent type a backend may hold a long-lived host process for.
    ///
    /// This used to be spelled inline as `[Opencode, Codex]` at both call sites,
    /// which meant cursor and pi bridge processes were never evicted: cursor kept
    /// serving with a stale API key after the user changed it in Settings, and
    /// both survived daemon exit. Codex was listed despite having no backend at
    /// all. Listing every implemented type is safe — `evict_agent_types` only
    /// removes hosts that exist.
    const EVICTABLE_AGENT_TYPES: &'static [amux::AgentType] = &[
        amux::AgentType::Opencode,
        amux::AgentType::Pi,
        amux::AgentType::Cursor,
        amux::AgentType::ClaudeCode,
    ];

    /// Invalidate long-lived ACP host processes after provider credentials change.
    pub async fn evict_acp_hosts_after_provider_auth_change(&mut self) {
        let removed = self
            .agent_backend
            .lock()
            .await
            .evict_agent_types(Self::EVICTABLE_AGENT_TYPES);
        if removed > 0 {
            info!(
                removed,
                "evicted ACP hosts so new sessions pick up provider auth"
            );
        }
    }

    pub async fn request_workspace_host_refresh(&mut self, workspace_id: &str) -> bool {
        self.agent_backend
            .lock()
            .await
            .invalidate_workspace_host(&IsolationDomainKey::Workspace(workspace_id.to_string()))
    }

    pub async fn request_all_workspace_host_refreshes(&mut self) -> usize {
        self.agent_backend
            .lock()
            .await
            .invalidate_all_workspace_hosts()
    }

    /// Full local-runtime teardown for daemon exit (`amuxd stop` / SIGTERM).
    /// Stops every session handle, then kills backend host processes
    /// (`opencode serve` process group including MCP children).
    pub async fn shutdown_for_exit(&mut self) {
        let ids = self.agent_ids();
        for id in ids {
            let _ = self.stop_runtime(&id).await;
        }
        let removed = self.agent_backend.lock().await.shutdown_for_exit().await;
        info!(
            removed_hosts = removed,
            "local agent backends shut down for daemon exit"
        );
    }

    /// Send a prompt to an existing agent via ACP, draining buffered
    /// `inject_context` instructions and `pending_silent` messages first.
    /// Returns the drained silent message IDs (empty when none existed).
    pub async fn send_prompt(
        &mut self,
        agent_id: &str,
        text: &str,
        attachment_urls: Vec<String>,
    ) -> crate::error::Result<Vec<String>> {
        self.send_prompt_with_requester(agent_id, text, attachment_urls, None, None)
            .await
    }

    /// Like [`send_prompt`], but stamps turn-scoped requester / reply_to onto the
    /// ACP prompt job (bound when the prompt worker starts the turn).
    pub async fn send_prompt_with_requester(
        &mut self,
        agent_id: &str,
        text: &str,
        attachment_urls: Vec<String>,
        requester_actor_id: Option<String>,
        reply_to_message_id: Option<String>,
    ) -> crate::error::Result<Vec<String>> {
        let (final_text, drained_ids, drained_messages, drained_injected, drained_next_context) =
            if let Some(handle) = self.agents.get_mut(agent_id) {
                let drained_messages = handle.pending_silent.clone();
                let drained_injected = handle.injected_context.clone();
                let drained_next_context = std::mem::take(&mut handle.next_prompt_context);
                let (injected_prefix, _) = if super::instruction_delivery::skips_buffered_inject(
                    handle.instruction_delivery,
                ) {
                    (String::new(), Vec::new())
                } else {
                    handle.flush_injected_context()
                };
                let (silent_prefix, drained) = handle.flush_pending_silent();
                let next_context_prefix = if drained_next_context.is_empty() {
                    String::new()
                } else {
                    format!("{drained_next_context}\n\n")
                };
                let prefix = format!("{injected_prefix}{next_context_prefix}{silent_prefix}");
                let final_text = if prefix.is_empty() {
                    text.to_string()
                } else {
                    format!("{prefix}{text}")
                };
                (
                    final_text,
                    drained,
                    drained_messages,
                    drained_injected,
                    drained_next_context,
                )
            } else {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    agent_id
                )));
            };

        if let Err(err) = self
            .send_prompt_raw(
                agent_id,
                &final_text,
                attachment_urls,
                requester_actor_id,
                reply_to_message_id,
            )
            .await
        {
            if let Some(handle) = self.agents.get_mut(agent_id) {
                if !drained_injected.is_empty() {
                    handle.injected_context = drained_injected;
                }
                if !drained_next_context.is_empty() {
                    handle.next_prompt_context = drained_next_context;
                }
                if !drained_messages.is_empty() {
                    let mut restored = drained_messages;
                    restored.append(&mut handle.pending_silent);
                    handle.pending_silent = restored;
                }
            }
            return Err(err);
        }
        if let Some(handle) = self.agents.get_mut(agent_id) {
            handle.status = amux::AgentStatus::Active;
            handle.current_prompt = text.to_string();
        }
        Ok(drained_ids)
    }

    /// Inner helper: send the given body to ACP without any prefix logic.
    pub async fn send_prompt_raw(
        &mut self,
        agent_id: &str,
        text: &str,
        attachment_urls: Vec<String>,
        requester_actor_id: Option<String>,
        reply_to_message_id: Option<String>,
    ) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            let _ = (&attachment_urls, &requester_actor_id);
            if let Some(message) = self.send_failures.remove(agent_id) {
                return Err(crate::error::AmuxError::Agent(message));
            }
            let event_tx = if let Some(h) = self.agents.get_mut(agent_id) {
                h.bump_activity();
                Some(h.event_tx.clone())
            } else {
                None
            };
            self.last_sent
                .insert(agent_id.to_string(), text.to_string());
            if let Some(event_tx) = event_tx {
                let text = text.to_string();
                let reply_to = reply_to_message_id.clone();
                tokio::spawn(async move {
                    let _ = event_tx
                        .send(
                            AcpEventFrame::new(
                                "",
                                amux::AcpEvent {
                                    event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                                        text,
                                        is_complete: true,
                                    })),
                                    model: String::new(),
                                },
                            )
                            .with_reply_to(reply_to),
                        )
                        .await;
                });
            }
            return Ok(());
        }
        #[cfg(not(test))]
        {
            let (acp_session_id, attachment_count) = {
                let handle = self.agents.get(agent_id).ok_or_else(|| {
                    crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
                })?;
                (handle.acp_session_id.clone(), attachment_urls.len())
            };
            super::agent_trace::log_runtime_prompt(
                agent_id,
                &acp_session_id,
                text,
                attachment_count,
            );
            let handle = self.agents.get_mut(agent_id).ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
            })?;
            handle.bump_activity();
            handle
                .send_prompt(
                    text,
                    attachment_urls,
                    requester_actor_id,
                    reply_to_message_id,
                )
                .await
        }
    }

    /// Returns an agent_id whose adapter has finished initializing and is ready
    /// for prompts. Excludes Starting (transient) and dead statuses -- an agent
    /// in Starting may crash before becoming Active, and baking that into a
    /// session's `primary_agent_id` would point to a dead slot.
    /// Used to populate the `primary_agent_id` of newly created collab sessions
    /// in v1 (multi-agent sessions are out of scope).
    /// Whether any agent infrastructure is available: either an active session
    /// or a prewarmed ACP host. Used by `handle_prompt_await` to gate cron
    /// execution without requiring the Tauri app to have created a session
    /// first (which would break cron on fresh daemon starts).
    pub async fn agent_count(&self) -> usize {
        self.agents.len() + self.agent_backend.lock().await.host_count()
    }

    pub fn first_running_agent_id(&self) -> Option<String> {
        self.agents
            .iter()
            .find(|(_, h)| {
                matches!(
                    h.status,
                    amux::AgentStatus::Active | amux::AgentStatus::Idle
                )
            })
            .map(|(id, _)| id.clone())
    }

    pub fn running_agent_id_for_collab_session(&self, session_id: &str) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| {
                h.session_id == session_id
                    && matches!(
                        h.status,
                        amux::AgentStatus::Active | amux::AgentStatus::Idle
                    )
            })
            .map(|(id, _)| id.clone())
    }

    pub fn get_handle(&self, agent_id: &str) -> Option<&RuntimeHandle> {
        self.agents.get(agent_id)
    }

    /// Whether this runtime is driving a turn right now.
    ///
    /// The unattended drive paths (cron's `drive_cron_turn`, the gateway's
    /// `AmuxdAgentHandle::send_prompt`) hold the handle's `turn_lock` for the
    /// whole turn, so a failed `try_lock` means "an answer is in flight".
    /// Runtime bookkeeping consults this before stopping anything: a stopped
    /// runtime takes its unfinished turn with it, and the caller that asked
    /// for the answer just never gets one.
    pub fn turn_in_flight(&self, runtime_id: &str) -> bool {
        self.get_handle(runtime_id)
            .map(|h| h.turn_lock.try_lock().is_err())
            .unwrap_or(false)
    }

    /// Find an existing live runtime matching the (session_id, agent_type,
    /// workspace_id) key. Used by `apply_start_runtime` to dedupe duplicate
    /// `RuntimeStart` RPCs from misbehaving clients into a single spawn.
    ///
    /// Bare-agent spawns (empty `session_id`) are never deduped — every such
    /// call gets its own runtime. `stop_runtime` removes handles from the map,
    /// so anything present here is by definition still tracked; the caller
    /// reads `AgentStatus` off the retained state topic if it cares about
    /// liveness.
    /// Tuple-exact lookup `(session_id, agent_type, workspace_id)`.
    ///
    /// Retained for reference/tests: `apply_start_runtime` now enforces the
    /// stronger "one live runtime per session" invariant directly (reuse the
    /// tuple-exact match, supersede the rest), so this is no longer on the
    /// runtime-start hot path.
    #[allow(dead_code)]
    pub fn find_active_runtime_for(
        &self,
        session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
    ) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| {
                h.session_id == session_id
                    && h.agent_type == agent_type
                    && h.workspace_id == workspace_id
                    && matches!(
                        h.status,
                        amux::AgentStatus::Starting
                            | amux::AgentStatus::Active
                            | amux::AgentStatus::Idle
                    )
            })
            .map(|(id, _)| id.clone())
    }

    pub fn get_handle_mut(&mut self, agent_id: &str) -> Option<&mut RuntimeHandle> {
        self.agents.get_mut(agent_id)
    }

    /// Advance the in-memory replay cursor after routing a session message.
    /// The backend row is updated separately; both must stay in sync so a
    /// later dedup catchup does not re-prompt already-handled rows.
    pub fn advance_message_cursor(&mut self, runtime_id: &str, message_id: &str) {
        if message_id.is_empty() {
            return;
        }
        if let Some(h) = self.agents.get_mut(runtime_id) {
            h.last_processed_message_id = Some(message_id.to_string());
        }
    }

    /// Look up the agent for `acp_session_id`, take its `event_rx` out of
    /// the manager-owned handle, and return the bits needed to drive a
    /// turn without holding the global mutex. Caller MUST eventually call
    /// `checkin_turn` (or the channel stays parked and `poll_events`
    /// silently drops the agent's events).
    pub fn checkout_turn_for_acp(
        &mut self,
        acp_session_id: &str,
    ) -> crate::error::Result<(CheckedOutTurn, std::sync::Arc<tokio::sync::Mutex<()>>)> {
        let agent_id = self
            .agent_id_by_acp_session(acp_session_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!(
                    "no agent for acp_session_id {acp_session_id}"
                ))
            })?;
        let handle = self.agents.get_mut(&agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {agent_id} disappeared during checkout"))
        })?;
        let event_rx = handle.event_rx.take().ok_or_else(|| {
            crate::error::AmuxError::Agent(format!(
                "agent {agent_id} event_rx already checked out (concurrent turn?)"
            ))
        })?;
        let turn_lock = handle.turn_lock.clone();
        Ok((CheckedOutTurn { agent_id, event_rx }, turn_lock))
    }

    /// Hand the per-agent `event_rx` back so daemon `poll_events` resumes
    /// draining and follow-up turns can take it out again. Idempotent: if
    /// the agent has been removed in the meantime, the receiver is dropped.
    pub fn checkin_turn(&mut self, turn: CheckedOutTurn) {
        if let Some(handle) = self.agents.get_mut(&turn.agent_id) {
            handle.event_rx = Some(turn.event_rx);
        }
    }

    /// Mark the actor snapshot stale so the main loop republishes it.
    ///
    /// Hooking the publish onto `apply_start_runtime` is not enough: gateway
    /// and cron spawn straight through this manager and never reach that
    /// function, so their attachments stayed invisible in the retain until an
    /// unrelated MQTT reconnect. Every mutation of `agents` funnels through
    /// here instead, which is the only way all three spawn paths agree.
    pub fn mark_actor_state_dirty(&mut self) {
        self.actor_state_dirty = true;
    }

    /// Consume the stale flag. Called once per main-loop tick.
    pub fn take_actor_state_dirty(&mut self) -> bool {
        std::mem::take(&mut self.actor_state_dirty)
    }

    /// Session attachment lookup scoped to a cloud actor when `actor_id` is set.
    /// Among matches, prefer the newest `started_at` (same rule as command
    /// resolve) so a leaked mid-turn sibling is not picked at random.
    pub fn attachment_for_session_actor(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> Option<&RuntimeHandle> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return None;
        }
        let actor_id = actor_id.trim();
        self.agents
            .values()
            .filter(|h| {
                h.session_id == session_id
                    && (actor_id.is_empty()
                        || h.owner_actor_id.is_empty()
                        || h.owner_actor_id == actor_id)
            })
            .max_by_key(|h| h.started_at)
    }

    /// The sessions this daemon currently holds an attachment for.
    ///
    /// Absence from this list is meaningful: it is how a client tells "warm,
    /// answers immediately" from "cold, will spawn on send". Bounded by the
    /// detach policy rather than by history.
    pub fn live_sessions(&self) -> Vec<amux::LiveSession> {
        self.agents
            .values()
            .filter(|h| !h.session_id.is_empty())
            .map(|h| amux::LiveSession {
                session_id: h.session_id.clone(),
                // Lifecycle is still a placeholder: an attachment that exists
                // is treated as Active. Same as `RuntimeHandle::to_proto_info`.
                lifecycle: amux::RuntimeLifecycle::Active as i32,
                status: h.status as i32,
                stage: String::new(),
                error_code: String::new(),
                error_message: String::new(),
                failed_stage: String::new(),
                workspace_id: h.workspace_id.clone(),
                current_model: self.agent_state.model_or_default(&h.agent_id),
                worktree: h.worktree.clone(),
            })
            .collect()
    }

    /// Every model the ACTIVE backend advertises on this device, deduplicated.
    ///
    /// This is the actor's *capability*, and it is the only model source a
    /// remote client has — iOS has no loopback catalog at all. It stays exactly
    /// as it was when ADR-0007 retired the preference fields around it.
    ///
    /// The per-worktree grouping this used to return is gone with
    /// `ActorPresence.worktrees`: #742 audited 15 worktrees on one device and
    /// traced every catalog difference to the team gateway or to probe
    /// staleness, none to the directory. Storage stays sharded (it is an
    /// observation log); the wire never was.
    pub fn catalog_models(&self) -> Vec<amux::ModelInfo> {
        let backend = self.local_backend_type();
        let Some(by_worktree) = self.model_catalog.by_backend.get(backend) else {
            return Vec::new();
        };

        let mut union: Vec<amux::ModelInfo> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for worktree in by_worktree.keys() {
            for model in self.model_catalog.models_for(backend, worktree) {
                if seen.insert(model.id.clone()) {
                    union.push(model);
                }
            }
        }
        union
    }

    /// Built-ins for the active backend — the same list every worktree carried,
    /// since it never depended on the directory.
    pub fn actor_available_commands(&self) -> Vec<amux::AcpAvailableCommand> {
        builtin_commands(self.default_agent_type())
    }

    pub fn to_proto_agent_list(&self) -> amux::AgentList {
        amux::AgentList {
            runtimes: self
                .agents
                .iter()
                .map(|(id, h)| {
                    let current = self.agent_state.model_or_default(id);
                    let commands = self.agent_state.commands(id);
                    let mut info = h.to_proto_info(current, commands);
                    self.fill_catalog(&mut info);
                    info
                })
                .collect(),
        }
    }

    /// Build a `RuntimeInfo` for a single agent, populating the model fields
    /// from the manager's tracking state. Returns None if the agent is unknown.
    pub fn to_proto_info(&self, agent_id: &str) -> Option<amux::RuntimeInfo> {
        let handle = self.agents.get(agent_id)?;
        let current = self.agent_state.model_or_default(agent_id);
        let commands = self.agent_state.commands(agent_id);
        let mut info = handle.to_proto_info(current, commands);
        self.fill_catalog(&mut info);
        Some(info)
    }

    pub fn agent_ids(&self) -> Vec<String> {
        self.agents.keys().cloned().collect()
    }

    /// Seed the catch-up cursor for an attachment. Addressed by (session,
    /// actor) on the wire; there is no runtime row id to carry any more
    /// (ADR-0005).
    pub fn set_session_cursor(
        &mut self,
        runtime_id: &str,
        last_processed_message_id: Option<String>,
    ) {
        if last_processed_message_id.is_none() {
            return;
        }
        if let Some(handle) = self.agents.get_mut(runtime_id) {
            handle.last_processed_message_id = last_processed_message_id;
        }
    }

    // ── Gateway adapter hooks ────────────────────────────────────────────────
    //
    // The methods below are called from the `channels::AmuxdAgentHandle`
    // (impl of `teamclu_gateway::AgentHandle`) so a gateway can drive an
    // in-process ACP agent without speaking to opencode's HTTP server.

    /// Spawn an ACP-backed agent for a freshly-bound gateway conversation.
    /// Used by `AmuxdAgentHandle::create_session`. The returned String is the
    /// agent's `acp_session_id`, which the gateway persists on its `Binding`.
    ///
    /// `logical_session_id` is the amuxd-side key the caller maps to the
    /// real ACP UUID (for gateway sessions this is the SQL-minted
    /// `acp_session_id` hex). It's used to name the per-session MCP config
    /// file and is forwarded back to amuxd by the spawned `mcp-server`.
    #[allow(dead_code)]
    pub async fn create_gateway_session(
        &mut self,
        team_id: &str,
        logical_session_id: &str,
        binding: &str,
        title: &str,
    ) -> crate::error::Result<String> {
        self.create_gateway_session_with_model(
            team_id,
            logical_session_id,
            binding,
            title,
            None,
            None,
            ExecutionContext {
                isolation_domain: IsolationDomainKey::UnscopedAgent {
                    team_id: team_id.to_string(),
                    actor_id: logical_session_id.to_string(),
                },
                workspace: None,
                working_directory: PathBuf::new(),
                spawn_env: SpawnRuntimeEnv {
                    is_gateway: true,
                    ..SpawnRuntimeEnv::default()
                },
            },
            None,
        )
        .await
    }

    /// Variant of `create_gateway_session` that honours a per-session model
    /// override. The gateway's `AmuxdAgentHandle` resolves the override from
    /// its `model_override` map and passes it as `(provider, model)`. We
    /// translate the short name ("sonnet"/"opus"/"haiku") into the full ACP
    /// model id ("claude-sonnet-4-6", …) via `model_id_for_short_name`
    /// before threading through to the adapter. `provider` is currently
    /// unused (claude-code adapter == anthropic) but kept on the signature
    /// for future multi-provider routing.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_gateway_session_with_model(
        &mut self,
        _team_id: &str,
        logical_session_id: &str,
        binding: &str,
        _title: &str,
        model_override: Option<(String, String)>,
        remote_session_id: Option<&str>,
        context: ExecutionContext,
        // Backend to run on. `None` falls back to `default_agent_type` (the
        // gateway path and "auto" cron selection); cron jobs that pin a backend
        // pass `Some(..)` so a job created for Claude does not run on OpenCode
        // just because OpenCode is the daemon default.
        agent_type_override: Option<amux::AgentType>,
        // Runtime environment for the spawn. Gateway callers assemble the team
        // env (secrets, `tc_api_key`, `provider.team`) so a gateway-first cold
        // start does not launch the shared `opencode serve` without any
        // provider credentials; `is_gateway` must stay true on whatever is
        // passed.
    ) -> crate::error::Result<String> {
        let ExecutionContext {
            isolation_domain,
            workspace,
            working_directory,
            spawn_env,
        } = context;
        // Gateway sessions don't yet have a "real" workspace concept — they
        // run against a freshly-created scratch dir so the ACP process has a
        // valid cwd. Future work can wire this through `default_workspace_id`
        // on the agent's `agents` row.
        //
        // `working_directory: Some(wd)` lets callers (e.g. cron's worktree mode)
        // spawn the agent in a directory they already prepared — amuxd does NOT
        // mkdir caller-supplied paths; the caller's lifecycle code owns that.
        // `None` keeps the legacy throwaway behavior so other gateway callers
        // (channels/agent_handle.rs etc.) are unaffected.
        let has_working_directory = !working_directory.as_os_str().is_empty();
        let worktree = if has_working_directory {
            working_directory.to_string_lossy().into_owned()
        } else {
            let scratch = format!(
                "/tmp/amuxd-gateway-{}",
                Uuid::new_v4().to_string()[..8].to_string()
            );
            std::fs::create_dir_all(&scratch).map_err(|e| {
                crate::error::AmuxError::Agent(format!(
                    "create_gateway_session: mkdir {scratch}: {e}"
                ))
            })?;
            scratch
        };

        // Resolve the initial model against the backend that will actually
        // run this session. For OpenCode/Codex the ACP model id is
        // `provider/model`, so the override's provider segment must be
        // preserved — dropping it (the previous behavior) made the agent
        // silently fall back to its default model.
        let agent_type = agent_type_override.unwrap_or_else(|| self.default_agent_type());
        let initial_model: Option<String> = model_override
            .as_ref()
            .map(|(provider, model)| resolve_initial_model(agent_type, provider, model));

        // The `send` tool is no longer wired up here. It used to be written to
        // a per-session MCP config just below, which only the fresh-attach path
        // forwarded — so the reuse branch further down returned before it was
        // ever applied and those sessions had no send tool at all. It is now an
        // inherent per-workspace server (`supervisor::send_mcp_config`) that
        // takes its destination from the turn's reply token, so it is present
        // however the session got attached.

        // An attachment is keyed by its cloud session, so the gateway must
        // have resolved one before spawning. This used to fall through with
        // `None` and "still spawn so basic prompt/reply works" — that produced
        // an attachment keyed by the empty string, which every other
        // session-less gateway spawn then collided with.
        let Some(session_id) = remote_session_id else {
            return Err(crate::error::AmuxError::Agent(format!(
                "gateway session {logical_session_id} has no cloud session yet; \
                 cannot attach"
            )));
        };

        // Desktop (or a concurrent gateway turn) may already hold this session's
        // attachment. Reuse it — `start_runtime_with_model` rejects a second
        // attach with "already has an attachment", which SeaTalk/WeCom surface
        // as a failed bot reply even though the runtime is healthy.
        if let Some(existing) = self
            .agents
            .get(session_id)
            .map(|h| h.acp_session_id.clone())
            .filter(|s| !s.is_empty())
        {
            info!(
                session_id,
                acp_session_id = %existing,
                logical_session_id,
                "create_gateway_session: reusing live attachment"
            );
            return Ok(existing);
        }

        let workspace_id = format!("{GATEWAY_WORKSPACE_ID_PREFIX}{binding}");
        let agent_id = match self
            .start_runtime_with_model(
                agent_type,
                "",
                &workspace_id,
                None,
                session_id,
                initial_model,
                None,
                None,
                false,
                ExecutionContext {
                    isolation_domain,
                    workspace,
                    working_directory: PathBuf::from(&worktree),
                    spawn_env,
                },
            )
            .await
        {
            Ok(id) => id,
            Err(e) => {
                // Lost the race to another attach between the check above and
                // start — reuse whatever won rather than failing the chat turn.
                if let Some(existing) = self
                    .agents
                    .get(session_id)
                    .map(|h| h.acp_session_id.clone())
                    .filter(|s| !s.is_empty())
                {
                    warn!(
                        session_id,
                        acp_session_id = %existing,
                        error = %e,
                        "create_gateway_session: attach raced; reusing winner"
                    );
                    return Ok(existing);
                }
                return Err(e);
            }
        };

        let acp_sid = self
            .agents
            .get(&agent_id)
            .map(|h| h.acp_session_id.clone())
            .unwrap_or_default();

        if acp_sid.is_empty() {
            return Err(crate::error::AmuxError::Agent(
                "create_gateway_session: adapter did not report acp_session_id".into(),
            ));
        }

        if has_working_directory {
            if let Err(e) = super::workspace_runtime::apply_workspace_system_instructions(
                self,
                &agent_id,
                std::path::Path::new(&worktree),
                agent_type,
            ) {
                warn!(
                    agent_id = %agent_id,
                    worktree = %worktree,
                    error = %e,
                    "create_gateway_session: workspace system instructions failed"
                );
            }
        }

        Ok(acp_sid)
    }

    /// Buffer context for the next `send_prompt` without driving an ACP turn.
    pub async fn inject_context(
        &mut self,
        acp_session_id: &str,
        sender_display: &str,
        text: &str,
    ) -> crate::error::Result<()> {
        let agent_id = self
            .agent_id_by_acp_session(acp_session_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!(
                    "no runtime for acp_session_id {acp_session_id}"
                ))
            })?;
        self.inject_context_for_runtime(&agent_id, sender_display, text)
    }

    pub fn inject_context_for_runtime(
        &mut self,
        agent_id: &str,
        sender_display: &str,
        text: &str,
    ) -> crate::error::Result<()> {
        let handle = self
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| crate::error::AmuxError::Agent(format!("agent {agent_id} not found")))?;
        handle.push_injected_context(sender_display, text);
        Ok(())
    }
}

#[cfg(test)]
impl RuntimeManager {
    fn test_launch_configs() -> HashMap<amux::AgentType, AgentLaunchConfig> {
        Self::default_launch_configs()
    }

    /// Build a manager with a single dummy attachment pre-inserted, for tests.
    /// The id is the session: key, `agent_id` and `session_id` are one value
    /// now (ADR-0004).
    pub fn test_dummy_with_runtime(session_id: &str) -> Self {
        let mut mgr = RuntimeManager::new(Self::test_launch_configs(), None);
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = session_id.to_string();
        h.session_id = session_id.to_string();
        mgr.agents.insert(session_id.to_string(), h);
        // Test helpers stand in for an attach, so they hold the same invariant
        // production does: any mutation of `agents` marks the snapshot stale.
        mgr.mark_actor_state_dirty();
        mgr
    }

    /// Insert a test runtime with explicit runtime_id, agent_id, and session_id.
    /// Insert an attachment for `session_id`. The map key, `handle.agent_id`
    /// and `handle.session_id` are all that one id — there is no separate
    /// per-spawn identity to diverge (ADR-0004).
    pub fn add_test_runtime(&mut self, session_id: &str) {
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = session_id.to_string();
        h.session_id = session_id.to_string();
        self.agents.insert(session_id.to_string(), h);
        self.mark_actor_state_dirty();
    }

    /// Return the last body sent to the given runtime via send_prompt_raw.
    pub fn last_sent_to(&self, runtime_id: &str) -> Option<String> {
        self.last_sent.get(runtime_id).cloned()
    }

    pub fn fail_next_send_for(&mut self, runtime_id: &str, message: &str) {
        self.send_failures
            .insert(runtime_id.to_string(), message.to_string());
    }

    pub fn permission_log(&self) -> Vec<(String, bool)> {
        self.permission_log.clone()
    }

    pub fn add_test_workspace_runtime(
        &mut self,
        runtime_id: &str,
        workspace_path: &str,
        workspace_id: &str,
        status: amux::AgentStatus,
    ) {
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = runtime_id.to_string();
        h.worktree = workspace_path.to_string();
        h.workspace_id = workspace_id.to_string();
        h.status = status;
        self.agents.insert(runtime_id.to_string(), h);
    }

    pub fn set_test_runtime_status(&mut self, runtime_id: &str, status: amux::AgentStatus) {
        if let Some(handle) = self.agents.get_mut(runtime_id) {
            handle.status = status;
        }
    }

    pub fn set_test_runtime_env_snapshot(
        &mut self,
        runtime_id: &str,
        snapshot: teamclu_runtime_env::ResolvedEnvSnapshot,
        team_id: Option<String>,
    ) {
        if let Some(handle) = self.agents.get_mut(runtime_id) {
            handle.env_fingerprint = Some(snapshot.fingerprint.clone());
            handle.env_snapshot = Some(snapshot);
            handle.env_team_id = team_id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::handle::PendingMessage;
    use super::*;

    fn workspace_context(path: &std::path::Path) -> ExecutionContext {
        ExecutionContext {
            isolation_domain: IsolationDomainKey::Workspace("ws-a".into()),
            workspace: Some(super::super::execution_context::WorkspaceIdentity {
                workspace_id: "ws-a".into(),
                workspace_root: path.to_path_buf(),
                team_id: Some("team-a".into()),
            }),
            working_directory: path.to_path_buf(),
            spawn_env: SpawnRuntimeEnv::default(),
        }
    }

    fn catalog_model(id: &str) -> amux::ModelInfo {
        amux::ModelInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            provider_name: "test".to_string(),
        }
    }

    /// `live_sessions` is what turns the actor retain into something a client
    /// can key by (actor, session). If it comes back empty while attachments
    /// exist, the retain degrades to bare presence and every reader concludes
    /// the actor is serving nothing — the shape observed on 2026-08-04, where a
    /// reconnect shrank the retain from 7346 bytes to 19 and the desktop store
    /// held zero composite keys while an agent was mid-turn.
    #[test]
    fn live_sessions_reports_every_attachment_by_session() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session-a");
        mgr.add_test_runtime("session-b");

        let live = mgr.live_sessions();
        let mut ids: Vec<&str> = live.iter().map(|s| s.session_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["session-a", "session-b"]);
    }

    /// Every attachment has a session: `start_runtime_with_model` rejects an
    /// empty one, and the map is keyed by it. This pins the invariant so a
    /// future "spawn without a session" path cannot slip back in unnoticed.
    #[test]
    fn every_attachment_is_reported_as_a_live_session() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session-a");
        mgr.add_test_runtime("session-b");
        let sessions: Vec<String> = mgr
            .live_sessions()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains(&"session-a".to_string()));
        assert!(sessions.contains(&"session-b".to_string()));
    }

    /// The catalog belongs to the device, so a binding that never attached
    /// still advertises it. Before this, such a binding published an empty
    /// list and its session's pill could never leave "connecting".
    #[test]
    fn fill_catalog_populates_a_binding_that_never_attached() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.record_catalog("/w1", &[catalog_model("a/x"), catalog_model("a/y")]);

        let mut info = amux::RuntimeInfo {
            runtime_id: "rt-idle".into(),
            worktree: "/w1".into(),
            ..Default::default()
        };
        mgr.fill_catalog(&mut info);
        assert_eq!(info.available_models.len(), 2);
    }

    /// A live attach's own catalog is authoritative — never overwritten by the
    /// cached one.
    #[test]
    fn fill_catalog_leaves_a_populated_list_alone() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.record_catalog("/w1", &[catalog_model("a/x"), catalog_model("a/y")]);

        let mut info = amux::RuntimeInfo {
            runtime_id: "sess-live".into(),
            worktree: "/w1".into(),
            available_models: vec![catalog_model("live/only")],
            ..Default::default()
        };
        mgr.fill_catalog(&mut info);
        assert_eq!(info.available_models.len(), 1);
        assert_eq!(info.available_models[0].id, "live/only");
    }

    /// A historical row can name a worktree this device no longer uses; one
    /// serve with one set of provider credentials backs them all, so some
    /// catalog beats none.
    #[test]
    fn fill_catalog_falls_back_across_worktrees() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.record_catalog("/w1", &[catalog_model("a/x")]);

        let mut info = amux::RuntimeInfo {
            runtime_id: "rt-old".into(),
            worktree: "/deleted-worktree".into(),
            ..Default::default()
        };
        mgr.fill_catalog(&mut info);
        assert_eq!(info.available_models.len(), 1);
    }

    /// An empty catalog must never be recorded: a failed probe would otherwise
    /// erase the good list and reintroduce the bug.
    #[test]
    fn record_catalog_ignores_an_empty_probe_result() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.record_catalog("/w1", &[catalog_model("a/x")]);
        mgr.record_catalog("/w1", &[]);
        assert_eq!(mgr.catalog_for_worktree("/w1").len(), 1);
    }

    /// The cloud row is keyed by the actor, not by the spawn key. `agent_id` is
    /// an 8-char spawn key that means nothing to Supabase, so addressing the
    /// participant row with it would write to a row that does not exist —
    /// silently, since the PATCH matches zero rows and still returns 204.
    #[test]
    fn participant_model_write_addresses_the_actor_not_the_spawn_key() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("session_S");
        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "actor-A".into();

        let (session_id, actor_id, model) = mgr
            .participant_model_write("session_S", "anthropic/claude-sonnet-4-6")
            .expect("addressable");
        assert_eq!(session_id, "session_S");
        assert_eq!(actor_id, "actor-A");
        assert_eq!(model, "anthropic/claude-sonnet-4-6");
    }

    /// `owner_actor_id` is stamped by the env snapshot and back-filled in
    /// `runtime_lifecycle`, so a cold attach can reach here with it still empty.
    /// Writing then would address `/participants//model`.
    #[test]
    fn participant_model_write_skips_what_it_cannot_address() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("session_S");
        // owner_actor_id still empty — the cold-attach window.
        assert_eq!(mgr.participant_model_write("session_S", "a/b"), None);

        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "actor-A".into();
        assert_eq!(mgr.participant_model_write("session_S", "   "), None);
        assert_eq!(mgr.participant_model_write("no-such-runtime", "a/b"), None);

        mgr.get_handle_mut("session_S").unwrap().session_id = String::new();
        assert_eq!(mgr.participant_model_write("session_S", "a/b"), None);
    }

    #[test]
    fn set_current_model_records_value() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.set_current_model("agent-1", "claude-sonnet-4-6");
        assert_eq!(
            mgr.current_model("agent-1").map(|s| s.as_str()),
            Some("claude-sonnet-4-6")
        );
    }

    /// A backend that records the calls it receives and nothing else, for
    /// exercising manager-level paths without a process.
    struct StubBackend {
        shutdown_called: Arc<std::sync::atomic::AtomicBool>,
        catalog_domain: Arc<std::sync::Mutex<Option<IsolationDomainKey>>>,
    }

    #[async_trait::async_trait]
    impl AgentBackend for StubBackend {
        async fn attach_session(
            &mut self,
            _agent_type: amux::AgentType,
            _launch: &AgentLaunchConfig,
            _isolation_domain: IsolationDomainKey,
            _process_env_revision: ProcessEnvRevision,
            _extra_env: HashMap<String, String>,
            _force_env_override: bool,
            _worktree: String,
            _resume_acp_session_id: Option<String>,
            _mcp_config_path: Option<PathBuf>,
            _initial_model_override: Option<String>,
            _model_mru: Vec<String>,
            _initial_prompt: String,
            _event_tx: mpsc::Sender<AcpEventFrame>,
            _permission: PermissionPolicy,
            _forbid_new_session_fallback: bool,
            _teamclu_session_id: String,
        ) -> crate::error::Result<(
            mpsc::Sender<super::super::backend::AcpCommand>,
            super::super::backend::AcpStartupMetadata,
        )> {
            Err(crate::error::AmuxError::Agent("stub".into()))
        }
        async fn prewarm(&mut self, _c: &HashMap<amux::AgentType, AgentLaunchConfig>) {}
        async fn prewarm_with_env(
            &mut self,
            _c: &HashMap<amux::AgentType, AgentLaunchConfig>,
            _e: HashMap<String, String>,
            _f: bool,
            _w: Option<&str>,
        ) {
        }
        fn evict_agent_types(&mut self, _t: &[amux::AgentType]) -> usize {
            0
        }
        async fn shutdown_for_exit(&mut self) -> usize {
            self.shutdown_called
                .store(true, std::sync::atomic::Ordering::SeqCst);
            0
        }
        fn host_count(&self) -> usize {
            0
        }
        async fn model_catalog(
            &mut self,
            _workspace_path: &std::path::Path,
        ) -> crate::error::Result<Vec<amux::ModelInfo>> {
            Ok(Vec::new())
        }
        async fn model_catalog_for_context(
            &mut self,
            _workspace_path: &std::path::Path,
            isolation_domain: IsolationDomainKey,
            _process_env_revision: ProcessEnvRevision,
            _extra_env: HashMap<String, String>,
        ) -> crate::error::Result<Vec<amux::ModelInfo>> {
            *self.catalog_domain.lock().unwrap() = Some(isolation_domain);
            Ok(vec![catalog_model("provider/model")])
        }
    }

    #[tokio::test]
    async fn daemon_exit_uses_backend_exit_teardown() {
        let shutdown_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.agent_backend = Arc::new(AsyncMutex::new(Box::new(StubBackend {
            shutdown_called: Arc::clone(&shutdown_called),
            catalog_domain: Arc::new(std::sync::Mutex::new(None)),
        })));

        mgr.shutdown_for_exit().await;

        assert!(shutdown_called.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn default_workspace_catalog_uses_resolved_workspace_domain() {
        let workspace = tempfile::tempdir().unwrap();
        let catalog_domain = Arc::new(std::sync::Mutex::new(None));
        let mut manager = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        manager.agent_backend = Arc::new(AsyncMutex::new(Box::new(StubBackend {
            shutdown_called: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            catalog_domain: Arc::clone(&catalog_domain),
        })));

        let models = RuntimeManager::probe_default_workspace_catalog(
            Arc::new(AsyncMutex::new(manager)),
            workspace_context(workspace.path()),
        )
        .await;

        assert_eq!(models, vec![catalog_model("provider/model")]);
        assert_eq!(
            *catalog_domain.lock().unwrap(),
            Some(IsolationDomainKey::Workspace("ws-a".into()))
        );
    }

    #[test]
    fn current_model_returns_none_for_unknown_agent() {
        let mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        assert_eq!(mgr.current_model("agent-1"), None);
    }

    #[test]
    fn resolve_initial_model_claude_maps_short_name() {
        assert_eq!(
            resolve_initial_model(amux::AgentType::ClaudeCode, "anthropic", "sonnet"),
            "claude-sonnet-4-6"
        );
        assert_eq!(
            resolve_initial_model(amux::AgentType::ClaudeCode, "", "opus"),
            "claude-opus-4-7"
        );
    }

    #[test]
    fn resolve_initial_model_claude_passes_full_id_unchanged() {
        // A full claude id is not a known short name; it must pass through and
        // the provider segment must be ignored (the binary is anthropic-only).
        assert_eq!(
            resolve_initial_model(
                amux::AgentType::ClaudeCode,
                "anthropic",
                "claude-sonnet-4-6"
            ),
            "claude-sonnet-4-6"
        );
    }

    #[test]
    fn resolve_initial_model_opencode_rejoins_provider() {
        // Regression: OpenCode ACP model ids are `provider/model`. Dropping the
        // provider made set_session_model miss and fall back to the default.
        assert_eq!(
            resolve_initial_model(amux::AgentType::Opencode, "scnet", "MiniMax-M2.5"),
            "scnet/MiniMax-M2.5"
        );
        assert_eq!(
            resolve_initial_model(amux::AgentType::Codex, "openai", "gpt-5.5"),
            "openai/gpt-5.5"
        );
    }

    #[test]
    fn resolve_initial_model_opencode_empty_provider_passes_model_through() {
        assert_eq!(
            resolve_initial_model(amux::AgentType::Opencode, "", "MiniMax-M2.5"),
            "MiniMax-M2.5"
        );
    }

    #[test]
    fn launch_config_for_opencode_uses_registered_backend() {
        let mut configs = RuntimeManager::test_launch_configs();
        configs.insert(
            amux::AgentType::Opencode,
            AgentLaunchConfig::new("opencode", vec!["acp".to_string()], "opencode"),
        );
        let mgr = RuntimeManager::new(configs, None);

        assert_eq!(
            mgr.launch_config_for(amux::AgentType::Opencode),
            AgentLaunchConfig::new("opencode", vec!["acp".to_string()], "opencode")
        );
    }

    // ── seed_cursor_from_prior_runtime ─────────────────────────────────────
    //
    // The spawn path calls into this helper to carry `last_processed_message_id`
    // forward from a prior agent_runtimes row. We can't easily exercise the
    // full spawn (it boots a real ACP subprocess), but we can verify the helper
    // populates the handle when (a) the Cloud API has a prior row and (b) does not
    // when the row is missing or its cursor is empty.

    use crate::backend::cloud_api::CloudApiBackend;
    use crate::provider_config::CloudApiConfig;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_cloud_api_with_url(url: String) -> Arc<dyn Backend> {
        Arc::new(CloudApiBackend::new(CloudApiConfig {
            url,
            refresh_token: "rt".into(),
            team_id: "t".into(),
            actor_id: "agent-actor".into(),
        }))
    }

    async fn auth_mock(srv: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at",
                "refreshToken": "rt",
                "expiresAt": 9999999999_i64
            })))
            .mount(srv)
            .await;
    }

    fn dummy_handle(agent_id: &str, session_id: &str) -> RuntimeHandle {
        let mut h = RuntimeHandle::test_dummy();
        h.agent_id = agent_id.into();
        h.session_id = session_id.into();
        h
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_populates_handle() {
        let srv = MockServer::start().await;
        auth_mock(&srv).await;
        // The cursor comes off this actor's participant row now (ADR-0005),
        // so the seed reads the participants list rather than a runtime row.
        Mock::given(method("GET"))
            .and(path("/v1/sessions/sess-1/participants"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    { "actorId": "someone-else", "lastProcessedMessageId": "msg-1" },
                    { "actorId": "agent-actor", "lastProcessedMessageId": "msg-42" }
                ]
            })))
            .mount(&srv)
            .await;

        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url(srv.uri())),
        );
        mgr.agents
            .insert("rt-X".into(), dummy_handle("rt-X", "sess-1"));

        mgr.seed_cursor_from_prior_runtime("rt-X", Some("sess-1"))
            .await;

        assert_eq!(
            mgr.agents
                .get("rt-X")
                .unwrap()
                .last_processed_message_id
                .as_deref(),
            Some("msg-42")
        );
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_noop_when_no_session_id() {
        // Without a session id we shouldn't touch the cloud backend. We deliberately
        // give the client a bogus URL so any HTTP call would explode.
        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url("http://127.0.0.1:1".into())),
        );
        mgr.agents.insert("rt-X".into(), dummy_handle("rt-X", ""));
        mgr.seed_cursor_from_prior_runtime("rt-X", None).await;
        assert!(mgr
            .agents
            .get("rt-X")
            .unwrap()
            .last_processed_message_id
            .is_none());
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_noop_when_no_prior_row() {
        let srv = MockServer::start().await;
        auth_mock(&srv).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "no runtime" }
            })))
            .mount(&srv)
            .await;

        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url(srv.uri())),
        );
        mgr.agents
            .insert("rt-X".into(), dummy_handle("rt-X", "sess-1"));
        mgr.seed_cursor_from_prior_runtime("rt-X", Some("sess-1"))
            .await;
        assert!(mgr
            .agents
            .get("rt-X")
            .unwrap()
            .last_processed_message_id
            .is_none());
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_noop_when_cursor_empty_string() {
        // An older daemon may have written an empty string instead of NULL.
        // Treat that as "no cursor".
        let srv = MockServer::start().await;
        auth_mock(&srv).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "row-1",
                "backendSessionId": "acp-1",
                "lastProcessedMessageId": ""
            })))
            .mount(&srv)
            .await;

        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url(srv.uri())),
        );
        mgr.agents
            .insert("rt-X".into(), dummy_handle("rt-X", "sess-1"));
        mgr.seed_cursor_from_prior_runtime("rt-X", Some("sess-1"))
            .await;
        assert!(mgr
            .agents
            .get("rt-X")
            .unwrap()
            .last_processed_message_id
            .is_none());
    }

    #[test]
    fn running_agent_id_for_collab_session_ignores_stopped_agents() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut stopped = RuntimeHandle::new(
            "stopped-1".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        stopped.session_id = "session-1".to_string();
        stopped.status = amux::AgentStatus::Stopped;

        let mut running = RuntimeHandle::new(
            "running-1".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        running.session_id = "session-1".to_string();
        running.status = amux::AgentStatus::Idle;

        mgr.agents.insert(stopped.agent_id.clone(), stopped);
        mgr.agents.insert(running.agent_id.clone(), running);

        assert_eq!(
            mgr.running_agent_id_for_collab_session("session-1")
                .as_deref(),
            Some("running-1")
        );
        assert_eq!(mgr.running_agent_id_for_collab_session("missing"), None);
    }

    #[test]
    fn runtime_workspace_busy_detection_treats_idle_handle_as_idle() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut handle = RuntimeHandle::new(
            "rt-idle".to_string(),
            amux::AgentType::ClaudeCode,
            "/tmp/ws-idle".to_string(),
            "ws-idle".to_string(),
        );
        handle.status = amux::AgentStatus::Idle;
        mgr.agents.insert(handle.agent_id.clone(), handle);

        assert!(!mgr.workspace_has_active_turn("/tmp/ws-idle", "ws-idle"));
    }

    #[test]
    fn runtime_workspace_busy_detection_detects_active_status() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut handle = RuntimeHandle::new(
            "rt-active".to_string(),
            amux::AgentType::ClaudeCode,
            "/tmp/ws-active".to_string(),
            "ws-active".to_string(),
        );
        handle.status = amux::AgentStatus::Active;
        mgr.agents.insert(handle.agent_id.clone(), handle);

        assert!(mgr.workspace_has_active_turn("/tmp/ws-active", "ws-active"));
    }

    #[test]
    fn runtime_workspace_busy_detection_detects_checked_out_turn() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut handle = RuntimeHandle::new(
            "rt-checked-out".to_string(),
            amux::AgentType::ClaudeCode,
            "/tmp/ws-checked-out".to_string(),
            "ws-checked-out".to_string(),
        );
        handle.status = amux::AgentStatus::Idle;
        handle.event_rx = None;
        mgr.agents.insert(handle.agent_id.clone(), handle);

        assert!(mgr.workspace_has_active_turn("/tmp/ws-checked-out", "ws-checked-out"));
    }

    #[test]
    fn find_active_runtime_for_matches_full_tuple() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut h = RuntimeHandle::new(
            "rt-1".to_string(),
            amux::AgentType::ClaudeCode,
            "/tmp/wt".to_string(),
            "ws-1".to_string(),
        );
        h.session_id = "sess-1".to_string();
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("sess-1", amux::AgentType::ClaudeCode, "ws-1"),
            Some("rt-1".to_string())
        );
        // workspace mismatch — different session in a different workspace
        // is a legitimate distinct runtime, not a dup.
        assert_eq!(
            mgr.find_active_runtime_for("sess-1", amux::AgentType::ClaudeCode, "ws-OTHER"),
            None
        );
        // session mismatch — distinct sessions on the same workspace also
        // get their own runtimes.
        assert_eq!(
            mgr.find_active_runtime_for("sess-OTHER", amux::AgentType::ClaudeCode, "ws-1"),
            None
        );
    }

    #[test]
    fn find_active_runtime_for_skips_bare_agent_spawns() {
        // Empty session_id is the bare-agent / test spawn sentinel. Two
        // such spawns must NOT dedupe into the first one — they're
        // explicit fresh runtimes.
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut h = RuntimeHandle::new(
            "rt-bare".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "".to_string(),
        );
        h.session_id = "".to_string();
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("", amux::AgentType::ClaudeCode, ""),
            None
        );
    }

    #[test]
    fn find_active_runtime_for_skips_error_agents() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut h = RuntimeHandle::new(
            "rt-error".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        h.session_id = "session-1".to_string();
        h.status = amux::AgentStatus::Error;
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("session-1", amux::AgentType::ClaudeCode, "workspace-1"),
            None
        );
    }

    #[test]
    fn resolve_command_agent_id_accepts_cloud_session_id() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("54809303-ed5b-4f10-893f-2d0fd2db4e00");
        assert_eq!(
            mgr.resolve_command_agent_id("54809303-ed5b-4f10-893f-2d0fd2db4e00", "")
                .as_deref(),
            Some("54809303-ed5b-4f10-893f-2d0fd2db4e00"),
            "the session id is the key; resolution is identity"
        );
    }

    #[test]
    fn resolve_command_agent_id_rejects_an_unknown_session() {
        let mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        assert_eq!(
            mgr.resolve_command_agent_id("54809303-ed5b-4f10-893f-2d0fd2db4e00", ""),
            None
        );
    }

    #[test]
    fn resolve_command_agent_id_accepts_actor_session_composite() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("54809303-ed5b-4f10-893f-2d0fd2db4e00");
        mgr.get_handle_mut("54809303-ed5b-4f10-893f-2d0fd2db4e00")
            .unwrap()
            .owner_actor_id = "614433ab-52dd-4ce3-b5f4-14376f8eb680".into();
        assert_eq!(
            mgr.resolve_command_agent_id(
                "614433ab-52dd-4ce3-b5f4-14376f8eb680::54809303-ed5b-4f10-893f-2d0fd2db4e00",
                "614433ab-52dd-4ce3-b5f4-14376f8eb680",
            )
            .as_deref(),
            Some("54809303-ed5b-4f10-893f-2d0fd2db4e00")
        );
    }

    #[test]
    fn resolve_command_agent_id_unknown_returns_none() {
        let mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        assert_eq!(mgr.resolve_command_agent_id("no-such", "").as_deref(), None);
        assert_eq!(mgr.resolve_command_agent_id("", "").as_deref(), None);
    }

    /// One daemon holds at most one attachment per session, so the old
    /// "pick the newest of several" case is gone. What must still hold is the
    /// owner gate: a composite naming another actor must not resolve.
    #[test]
    fn resolve_command_agent_id_rejects_a_foreign_owner() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "actor-A".into();

        assert_eq!(
            mgr.resolve_command_agent_id("actor-A::session_S", "actor-A")
                .as_deref(),
            Some("session_S")
        );
        assert_eq!(
            mgr.resolve_command_agent_id("actor-A::session_S", "actor-B"),
            None,
            "the composite's actor must match the requester"
        );
        assert_eq!(
            mgr.resolve_command_agent_id("session_S", "actor-B"),
            None,
            "a bare session id must still respect the attachment's owner"
        );
    }

    /// Desktop setModel/runtimeStop: client sends bare cloud session_id; the RPC
    /// handler resolves with this daemon's actor id (not the signed-in member).
    #[test]
    fn resolve_command_agent_id_accepts_bare_session_for_daemon_actor() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "actor-A".into();

        assert_eq!(
            mgr.resolve_command_agent_id("session_S", "actor-A")
                .as_deref(),
            Some("session_S")
        );
    }

    /// The client-facing address and the map key are the same value now, so
    /// set-model needs no lookup. Before the rekey this call failed with
    /// "agent {session} not found" for every client, because the map was keyed
    /// by a per-spawn id that nothing published.
    #[tokio::test]
    async fn set_model_addresses_the_session_directly() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");

        assert!(mgr
            .set_model("session_S", "claude-sonnet-4-6")
            .await
            .is_ok());
        assert!(
            mgr.set_model("session_UNKNOWN", "claude-sonnet-4-6")
                .await
                .is_err(),
            "an unknown session must not silently succeed"
        );
    }

    /// iOS addresses by `{actor}::{session}` (ADR-0004). Same contract as the
    /// stop/cancel path, which has resolved since #780.
    #[tokio::test]
    async fn set_model_accepts_actor_session_composite() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "actor-A".into();

        let resolved = mgr
            .resolve_command_agent_id("actor-A::session_S", "actor-A")
            .expect("composite address must resolve");
        assert_eq!(resolved, "session_S");
        assert!(mgr.set_model(&resolved, "claude-sonnet-4-6").await.is_ok());

        // A composite naming a different owner must not reach this handle.
        assert_eq!(
            mgr.resolve_command_agent_id("actor-A::session_S", "actor-B"),
            None
        );
    }

    /// Stop takes the same addresses as set-model; both handlers resolve now.
    #[tokio::test]
    async fn stop_runtime_accepts_resolved_session_address() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");

        let resolved = mgr
            .resolve_command_agent_id("session_S", "")
            .expect("cloud session id must resolve to the spawn key");
        assert!(mgr.stop_runtime(&resolved).await.is_some());
        // Gone from the map — a second stop finds nothing to resolve.
        assert_eq!(mgr.resolve_command_agent_id("session_S", ""), None);
    }

    #[tokio::test]
    async fn inject_context_buffers_without_sending() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        mgr.get_handle_mut("rt1").unwrap().acp_session_id = "acp-1".into();

        mgr.inject_context("acp-1", "system", "请使用中文回答")
            .await
            .unwrap();

        assert!(mgr.last_sent_to("rt1").is_none());
        assert_eq!(
            mgr.get_handle("rt1").unwrap().injected_context[0].content,
            "请使用中文回答"
        );
    }

    #[tokio::test]
    async fn send_prompt_skips_injected_when_native_delivery() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        mgr.get_handle_mut("rt1").unwrap().instruction_delivery =
            crate::runtime::InstructionDelivery::NativeClaudeMd;
        mgr.inject_context_for_runtime("rt1", "system", "请使用中文回答")
            .unwrap();

        mgr.send_prompt("rt1", "hello", vec![]).await.unwrap();

        assert_eq!(mgr.last_sent_to("rt1").as_deref(), Some("hello"));
        assert_eq!(mgr.get_handle("rt1").unwrap().injected_context.len(), 1);
    }

    #[tokio::test]
    async fn send_prompt_includes_next_prompt_context_when_native_delivery() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        let handle = mgr.get_handle_mut("rt1").unwrap();
        handle.instruction_delivery = crate::runtime::InstructionDelivery::NativeOpenCodePlugin;
        handle.next_prompt_context =
            "When calling get_page_dom, include remote_context_id exactly as: rtctx_1".into();

        mgr.send_prompt("rt1", "hello", vec![]).await.unwrap();

        let sent = mgr.last_sent_to("rt1").expect("sent prompt");
        assert!(sent.contains("remote_context_id exactly as: rtctx_1"));
        assert!(sent.ends_with("hello"));
        assert!(mgr
            .get_handle("rt1")
            .unwrap()
            .next_prompt_context
            .is_empty());
    }

    #[tokio::test]
    async fn send_prompt_drains_injected_before_pending_silent() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        mgr.inject_context_for_runtime("rt1", "system", "请使用中文回答")
            .unwrap();
        {
            let h = mgr.get_handle_mut("rt1").unwrap();
            h.pending_silent.push(PendingMessage {
                message_id: "m1".into(),
                sender_display: "Ann".into(),
                content: "earlier note".into(),
                created_at: 100,
            });
        }

        mgr.send_prompt("rt1", "hello", vec![]).await.unwrap();

        let last = mgr.last_sent_to("rt1").unwrap();
        let system_pos = last.find("请使用中文回答").unwrap();
        let ann_pos = last.find("Ann: earlier note").unwrap();
        let hello_pos = last.find("hello").unwrap();
        assert!(system_pos < ann_pos);
        assert!(ann_pos < hello_pos);
    }

    #[tokio::test]
    async fn send_prompt_drains_pending_silent_into_prefix() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        {
            let h = mgr.get_handle_mut("rt1").unwrap();
            h.pending_silent.push(PendingMessage {
                message_id: "m1".into(),
                sender_display: "Ann".into(),
                content: "earlier note".into(),
                created_at: 100,
            });
        }
        let drained = mgr
            .send_prompt("rt1", "real question", vec![])
            .await
            .unwrap();
        assert_eq!(drained, vec!["m1".to_string()]);
        let last = mgr.last_sent_to("rt1").unwrap();
        assert!(last.contains("Ann: earlier note"), "body was: {last}");
        assert!(last.ends_with("real question"), "body was: {last}");
    }

    #[tokio::test]
    async fn send_prompt_no_pending_sends_plain_text() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        let drained = mgr.send_prompt("rt1", "hello", vec![]).await.unwrap();
        assert!(drained.is_empty());
        assert_eq!(mgr.last_sent_to("rt1").as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn send_prompt_returns_err_for_missing_runtime() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let result = mgr.send_prompt("nonexistent", "hello", vec![]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn send_prompt_restores_injected_when_send_fails() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        mgr.inject_context_for_runtime("rt1", "system", "请使用中文回答")
            .unwrap();
        mgr.get_handle_mut("rt1").unwrap().next_prompt_context = "remote ctx".into();
        mgr.fail_next_send_for("rt1", "boom");

        let result = mgr.send_prompt("rt1", "real question", vec![]).await;

        assert!(result.is_err());
        let injected = &mgr.get_handle("rt1").unwrap().injected_context;
        assert_eq!(injected.len(), 1);
        assert_eq!(injected[0].content, "请使用中文回答");
        assert_eq!(
            mgr.get_handle("rt1").unwrap().next_prompt_context,
            "remote ctx"
        );
        assert!(mgr.last_sent_to("rt1").is_none());
    }

    #[tokio::test]
    async fn send_prompt_restores_pending_silent_when_send_fails() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        {
            let h = mgr.get_handle_mut("rt1").unwrap();
            h.pending_silent.push(PendingMessage {
                message_id: "m1".into(),
                sender_display: "Ann".into(),
                content: "earlier note".into(),
                created_at: 100,
            });
        }
        mgr.fail_next_send_for("rt1", "boom");

        let result = mgr.send_prompt("rt1", "real question", vec![]).await;

        assert!(result.is_err());
        let pending = &mgr.get_handle("rt1").unwrap().pending_silent;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message_id, "m1");
        assert!(mgr.last_sent_to("rt1").is_none());
    }

    #[tokio::test]
    async fn start_runtime_errors_when_opencode_serve_cannot_spawn() {
        let mut configs = HashMap::new();
        configs.insert(
            amux::AgentType::ClaudeCode,
            AgentLaunchConfig::new(
                "/definitely/not/a/teamclu-agent-binary",
                Vec::new(),
                "claude",
            ),
        );
        let mut mgr = RuntimeManager::new(configs, None);
        let tmp = tempfile::TempDir::new().unwrap();

        let result = mgr
            .start_runtime_with_model(
                amux::AgentType::ClaudeCode,
                "",
                "workspace-1",
                None,
                "session-1",
                None,
                None,
                None,
                false,
                workspace_context(tmp.path()),
            )
            .await;

        let err = result.expect_err("missing agent binary should fail startup");
        assert!(
            err.to_string().contains("spawn opencode serve")
                || err.to_string().contains("opencode serve unavailable"),
            "got: {err}"
        );
        assert_eq!(mgr.agent_count().await, 0);
    }

    // ── mention-routing accessors ─────────────────────────────────────────────

    /// At most one attachment per session, by construction — a second insert
    /// for the same session replaces rather than accumulates. This is the
    /// property the 1306-rows-for-1296-sessions incident was missing.
    #[test]
    fn a_session_has_at_most_one_attachment() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        mgr.add_test_runtime("session_S");
        mgr.add_test_runtime("session_OTHER");

        assert_eq!(mgr.runtime_ids_for_session("session_S"), vec!["session_S"]);
        assert_eq!(
            mgr.runtime_ids_for_session("session_OTHER"),
            vec!["session_OTHER"]
        );
        assert!(mgr.runtime_ids_for_session("unknown").is_empty());
    }

    /// Gateway bots (SeaTalk/WeCom) must reuse a live desktop/gateway
    /// attachment instead of failing with "already has an attachment".
    #[tokio::test]
    async fn create_gateway_session_reuses_live_attachment() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("f8346f4d-62a5-4fdc-b8fc-8cb0e9ee4d93");
        mgr.get_handle_mut("f8346f4d-62a5-4fdc-b8fc-8cb0e9ee4d93")
            .unwrap()
            .acp_session_id = "ses_already_live".into();

        let acp = mgr
            .create_gateway_session_with_model(
                "team-1",
                "logical-acp-hex",
                "seatalk://app/dm/E001",
                "SeaTalk DM",
                None,
                Some("f8346f4d-62a5-4fdc-b8fc-8cb0e9ee4d93"),
                ExecutionContext {
                    isolation_domain: IsolationDomainKey::UnscopedAgent {
                        team_id: "team-1".into(),
                        actor_id: "logical-acp-hex".into(),
                    },
                    workspace: None,
                    working_directory: PathBuf::new(),
                    spawn_env: SpawnRuntimeEnv {
                        is_gateway: true,
                        ..SpawnRuntimeEnv::default()
                    },
                },
                None,
            )
            .await
            .expect("should reuse, not re-attach");

        assert_eq!(acp, "ses_already_live");
        assert_eq!(mgr.agent_count().await, 1);
    }

    #[test]
    fn newest_runtime_id_for_session_is_the_session_itself() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        assert_eq!(
            mgr.newest_runtime_id_for_session("session_S"),
            Some("session_S".to_string())
        );
        assert_eq!(mgr.newest_runtime_id_for_session("missing"), None);
    }

    #[test]
    fn resolve_permission_runtime_key_retargets_stale_topic_to_sole_active_runtime() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session-s");
        mgr.get_handle_mut("session-s").unwrap().status = amux::AgentStatus::Active;

        assert_eq!(
            mgr.resolve_permission_runtime_key("ff679fef").as_deref(),
            Some("session-s")
        );
        assert_eq!(
            mgr.resolve_permission_runtime_key("session-s").as_deref(),
            Some("session-s")
        );
    }

    /// A resumed cron/gateway runtime must come back with the policy it ran
    /// under. The env builders always say "desktop", so without the restore a
    /// resume silently downgrades the session to approval prompts.
    #[test]
    fn resume_restores_full_access_for_gateway_runtimes() {
        let mut env = SpawnRuntimeEnv::default();
        restore_gateway_shape_for_resume(&mut env, "gateway:cron://cron/job-1/run-1");
        assert!(env.is_gateway);
        assert_eq!(env.permission_policy(), PermissionPolicy::Full);

        // A desktop workspace id is untouched: those runtimes have a human
        // watching, and approvals are the point.
        let mut env = SpawnRuntimeEnv::default();
        restore_gateway_shape_for_resume(&mut env, "e78b4c4c-95a3-48bf-9c6f-8eee385cd0d2");
        assert!(!env.is_gateway);
        assert_eq!(env.permission_policy(), PermissionPolicy::Ask);
    }

    /// An explicit policy still wins — a cron job that opted back into "ask"
    /// keeps asking even though the restore marks it as a gateway runtime.
    #[test]
    fn restore_does_not_override_an_explicit_permission() {
        let mut env = SpawnRuntimeEnv {
            permission: Some(PermissionPolicy::Ask),
            ..Default::default()
        };
        restore_gateway_shape_for_resume(&mut env, "gateway:cron://cron/job-1/run-1");
        assert_eq!(env.permission_policy(), PermissionPolicy::Ask);
    }

    /// The signal `apply_start_runtime` / `coalesce_session_runtimes` use to
    /// decide a runtime must not be stopped. Cron holds this lock for the whole
    /// turn; without the check, the RuntimeStart that follows "Run Now"'s jump
    /// into the session stopped the runtime mid-answer.
    #[tokio::test]
    async fn turn_in_flight_tracks_the_handles_turn_lock() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        assert!(!mgr.turn_in_flight("rt1"), "idle runtime is not mid-turn");
        assert!(
            !mgr.turn_in_flight("missing"),
            "unknown runtime is not busy"
        );

        let turn_lock = mgr.get_handle("session_S").unwrap().turn_lock.clone();
        let guard = turn_lock.lock().await;
        assert!(
            mgr.turn_in_flight("session_S"),
            "a held turn_lock reads as busy"
        );
        drop(guard);
        assert!(
            !mgr.turn_in_flight("rt1"),
            "released turn_lock reads as idle"
        );
    }

    #[test]
    fn session_id_for_runtime_is_the_key_itself() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("session-1");
        assert_eq!(
            mgr.session_id_for_runtime("session-1").as_deref(),
            Some("session-1")
        );
        mgr.add_test_runtime("session-2");
        assert_eq!(
            mgr.session_id_for_runtime("session-2").as_deref(),
            Some("session-2")
        );
        assert_eq!(mgr.session_id_for_runtime("missing"), None);
    }

    /// Simulate the "mentioned" branch: send_prompt is called with the message content.
    #[tokio::test]
    async fn route_mentioned_sends_prompt() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "agent_X".into();

        // Simulates the mentioned path: directly call send_prompt (as route_session_message does).
        // Mentions name the cloud *actor*, which is `owner_actor_id` — the
        // attachment key is the session and was never an actor id.
        let mention_actor_ids = vec!["agent_X".to_string()];
        for rid in mgr.runtime_ids_for_session("session_S") {
            let owner = mgr.get_handle(&rid).unwrap().owner_actor_id.clone();
            if mention_actor_ids.contains(&owner) {
                mgr.send_prompt(&rid, "hi", vec![]).await.unwrap();
            }
        }

        assert_eq!(mgr.last_sent_to("session_S").as_deref(), Some("hi"));
        assert!(mgr
            .get_handle("session_S")
            .unwrap()
            .pending_silent
            .is_empty());
    }

    /// Simulate the "not mentioned" branch: message is queued as pending_silent.
    #[tokio::test]
    async fn route_not_mentioned_queues_silent() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("session_S");
        mgr.get_handle_mut("session_S").unwrap().owner_actor_id = "agent_X".into();

        let mention_actor_ids: Vec<String> = vec!["agent_OTHER".to_string()];
        let runtime_ids = mgr.runtime_ids_for_session("session_S");
        for rid in &runtime_ids {
            let owner = mgr.get_handle(rid).unwrap().owner_actor_id.clone();
            if !mention_actor_ids.contains(&owner) {
                if let Some(h) = mgr.get_handle_mut(rid) {
                    h.pending_silent.push(PendingMessage {
                        message_id: "m1".into(),
                        sender_display: "Alice".into(),
                        content: "context".into(),
                        created_at: 100,
                    });
                }
            }
        }

        assert_eq!(mgr.last_sent_to("session_S"), None);
        assert_eq!(mgr.get_handle("session_S").unwrap().pending_silent.len(), 1);
        assert_eq!(
            mgr.get_handle("session_S").unwrap().pending_silent[0].message_id,
            "m1"
        );
    }

    #[tokio::test]
    async fn send_prompt_bumps_last_active_at() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        // Reset to a known-old timestamp.
        mgr.get_handle_mut("rt1").unwrap().last_active_at = 0;
        let before = mgr.get_handle_mut("rt1").unwrap().last_active_at;
        mgr.send_prompt("rt1", "hi", vec![]).await.unwrap();
        let after = mgr.get_handle_mut("rt1").unwrap().last_active_at;
        assert!(after > before, "send_prompt should bump last_active_at");
    }

    #[test]
    fn poll_events_bumps_last_active_at_for_emitting_agents() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        mgr.get_handle_mut("rt1").unwrap().last_active_at = 0;
        // Push a fake event into the handle's channel from the sender side.
        let tx = mgr.get_handle_mut("rt1").unwrap().event_tx.clone();
        let evt = AcpEventFrame::new(
            "acp-test",
            amux::AcpEvent {
                model: String::new(),
                event: None,
            },
        );
        tx.try_send(evt).expect("event channel ready");
        let drained = mgr.poll_events();
        assert_eq!(drained.len(), 1);
        let after = mgr.get_handle_mut("rt1").unwrap().last_active_at;
        assert!(
            after > 0,
            "poll_events should bump last_active_at for agents that emitted"
        );
    }

    #[test]
    fn poll_events_for_only_drains_allowlisted_runtimes() {
        // Regression: the HTTP/SSE adapter's event pump shares the single
        // RuntimeManager with the MQTT main loop. It used to call the global
        // `poll_events()`, draining (and then silently discarding) events for
        // runtimes it did not own — starving the desktop's `session/live`
        // path. `poll_events_for` must touch ONLY the allowlisted runtimes and
        // leave everyone else's events queued for the main loop.
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-http");
        mgr.add_test_runtime("sess-mqtt");

        let mk = || {
            AcpEventFrame::new(
                "acp-test",
                amux::AcpEvent {
                    model: String::new(),
                    event: None,
                },
            )
        };
        let http_tx = mgr.get_handle_mut("rt-http").unwrap().event_tx.clone();
        let mqtt_tx = mgr.get_handle_mut("sess-mqtt").unwrap().event_tx.clone();
        http_tx.try_send(mk()).expect("http channel ready");
        mqtt_tx.try_send(mk()).expect("mqtt channel ready");

        // HTTP pump drains only the runtime it owns.
        let owned: std::collections::HashSet<String> =
            std::iter::once("rt-http".to_string()).collect();
        let http_drained = mgr.poll_events_for(&owned);
        assert_eq!(
            http_drained.len(),
            1,
            "HTTP pump drains only its own runtime"
        );
        assert!(
            http_drained.iter().all(|(id, _)| id == "rt-http"),
            "HTTP pump must not steal events from rt-mqtt"
        );

        // The MQTT main loop's global drain still sees rt-mqtt's untouched
        // event (and nothing left for rt-http).
        let main_drained = mgr.poll_events();
        assert_eq!(
            main_drained.len(),
            1,
            "main loop still receives the un-stolen rt-mqtt event"
        );
        assert_eq!(
            main_drained[0].0, "sess-mqtt",
            "main loop drains exactly rt-mqtt's event, not rt-http's (already taken)"
        );
    }

    #[tokio::test]
    async fn evict_idle_stops_runtimes_past_threshold() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-stale");
        let stale_ts = chrono::Utc::now().timestamp() - 3600; // 1h ago
        mgr.get_handle_mut("rt-stale").unwrap().last_active_at = stale_ts;
        mgr.add_test_runtime("sess-fresh");
        // rt-fresh was just inserted, last_active_at = 0 from test_dummy,
        // so set it to now so it isn't evicted.
        mgr.get_handle_mut("sess-fresh").unwrap().last_active_at = chrono::Utc::now().timestamp();

        let evicted = mgr.evict_idle(1800).await; // 30-minute threshold
        assert_eq!(evicted, vec!["rt-stale".to_string()]);
        assert!(mgr.get_handle("rt-stale").is_none(), "stale handle removed");
        assert!(
            mgr.get_handle("sess-fresh").is_some(),
            "fresh handle retained"
        );
    }

    #[tokio::test]
    async fn evict_over_capacity_detaches_least_recently_used_first() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-oldest");
        mgr.get_handle_mut("rt-oldest").unwrap().last_active_at = 100;
        mgr.add_test_runtime("sess-middle");
        mgr.get_handle_mut("sess-middle").unwrap().last_active_at = 200;
        mgr.add_test_runtime("sess-newest");
        mgr.get_handle_mut("sess-newest").unwrap().last_active_at = 300;

        let evicted = mgr.evict_over_capacity(2).await;

        assert_eq!(evicted, vec!["rt-oldest".to_string()]);
        assert!(mgr.get_handle("rt-oldest").is_none());
        assert!(mgr.get_handle("sess-middle").is_some());
        assert!(mgr.get_handle("sess-newest").is_some());
        assert_eq!(mgr.drain_evicted(), vec!["rt-oldest".to_string()]);
    }

    #[tokio::test]
    async fn any_attach_or_detach_marks_the_actor_snapshot_stale() {
        // Regression: the publish was hooked onto `apply_start_runtime`, which
        // gateway and cron never reach — they spawn straight through the
        // manager. A real cron turn created a session, answered, and never
        // appeared in the retain. Marking here is what makes all three spawn
        // paths agree.
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-a");
        assert!(mgr.take_actor_state_dirty(), "attach marks it stale");
        assert!(
            !mgr.take_actor_state_dirty(),
            "flag is consumed, not sticky"
        );

        mgr.stop_runtime("rt-a").await;
        assert!(mgr.take_actor_state_dirty(), "detach marks it stale too");
    }

    #[tokio::test]
    async fn evict_over_capacity_is_a_noop_under_the_cap() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-only");
        assert!(mgr.evict_over_capacity(16).await.is_empty());
        assert!(mgr.get_handle("rt-only").is_some());
    }

    #[tokio::test]
    async fn evict_over_capacity_ignores_the_checked_out_event_rx_guard() {
        // The idle sweep skips a handle whose receiver is checked out, to
        // protect a turn in flight. Capacity must NOT: a receiver stranded by a
        // failed checkout would otherwise exempt its attachment forever, and
        // the cap is the backstop that has to hold regardless.
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-stranded");
        mgr.get_handle_mut("rt-stranded").unwrap().last_active_at = 1;
        mgr.get_handle_mut("rt-stranded").unwrap().event_rx = None;
        mgr.add_test_runtime("sess-live");
        mgr.get_handle_mut("sess-live").unwrap().last_active_at = chrono::Utc::now().timestamp();

        assert!(
            mgr.evict_idle(60).await.is_empty(),
            "idle sweep leaves the stranded handle alone despite it being ancient"
        );
        assert_eq!(
            mgr.evict_over_capacity(1).await,
            vec!["rt-stranded".to_string()],
            "capacity sweep reclaims it anyway"
        );
    }

    #[tokio::test]
    async fn evict_idle_buffers_ids_for_drain() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-old");
        mgr.get_handle_mut("rt-old").unwrap().last_active_at = 0;
        let evicted = mgr.evict_idle(60).await;
        assert_eq!(evicted, vec!["rt-old".to_string()]);
        let drained = mgr.drain_evicted();
        assert_eq!(drained, vec!["rt-old".to_string()]);
        // Second drain returns empty.
        assert!(mgr.drain_evicted().is_empty());
    }

    #[tokio::test]
    async fn evict_idle_skips_runtimes_with_checked_out_event_rx() {
        // Mid-turn safety: a runtime whose event_rx has been taken (i.e.
        // a gateway turn is in flight) must not be evicted even if its
        // last_active_at is stale.
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-mid-turn");
        mgr.get_handle_mut("rt-mid-turn").unwrap().last_active_at = 0;
        // Simulate a checked-out event_rx by taking it directly.
        let _rx = mgr
            .get_handle_mut("rt-mid-turn")
            .unwrap()
            .event_rx
            .take()
            .expect("event_rx present");
        let evicted = mgr.evict_idle(60).await;
        assert!(
            evicted.is_empty(),
            "runtime mid-turn (event_rx None) must not be evicted"
        );
        assert!(
            mgr.get_handle("rt-mid-turn").is_some(),
            "handle must remain in map"
        );
    }

    #[tokio::test]
    async fn evict_idle_full_cycle_emits_evicted_id_for_publish() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-x");
        mgr.get_handle_mut("rt-x").unwrap().last_active_at = 0;

        // First sweep: stops the runtime, buffers id.
        let evicted = mgr.evict_idle(60).await;
        assert_eq!(evicted, vec!["rt-x".to_string()]);
        assert!(mgr.get_handle("rt-x").is_none());

        // Main loop drains the buffer.
        let to_publish = mgr.drain_evicted();
        assert_eq!(to_publish, vec!["rt-x".to_string()]);

        // Second sweep: nothing left, buffer is empty.
        assert!(mgr.evict_idle(60).await.is_empty());
        assert!(mgr.drain_evicted().is_empty());
    }

    #[tokio::test]
    async fn finalize_attached_session_registers_before_prompt_is_resolvable() {
        use super::super::context_registry::ResolveRuntimeContextRequest;
        use super::super::context_service::RuntimeContextService;
        use teamclu_runtime_env::session_context::TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV;

        let service = Arc::new(RuntimeContextService::new());
        service.set_base_url("http://127.0.0.1:1");
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.attach_context_service(Arc::clone(&service));

        let (cmd_tx, mut cmd_rx) = mpsc::channel(4);
        let startup = super::super::backend::AcpStartupMetadata {
            available_models: Vec::new(),
            initial_model: None,
            acp_session_id: "backend-a".into(),
            host_generation_id: "gen-1".into(),
            route_lease: None,
        };

        let service_bg = Arc::clone(&service);
        let checker = tokio::spawn(async move {
            let Some(super::super::backend::AcpCommand::Prompt { .. }) = cmd_rx.recv().await else {
                panic!("expected Prompt command");
            };
            let token = service_bg
                .env_for_generation(amux::AgentType::Opencode, "gen-1")
                .get(TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV)
                .cloned()
                .expect("token");
            let resolved = service_bg
                .resolve_with_token(
                    &token,
                    &ResolveRuntimeContextRequest {
                        backend_session_id: "backend-a".into(),
                        host_generation_id: "gen-1".into(),
                        backend_kind: "opencode".into(),
                    },
                )
                .expect("registry must be bound before prompt runs");
            assert_eq!(resolved.teamclu_session_id, "teamclu-a");
        });

        mgr.finalize_attached_session(
            amux::AgentType::Opencode,
            &startup,
            "teamclu-a",
            "runtime-a",
            &cmd_tx,
            "hello",
        )
        .await
        .unwrap();
        checker.await.unwrap();
    }

    #[tokio::test]
    async fn finalize_attached_session_rejects_incomplete_metadata_before_prompt() {
        use super::super::context_service::RuntimeContextService;

        let service = Arc::new(RuntimeContextService::new());
        service.set_base_url("http://127.0.0.1:1");
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.attach_context_service(service);

        let (cmd_tx, mut cmd_rx) = mpsc::channel(4);
        let startup = super::super::backend::AcpStartupMetadata {
            available_models: Vec::new(),
            initial_model: None,
            acp_session_id: "backend-a".into(),
            host_generation_id: String::new(),
            route_lease: None,
        };

        let drain = tokio::spawn(async move {
            let mut prompt_seen = false;
            let mut detach_seen = false;
            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    super::super::backend::AcpCommand::DetachSession { ack, .. } => {
                        detach_seen = true;
                        if let Some(tx) = ack {
                            let _ = tx.send(());
                        }
                    }
                    super::super::backend::AcpCommand::Prompt { .. } => prompt_seen = true,
                    _ => {}
                }
            }
            (prompt_seen, detach_seen)
        });

        let err = mgr
            .finalize_attached_session(
                amux::AgentType::Opencode,
                &startup,
                "teamclu-a",
                "runtime-a",
                &cmd_tx,
                "hello",
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("session context metadata incomplete"));
        drop(cmd_tx);
        let (prompt_seen, detach_seen) = drain.await.unwrap();
        assert!(!prompt_seen, "prompt must not be enqueued");
        assert!(detach_seen, "backend session must be detached on validation failure");
    }
}
