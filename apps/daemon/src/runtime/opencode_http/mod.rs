//! opencode serve HTTP runtime backend.
//!
//! Replaces the Zed-ACP integration (`adapter.rs` + `acp_host.rs`): amuxd now
//! drives a bounded pool of `opencode serve` HTTP generations. The manager-facing
//! surface (`AcpCommand`, `AcpStartupMetadata`, `OpencodeHost`) keeps the old
//! names and signatures so `RuntimeManager` / gateway plumbing is unchanged.

// Nothing constructs this backend since pi became the only runtime (#1247 /
// #1250). The module is compiled until #1247 deletes it, so dead-code lints
// are silenced here rather than chased through every function.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::permission_policy::PermissionPolicy;

pub mod client;
mod envelope;
mod events;
pub mod host_pool;
pub mod process_registry;
pub mod supervisor;
pub mod translate;

pub use envelope::*;

use client::{PromptBody, PromptPart};
use host_pool::{
    HostGeneration, HostPoolError, OpenCodeHostPool, PrewarmOutcome, SupervisorGenerationFactory,
};
use supervisor::ServeSupervisor;
use translate::TranslateState;

// ---------------------------------------------------------------------------
// Manager-facing command surface (names preserved from the ACP adapter)
// ---------------------------------------------------------------------------

// `AcpCommand` / `AcpStartupMetadata` are backend-neutral channel types shared
// with future backends; they live in `runtime/backend.rs` and are re-exported
// here so existing `runtime::adapter::*` import paths keep working.
pub use crate::runtime::backend::{AcpCommand, AcpStartupMetadata};

// ---------------------------------------------------------------------------
// Generation-owned routing state
// ---------------------------------------------------------------------------

pub(crate) struct Route {
    pub(crate) event_tx: mpsc::Sender<AcpEventFrame>,
    /// Permission handling for this session. `Full` (gateway / cron) means
    /// permission requests are auto-approved and `question` requests
    /// auto-rejected, so an unattended turn never waits on a human.
    pub(crate) permission: PermissionPolicy,
    /// Canonicalized worktree the session was created in (`?directory=`).
    pub(crate) directory: String,
    /// Model applied on the next prompt (opencode model is per-message).
    pub(crate) model: Option<client::PromptModel>,
    pub(crate) turn_active: bool,
    pub(crate) turn_reply_to: Option<String>,
    pub(crate) turn_requester: Option<String>,
    /// Monotonic per-route prompt counter; the stuck-turn watchdog only acts
    /// if the turn it armed for is still the current one.
    pub(crate) turn_seq: u64,
    /// True once the current turn produced at least one translated event
    /// (text/reasoning/tool). A provider that fails before the first token
    /// (out of credit, usage limit) produces none — opencode keeps the
    /// assistant message `error: null` and retries internally, so this plus
    /// `/session/status` polling is how we detect it.
    pub(crate) turn_saw_output: bool,
    /// Last transport activity for the current turn (session-scoped SSE
    /// progress events, permission/question resolution, SSE reconnect grace).
    /// The stuck-turn watchdog aborts when this is silent for
    /// [`FIRST_OUTPUT_TIMEOUT`]. Decoupled from translate dedupe so a long
    /// running tool that re-sends identical `message.part.updated` frames
    /// still counts as alive.
    pub(crate) turn_last_event_at: std::time::Instant,
    /// Provider retry message from the most recent `session.status` event,
    /// with a repeat count. A permanent failure (quota exhausted, out of
    /// credit) reports the *same* message on every retry regardless of how
    /// short opencode's backoff is — two occurrences is enough to tell it
    /// apart from a transient blip, so we don't wait out the [`FIRST_OUTPUT_TIMEOUT`]
    /// window when the backoff itself never grows past it.
    pub(crate) retry_streak: Option<(String, u32)>,
    /// Tool call ids currently in flight (ToolUse seen, no ToolResult yet).
    /// opencode emits no SSE events while a tool runs, so the stuck-turn
    /// watchdog must not treat that silence as a stalled model.
    pub(crate) tools_in_flight: HashSet<String>,
    pub(crate) translate: TranslateState,
    /// MCP server names amuxd injected into the worktree's `opencode.json`
    /// for this session (gateway `send` tool / remote tools). Pruned back out
    /// on detach / re-attach so stale entries don't accumulate.
    pub(crate) injected_mcp: Vec<String>,
    /// Latest assistant message id seen during the current or last turn (`^msg…`).
    pub(crate) last_assistant_message_id: Option<String>,
    /// Set when this route is a lightweight alias for an opencode `task`
    /// subagent session (`Session.parentID`). Frames still carry the child
    /// `acp_session_id`; only the delivery channel / directory / permission
    /// policy are inherited from the parent attach.
    pub(crate) parent_session_id: Option<String>,
}

/// Loopback SSE subscription state for one canonical worktree directory.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SseTransportState {
    pub connected: bool,
    pub last_read_at: Option<std::time::Instant>,
    /// Set when the stream drops until the next successful subscribe.
    pub reconnecting_since: Option<std::time::Instant>,
}

impl Default for SseTransportState {
    fn default() -> Self {
        Self {
            connected: false,
            last_read_at: None,
            reconnecting_since: None,
        }
    }
}

impl HostGeneration {
    fn sse_transport_entry(&self, directory: &str) -> SseTransportState {
        self.sse_transport
            .lock()
            .get(directory)
            .copied()
            .unwrap_or_default()
    }

    pub(super) fn mark_sse_disconnected(&self, directory: &str) {
        let mut transport = self.sse_transport.lock();
        let entry = transport.entry(directory.to_string()).or_default();
        entry.connected = false;
        entry.reconnecting_since = Some(std::time::Instant::now());
    }

    pub(super) fn mark_sse_connected(&self, directory: &str) {
        let now = std::time::Instant::now();
        {
            let mut transport = self.sse_transport.lock();
            let entry = transport.entry(directory.to_string()).or_default();
            entry.connected = true;
            entry.last_read_at = Some(now);
            entry.reconnecting_since = None;
        }
        self.refresh_active_turn_clocks_for_directory(directory);
    }

    pub(super) fn touch_sse_read(&self, directory: &str) {
        let mut transport = self.sse_transport.lock();
        let entry = transport.entry(directory.to_string()).or_default();
        entry.last_read_at = Some(std::time::Instant::now());
    }

    /// While SSE is down or reconnecting, the stuck-turn watchdog must not
    /// count silence toward [`FIRST_OUTPUT_TIMEOUT`].
    pub(super) fn sse_watchdog_paused(&self, directory: &str) -> bool {
        let entry = self.sse_transport_entry(directory);
        !entry.connected || entry.reconnecting_since.is_some()
    }

    pub(super) fn touch_turn_transport_activity(&self, session_id: &str) {
        let mut routes = self.routes.lock();
        let parent_id = routes
            .get(session_id)
            .and_then(|r| r.parent_session_id.clone());
        let now = std::time::Instant::now();
        if let Some(route) = routes.get_mut(session_id) {
            if route.turn_active {
                route.turn_last_event_at = now;
            }
        }
        // Subagent progress must keep the parent's stuck-turn watchdog alive.
        if let Some(parent_id) = parent_id {
            if let Some(route) = routes.get_mut(&parent_id) {
                if route.turn_active {
                    route.turn_last_event_at = now;
                }
            }
        }
    }

    /// Parent session id plus any registered task-subagent child alias ids.
    /// Pending permissions/questions on children must pause the parent's
    /// stuck-turn watchdog the same way top-level asks do.
    pub(super) fn session_ids_for_user_wait(&self, parent_session_id: &str) -> Vec<String> {
        let routes = self.routes.lock();
        let mut ids = vec![parent_session_id.to_string()];
        for (id, route) in routes.iter() {
            if route.parent_session_id.as_deref() == Some(parent_session_id) {
                ids.push(id.clone());
            }
        }
        ids
    }

    /// True while any tool call is in flight on this turn — on the parent
    /// session or on a task-subagent child riding its channel.
    pub(super) fn turn_has_tool_in_flight(&self, parent_session_id: &str) -> bool {
        let ids = self.session_ids_for_user_wait(parent_session_id);
        let routes = self.routes.lock();
        ids.iter().any(|id| {
            routes
                .get(id)
                .is_some_and(|r| !r.tools_in_flight.is_empty())
        })
    }

    pub(super) fn turn_waiting_on_user(&self, parent_session_id: &str) -> bool {
        let wait_ids = self.session_ids_for_user_wait(parent_session_id);
        let has_perm = self
            .permissions
            .lock()
            .values()
            .any(|sid| wait_ids.iter().any(|id| id == sid));
        if has_perm {
            return true;
        }
        self.questions
            .lock()
            .values()
            .any(|sid| wait_ids.iter().any(|id| id == sid))
    }

    /// After re-attaching a parent session (new `event_tx`), refresh any
    /// lightweight child alias routes so they forward on the live channel.
    pub(super) fn sync_child_routes_from_parent(&self, parent_id: &str) {
        let mut routes = self.routes.lock();
        let Some(parent) = routes.get(parent_id) else {
            return;
        };
        let event_tx = parent.event_tx.clone();
        let permission = parent.permission;
        let directory = parent.directory.clone();
        let turn_reply_to = parent.turn_reply_to.clone();
        let turn_requester = parent.turn_requester.clone();
        for route in routes.values_mut() {
            if route.parent_session_id.as_deref() == Some(parent_id) {
                route.event_tx = event_tx.clone();
                route.permission = permission;
                route.directory = directory.clone();
                route.turn_reply_to = turn_reply_to.clone();
                route.turn_requester = turn_requester.clone();
            }
        }
    }

    /// Register a lightweight route for an opencode task subagent session so
    /// its SSE events (`permission.asked`, tool deltas, …) are forwarded on
    /// the parent's `event_tx` while keeping `acp_session_id` = child.
    pub(super) fn ensure_child_route(&self, child_id: &str, parent_id: &str) -> bool {
        if child_id.is_empty() || parent_id.is_empty() || child_id == parent_id {
            return false;
        }
        let mut routes = self.routes.lock();
        if let Some(child) = routes.get(child_id) {
            if child.parent_session_id.as_deref() != Some(parent_id) {
                return false;
            }
            let Some(parent) = routes.get(parent_id) else {
                return false;
            };
            let event_tx = parent.event_tx.clone();
            let permission = parent.permission;
            let directory = parent.directory.clone();
            let turn_reply_to = parent.turn_reply_to.clone();
            let turn_requester = parent.turn_requester.clone();
            if let Some(child) = routes.get_mut(child_id) {
                child.event_tx = event_tx;
                child.permission = permission;
                child.directory = directory;
                child.turn_reply_to = turn_reply_to;
                child.turn_requester = turn_requester;
            }
            return true;
        }
        let Some(parent) = routes.get(parent_id) else {
            return false;
        };
        let child = Route {
            event_tx: parent.event_tx.clone(),
            permission: parent.permission,
            directory: parent.directory.clone(),
            model: None,
            turn_active: false,
            turn_reply_to: parent.turn_reply_to.clone(),
            turn_requester: parent.turn_requester.clone(),
            turn_seq: 0,
            turn_saw_output: false,
            turn_last_event_at: std::time::Instant::now(),
            tools_in_flight: HashSet::new(),
            translate: TranslateState::default(),
            injected_mcp: Vec::new(),
            last_assistant_message_id: None,
            parent_session_id: Some(parent_id.to_string()),
            retry_streak: None,
        };
        routes.insert(child_id.to_string(), child);
        info!(
            child_id,
            parent_id, "registered lightweight opencode subagent route"
        );
        true
    }

