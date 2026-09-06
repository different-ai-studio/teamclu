//! Shared application state for the HTTP layer.
//!
//! `HttpState` is the single `Arc`-wrapped bundle the axum router hangs
//! every handler off. Keep it small and trait-object-friendly: handlers
//! that need fine-grained pieces extract from this struct rather than
//! introducing parallel statics.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::backend::Backend;
use crate::config::workspace_control::WorkspaceControlStore;
use crate::config::HttpConfig;

use super::limit::RateLimiter;
use super::runtime_adapter::RuntimeAdapter;
use super::sessions::{IdempotencyCache, SessionOwnerIndex};
use super::tokens::TokenStore;

/// Request to register a workspace into the cloud `amux.workspaces` table
/// (the sole source of truth), idempotently.
///
/// The HTTP `POST /v1/workspaces` handler cannot upsert directly — the
/// daemon actor loop owns all cloud writes, so a concurrent upsert from the
/// HTTP task would race the actor. Instead the handler sends this request to
/// the actor loop (via the same command channel that backs the Unix control
/// socket) and waits on `reply_tx` for a single JSON line:
/// `{"ok":true,"result":{workspace}}` or `{"ok":false,"error":...}`.
pub struct RegisterWorkspaceRequest {
    /// Absolute workspace path to register (e.g. `~/.amuxd/teams/<teamId>`
    /// already expanded by the caller).
    pub path: String,
    pub reply_tx: oneshot::Sender<String>,
}

/// Producer side of the register-workspace bridge handed to `HttpState`.
pub type RegisterWorkspaceTx = mpsc::Sender<RegisterWorkspaceRequest>;

/// One local RPC dispatch (`POST /v1/rpc`) forwarded to the daemon actor
/// loop. `payload` is the exact `teamclu.RpcRequest` protobuf bytes a client
/// would otherwise publish to `amux/{team}/{actor}/rpc/req`; `reply_tx`
/// carries back the encoded `teamclu.RpcResponse` bytes (the same bytes the
/// MQTT reply would carry) or a dispatch error string.
pub struct LocalRpcRequest {
    pub payload: Vec<u8>,
    pub reply_tx: oneshot::Sender<Result<Vec<u8>, String>>,
}

/// Producer side of the local RPC bridge handed to `HttpState`.
pub type LocalRpcTx = mpsc::Sender<LocalRpcRequest>;

/// One local session/live ingest (`POST /v1/session-live/ingest`) forwarded to
/// the daemon actor loop. `payload` is the exact `teamclu.LiveEventEnvelope`
/// protobuf bytes a client would otherwise publish to
/// `amux/{team}/session/{id}/live`; the actor runs the same
/// `route_session_message` sink the MQTT path uses (message_id dedup included).
pub struct LocalLiveIngestRequest {
    pub session_id: String,
    pub payload: Vec<u8>,
    pub reply_tx: oneshot::Sender<Result<(), String>>,
}

/// Producer side of the local live-ingest bridge handed to `HttpState`.
pub type LocalLiveIngestTx = mpsc::Sender<LocalLiveIngestRequest>;

