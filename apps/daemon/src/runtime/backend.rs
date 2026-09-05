//! Backend-neutral local agent runtime abstraction.
//!
//! `RuntimeManager` talks to the pi RPC backend exclusively through the
//! [`AgentBackend`] trait. Shared channel types ([`AcpCommand`],
//! [`AcpStartupMetadata`], and `AcpEventFrame` in `runtime/acp_event_frame.rs`)
//! live here rather than inside a specific backend module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use crate::runtime::permission_policy::PermissionPolicy;

use super::manager::AgentLaunchConfig;

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
        #[allow(dead_code)]
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
}

/// Inputs for lazy thread fork at first runtimeStart on a thread session.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ForkSpec {
    pub parent_acp_session_id: String,
    pub parent_teamclu_session_id: String,
    pub root_message_id: String,
    pub worktree: String,
    pub fork_leaf_id: Option<String>,
    pub isolation_domain: IsolationDomainKey,
    pub process_env_revision: ProcessEnvRevision,
    pub extra_env: HashMap<String, String>,
    pub force_env_override: bool,
}

// ---------------------------------------------------------------------------
// AgentBackend trait
// ---------------------------------------------------------------------------

/// Local agent runtime backend surface consumed by `RuntimeManager`.
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

    fn invalidate_workspace_host(&mut self, domain: &IsolationDomainKey) -> bool;

    fn invalidate_all_workspace_hosts(&mut self) -> usize;

    /// Permanently retire backend processes and background tasks during daemon exit.
    async fn shutdown_for_exit(&mut self) -> usize;

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

    /// pi provider auth — the settings pane's `/login`, `/logout`, catalog
    /// refresh and custom-provider edits, forwarded to a pi host as one
    /// `auth_*` command.
    async fn pi_auth_request(
        &mut self,
        workspace_path: &Path,
        request: serde_json::Value,
    ) -> crate::error::Result<serde_json::Value> {
        let _ = (workspace_path, request);
        Err(crate::error::AmuxError::Agent(
            "pi provider auth is only available when the local agent is pi".into(),
        ))
    }

    fn attach_context_service(
        &mut self,
        _service: std::sync::Arc<super::context_service::RuntimeContextService>,
    ) {
    }

    /// Fork a backend session at an anchor message (thread lazy attach).
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
}

/// Build the local agent backend. pi is the only runtime (#1247).
pub fn create_backend() -> Box<dyn AgentBackend> {
    Box::new(super::pi_rpc::PiRpcBackend::new())
}