    pub(super) fn refresh_active_turn_clocks_for_directory(&self, directory: &str) {
        let now = std::time::Instant::now();
        let mut routes = self.routes.lock();
        for route in routes.values_mut() {
            if route.directory == directory && route.turn_active {
                route.turn_last_event_at = now;
            }
        }
    }
}

/// SSE events that indicate opencode is still working on an active turn.
pub(super) fn is_turn_progress_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "message.part.delta"
            | "message.part.updated"
            | "message.updated"
            | "session.status"
            | "session.error"
    )
}

fn canonical_dir(worktree: &str) -> String {
    std::fs::canonicalize(worktree)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| worktree.to_string())
}

// ---------------------------------------------------------------------------
// OpencodeHost
// ---------------------------------------------------------------------------

/// Facade over the bounded workspace-scoped OpenCode host pool.
pub struct OpencodeHost {
    pool: Arc<OpenCodeHostPool>,
    factory: Arc<SupervisorGenerationFactory>,
    generations: parking_lot::Mutex<HashMap<String, std::sync::Weak<HostGeneration>>>,
}

impl OpencodeHost {
    pub fn new() -> Self {
        let registry = Arc::new(process_registry::ServeProcessRegistry::default());
        let factory = Arc::new(SupervisorGenerationFactory::new(Arc::clone(&registry)));
        let pool = OpenCodeHostPool::new(factory.clone());
        Self {
            pool,
            factory,
            generations: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    pub fn pool(&self) -> Arc<OpenCodeHostPool> {
        Arc::clone(&self.pool)
    }

    pub fn attach_context_service(
        &self,
        service: Arc<crate::runtime::context_service::RuntimeContextService>,
    ) {
        self.factory.attach_context_service(Arc::clone(&service));
        self.pool.attach_context_service(service);
    }

    /// Number of live backend processes (0 or 1: the global serve instance).
    pub fn host_count(&self) -> usize {
        self.pool.host_count()
    }

    pub fn evict_agent_types(&mut self, _agent_types: &[amux::AgentType]) -> usize {
        self.pool.invalidate_all_domains()
    }

    pub fn invalidate_workspace_host(
        &self,
        domain: &crate::runtime::execution_context::IsolationDomainKey,
    ) -> bool {
        self.pool.invalidate_domain(domain)
    }

    pub fn invalidate_all_workspace_hosts(&self) -> usize {
        self.pool.invalidate_all_domains()
    }

    pub async fn shutdown_for_exit(&mut self) -> usize {
        let pooled_before = self.pool.host_count();
        self.pool.shutdown_all().await;
        pooled_before.saturating_sub(self.pool.host_count())
    }

    #[cfg(test)]
    fn test_with_pool(pool: Arc<OpenCodeHostPool>) -> Self {
        let mut host = Self::new();
        host.pool = pool;
        host
    }

    pub async fn prewarm(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
    ) {
        self.apply_binary_hint(launch_configs);
    }

    /// Pre-warm with a real session env (merged into the serve process env on
    /// its next spawn) and, when a worktree is known, its SSE subscription.
    pub async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        _force_env_override: bool,
        worktree: Option<&str>,
    ) {
        let Some(worktree) = worktree.filter(|worktree| !worktree.is_empty()) else {
            return;
        };
        let domain = crate::runtime::execution_context::IsolationDomainKey::Workspace(
            canonical_dir(worktree),
        );
        let revision =
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&extra_env);
        self.prewarm_workspace(launch_configs, domain, revision, extra_env, false, worktree)
            .await;
    }

    pub async fn prewarm_workspace(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
        isolation_domain: crate::runtime::execution_context::IsolationDomainKey,
        process_env_revision: crate::runtime::execution_context::ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        _force_env_override: bool,
        worktree: &str,
    ) {
        self.apply_binary_hint(launch_configs);
        match self
            .pool
            .try_prewarm(isolation_domain.clone(), process_env_revision, extra_env)
            .await
        {
            Ok(PrewarmOutcome::Reused(lease) | PrewarmOutcome::Started(lease)) => {
                events::ensure_sse_task(&lease.generation, &canonical_dir(worktree));
                info!(?isolation_domain, "workspace opencode host prewarmed");
            }
            Ok(
                PrewarmOutcome::SkippedCapacity
                | PrewarmOutcome::SkippedDemandQueued
                | PrewarmOutcome::SkippedDraining,
            ) => {
                info!(?isolation_domain, "workspace opencode host prewarm skipped");
            }
            Err(error) => {
                warn!(?isolation_domain, %error, "workspace opencode host prewarm failed");
            }
        }
    }

    fn apply_binary_hint(
        &self,
        launch_configs: &HashMap<amux::AgentType, super::manager::AgentLaunchConfig>,
    ) {
        if let Some(launch) = launch_configs.get(&amux::AgentType::Opencode) {
            self.factory.set_binary_hint(&launch.binary);
        }
    }

    /// Model catalog for a workspace directory (cron catalog UI).
    pub async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let env = HashMap::new();
        self.model_catalog_for_context(
            workspace_path,
            crate::runtime::execution_context::IsolationDomainKey::Workspace(canonical_dir(
                &workspace_path.to_string_lossy(),
            )),
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&env),
            env,
        )
        .await
    }

    pub async fn model_catalog_for_context(
        &mut self,
        workspace_path: &Path,
        isolation_domain: crate::runtime::execution_context::IsolationDomainKey,
        process_env_revision: crate::runtime::execution_context::ProcessEnvRevision,
        extra_env: HashMap<String, String>,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let lease = self
            .pool
            .acquire(
                isolation_domain,
                process_env_revision,
                extra_env,
                std::time::Instant::now() + std::time::Duration::from_secs(30),
            )
            .await
            .map_err(|error| crate::error::AmuxError::Agent(error.to_string()))?;
        let client = lease.generation.serve.ensure().await?;
        client
            .model_catalog(&canonical_dir(&workspace_path.to_string_lossy()))
            .await
    }

    /// Bind a TeamClu runtime to an opencode session (create or resume).
    #[allow(clippy::too_many_arguments)]
    pub async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &super::manager::AgentLaunchConfig,
        isolation_domain: crate::runtime::execution_context::IsolationDomainKey,
        process_env_revision: crate::runtime::execution_context::ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        model_mru: Vec<String>,
        _initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        permission: PermissionPolicy,
        forbid_new_session_fallback: bool,
        _teamclu_session_id: String,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        if agent_type != amux::AgentType::Opencode {
            warn!(
                ?agent_type,
                "agent type mapped to the single opencode HTTP backend"
            );
        }
        self.factory.set_binary_hint(&launch.binary);
        let _ = force_env_override; // preserved in the backend interface during transition
        let lease = self
            .pool
            .acquire(
                isolation_domain,
                process_env_revision,
                extra_env,
                Instant::now() + Duration::from_secs(20),
            )
            .await
            .map_err(|error| match error {
                HostPoolError::CapacityTimeout {
                    active,
                    draining,
                    queued,
                } => crate::error::AmuxError::Agent(format!(
                    "host_capacity_timeout: {active} active, {draining} draining, {queued} queued"
                )),
                HostPoolError::Spawn(message) => crate::error::AmuxError::Agent(message),
            })?;
        let (generation, route_lease) = lease.into_route_parts();
        self.generations.lock().insert(
            generation.generation_id.clone(),
            Arc::downgrade(&generation),
        );
        generation.serve.set_binary_hint(&launch.binary);
        let cmd_tx = command_sender_for_generation(Arc::clone(&generation));
        let startup = attach(
            &generation,
            AttachArgs {
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                model_mru,
                event_tx,
                permission,
                forbid_new_session_fallback,
            },
        )
        .await
        .map_err(crate::error::AmuxError::Agent)?
        .with_route_lease(route_lease);
        Ok((cmd_tx, startup))
    }

    /// Fork parent opencode session at anchor message (`POST /session/{id}/fork`).
    pub async fn fork_session_at(
        &mut self,
        spec: crate::runtime::backend::ForkSpec,
    ) -> crate::error::Result<String> {
        let anchor_message_id = spec
            .fork_opencode_message_id
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(
                    "opencode thread fork requires fork_opencode_message_id (anchor messageID)"
                        .into(),
                )
            })?;
        let lease = self
            .pool
            .acquire(
                spec.isolation_domain,
                spec.process_env_revision,
                spec.extra_env,
                Instant::now() + Duration::from_secs(30),
            )
            .await
            .map_err(|error| match error {
                HostPoolError::CapacityTimeout {
                    active,
                    draining,
                    queued,
                } => crate::error::AmuxError::Agent(format!(
                    "host_capacity_timeout: {active} active, {draining} draining, {queued} queued"
                )),
                HostPoolError::Spawn(message) => crate::error::AmuxError::Agent(message),
            })?;
        let directory = canonical_dir(&spec.worktree);
        let client = lease
            .generation
            .serve
            .ensure()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(e.to_string()))?;
        events::ensure_sse_task(&lease.generation, &directory);
        let messages = client
            .session_messages(&directory, &spec.parent_acp_session_id)
            .await?;
        let exclusive_cutoff = client::resolve_exclusive_fork_cutoff(&messages, &anchor_message_id)
            .map_err(crate::error::AmuxError::Agent)?;
        client
            .fork_session(
                &directory,
                &spec.parent_acp_session_id,
                exclusive_cutoff.as_deref(),
            )
            .await
    }

    pub fn completed_turn_opencode_message_id(&self, acp_session_id: &str) -> Option<String> {
        let gens = self.generations.lock();
        for weak in gens.values() {
            let Some(gen) = weak.upgrade() else {
                continue;
            };
            let routes = gen.routes.lock();
            if let Some(route) = routes.get(acp_session_id) {
                return route.last_assistant_message_id.clone();
            }
        }
        None
    }
}