/// Process metadata surfaced via `/v1/info`. Filled in at startup and
/// treated as immutable thereafter.
#[derive(Debug, Clone)]
pub struct DaemonMetadata {
    pub version: &'static str,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub actor_id: String,
    pub backend_kind: String,
    /// This machine's stable id (`~/.amuxd/device-id`). Surfaced via `/v1/info`
    /// so the desktop can ask the Cloud API for the agent bound to this machine
    /// (`POST /v1/teams/:id/agents/ensure-for-device`) — the daemon owns the id
    /// but cannot make that call itself, having no cloud session before it is
    /// onboarded.
    pub device_id: String,
    /// Agent backends this daemon has configured (subset of
    /// `["claude", "opencode", "codex"]`), as reported by
    /// `supported_agent_type_names`. Drives the per-backend model catalog
    /// (`GET /v1/workspaces/:id/model-catalog`). Empty in focused tests that
    /// build metadata via `metadata()` without daemon config.
    pub configured_agent_types: Vec<String>,
    /// Live status of the background "advertise agent_types to the cloud"
    /// task. Shared (interior-mutable) so the task can record the outcome and
    /// `/v1/info` can surface a failure instead of swallowing it in a log line.
    pub agent_types_advertise: Arc<parking_lot::Mutex<AgentTypesAdvertise>>,
    /// Whether the daemon's MQTT connection is currently established.
    /// Updated by the MQTT event loop; surfaced via `/v1/info`.
    pub mqtt_connected: Arc<AtomicBool>,
    /// Generation-independent MQTT recovery signal exposed only to the local
    /// daemon HTTP adapter. The receiver is attached when the supervisor starts.
    pub mqtt_recovery: Option<crate::mqtt::MqttRecoveryHandle>,
    /// A single coherent MQTT status snapshot for `/v1/info`.
    pub mqtt_snapshot: crate::mqtt::MqttSnapshotHandle,
}

/// Outcome of the cloud `agents.agent_types` advertise. Surfaced via
/// `/v1/info` so a denied/failed advertise (e.g. RLS or permission error) is
/// visible to the desktop instead of only living in a daemon log line.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypesAdvertise {
    /// True once the advertise has succeeded at least once this run.
    pub advertised: bool,
    /// The last advertise error (cleared on success). `None` while pending or
    /// after a success.
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct HttpState {
    pub config: Arc<HttpConfig>,
    pub tokens: TokenStore,
    pub meta: Arc<DaemonMetadata>,
    pub runtime: Arc<dyn RuntimeAdapter>,
    pub session_index: Arc<SessionOwnerIndex>,
    pub idempotency: Arc<IdempotencyCache>,
    pub limiter: Arc<RateLimiter>,
    /// Shared outbound HTTP client for `/v1/ai/*`. One per state rather than
    /// one per request: a fresh `reqwest::Client` builds its own connection
    /// pool and TLS session cache, so per-request construction would add a
    /// full handshake to every completion.
    pub http_client: reqwest::Client,
    /// Workspace configuration control (providers, permissions, allowlist).
    /// `None` when the HTTP server is started without a workspace control
    /// store (e.g. in focused unit tests). Workspace routes return 404 in
    /// that case.
    pub workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
    pub runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
    /// Workspace refresh state shared with `/v1/workspaces/:id/runtime*`.
    pub runtime_refresh: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    pub refresh_watch_registry:
        Option<Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
    /// Daemon-owned team sync dispatcher (drives `/v1/team/sync*`).
    pub sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    /// Bridge to the daemon actor loop for `POST /v1/workspaces`. `None` when
    /// the HTTP server runs without a daemon actor behind it (focused tests) —
    /// the route then returns 503.
    pub register_workspace_tx: Option<RegisterWorkspaceTx>,
    /// The cloud backend this daemon authenticates against, used by `/v1/info`
    /// to surface cloud-auth health (`cloud_auth_health()`). `None` in focused
    /// HTTP tests and for backends with no remote auth surface.
    pub backend: Option<Arc<dyn Backend>>,
    /// Local fast-path live-event tee (`GET /v1/live/events`). Mirrors every
    /// session/live MQTT publish (identical bytes incl. event_id). `None` in
    /// focused tests — the route then returns 503.
    pub live_tee: Option<tokio::sync::broadcast::Sender<super::live_events::LiveTeeEvent>>,
    /// Shared, TTL-cached resolver for the team's cloud managed LLM. The daemon
    /// and HTTP listener must hold the same `Arc` so provider reads and runtime
    /// assemble write one `provider.team`. `None` in focused tests — the
    /// reconcile is then skipped, unless spawn built a fallback from `backend`.
    pub managed_llm: Option<Arc<crate::runtime::managed_llm::ManagedLlmResolver>>,
    /// Mirrors team MCP / team env from the Cloud API onto the daemon-owned
    /// cache under `~/.amuxd/teams/<id>/cloud/`. Shared with the background
    /// tick so a post-write `POST /v1/team/cloud-config/reconcile` and the
    /// periodic poll share one TTL/`last_fetch`. `None` in focused tests.
    pub team_cloud: Option<Arc<crate::runtime::team_cloud_config::TeamCloudConfigResolver>>,
    /// Materialises the skills assigned to this daemon's agent. The loopback
    /// management API and the periodic task share this instance so both use
    /// the daemon-owned backend/token state and the same reconcile cadence.
    pub team_skills: Option<Arc<crate::runtime::team_skills::TeamSkillReconciler>>,
    /// `daemon.toml` path backing `/v1/config/*`. `None` in focused tests —
    /// those routes then return 503.
    pub config_path: Option<std::path::PathBuf>,
    /// Bridge to the daemon actor loop for `POST /v1/config/reload`, which
    /// restarts the channel manager. Mirrors `register_workspace_tx`: the HTTP
    /// task cannot touch the channel manager, since the actor loop owns it.
    pub channel_reload_tx: Option<mpsc::Sender<()>>,
    /// Onboarding backing `/v1/setup/*`. A trait, not the DeferredBackend
    /// itself, so this module stays usable from the `#[path]`-included test
    /// crates that have no daemon module tree.
    pub onboarding: Option<Arc<dyn super::setup::OnboardingService>>,
    /// Bridge to the daemon actor loop for `POST /v1/rpc` — the local
    /// fast-path twin of the MQTT `rpc/req` topic. `None` in focused tests
    /// and when the HTTP server runs without a daemon actor behind it; the
    /// route then returns 503.
    pub local_rpc_tx: Option<LocalRpcTx>,
    /// Bridge to the daemon actor loop for `POST /v1/session-live/ingest` —
    /// local twin of publishing to `session/{id}/live`. `None` in focused
    /// tests / when no actor loop is attached; the route then returns 503.
    pub local_live_ingest_tx: Option<LocalLiveIngestTx>,
    /// Backend session → TeamClu session registry for managed MCP adapters.
    pub runtime_context: Option<Arc<crate::runtime::context_service::RuntimeContextService>>,
    /// Per-session group-chat system prompt for managed backends (Pi v1).
    pub session_prompt: Option<Arc<crate::runtime::session_prompt::SessionPromptService>>,
}

