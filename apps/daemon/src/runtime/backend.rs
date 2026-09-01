//! Backend-neutral local agent runtime abstraction.
//!
//! `RuntimeManager` talks to a local agent runtime (today: the global
//! `opencode serve` HTTP backend in `runtime/opencode_http/`; future: the pi
//! RPC backend, see `docs/architecture/pi-agent-backend.md`) exclusively
//! through the [`AgentBackend`] trait. The per-session channel types
//! ([`AcpCommand`], [`AcpStartupMetadata`], and `AcpEventFrame` in
//! `runtime/acp_event_frame.rs`) are shared across backends and therefore
//! live here rather than inside a specific backend module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use crate::runtime::permission_policy::PermissionPolicy;

use super::manager::AgentLaunchConfig;
use super::opencode_http::OpencodeHost;

// ---------------------------------------------------------------------------
// Shared channel types (backend-neutral)
// ---------------------------------------------------------------------------

/// Commands the runtime manager sends to a local agent backend.
pub enum AcpCommand {
    /// Create or resume an agent session for a worktree.
    AttachSession {
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        /// Daemon MRU, newest first. Consulted only when nothing more
        /// specific resolves; every entry is availability-checked.
        model_mru: Vec<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
        /// How this session handles permission + question requests.
        permission: PermissionPolicy,
        /// When resuming, fail instead of falling back to a new session.
        forbid_new_session_fallback: bool,
        /// TeamClu cloud session this attachment belongs to.
        teamclu_session_id: String,
    },
    /// Drop routing state for a session; the backend process keeps running.
    DetachSession {
        acp_session_id: String,
        /// Completed after backend routing state is actually removed.
        ack: Option<oneshot::Sender<()>>,
    },
    /// Send a prompt to a bound session (async; turn ends on idle).
    Prompt {
        acp_session_id: String,
        text: String,
        attachment_urls: Vec<String>,
        /// Human actor that started this turn; stamped onto PermissionRequest params.
        requester_actor_id: Option<String>,
        /// User message id that triggered this turn; stamped onto AgentReply emits.
        reply_to_message_id: Option<String>,
    },
    /// Cancel the current turn for a bound session.
    Cancel { acp_session_id: String },
    /// Resolve a pending permission request (any session).
    ResolvePermission {
        request_id: String,
        granted: bool,
        /// "always" upgrades the grant; anything else (or None) means "once".
        option_id: Option<String>,
    },
    /// Answer (or reject) an opencode `question` tool request (any session).
    AnswerQuestion {
        request_id: String,
        /// JSON `[[selected labels], ...]` — one array per question, in order.
        answers_json: String,
        reject: bool,
    },
    /// Switch the model used by a bound session (applied on the next prompt).
    SetModel {
        acp_session_id: String,
        model_id: String,
    },
    /// Shut down the backend process (it respawns lazily on next use).
    #[allow(dead_code)]
    Shutdown,
}

#[derive(Debug)]
pub struct AcpStartupMetadata {
    pub available_models: Vec<amux::ModelInfo>,
    pub initial_model: Option<String>,
    pub acp_session_id: String,
    pub host_generation_id: String,
    pub(crate) route_lease: Option<super::opencode_http::host_pool::RouteLease>,
}

impl AcpStartupMetadata {
    pub(crate) fn with_route_lease(
        mut self,
        route_lease: super::opencode_http::host_pool::RouteLease,
    ) -> Self {
        self.route_lease = Some(route_lease);
        self
    }
}

/// Inputs for lazy thread fork at first runtimeStart on a thread session.
#[derive(Debug, Clone)]
pub struct ForkSpec {
    pub parent_acp_session_id: String,
    pub parent_teamclu_session_id: String,
    pub root_message_id: String,
    pub worktree: String,
    pub fork_leaf_id: Option<String>,
    /// opencode `messageID` (`^msg…`) for `POST /session/{id}/fork`.
    pub fork_opencode_message_id: Option<String>,
    pub isolation_domain: IsolationDomainKey,
    pub process_env_revision: ProcessEnvRevision,
    pub extra_env: HashMap<String, String>,
    pub force_env_override: bool,
}

// ---------------------------------------------------------------------------
// AgentBackend trait
// ---------------------------------------------------------------------------