impl Default for OpencodeHost {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Attach / prompt / command loop
// ---------------------------------------------------------------------------

struct AttachArgs {
    worktree: String,
    resume_acp_session_id: Option<String>,
    mcp_config_path: Option<PathBuf>,
    initial_model_override: Option<String>,
    /// Daemon MRU, newest first. See `config::model_mru`.
    model_mru: Vec<String>,
    event_tx: mpsc::Sender<AcpEventFrame>,
    permission: PermissionPolicy,
    forbid_new_session_fallback: bool,
}

/// Merge an amuxd-written `mcpServers` config file (gateway `send` tool or
/// remote-tools bridge — both use the same `mcpServers` shape) into the
/// worktree's `opencode.json` `mcp` map so serve-created sessions get the
/// tools. (serve has no per-session MCP parameter; config is per-directory.)
///
/// The merge is key-wise (`mcp.<name>` entries are inserted individually, the
/// map is never replaced wholesale), so gateway and remote-tools writes into
/// the same file cannot clobber each other's entries.
///
/// Returns the server names present in the source config so callers can
/// record them on the session route and prune them on detach.
fn merge_mcp_config_into_worktree(worktree: &str, mcp_config_path: &Path) -> Vec<String> {
    let merge = || -> anyhow::Result<Vec<String>> {
        let body = std::fs::read_to_string(mcp_config_path)?;
        let root: serde_json::Value = serde_json::from_str(&body)?;
        let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
            return Ok(Vec::new());
        };
        let config_path = Path::new(worktree).join("opencode.json");
        let mut config: serde_json::Value = if config_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&config_path)?)?
        } else {
            serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
        };
        let mcp = config
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("opencode.json root is not an object"))?
            .entry("mcp")
            .or_insert_with(|| serde_json::json!({}));
        let mcp_obj = mcp
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("mcp is not an object"))?;
        let mut changed = false;
        for (name, def) in servers {
            let command = def
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("mcp server '{name}' missing command"))?;
            let mut cmd_vec = vec![serde_json::json!(command)];
            if let Some(args) = def.get("args").and_then(|v| v.as_array()) {
                cmd_vec.extend(args.iter().cloned());
            }
            let entry = serde_json::json!({
                "type": "local",
                "enabled": true,
                "command": cmd_vec,
            });
            if mcp_obj.get(name) != Some(&entry) {
                mcp_obj.insert(name.clone(), entry);
                changed = true;
            }
        }
        if changed {
            // Our own write must not be mistaken for a user config change —
            // that triggers a serve restart, which detaches live sessions
            // and re-runs this injection on the next attach (restart loop).
            crate::runtime::refresh::suppress_internal_opencode_write(Path::new(worktree));
            std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;
        }
        Ok(servers.keys().cloned().collect())
    };
    match merge() {
        Ok(names) => names,
        Err(e) => {
            warn!(worktree, mcp_config = %mcp_config_path.display(), error = %e,
                  "failed to merge amuxd MCP config into worktree opencode.json");
            Vec::new()
        }
    }
}

/// Remove amuxd-injected server names from the worktree's `opencode.json`
/// `mcp` map. Only the given names are touched; user-authored entries stay.
fn prune_mcp_servers_from_worktree(worktree: &str, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let prune = || -> anyhow::Result<()> {
        let config_path = Path::new(worktree).join("opencode.json");
        if !config_path.exists() {
            return Ok(());
        }
        let mut config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path)?)?;
        let Some(mcp_obj) = config.get_mut("mcp").and_then(|v| v.as_object_mut()) else {
            return Ok(());
        };
        let mut changed = false;
        for name in names {
            changed |= mcp_obj.remove(name).is_some();
        }
        if changed {
            crate::runtime::refresh::suppress_internal_opencode_write(Path::new(worktree));
            std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;
        }
        Ok(())
    };
    if let Err(e) = prune() {
        warn!(worktree, error = %e,
              "failed to prune amuxd MCP entries from worktree opencode.json");
    }
}

/// Names in `candidates` that no *other* live route in `directory` also
/// injected — i.e. the ones safe to prune from that worktree's opencode.json.
fn prunable_mcp_names(
    routes: &HashMap<String, Route>,
    exclude_session: &str,
    directory: &str,
    candidates: &[String],
) -> Vec<String> {
    candidates
        .iter()
        .filter(|name| {
            !routes.iter().any(|(sid, r)| {
                sid != exclude_session
                    && r.directory == directory
                    && r.injected_mcp.iter().any(|n| n == *name)
            })
        })
        .cloned()
        .collect()
}

async fn attach(
    generation: &Arc<HostGeneration>,
    args: AttachArgs,
) -> Result<AcpStartupMetadata, String> {
    let shared = generation;
    let directory = canonical_dir(&args.worktree);
    let injected_mcp = match args.mcp_config_path.as_deref() {
        Some(mcp_path) => merge_mcp_config_into_worktree(&args.worktree, mcp_path),
        None => Vec::new(),
    };
    let client = shared
        .serve
        .ensure()
        .await
        .map_err(|e| format!("opencode serve unavailable: {e}"))?;
    events::ensure_sse_task(shared, &directory);

    // Set when we resumed an existing session: the model opencode persisted
    // for it, i.e. what that conversation last actually ran on.
    let mut resumed_model: Option<String> = None;

    let session_id = match args.resume_acp_session_id.as_deref() {
        Some(resume_id) if !resume_id.is_empty() => {
            match client.get_session(&directory, resume_id).await {
                Ok(Some(session)) => {
                    resumed_model = client::session_model_id(&session);
                    resume_id.to_string()
                }
                Ok(None) | Err(_) if args.forbid_new_session_fallback => {
                    return Err(format!(
                        "opencode session {resume_id} not resumable (new-session fallback forbidden)"
                    ));
                }
                Ok(None) => {
                    warn!(resume_id, "opencode session not found; creating a new one");
                    client
                        .create_session(&directory)
                        .await
                        .map_err(|e| e.to_string())?
                }
                Err(e) => {
                    warn!(resume_id, error = %e, "opencode resume check failed; creating a new session");
                    client
                        .create_session(&directory)
                        .await
                        .map_err(|e| e.to_string())?
                }
            }
        }
        _ => client
            .create_session(&directory)
            .await
            .map_err(|e| e.to_string())?,
    };

    let available_models = client.model_catalog(&directory).await.unwrap_or_else(|e| {
        warn!(error = %e, "opencode model catalog fetch failed");
        Vec::new()
    });
    // Model resolution, most specific first:
    //
    //   1. an explicit override — someone ran `/model` or picked one in the UI
    //   2. `session.model` — what this conversation last actually ran on, read
    //      back from opencode, which persists it across daemon restarts
    //   3. the config default (`GET /config` → `model`)
    //   4. the daemon MRU — this device's recent models, shared by desktop,
    //      gateway and cron (`config::model_mru`)
    //   5. nothing: leave it `None` and let opencode decide
    //
    // Every level is checked against the live catalog by `first_available`, so
    // a pick that has stopped working (provider logged out, key revoked, model
    // retired) falls through to the next candidate instead of being handed to
    // the runtime and failing on the first turn. This mirrors what opencode
    // does for its own picker.
    //
    // (5) is a real answer, not a gap. `PromptBody.model` is
    // `skip_serializing_if = "none"`, so an unset model means the prompt omits
    // the field and opencode resolves it with its own ordering — better than
    // anything we can guess. An earlier `.or_else(|| available_models.first())`
    // did guess, taking the head of `model_catalog`, which
    // `models_from_providers` sorts by `provider/model` id — i.e.
    // alphabetically — with no availability check at all.
    let catalog: Vec<String> = available_models.iter().map(|m| m.id.clone()).collect();
    let candidates = args
        .initial_model_override
        .filter(|m| !m.is_empty())
        .into_iter()
        .chain(resumed_model)
        .chain(client.config_default_model(&directory).await)
        .chain(args.model_mru);
    let initial_model = crate::config::first_available(candidates, &catalog);
    let model = initial_model.as_deref().and_then(client::split_model_id);

    let orphaned_turn = {
        let mut routes = shared.routes.lock();
        // This insert REPLACES any existing route for the session, so a turn
        // still running on the old one has to be closed out rather than
        // silently dropped (see `take_active_turn`).
        let orphaned_turn = routes.get_mut(&session_id).and_then(take_active_turn);
        // Replace-don't-accumulate: when re-attaching the same session with a
        // new MCP config, entries we previously injected but that are absent
        // from the new config get pruned (unless another live session in the
        // same worktree still needs them).
        let stale: Vec<String> = routes
            .get(&session_id)
            .map(|old| {
                old.injected_mcp
                    .iter()
                    .filter(|n| !injected_mcp.contains(n))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let stale = prunable_mcp_names(&routes, &session_id, &directory, &stale);
        prune_mcp_servers_from_worktree(&directory, &stale);
        routes.insert(
            session_id.clone(),
            Route {
                event_tx: args.event_tx,
                permission: args.permission,
                directory: directory.clone(),
                model,
                turn_active: false,
                turn_reply_to: None,
                turn_requester: None,
                turn_seq: 0,
                turn_saw_output: false,
                turn_last_event_at: std::time::Instant::now(),
                tools_in_flight: HashSet::new(),
                translate: TranslateState::default(),
                injected_mcp,
                last_assistant_message_id: None,
                parent_session_id: None,
                retry_streak: None,
            },
        );
        orphaned_turn
    };
    close_orphaned_turn(&session_id, orphaned_turn).await;
    shared.sync_child_routes_from_parent(&session_id);

    info!(
        session_id = %session_id,
        directory = %directory,
        models = available_models.len(),
        initial_model = initial_model.as_deref().unwrap_or(""),
        "opencode session attached"
    );

    // A pending question survives in opencode across daemon restarts, but the
    // one-shot SSE announcement doesn't — re-sync so the client gets its card.
    {
        let shared = Arc::clone(shared);
        let sid = session_id.clone();
        tokio::spawn(async move {
            events::resync_pending_questions(&shared, &sid).await;
        });
    }

    Ok(AcpStartupMetadata {
        available_models,
        initial_model,
        acp_session_id: session_id,
        host_generation_id: generation.generation_id.clone(),
        route_lease: None,
    })
}

fn guess_mime(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or(url);
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

async fn emit_frame(
    event_tx: &mpsc::Sender<AcpEventFrame>,
    session_id: &str,
    event: amux::AcpEvent,
    reply_to: Option<String>,
) {
    crate::runtime::agent_trace::log_acp_event(session_id, &event);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, event).with_reply_to(reply_to))
        .await;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveTurnStatusCheck {
    emit_turn_open: bool,
    reconcile_stale_idle: bool,
}

/// When daemon already claims an active turn, cross-check opencode before
/// deciding whether to re-emit Idle→Active on the next prompt.
fn active_turn_status_check(phase: client::OpencodeSessionPhase) -> ActiveTurnStatusCheck {
    match phase {
        client::OpencodeSessionPhase::Running => ActiveTurnStatusCheck {
            emit_turn_open: false,
            reconcile_stale_idle: false,
        },
        client::OpencodeSessionPhase::Idle => ActiveTurnStatusCheck {
            emit_turn_open: true,
            reconcile_stale_idle: true,
        },
        client::OpencodeSessionPhase::Unknown => ActiveTurnStatusCheck {
            emit_turn_open: false,
            reconcile_stale_idle: false,
        },
    }
}

async fn opencode_session_phase(
    shared: &Arc<HostGeneration>,
    directory: &str,
    session_id: &str,
) -> client::OpencodeSessionPhase {
    let client = match shared.serve.ensure().await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                session_id,
                error = %e,
                "session/status poll skipped: serve unavailable"
            );
            return client::OpencodeSessionPhase::Unknown;
        }
    };
    match client.session_status(directory).await {
        Ok(map) => client::ServeClient::session_phase_from_map(&map, session_id),
        Err(e) => {
            warn!(session_id, error = %e, "session/status poll failed");
            client::OpencodeSessionPhase::Unknown
        }
    }
}