impl HttpState {
    // sync_dispatcher was added in the daemon-owns-team-sync pass; constructor
    // is intentionally wide to avoid a builder while the field set is stable.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: HttpConfig,
        tokens: TokenStore,
        meta: DaemonMetadata,
        runtime: Arc<dyn RuntimeAdapter>,
        workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
        runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
        sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
        register_workspace_tx: Option<RegisterWorkspaceTx>,
    ) -> Self {
        let runtime_refresh = runtime_supervisor
            .as_ref()
            .map(|supervisor| supervisor.refresh_coordinator());
        Self {
            config: Arc::new(config),
            tokens,
            meta: Arc::new(meta),
            runtime,
            session_index: SessionOwnerIndex::new(),
            idempotency: IdempotencyCache::new(),
            limiter: RateLimiter::new(),
            // No global timeout: a long completion legitimately streams for
            // minutes, and the client hanging up is what cancels it.
            http_client: reqwest::Client::builder()
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            workspace_control,
            runtime_supervisor,
            runtime_refresh,
            refresh_watch_registry: None,
            sync_dispatcher,
            register_workspace_tx,
            backend: None,
            live_tee: None,
            managed_llm: None,
            team_cloud: None,
            team_skills: None,
            config_path: None,
            channel_reload_tx: None,
            onboarding: None,
            local_rpc_tx: None,
            local_live_ingest_tx: None,
            runtime_context: None,
            session_prompt: None,
        }
    }

    pub fn with_runtime_context(
        mut self,
        service: Arc<crate::runtime::context_service::RuntimeContextService>,
    ) -> Self {
        self.runtime_context = Some(service);
        self
    }

    pub fn with_session_prompt(
        mut self,
        service: Option<Arc<crate::runtime::session_prompt::SessionPromptService>>,
    ) -> Self {
        self.session_prompt = service;
        self
    }

    /// Attach the daemon-level config surface (`/v1/config/*`, `/v1/setup/*`).
    /// Chained after `new()` to keep the (already wide) constructor stable.
    pub fn with_config_admin(
        mut self,
        config_path: Option<std::path::PathBuf>,
        channel_reload_tx: Option<mpsc::Sender<()>>,
        onboarding: Option<Arc<dyn super::setup::OnboardingService>>,
    ) -> Self {
        self.config_path = config_path;
        self.channel_reload_tx = channel_reload_tx;
        self.onboarding = onboarding;
        self
    }

    /// Attach the cloud backend so `/v1/info` can report cloud-auth health.
    /// Chained after `new()` to keep the (already wide) constructor stable.
    pub fn with_backend(mut self, backend: Option<Arc<dyn Backend>>) -> Self {
        self.backend = backend;
        self
    }

    /// Attach the shared managed-LLM resolver so provider reads reconcile
    /// `provider.team` against the team's current cloud config.
    pub fn with_managed_llm(
        mut self,
        managed_llm: Option<Arc<crate::runtime::managed_llm::ManagedLlmResolver>>,
    ) -> Self {
        self.managed_llm = managed_llm;
        self
    }

    /// Attach the shared team-cloud (MCP/env) cache resolver.
    pub fn with_team_cloud(
        mut self,
        team_cloud: Option<Arc<crate::runtime::team_cloud_config::TeamCloudConfigResolver>>,
    ) -> Self {
        self.team_cloud = team_cloud;
        self
    }

    /// Attach the shared team-skill reconciler.
    pub fn with_team_skills(
        mut self,
        team_skills: Option<Arc<crate::runtime::team_skills::TeamSkillReconciler>>,
    ) -> Self {
        self.team_skills = team_skills;
        self
    }

    pub fn with_refresh_watch_registry(
        mut self,
        registry: Option<Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
    ) -> Self {
        self.refresh_watch_registry = registry;
        self
    }

    /// Attach the local RPC bridge (enables `POST /v1/rpc`).
    pub fn with_local_rpc(mut self, tx: Option<LocalRpcTx>) -> Self {
        self.local_rpc_tx = tx;
        self
    }

    /// Attach the local live-ingest bridge (enables `POST /v1/session-live/ingest`).
    pub fn with_local_live_ingest(mut self, tx: Option<LocalLiveIngestTx>) -> Self {
        self.local_live_ingest_tx = tx;
        self
    }

    /// Attach the local live-event tee (enables `GET /v1/live/events`).
    pub fn with_live_tee(
        mut self,
        tee: Option<tokio::sync::broadcast::Sender<super::live_events::LiveTeeEvent>>,
    ) -> Self {
        self.live_tee = tee;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_types_advertise_serializes_camel_case() {
        let s = AgentTypesAdvertise {
            advertised: false,
            last_error: Some("permission denied".into()),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["advertised"], serde_json::json!(false));
        assert_eq!(v["lastError"], serde_json::json!("permission denied"));
    }

    #[test]
    fn advertise_status_is_shared_through_metadata_clone() {
        // The advertise task holds one clone of the Arc; `/v1/info` reads it
        // through `meta`. A write on one handle must be visible on the other,
        // otherwise a failed advertise would never surface.
        let shared = Arc::new(parking_lot::Mutex::new(AgentTypesAdvertise::default()));
        let via_meta = shared.clone();
        shared.lock().last_error = Some("update did not apply".into());
        assert_eq!(
            via_meta.lock().last_error.as_deref(),
            Some("update did not apply")
        );
        assert!(!via_meta.lock().advertised);
    }
}