/// Local agent runtime backend surface consumed by `RuntimeManager`.
///
/// Mirrors the historical `OpencodeHost` API one-to-one so the opencode HTTP
/// backend is a zero-behavior-change adaptation; a future pi RPC backend
/// implements the same surface.
#[async_trait]
pub trait AgentBackend: Send {
    /// Bind a TeamClu runtime to a backend session (create or resume).
    #[allow(clippy::too_many_arguments)]
    async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        model_mru: Vec<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        permission: PermissionPolicy,
        forbid_new_session_fallback: bool,
        teamclu_session_id: String,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)>;

    /// Pre-warm: start the backend process ahead of the first session.
    async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>);

    /// Pre-warm with a real session env (merged into the backend process env
    /// on its next spawn) and, when a worktree is known, its event stream.
    async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    );

    async fn prewarm_workspace(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: &str,
    ) {
        let _ = (isolation_domain, process_env_revision);
        self.prewarm_with_env(
            launch_configs,
            extra_env,
            force_env_override,
            Some(worktree),
        )
        .await;
    }

    /// Invalidate backend processes for the given agent types so new sessions
    /// pick up provider auth/config changes. Returns the number removed.
    fn evict_agent_types(&mut self, agent_types: &[amux::AgentType]) -> usize;

    fn invalidate_workspace_host(&mut self, _domain: &IsolationDomainKey) -> bool {
        self.evict_agent_types(&[amux::AgentType::Opencode]) > 0
    }

    fn invalidate_all_workspace_hosts(&mut self) -> usize {
        self.evict_agent_types(&[amux::AgentType::Opencode])
    }

    /// Permanently retire backend processes and background tasks during daemon exit.
    async fn shutdown_for_exit(&mut self) -> usize {
        self.evict_agent_types(&[
            amux::AgentType::Opencode,
            amux::AgentType::Pi,
            amux::AgentType::Cursor,
            amux::AgentType::ClaudeCode,
        ])
    }

    /// Number of live backend processes.
    fn host_count(&self) -> usize;

    /// Model catalog for a workspace directory (cron catalog UI).
    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>>;

    async fn model_catalog_for_context(
        &mut self,
        workspace_path: &Path,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let _ = (isolation_domain, process_env_revision, extra_env);
        self.model_catalog(workspace_path).await
    }

    fn opencode_host_pool(
        &self,
    ) -> Option<std::sync::Arc<super::opencode_http::host_pool::OpenCodeHostPool>> {
        None
    }

    fn attach_context_service(
        &mut self,
        _service: std::sync::Arc<super::context_service::RuntimeContextService>,
    ) {
    }

    /// Fork a backend session at an anchor message (thread lazy attach).
    /// Pi implements via `createBranchedSession`; other backends may override
    /// or return an error until implemented.
    async fn fork_session_at(&mut self, spec: ForkSpec) -> crate::error::Result<String> {
        let _ = spec;
        Err(crate::error::AmuxError::Agent(
            "fork_session_at not supported for this backend".into(),
        ))
    }

    /// Latest pi leaf entry id after a completed turn (for thread fork metadata).
    fn completed_turn_leaf_id(&self, _acp_session_id: &str) -> Option<String> {
        None
    }

    /// Latest opencode assistant `messageID` after a completed turn (thread fork anchor).
    fn completed_turn_opencode_message_id(&self, _acp_session_id: &str) -> Option<String> {
        None
    }
}

// ---------------------------------------------------------------------------
// OpencodeHttpBackend — thin adapter over the existing OpencodeHost
// ---------------------------------------------------------------------------

/// The opencode serve HTTP backend (`runtime/opencode_http/`) behind the
/// backend-neutral trait.
pub struct OpencodeHttpBackend {
    host: OpencodeHost,
}

impl OpencodeHttpBackend {
    pub fn new() -> Self {
        Self {
            host: OpencodeHost::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_with_host(host: OpencodeHost) -> Self {
        Self { host }
    }

    pub fn attach_context_service(
        &mut self,
        service: std::sync::Arc<super::context_service::RuntimeContextService>,
    ) {
        self.host.attach_context_service(service);
    }
}

impl Default for OpencodeHttpBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentBackend for OpencodeHttpBackend {
    fn attach_context_service(
        &mut self,
        service: std::sync::Arc<super::context_service::RuntimeContextService>,
    ) {
        self.host.attach_context_service(service);
    }

    async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        model_mru: Vec<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        permission: PermissionPolicy,
        forbid_new_session_fallback: bool,
        teamclu_session_id: String,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        self.host
            .attach_session(
                agent_type,
                launch,
                isolation_domain,
                process_env_revision,
                extra_env,
                force_env_override,
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                model_mru,
                initial_prompt,
                event_tx,
                permission,
                forbid_new_session_fallback,
                teamclu_session_id,
            )
            .await
    }

    async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        self.host.prewarm(launch_configs).await;
    }