async fn do_prompt(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    text: String,
    attachment_urls: Vec<String>,
    requester_actor_id: Option<String>,
    reply_to_message_id: Option<String>,
) {
    let reply_to = reply_to_message_id.filter(|id| !id.is_empty());
    // Resolve before marking the turn active so download latency does not
    // consume the stuck-turn watchdog budget.
    let resolved =
        crate::runtime::prompt_attachments::resolve_all(&attachment_urls, session_id).await;

    let (directory, was_turn_active) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            warn!(session_id, "prompt for unknown opencode session");
            return;
        };
        (route.directory.clone(), route.turn_active)
    };

    let mut emit_turn_open = !was_turn_active;
    if was_turn_active {
        let phase = opencode_session_phase(&shared, &directory, session_id).await;
        let check = active_turn_status_check(phase);
        if check.reconcile_stale_idle {
            warn!(
                session_id,
                "turn_active but opencode session/status is idle; reconciling stale turn"
            );
            let taken = {
                let mut routes = shared.routes.lock();
                routes.get_mut(session_id).and_then(take_active_turn)
            };
            close_orphaned_turn(session_id, taken).await;
        } else if phase == client::OpencodeSessionPhase::Running {
            debug!(
                session_id,
                "turn_active confirmed by opencode session/status busy/retry"
            );
        }
        emit_turn_open = check.emit_turn_open;
    }

    let (event_tx, directory, model, turn_seq) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            warn!(session_id, "prompt for unknown opencode session");
            return;
        };
        route.turn_active = true;
        route.turn_reply_to = reply_to.clone();
        route.turn_requester = requester_actor_id.filter(|id| !id.is_empty());
        route.turn_seq += 1;
        route.turn_saw_output = false;
        route.turn_last_event_at = std::time::Instant::now();
        route.retry_streak = None;
        route.tools_in_flight.clear();
        route.last_assistant_message_id = None;
        (
            route.event_tx.clone(),
            route.directory.clone(),
            route.model.clone(),
            route.turn_seq,
        )
    };

    crate::runtime::agent_trace::log_prompt_begin(session_id, &text, attachment_urls.len());
    if emit_turn_open {
        emit_frame(
            &event_tx,
            session_id,
            translate::status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
            reply_to.clone(),
        )
        .await;
    }

    let mut text = text;
    crate::runtime::prompt_attachments::substitute_in_message(&mut text, &resolved);
    crate::runtime::prompt_attachments::append_unreferenced(&mut text, &resolved, false);
    let mut parts = vec![PromptPart::Text { text }];
    for entry in &resolved {
        match &entry.attachment {
            crate::runtime::prompt_attachments::ResolvedAttachment::Image { .. } => {
                let (mime, url, filename) = entry.attachment.opencode_file_fields();
                parts.push(PromptPart::File {
                    mime,
                    url,
                    filename,
                });
            }
            crate::runtime::prompt_attachments::ResolvedAttachment::LocalFile { .. } => {
                // Non-image files are referenced via local path in prompt text.
            }
            crate::runtime::prompt_attachments::ResolvedAttachment::Link { url, .. } => {
                // Failed image downloads fall back to Link; opencode rejects HTTPS
                // image URLs, so omit those rather than surfacing ImageInvalidDataUrlError.
                if crate::runtime::prompt_attachments::is_image_attachment_url(url) {
                    warn!(url = %url, "skipping unresolved image attachment for opencode prompt");
                    continue;
                }
                // Non-image link fallbacks stay in text only — no File part.
            }
        }
    }
    let body = PromptBody { model, parts };

    let result = match shared.serve.ensure().await {
        Ok(client) => client.prompt_async(&directory, session_id, &body).await,
        Err(e) => Err(e),
    };
    if result.is_ok() {
        spawn_stuck_turn_watchdog(shared, session_id, turn_seq);
    }
    if let Err(e) = result {
        let details = e.to_string();
        crate::runtime::agent_trace::log_prompt_end(session_id, false, &details, 0);
        emit_frame(
            &event_tx,
            session_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: "opencode prompt failed".to_string(),
                    details,
                })),
                model: String::new(),
            },
            reply_to.clone(),
        )
        .await;
        // Close the turn — no `session.idle` will arrive for a failed submit.
        {
            let mut routes = shared.routes.lock();
            if let Some(route) = routes.get_mut(session_id) {
                route.turn_active = false;
                route.turn_reply_to = None;
                route.turn_requester = None;
                route.tools_in_flight.clear();
            }
        }
        emit_frame(
            &event_tx,
            session_id,
            translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            reply_to,
        )
        .await;
    }
}

/// How often the stuck-turn watchdog polls `/session/status` after a prompt.
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Give up on a turn that produced no output and no retry status after this.
pub(crate) const FIRST_OUTPUT_TIMEOUT: Duration = Duration::from_secs(120);
/// Silence budget while a tool call is in flight. opencode sends no SSE
/// events while a tool runs (long bash, builds, slow MCP calls), so model
/// silence is expected then — only give up after this much larger bound.
pub(crate) const TOOL_SILENCE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// A failed upstream provider request (out of credit, usage limit, rate
/// limit) is invisible on the happy path: opencode keeps the assistant
/// message `error: null`, retries internally, and never sends
/// `session.idle`. The retry state IS exposed — via the `session.status` SSE
/// event (fires once, easy to miss across reconnects) and the
/// `GET /session/status` snapshot (what the official desktop app uses). This
/// watchdog polls the snapshot every few seconds so the user sees the
/// provider's own error within seconds, and falls back to a hard timeout for
/// providers that hang without reporting anything.
fn spawn_stuck_turn_watchdog(shared: &Arc<HostGeneration>, session_id: &str, turn_seq: u64) {
    let shared = Arc::clone(shared);
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(STATUS_POLL_INTERVAL).await;
            let (directory, silent_for) = {
                let routes = shared.routes.lock();
                match routes.get(&session_id) {
                    Some(route) if route.turn_active && route.turn_seq == turn_seq => {
                        (route.directory.clone(), route.turn_last_event_at.elapsed())
                    }
                    // The turn ended or a newer prompt took over.
                    _ => return,
                }
            };
            // Waiting on the USER (pending permission or question) is not a
            // stall — stand by until it resolves (resolution refreshes
            // turn_last_event_at).
            let waiting_on_user = shared.turn_waiting_on_user(&session_id);
            if waiting_on_user {
                continue;
            }
            if shared.sse_watchdog_paused(&directory) {
                continue;
            }
            if let Some((message, next_ms)) =
                retry_status_for(&shared, &directory, &session_id).await
            {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let wait = next_ms.saturating_sub(now_ms);
                // Same message on consecutive polls means the failure is
                // permanent (quota exhausted, out of credit) — the backoff
                // itself never has to grow past the wait window for us to
                // know retrying won't help.
                let repeats = {
                    let mut routes = shared.routes.lock();
                    routes
                        .get_mut(&session_id)
                        .map(|route| match &mut route.retry_streak {
                            Some((last, count)) if last == &message => {
                                *count += 1;
                                *count
                            }
                            _ => {
                                route.retry_streak = Some((message.clone(), 1));
                                1
                            }
                        })
                };
                // A retry due soon may still succeed — keep waiting for it
                // (bounded by the silence timeout below).
                if repeats.unwrap_or(0) >= 2 || wait > FIRST_OUTPUT_TIMEOUT.as_millis() as i64 {
                    warn!(
                        session_id,
                        message = %message,
                        next_in_s = wait / 1000,
                        "provider retry scheduled beyond wait window; aborting turn"
                    );
                    abort_turn_with_error(
                        &shared,
                        &session_id,
                        "model provider error".to_string(),
                        message,
                    )
                    .await;
                    return;
                }
            }
            if silent_for >= FIRST_OUTPUT_TIMEOUT {
                if shared.turn_has_tool_in_flight(&session_id) {
                    if silent_for < TOOL_SILENCE_TIMEOUT {
                        continue;
                    }
                    warn!(
                        session_id,
                        timeout_s = TOOL_SILENCE_TIMEOUT.as_secs(),
                        "in-flight tool silent past its budget; aborting stuck opencode turn"
                    );
                    abort_turn_with_error(
                        &shared,
                        &session_id,
                        "tool stalled".to_string(),
                        format!(
                            "A tool call produced no result for {}s. The turn was \
                             aborted; try again.",
                            TOOL_SILENCE_TIMEOUT.as_secs()
                        ),
                    )
                    .await;
                    return;
                }
                warn!(
                    session_id,
                    timeout_s = FIRST_OUTPUT_TIMEOUT.as_secs(),
                    "event stream silent too long; aborting stuck opencode turn"
                );
                abort_turn_with_error(
                    &shared,
                    &session_id,
                    "model stalled".to_string(),
                    format!(
                        "No output from the model for {}s — the provider may be \
                         unreachable or overloaded. The turn was aborted; try again \
                         or switch models.",
                        FIRST_OUTPUT_TIMEOUT.as_secs()
                    ),
                )
                .await;
                return;
            }
        }
    });
}

/// `Some((provider message, next-retry epoch ms))` when opencode reports the
/// session in a provider-retry loop.
async fn retry_status_for(
    shared: &Arc<HostGeneration>,
    directory: &str,
    session_id: &str,
) -> Option<(String, i64)> {
    let client = shared.serve.ensure().await.ok()?;
    let statuses = client.session_status(directory).await.ok()?;
    let status = statuses.get(session_id)?;
    if status.get("type").and_then(|v| v.as_str()) != Some("retry") {
        return None;
    }
    let message = status
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("provider error")
        .to_string();
    let next_ms = status.get("next").and_then(|v| v.as_i64()).unwrap_or(0);
    Some((message, next_ms))
}

/// Close an active turn: abort it in opencode, surface `details` to the
/// client as an error bubble, and return the agent to Idle so "replying…"
/// clears. Used by the stuck-turn watchdog and the `session.status` SSE
/// handler.
/// Take the in-flight turn off a route that is about to be dropped or replaced.
///
/// A route owns all of its turn's bookkeeping, and [`events::handle_session_idle`]
/// needs `turn_active` to emit the Active→Idle close. So a route that goes away
/// mid-turn — a detach, or a re-attach that re-points the same session at
/// another worktree — used to strand the client on "replying" forever: the
/// later `session.idle` found either no route or a fresh one with
/// `turn_active = false` and returned having emitted nothing.
fn take_active_turn(route: &mut Route) -> Option<(mpsc::Sender<AcpEventFrame>, Option<String>)> {
    if !route.turn_active {
        return None;
    }
    route.turn_active = false;
    route.turn_requester = None;
    route.tools_in_flight.clear();
    Some((route.event_tx.clone(), route.turn_reply_to.take()))
}

/// Emit the Active→Idle close for a turn taken by [`take_active_turn`]. Sends
/// on the *old* route's channel, which is the one the client is still waiting
/// on. Separate from taking it so the routes lock is never held across an await.
async fn close_orphaned_turn(
    session_id: &str,
    taken: Option<(mpsc::Sender<AcpEventFrame>, Option<String>)>,
) {
    let Some((event_tx, reply_to)) = taken else {
        return;
    };
    warn!(
        session_id,
        "closing an in-flight turn: its runtime went away mid-turn"
    );
    let ev = translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle);
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

pub(crate) async fn abort_turn_with_error(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    message: String,
    details: String,
) {
    let (event_tx, directory, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return;
        };
        if !route.turn_active {
            return;
        }
        route.turn_active = false;
        route.turn_requester = None;
        route.tools_in_flight.clear();
        (
            route.event_tx.clone(),
            route.directory.clone(),
            route.turn_reply_to.take(),
        )
    };
    if let Ok(client) = shared.serve.ensure().await {
        if let Err(e) = client.abort(&directory, session_id).await {
            warn!(session_id, error = %e, "turn abort failed");
        }
    }
    emit_frame(
        &event_tx,
        session_id,
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                message,
                details,
            })),
            model: String::new(),
        },
        reply_to.clone(),
    )
    .await;
    emit_frame(
        &event_tx,
        session_id,
        translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
        reply_to,
    )
    .await;
}

/// After a successful `POST /abort`, how long to wait for opencode's own
/// `session.error` + `session.idle` to close the turn before forcing it.
const CANCEL_CLOSE_GRACE: Duration = Duration::from_secs(10);

/// User-initiated interrupt. On the happy path opencode answers the abort
/// with `session.error` (MessageAbortedError) + `session.idle` over SSE and
/// those close the turn. The close must not depend on that though: when the
/// abort call itself fails the turn is force-closed immediately, and even a
/// successful abort is backstopped by a grace timer in case the terminal SSE
/// events are lost to a gap — otherwise the client never leaves "replying…"
/// and cannot even re-interrupt.
async fn cancel_turn(shared: &Arc<HostGeneration>, session_id: &str) {
    let (directory, turn_seq) = {
        let routes = shared.routes.lock();
        match routes.get(session_id) {
            Some(route) => (route.directory.clone(), route.turn_seq),
            None => (String::new(), 0),
        }
    };
    let abort_ok = match shared.serve.ensure().await {
        Ok(client) => match client.abort(&directory, session_id).await {
            Ok(()) => {
                crate::runtime::agent_trace::log_cancel(session_id, true, "");
                true
            }
            Err(e) => {
                let err = e.to_string();
                crate::runtime::agent_trace::log_cancel(session_id, false, &err);
                warn!(session_id, error = %err, "opencode abort failed");
                false
            }
        },
        Err(e) => {
            warn!(error = %e, "cancel: serve unavailable");
            false
        }
    };
    if !abort_ok {
        force_close_interrupted_turn(shared, session_id, turn_seq).await;
        return;
    }
    let shared = Arc::clone(shared);
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(CANCEL_CLOSE_GRACE).await;
        force_close_interrupted_turn(&shared, &session_id, turn_seq).await;
    });
}

/// Close a turn that a cancel could not (or did not) close through opencode:
/// emit the abort-shaped `Error` (so the aggregator produces the durable
/// interrupted AgentReply, keeping any partial prose) followed by the
/// Active→Idle terminal. No-op when the turn already closed or a newer
/// prompt took the route over.
async fn force_close_interrupted_turn(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    turn_seq: u64,
) {
    let (event_tx, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return;
        };
        if !route.turn_active || route.turn_seq != turn_seq {
            return;
        }
        route.turn_active = false;
        route.turn_requester = None;
        route.tools_in_flight.clear();
        (route.event_tx.clone(), route.turn_reply_to.take())
    };
    warn!(
        session_id,
        "turn did not close after cancel; forcing interrupted close"
    );
    emit_frame(
        &event_tx,
        session_id,
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                message: "TurnInterrupted".to_string(),
                details: "The turn was stopped by the user.".to_string(),
            })),
            model: String::new(),
        },
        reply_to.clone(),
    )
    .await;
    emit_frame(
        &event_tx,
        session_id,
        translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
        reply_to,
    )
    .await;
}

async fn resolve_permission(
    shared: &Arc<HostGeneration>,
    request_id: &str,
    granted: bool,
    option_id: Option<String>,
) {
    let Some(session_id) = shared.permissions.lock().remove(request_id) else {
        warn!(request_id, "no pending opencode permission request found");
        return;
    };
    if let Some(route) = shared.routes.lock().get_mut(&session_id) {
        route.turn_last_event_at = std::time::Instant::now();
    }
    let directory = shared
        .routes
        .lock()
        .get(&session_id)
        .map(|r| r.directory.clone())
        .unwrap_or_default();
    let response = translate::permission_response_for(granted, option_id.as_deref());
    match shared.serve.ensure().await {
        Ok(client) => {
            if let Err(e) = client
                .permission_respond(&directory, &session_id, request_id, response)
                .await
            {
                warn!(request_id, session_id = %session_id, error = %e, "permission respond failed");
            }
        }
        Err(e) => warn!(error = %e, "permission respond: serve unavailable"),
    }
}

/// Forward a user's answer (or rejection) to opencode's question endpoint.
async fn answer_question(
    shared: &Arc<HostGeneration>,
    request_id: &str,
    answers_json: &str,
    reject: bool,
) {
    let Some(session_id) = shared.questions.lock().remove(request_id) else {
        warn!(request_id, "no pending opencode question request found");
        return;
    };
    if let Some(route) = shared.routes.lock().get_mut(&session_id) {
        route.turn_last_event_at = std::time::Instant::now();
    }
    let directory = shared
        .routes
        .lock()
        .get(&session_id)
        .map(|r| r.directory.clone())
        .unwrap_or_default();
    let client = match shared.serve.ensure().await {
        Ok(client) => client,
        Err(e) => {
            warn!(error = %e, "question reply: serve unavailable");
            return;
        }
    };
    let result = if reject {
        client.question_reject(&directory, request_id).await
    } else {
        let answers: serde_json::Value =
            serde_json::from_str(answers_json).unwrap_or_else(|_| serde_json::json!([]));
        client
            .question_reply(&directory, request_id, &answers)
            .await
    };
    if let Err(e) = result {
        warn!(request_id, session_id = %session_id, error = %e, "question reply failed");
        // Leave a chance to retry: re-register the request.
        shared
            .questions
            .lock()
            .insert(request_id.to_string(), session_id);
    }
}

async fn detach_generation_route(generation: &Arc<HostGeneration>, acp_session_id: &str) {
    let (pruned, orphaned_turn, detached_session_ids) = {
        let mut routes = generation.routes.lock();
        let mut detached_session_ids = vec![acp_session_id.to_string()];
        routes.retain(|id, route| {
            if route.parent_session_id.as_deref() == Some(acp_session_id) {
                detached_session_ids.push(id.clone());
                false
            } else {
                true
            }
        });
        let removed = routes.remove(acp_session_id);
        let mut orphaned_turn = None;
        let pruned = removed.map(|mut route| {
            orphaned_turn = take_active_turn(&mut route);
            let names = prunable_mcp_names(
                &routes,
                acp_session_id,
                &route.directory,
                &route.injected_mcp,
            );
            (route.directory, names)
        });
        (pruned, orphaned_turn, detached_session_ids)
    };
    close_orphaned_turn(acp_session_id, orphaned_turn).await;
    if let Some((directory, names)) = pruned {
        prune_mcp_servers_from_worktree(&directory, &names);
    }
    generation
        .permissions
        .lock()
        .retain(|_, sid| !detached_session_ids.iter().any(|detached| detached == sid));
    generation
        .questions
        .lock()
        .retain(|_, sid| !detached_session_ids.iter().any(|detached| detached == sid));
}

fn command_sender_for_generation(generation: Arc<HostGeneration>) -> mpsc::Sender<AcpCommand> {
    let (tx, rx) = mpsc::channel::<AcpCommand>(64);
    tokio::spawn(command_loop(generation, rx));
    tx
}

async fn command_loop(shared: Arc<HostGeneration>, mut cmd_rx: mpsc::Receiver<AcpCommand>) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::AttachSession {
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                model_mru,
                initial_prompt,
                event_tx,
                startup_tx,
                permission,
                forbid_new_session_fallback,
                teamclu_session_id: _,
            } => {
                let result = attach(
                    &shared,
                    AttachArgs {
                        worktree,
                        resume_acp_session_id,
                        mcp_config_path,
                        initial_model_override,
                        model_mru,
                        event_tx,
                        permission,
                        forbid_new_session_fallback,
                    },
                )
                .await;
                let follow_up = result
                    .as_ref()
                    .ok()
                    .filter(|_| !initial_prompt.is_empty())
                    .map(|meta| meta.acp_session_id.clone());
                let _ = startup_tx.send(result);
                if let Some(session_id) = follow_up {
                    do_prompt(&shared, &session_id, initial_prompt, Vec::new(), None, None).await;
                }
            }
            AcpCommand::Prompt {
                acp_session_id,
                text,
                attachment_urls,
                requester_actor_id,
                reply_to_message_id,
            } => {
                do_prompt(
                    &shared,
                    &acp_session_id,
                    text,
                    attachment_urls,
                    requester_actor_id,
                    reply_to_message_id,
                )
                .await;
            }
            AcpCommand::Cancel { acp_session_id } => {
                cancel_turn(&shared, &acp_session_id).await;
            }
            AcpCommand::ResolvePermission {
                request_id,
                granted,
                option_id,
            } => {
                resolve_permission(&shared, &request_id, granted, option_id).await;
            }
            AcpCommand::AnswerQuestion {
                request_id,
                answers_json,
                reject,
            } => {
                answer_question(&shared, &request_id, &answers_json, reject).await;
            }
            AcpCommand::SetModel {
                acp_session_id,
                model_id,
            } => match client::split_model_id(&model_id) {
                Some(model) => {
                    let mut routes = shared.routes.lock();
                    if let Some(route) = routes.get_mut(&acp_session_id) {
                        route.model = Some(model);
                        info!(acp_session_id, model_id = %model_id, "opencode model recorded for next prompt");
                    } else {
                        warn!(acp_session_id, "set_model for unknown session");
                    }
                }
                None => warn!(model_id = %model_id, "set_model: expected provider/model id"),
            },
            AcpCommand::DetachSession {
                acp_session_id,
                ack,
            } => {
                detach_generation_route(&shared, &acp_session_id).await;
                info!(acp_session_id, "opencode session detached");
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
            }
            AcpCommand::Shutdown => {
                shared.serve.shutdown();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// CLI compat: `amuxd test-spawn`
// ---------------------------------------------------------------------------

/// Legacy single-session helper used by the `amuxd test-spawn` debug CLI.
/// Production runtimes attach via [`OpencodeHost`] instead.
#[allow(clippy::too_many_arguments)]
pub fn start_standalone_runtime(
    binary: String,
    _args: Vec<String>,
    worktree: String,
    initial_prompt: String,
    _agent_type: amux::AgentType,
    event_tx: mpsc::Sender<AcpEventFrame>,
    resume_acp_session_id: Option<String>,
    startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
    initial_model_override: Option<String>,
    mcp_config_path: Option<PathBuf>,
    extra_env: HashMap<String, String>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let revision = crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&extra_env);
    let generation_id = format!("standalone-{}", uuid::Uuid::new_v4());
    let serve = Arc::new(ServeSupervisor::new(
        generation_id.clone(),
        Arc::new(process_registry::ServeProcessRegistry::default()),
        extra_env,
        revision.clone(),
    ));
    serve.set_binary_hint(&binary);
    let generation = Arc::new(HostGeneration::new(
        generation_id,
        crate::runtime::execution_context::IsolationDomainKey::UnscopedAgent {
            team_id: "standalone".to_string(),
            actor_id: "standalone".to_string(),
        },
        revision,
        serve,
        None,
    ));
    let cmd_tx = command_sender_for_generation(generation);
    let attach_tx = cmd_tx.clone();
    tokio::spawn(async move {
        let _ = attach_tx
            .send(AcpCommand::AttachSession {
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                model_mru: Vec::new(),
                initial_prompt,
                event_tx,
                startup_tx,
                permission: PermissionPolicy::Ask,
                forbid_new_session_fallback: false,
                teamclu_session_id: String::new(),
            })
            .await;
    });
    Ok(cmd_tx)
}