    async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        self.host
            .prewarm_with_env(launch_configs, extra_env, force_env_override, worktree)
            .await;
    }

    async fn prewarm_workspace(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: &str,
    ) {
        self.host
            .prewarm_workspace(
                launch_configs,
                isolation_domain,
                process_env_revision,
                extra_env,
                force_env_override,
                worktree,
            )
            .await;
    }

    fn evict_agent_types(&mut self, agent_types: &[amux::AgentType]) -> usize {
        self.host.evict_agent_types(agent_types)
    }

    fn invalidate_workspace_host(&mut self, domain: &IsolationDomainKey) -> bool {
        self.host.invalidate_workspace_host(domain)
    }

    fn invalidate_all_workspace_hosts(&mut self) -> usize {
        self.host.invalidate_all_workspace_hosts()
    }

    async fn shutdown_for_exit(&mut self) -> usize {
        self.host.shutdown_for_exit().await
    }

    fn host_count(&self) -> usize {
        self.host.host_count()
    }

    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        self.host.model_catalog(workspace_path).await
    }

    async fn model_catalog_for_context(
        &mut self,
        workspace_path: &Path,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        self.host
            .model_catalog_for_context(
                workspace_path,
                isolation_domain,
                process_env_revision,
                extra_env,
            )
            .await
    }

    fn opencode_host_pool(
        &self,
    ) -> Option<std::sync::Arc<super::opencode_http::host_pool::OpenCodeHostPool>> {
        Some(self.host.pool())
    }

    async fn fork_session_at(&mut self, spec: ForkSpec) -> crate::error::Result<String> {
        self.host.fork_session_at(spec).await
    }

    fn completed_turn_opencode_message_id(&self, acp_session_id: &str) -> Option<String> {
        self.host.completed_turn_opencode_message_id(acp_session_id)
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/// The agent type `agents.local_agent` selects, normalized to the backend that
/// [`create_backend`] will *actually* build.
///
/// This is deliberately the only place the config string is interpreted, and
/// [`create_backend`] dispatches on its result, so "what type are we running"
/// and "which backend did we build" can never disagree. They used to: this
/// function's job was previously spread between `create_backend`'s string match
/// and `RuntimeManager::default_agent_type`'s `launch_configs` probing, and the
/// two gave different answers for pi, cursor, and two of claude's three aliases.
///
/// `codex` maps to opencode on purpose — there is no codex backend module and no
/// arm to build one, so a codex-configured daemon runs opencode. Reporting
/// `Codex` here would be a lie the rest of the system then acts on.
pub fn agent_type_for_local_agent(local_agent: &str) -> amux::AgentType {
    match local_agent {
        "pi" => amux::AgentType::Pi,
        "cursor" => amux::AgentType::Cursor,
        // All three spellings accepted by `config::runtime_resolution` land on
        // the claude backend; previously only the bare "claude" did, and the
        // other two silently ran opencode.
        "claude" | "claude-code" | "claude_code" => amux::AgentType::ClaudeCode,
        "opencode" => amux::AgentType::Opencode,
        other => {
            warn!(
                local_agent = other,
                "unknown or unimplemented agents.local_agent; falling back to opencode"
            );
            amux::AgentType::Opencode
        }
    }
}

/// Build the local agent backend selected by daemon config
/// (`agents.local_agent`; default "opencode").
pub fn create_backend(local_agent: &str) -> Box<dyn AgentBackend> {
    match agent_type_for_local_agent(local_agent) {
        amux::AgentType::Pi => Box::new(super::pi_rpc::PiRpcBackend::new()),
        amux::AgentType::Cursor => Box::new(super::cursor_sdk::CursorSdkBackend::new()),
        amux::AgentType::ClaudeCode => Box::new(super::claude_agent::ClaudeAgentBackend::new()),
        _ => Box::new(OpencodeHttpBackend::new()),
    }
}

#[cfg(test)]
mod agent_type_tests {
    use super::*;

    #[test]
    fn every_implemented_backend_maps_to_its_own_agent_type() {
        assert_eq!(
            agent_type_for_local_agent("opencode"),
            amux::AgentType::Opencode
        );
        assert_eq!(agent_type_for_local_agent("pi"), amux::AgentType::Pi);
        assert_eq!(
            agent_type_for_local_agent("cursor"),
            amux::AgentType::Cursor
        );
    }

    #[test]
    fn all_three_claude_spellings_reach_the_claude_backend() {
        // Only the bare "claude" used to match, so `local_agent = "claude-code"`
        // — a spelling `config::runtime_resolution` accepts — silently built the
        // opencode backend instead.
        for name in ["claude", "claude-code", "claude_code"] {
            assert_eq!(
                agent_type_for_local_agent(name),
                amux::AgentType::ClaudeCode,
                "{name} should select the claude backend"
            );
        }
    }

    #[test]
    fn codex_and_unknown_names_normalize_to_opencode() {
        // There is no codex arm in `create_backend`; reporting Codex would name a
        // runtime that never starts.
        assert_eq!(
            agent_type_for_local_agent("codex"),
            amux::AgentType::Opencode
        );
        assert_eq!(
            agent_type_for_local_agent("typo-here"),
            amux::AgentType::Opencode
        );
    }
}