// ---------------------------------------------------------------------------
// PATH enrichment for spawned processes (kept from the ACP adapter; also used
// by mcp_probe / agent_discover)
// ---------------------------------------------------------------------------

#[cfg(windows)]
const PATH_SEP: char = ';';
#[cfg(not(windows))]
const PATH_SEP: char = ':';

/// Build a PATH for spawned agent runtimes that includes common user-level
/// binary directories.
///
/// amuxd is typically launched by launchd (macOS) or systemd (Linux) with a
/// minimal PATH that omits Homebrew, `~/.local/bin`, and the other locations
/// where runtimes like `opencode` and `npx` actually live. Inherited PATH
/// entries keep priority; the well-known directories are appended as
/// fallbacks, and duplicates are removed preserving first occurrence.
pub(crate) fn enriched_spawn_path(existing: Option<&str>, home: Option<&Path>) -> String {
    let mut candidates: Vec<String> = Vec::new();

    if let Some(existing) = existing {
        candidates.extend(existing.split(PATH_SEP).map(|s| s.to_string()));
    }

    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(format!("{pf}\\nodejs"));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\npm"));
        }
    } else {
        if let Some(home) = home {
            for sub in [
                ".local/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".cargo/bin",
                ".opencode/bin",
            ] {
                candidates.push(home.join(sub).to_string_lossy().into_owned());
            }
        }
        for dir in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            candidates.push(dir.to_string());
        }
    }

    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(&PATH_SEP.to_string())
}

#[cfg(test)]
mod spawn_path_tests {
    use super::{enriched_spawn_path, PATH_SEP};
    use std::path::Path;

    #[cfg(not(windows))]
    #[test]
    fn appends_homebrew_and_user_local_to_minimal_path() {
        let path = enriched_spawn_path(
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
            Some(Path::new("/Users/x")),
        );
        let dirs: Vec<&str> = path.split(':').collect();
        assert!(dirs.contains(&"/opt/homebrew/bin"), "{path}");
        assert!(dirs.contains(&"/Users/x/.local/bin"), "{path}");
        assert!(dirs.contains(&"/Users/x/.opencode/bin"), "{path}");
        assert!(path.starts_with("/usr/bin:/bin:/usr/sbin:/sbin"), "{path}");
    }

    #[cfg(not(windows))]
    #[test]
    fn dedupes_existing_entries() {
        let path = enriched_spawn_path(
            Some("/opt/homebrew/bin:/usr/bin"),
            Some(Path::new("/home/u")),
        );
        let count = path
            .split(':')
            .filter(|d| *d == "/opt/homebrew/bin")
            .count();
        assert_eq!(count, 1, "{path}");
    }

    #[test]
    fn uses_platform_path_separator() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(PATH_SEP, sep);
    }
}

#[cfg(test)]
mod pool_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use parking_lot::Mutex;

    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
    use crate::runtime::opencode_http::host_pool::GenerationFactory;
    use crate::runtime::opencode_http::process_registry::ServeProcessRegistry;
    use crate::runtime::opencode_http::supervisor::ShutdownOutcome;

    struct ExitFactory {
        registry: Arc<ServeProcessRegistry>,
        stops: Mutex<Vec<String>>,
        starts: AtomicUsize,
    }

    impl ExitFactory {
        fn new() -> Arc<Self> {
            let registry_path = tempfile::tempdir()
                .expect("temporary process registry")
                .keep()
                .join("opencode-pgids.json");
            Arc::new(Self {
                registry: Arc::new(ServeProcessRegistry::new(registry_path)),
                stops: Mutex::new(Vec::new()),
                starts: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl GenerationFactory for ExitFactory {
        async fn start(
            &self,
            generation_id: String,
            _domain: IsolationDomainKey,
            revision: ProcessEnvRevision,
            env: HashMap<String, String>,
        ) -> Result<Arc<ServeSupervisor>, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(ServeSupervisor::new(
                generation_id,
                Arc::clone(&self.registry),
                env,
                revision,
            )))
        }

        fn stop(&self, generation: &HostGeneration) -> ShutdownOutcome {
            self.stops.lock().push(generation.generation_id.clone());
            ShutdownOutcome::Stopped
        }
    }

    fn exit_test_deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[tokio::test]
    async fn backend_exit_stops_every_pooled_generation() {
        let factory = ExitFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let first = pool
            .acquire(
                IsolationDomainKey::Workspace("exit-a".to_string()),
                ProcessEnvRevision::from_bindings(&HashMap::new()),
                HashMap::new(),
                exit_test_deadline(),
            )
            .await
            .expect("first generation");
        let second = pool
            .acquire(
                IsolationDomainKey::Workspace("exit-b".to_string()),
                ProcessEnvRevision::from_bindings(&HashMap::new()),
                HashMap::new(),
                exit_test_deadline(),
            )
            .await
            .expect("second generation");
        let generations = [
            Arc::clone(&first.generation),
            Arc::clone(&second.generation),
        ];
        let mut backend = crate::runtime::backend::OpencodeHttpBackend::test_with_host(
            OpencodeHost::test_with_pool(pool),
        );

        let removed = crate::runtime::backend::AgentBackend::shutdown_for_exit(&mut backend).await;

        assert_eq!(removed, 2);
        assert_eq!(factory.starts.load(Ordering::SeqCst), 2);
        assert_eq!(factory.stops.lock().len(), 2);
        assert!(generations
            .iter()
            .all(|generation| generation.lifecycle() == host_pool::HostLifecycle::Stopped));
    }

    #[test]
    fn split_and_mime_helpers() {
        assert_eq!(guess_mime("https://x/y/photo.PNG?token=e.y.j"), "image/png");
        assert_eq!(guess_mime("https://x/y/no-ext"), "application/octet-stream");
    }

    fn generation(id: &str) -> Arc<host_pool::HostGeneration> {
        host_pool::HostGeneration::test_for_routing(
            id,
            IsolationDomainKey::Workspace(id.to_string()),
            ProcessEnvRevision::from_bindings(&HashMap::new()),
        )
    }

    fn test_route(directory: &str) -> Route {
        let (event_tx, _event_rx) = mpsc::channel(1);
        Route {
            event_tx,
            permission: PermissionPolicy::Ask,
            directory: directory.to_string(),
            model: None,
            turn_active: false,
            turn_reply_to: None,
            turn_requester: None,
            turn_seq: 0,
            turn_saw_output: false,
            turn_last_event_at: std::time::Instant::now(),
            retry_streak: None,
            tools_in_flight: HashSet::new(),
            translate: TranslateState::default(),
            injected_mcp: Vec::new(),
            last_assistant_message_id: None,
            parent_session_id: None,
        }
    }

    /// Poll `condition` until it holds, then return; fail if it never does.
    ///
    /// This used to spin on `yield_now()` against a 1s budget, and both halves
    /// of that hurt. The spin burns a core for the whole wait, and what these
    /// tests wait on is a real child process starting — so a dozen of them
    /// running at once starve the very spawns they are waiting for. The full
    /// `cargo test -p amuxd` run (1261 tests in parallel, on a machine also
    /// building the desktop app) randomly failed one of these three, while the
    /// same tests passed serially, and passed in parallel once the machine was
    /// idle. Sleeping between polls hands the CPU back to the thing being
    /// waited on.
    ///
    /// 10s is slack for a loaded machine, not license to hang: a command loop
    /// that never reaches the state still fails, just later. Every wait here
    /// is satisfied in microseconds when nothing else is competing.
    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !condition() {
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("command loop did not reach the expected state");
    }

    #[cfg(unix)]
    fn install_blocking_fake_serve(
        generation: &Arc<host_pool::HostGeneration>,
    ) -> (tempfile::TempPath, std::path::PathBuf) {
        let marker = tempfile::NamedTempFile::new()
            .expect("temporary fake-serve marker")
            .into_temp_path();
        let marker_path = marker.to_path_buf();
        std::fs::remove_file(&marker_path).expect("remove initial marker file");
        let mut script = tempfile::NamedTempFile::new().expect("temporary fake-serve script");
        writeln!(
            script,
            "#!/bin/sh\nprintf started > '{}'\nsleep 60",
            marker_path.display()
        )
        .unwrap();
        let mut permissions = script.as_file().metadata().unwrap().permissions();
        permissions.set_mode(0o755);
        script.as_file().set_permissions(permissions).unwrap();
        let script = script.into_temp_path();
        generation
            .serve
            .set_binary_hint(script.to_string_lossy().as_ref());
        (script, marker_path)
    }

    #[tokio::test]
    async fn duplicate_session_commands_stay_on_their_generation() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));
        let a_tx = command_sender_for_generation(Arc::clone(&a));
        let b_tx = command_sender_for_generation(Arc::clone(&b));

        a_tx.send(AcpCommand::SetModel {
            acp_session_id: "ses_same".into(),
            model_id: "provider/model-a".into(),
        })
        .await
        .unwrap();
        b_tx.send(AcpCommand::SetModel {
            acp_session_id: "ses_same".into(),
            model_id: "provider/model-b".into(),
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;

        assert_eq!(
            a.routes.lock()["ses_same"].model.as_ref().unwrap().model_id,
            "model-a"
        );
        assert_eq!(
            b.routes.lock()["ses_same"].model.as_ref().unwrap().model_id,
            "model-b"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn permission_commands_resolve_only_the_sender_generation() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        let (_fake_serve, marker) = install_blocking_fake_serve(&a);
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));
        a.permissions
            .lock()
            .insert("perm-1".into(), "ses_same".into());
        let a_tx = command_sender_for_generation(Arc::clone(&a));
        let b_tx = command_sender_for_generation(Arc::clone(&b));

        b_tx.send(AcpCommand::ResolvePermission {
            request_id: "perm-1".into(),
            granted: true,
            option_id: None,
        })
        .await
        .unwrap();
        b_tx.send(AcpCommand::SetModel {
            acp_session_id: "ses_same".into(),
            model_id: "provider/b-barrier".into(),
        })
        .await
        .unwrap();
        wait_until(|| b.routes.lock()["ses_same"].model.is_some()).await;

        assert_eq!(
            a.permissions.lock().get("perm-1").map(String::as_str),
            Some("ses_same")
        );
        a_tx.send(AcpCommand::ResolvePermission {
            request_id: "perm-1".into(),
            granted: true,
            option_id: None,
        })
        .await
        .unwrap();
        wait_until(|| !a.permissions.lock().contains_key("perm-1")).await;
        wait_until(|| marker.exists()).await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn question_commands_answer_only_the_sender_generation() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        let (_fake_serve, marker) = install_blocking_fake_serve(&a);
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));
        a.questions
            .lock()
            .insert("question-1".into(), "ses_same".into());
        let a_tx = command_sender_for_generation(Arc::clone(&a));
        let b_tx = command_sender_for_generation(Arc::clone(&b));

        b_tx.send(AcpCommand::AnswerQuestion {
            request_id: "question-1".into(),
            answers_json: "[]".into(),
            reject: false,
        })
        .await
        .unwrap();
        b_tx.send(AcpCommand::SetModel {
            acp_session_id: "ses_same".into(),
            model_id: "provider/b-barrier".into(),
        })
        .await
        .unwrap();
        wait_until(|| b.routes.lock()["ses_same"].model.is_some()).await;

        assert_eq!(
            a.questions.lock().get("question-1").map(String::as_str),
            Some("ses_same")
        );
        a_tx.send(AcpCommand::AnswerQuestion {
            request_id: "question-1".into(),
            answers_json: "[]".into(),
            reject: false,
        })
        .await
        .unwrap();
        wait_until(|| !a.questions.lock().contains_key("question-1")).await;
        wait_until(|| marker.exists()).await;
    }

    #[tokio::test]
    async fn detaching_duplicate_session_releases_only_its_generation() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        let a_lease = a.test_route_lease();
        let _b_lease = b.test_route_lease();
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));
        let a_tx = command_sender_for_generation(Arc::clone(&a));
        let (ack_tx, ack_rx) = oneshot::channel();

        a_tx.send(AcpCommand::DetachSession {
            acp_session_id: "ses_same".into(),
            ack: Some(ack_tx),
        })
        .await
        .unwrap();
        ack_rx.await.unwrap();
        drop(a_lease);

        assert!(!a.routes.lock().contains_key("ses_same"));
        assert!(b.routes.lock().contains_key("ses_same"));
        assert_eq!(a.route_count(), 0);
        assert_eq!(b.route_count(), 1);
    }

    #[test]
    fn sse_reconnect_keeps_the_route_generation_supervisor() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));

        assert!(Arc::ptr_eq(
            &events::supervisor_for_route(&a, "ses_same").unwrap(),
            &a.serve
        ));
        assert!(!Arc::ptr_eq(
            &events::supervisor_for_route(&a, "ses_same").unwrap(),
            &b.serve
        ));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn prompt_and_cancel_commands_do_not_mutate_duplicate_route_on_other_generation() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        let (_fake_serve, marker) = install_blocking_fake_serve(&a);
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));
        b.routes.lock().get_mut("ses_same").unwrap().model =
            client::split_model_id("provider/model-b");
        let a_prompt_tx = command_sender_for_generation(Arc::clone(&a));
        let a_cancel_tx = command_sender_for_generation(Arc::clone(&a));

        a_prompt_tx
            .send(AcpCommand::Prompt {
                acp_session_id: "ses_same".into(),
                text: "generation A only".into(),
                attachment_urls: Vec::new(),
                requester_actor_id: Some("actor-a".into()),
                reply_to_message_id: Some("message-a".into()),
            })
            .await
            .unwrap();
        wait_until(|| a.routes.lock()["ses_same"].turn_active).await;
        wait_until(|| marker.exists()).await;
        a_cancel_tx
            .send(AcpCommand::Cancel {
                acp_session_id: "ses_same".into(),
            })
            .await
            .unwrap();
        tokio::task::yield_now().await;

        let routes = b.routes.lock();
        let route = &routes["ses_same"];
        assert!(!route.turn_active);
        assert_eq!(route.turn_seq, 0);
        assert_eq!(route.turn_requester, None);
        assert_eq!(route.turn_reply_to, None);
        assert!(route.tools_in_flight.is_empty());
        assert_eq!(route.model.as_ref().unwrap().model_id, "model-b");
    }

    #[test]
    fn child_routes_remain_in_the_parent_generation() {
        let a = generation("gen-a");
        let b = generation("gen-b");
        a.routes.lock().insert("ses_same".into(), test_route("/a"));
        b.routes.lock().insert("ses_same".into(), test_route("/b"));

        assert!(a.ensure_child_route("ses_child", "ses_same"));
        assert!(a.routes.lock().contains_key("ses_child"));
        assert!(!b.routes.lock().contains_key("ses_child"));
    }

    #[test]
    fn merge_then_prune_mcp_roundtrip_preserves_user_entries() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_string_lossy().into_owned();
        // Pre-existing user config with its own mcp entry.
        std::fs::write(
            dir.path().join("opencode.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "mcp": { "user-server": { "type": "local", "enabled": true, "command": ["u"] } }
            }))
            .unwrap(),
        )
        .unwrap();
        let mcp_cfg = dir.path().join("gateway-mcp.json");
        std::fs::write(
            &mcp_cfg,
            serde_json::json!({
                "mcpServers": { "amuxd-send": { "command": "/bin/amuxd", "args": ["mcp-server"] } }
            })
            .to_string(),
        )
        .unwrap();

        let names = merge_mcp_config_into_worktree(&worktree, &mcp_cfg);
        assert_eq!(names, vec!["amuxd-send".to_string()]);
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(cfg["mcp"]["amuxd-send"].is_object());
        assert!(
            cfg["mcp"]["user-server"].is_object(),
            "key-wise merge keeps user entries"
        );

        prune_mcp_servers_from_worktree(&worktree, &names);
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(
            cfg["mcp"].get("amuxd-send").is_none(),
            "injected entry pruned"
        );
        assert!(
            cfg["mcp"]["user-server"].is_object(),
            "user entry survives prune"
        );
    }

    #[test]
    fn prunable_names_respect_other_sessions_in_same_directory() {
        let mut routes: HashMap<String, Route> = HashMap::new();
        let (tx, _rx) = mpsc::channel(1);
        routes.insert(
            "other".to_string(),
            Route {
                event_tx: tx,
                permission: PermissionPolicy::Full,
                directory: "/ws".to_string(),
                model: None,
                turn_active: false,
                turn_reply_to: None,
                turn_requester: None,
                turn_seq: 0,
                turn_saw_output: false,
                turn_last_event_at: std::time::Instant::now(),
                tools_in_flight: HashSet::new(),
                translate: TranslateState::default(),
                injected_mcp: vec!["amuxd-send".to_string()],
                last_assistant_message_id: None,
                parent_session_id: None,
                retry_streak: None,
            },
        );
        let candidates = vec!["amuxd-send".to_string(), "remote-tools".to_string()];
        let prunable = prunable_mcp_names(&routes, "me", "/ws", &candidates);
        assert_eq!(prunable, vec!["remote-tools".to_string()]);
    }
}

#[cfg(test)]
mod turn_activity_tests {
    use super::*;
    use tokio::sync::mpsc;

    fn test_route(directory: &str) -> Route {
        let (tx, _rx) = mpsc::channel(1);
        Route {
            event_tx: tx,
            permission: PermissionPolicy::Ask,
            directory: directory.to_string(),
            model: None,
            turn_active: true,
            turn_reply_to: None,
            turn_requester: None,
            turn_seq: 1,
            turn_saw_output: false,
            turn_last_event_at: std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(90))
                .unwrap_or_else(std::time::Instant::now),
            tools_in_flight: HashSet::new(),
            translate: TranslateState::default(),
            injected_mcp: Vec::new(),
            last_assistant_message_id: None,
            parent_session_id: None,
            retry_streak: None,
        }
    }

    fn test_generation() -> Arc<HostGeneration> {
        HostGeneration::test_for_routing(
            "turn-tests",
            crate::runtime::execution_context::IsolationDomainKey::Workspace(
                "turn-tests".to_string(),
            ),
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&HashMap::new()),
        )
    }

    #[test]
    fn active_turn_status_check_confirms_running_and_reconciles_idle() {
        let running = active_turn_status_check(client::OpencodeSessionPhase::Running);
        assert!(!running.emit_turn_open);
        assert!(!running.reconcile_stale_idle);

        let idle = active_turn_status_check(client::OpencodeSessionPhase::Idle);
        assert!(idle.emit_turn_open);
        assert!(idle.reconcile_stale_idle);

        let unknown = active_turn_status_check(client::OpencodeSessionPhase::Unknown);
        assert!(!unknown.emit_turn_open);
        assert!(!unknown.reconcile_stale_idle);
    }

    /// A route whose runtime goes away mid-turn must still close the turn, or
    /// the client sits on "replying" forever. Reproduces the app-workspace
    /// re-point: a prompt is in flight when the session is detached and
    /// re-attached against another worktree.
    #[tokio::test]
    async fn a_turn_orphaned_by_detach_is_closed_on_the_old_channel() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut route = test_route("/ws");
        route.event_tx = tx;
        route.turn_active = true;
        route.turn_reply_to = Some("reply-1".to_string());

        let taken = take_active_turn(&mut route);
        assert!(taken.is_some(), "an active turn is taken off the route");
        assert!(!route.turn_active, "the route no longer claims a live turn");
        close_orphaned_turn("ses_1", taken).await;

        let frame = rx.try_recv().expect("close emitted a frame");
        assert_eq!(frame.acp_session_id, "ses_1");
        assert_eq!(frame.turn_reply_to_message_id.as_deref(), Some("reply-1"));
    }

    /// Mid-turn follow-up must not re-emit Idle→Active — the agent is already
    /// active and the frontend treats that transition as a turn boundary.
    #[tokio::test]
    async fn second_prompt_while_turn_active_skips_idle_to_active() {
        let shared = test_generation();
        let (tx, mut rx) = mpsc::channel(8);
        {
            let mut routes = shared.routes.lock();
            let mut route = test_route("/ws");
            route.event_tx = tx.clone();
            route.turn_active = true;
            route.turn_seq = 1;
            route.tools_in_flight.insert("tool-turn1".to_string());
            routes.insert("ses_repro".to_string(), route);
        }

        // Mirror the synchronous head of `do_prompt`.
        let was_turn_active = {
            let routes = shared.routes.lock();
            routes.get("ses_repro").expect("route").turn_active
        };
        let (event_tx, turn_seq, emit_turn_open) = {
            let mut routes = shared.routes.lock();
            let route = routes.get_mut("ses_repro").expect("route");
            let was_turn_active = route.turn_active;
            route.turn_active = true;
            route.turn_seq += 1;
            route.tools_in_flight.clear();
            (route.event_tx.clone(), route.turn_seq, !was_turn_active)
        };
        assert!(was_turn_active);
        assert!(!emit_turn_open);
        if emit_turn_open {
            emit_frame(
                &event_tx,
                "ses_repro",
                translate::status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
                None,
            )
            .await;
        }

        assert!(
            rx.try_recv().is_err(),
            "mid-turn prompt must not emit Idle→Active"
        );

        let routes = shared.routes.lock();
        let route = routes.get("ses_repro").expect("route");
        assert!(route.turn_active);
        assert_eq!(route.turn_seq, turn_seq);
        assert!(route.tools_in_flight.is_empty());
    }

    #[tokio::test]
    async fn an_idle_route_emits_nothing_when_dropped() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut route = test_route("/ws");
        route.event_tx = tx;
        route.turn_active = false;

        let taken = take_active_turn(&mut route);
        assert!(taken.is_none());
        close_orphaned_turn("ses_1", taken).await;
        assert!(rx.try_recv().is_err(), "no spurious idle for an idle route");
    }

    #[test]
    fn ensure_child_route_aliases_parent_delivery_channel() {
        let shared = test_generation();
        {
            let mut routes = shared.routes.lock();
            routes.insert("ses_parent".to_string(), test_route("/ws"));
        }
        assert!(shared.ensure_child_route("ses_child", "ses_parent"));
        let routes = shared.routes.lock();
        let child = routes.get("ses_child").expect("child route");
        let parent = routes.get("ses_parent").expect("parent route");
        assert_eq!(child.parent_session_id.as_deref(), Some("ses_parent"));
        assert_eq!(child.directory, parent.directory);
        assert!(!child.turn_active);
        // Second call is idempotent.
        drop(routes);
        assert!(shared.ensure_child_route("ses_child", "ses_parent"));
    }

    #[test]
    fn child_progress_refreshes_parent_watchdog_clock() {
        let shared = test_generation();
        {
            let mut routes = shared.routes.lock();
            routes.insert("ses_parent".to_string(), test_route("/ws"));
        }
        assert!(shared.ensure_child_route("ses_child", "ses_parent"));
        {
            let mut routes = shared.routes.lock();
            let parent = routes.get_mut("ses_parent").unwrap();
            parent.turn_last_event_at = std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(90))
                .unwrap();
        }
        shared.touch_turn_transport_activity("ses_child");
        let elapsed = shared
            .routes
            .lock()
            .get("ses_parent")
            .unwrap()
            .turn_last_event_at
            .elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "parent turn clock should refresh from child activity"
        );
    }

    #[test]
    fn detach_clears_permissions_for_parent_and_child_routes() {
        let shared = test_generation();
        {
            let mut routes = shared.routes.lock();
            routes.insert("ses_parent".to_string(), test_route("/ws"));
            let parent_tx = routes.get("ses_parent").unwrap().event_tx.clone();
            routes.insert(
                "ses_child".to_string(),
                Route {
                    event_tx: parent_tx,
                    permission: PermissionPolicy::Ask,
                    directory: "/ws".to_string(),
                    model: None,
                    turn_active: false,
                    turn_reply_to: None,
                    turn_requester: None,
                    turn_seq: 0,
                    turn_saw_output: false,
                    turn_last_event_at: std::time::Instant::now(),
                    tools_in_flight: HashSet::new(),
                    translate: TranslateState::default(),
                    injected_mcp: Vec::new(),
                    last_assistant_message_id: None,
                    parent_session_id: Some("ses_parent".to_string()),
                    retry_streak: None,
                },
            );
        }
        {
            let mut perms = shared.permissions.lock();
            perms.insert("perm_parent".to_string(), "ses_parent".to_string());
            perms.insert("perm_child".to_string(), "ses_child".to_string());
            perms.insert("perm_other".to_string(), "ses_other".to_string());
        }
        {
            let mut questions = shared.questions.lock();
            questions.insert("q_parent".to_string(), "ses_parent".to_string());
            questions.insert("q_child".to_string(), "ses_child".to_string());
            questions.insert("q_other".to_string(), "ses_other".to_string());
        }

        {
            let mut routes = shared.routes.lock();
            let mut detached_session_ids = vec!["ses_parent".to_string()];
            routes.retain(|id, route| {
                if route.parent_session_id.as_deref() == Some("ses_parent") {
                    detached_session_ids.push(id.clone());
                    false
                } else {
                    true
                }
            });
            routes.remove("ses_parent");
            shared
                .permissions
                .lock()
                .retain(|_, sid| !detached_session_ids.iter().any(|detached| detached == sid));
            shared
                .questions
                .lock()
                .retain(|_, sid| !detached_session_ids.iter().any(|detached| detached == sid));
        }

        let remaining = shared.permissions.lock();
        assert!(!remaining.contains_key("perm_parent"));
        assert!(!remaining.contains_key("perm_child"));
        assert_eq!(remaining.get("perm_other"), Some(&"ses_other".to_string()));
        let remaining_q = shared.questions.lock();
        assert!(!remaining_q.contains_key("q_parent"));
        assert!(!remaining_q.contains_key("q_child"));
        assert_eq!(remaining_q.get("q_other"), Some(&"ses_other".to_string()));
    }

    #[test]
    fn child_pending_permission_pauses_parent_watchdog_wait() {
        let shared = test_generation();
        {
            let mut routes = shared.routes.lock();
            routes.insert("ses_parent".to_string(), test_route("/ws"));
        }
        assert!(shared.ensure_child_route("ses_child", "ses_parent"));
        assert!(
            !shared.turn_waiting_on_user("ses_parent"),
            "no pending interaction yet"
        );
        shared
            .permissions
            .lock()
            .insert("perm_child".to_string(), "ses_child".to_string());
        assert!(
            shared.turn_waiting_on_user("ses_parent"),
            "child permission should pause parent watchdog"
        );
    }

    #[test]
    fn sync_child_routes_follows_parent_reattach_channel() {
        let shared = test_generation();
        let (tx_old, _rx_old) = mpsc::channel(1);
        let (tx_new, mut rx_new) = mpsc::channel(1);
        {
            let mut routes = shared.routes.lock();
            let mut parent = test_route("/ws");
            parent.event_tx = tx_old;
            routes.insert("ses_parent".to_string(), parent);
        }
        assert!(shared.ensure_child_route("ses_child", "ses_parent"));
        {
            let mut routes = shared.routes.lock();
            routes.get_mut("ses_parent").unwrap().event_tx = tx_new;
        }
        shared.sync_child_routes_from_parent("ses_parent");
        let child_tx = shared
            .routes
            .lock()
            .get("ses_child")
            .unwrap()
            .event_tx
            .clone();
        child_tx
            .try_send(AcpEventFrame::new(
                "ses_child",
                translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            ))
            .expect("child route should use the refreshed parent channel");
        assert!(
            rx_new.try_recv().is_ok(),
            "frame should arrive on the new parent channel"
        );
    }

    #[test]
    fn turn_progress_event_classification() {
        assert!(is_turn_progress_event("message.part.updated"));
        assert!(is_turn_progress_event("message.part.delta"));
        assert!(is_turn_progress_event("session.status"));
        assert!(is_turn_progress_event("session.error"));
        assert!(!is_turn_progress_event("session.updated"));
        assert!(!is_turn_progress_event("session.idle"));
    }

    #[test]
    fn deduped_tool_running_still_refreshes_transport_clock() {
        let shared = test_generation();
        let running = serde_json::json!({"sessionID":"ses_1","part":{
            "id":"prt_t","messageID":"msg_a1","sessionID":"ses_1","type":"tool",
            "callID":"call_1","tool":"bash",
            "state":{"status":"running","input":{"command":"sleep 300"},"title":"Sleep","time":{"start":1}}
        },"time":1.0});
        {
            let mut routes = shared.routes.lock();
            routes.insert("ses_1".to_string(), test_route("/ws"));
        }
        let mut state = TranslateState::default();
        let props = running.clone();
        let first = translate::translate_event(&mut state, "message.part.updated", &props);
        assert_eq!(first.len(), 1, "first running update should emit ToolUse");
        let second = translate::translate_event(&mut state, "message.part.updated", &props);
        assert!(second.is_empty(), "identical running update is deduped");

        shared.touch_turn_transport_activity("ses_1");
        let elapsed = shared
            .routes
            .lock()
            .get("ses_1")
            .unwrap()
            .turn_last_event_at
            .elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "transport touch should refresh watchdog clock even when translate dedupes"
        );
    }

    #[test]
    fn sse_reconnect_pauses_watchdog_until_subscribed() {
        let shared = test_generation();
        let dir = "/ws";
        assert!(shared.sse_watchdog_paused(dir));

        shared.mark_sse_connected(dir);
        assert!(!shared.sse_watchdog_paused(dir));

        shared.mark_sse_disconnected(dir);
        assert!(shared.sse_watchdog_paused(dir));
    }

    #[test]
    fn sse_reconnect_refreshes_active_turn_clocks_for_directory() {
        let shared = test_generation();
        {
            let mut routes = shared.routes.lock();
            routes.insert("ses_1".to_string(), test_route("/ws"));
            routes.insert(
                "ses_2".to_string(),
                Route {
                    turn_active: false,
                    ..test_route("/ws")
                },
            );
            routes.insert(
                "ses_3".to_string(),
                Route {
                    directory: "/other".to_string(),
                    ..test_route("/other")
                },
            );
        }
        shared.mark_sse_connected("/ws");
        let elapsed = shared
            .routes
            .lock()
            .get("ses_1")
            .unwrap()
            .turn_last_event_at
            .elapsed();
        assert!(elapsed < std::time::Duration::from_secs(2));
        let idle_elapsed = shared
            .routes
            .lock()
            .get("ses_2")
            .unwrap()
            .turn_last_event_at
            .elapsed();
        assert!(idle_elapsed >= std::time::Duration::from_secs(80));
    }
}
