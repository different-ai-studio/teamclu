//! Claude Agent SDK backend (`claude-bridge` + `@anthropic-ai/claude-agent-sdk`).
//!
//! Peer of `runtime/cursor_sdk/` behind [`AgentBackend`]: one Node sidecar per
//! worktree (JSONL over stdin/stdout), sessions keyed as `claude:<sdkSessionId>`.
//!
//! Two things it gets for free that the other sidecar backend does not:
//!
//! * **Permissions** are an in-process `canUseTool` callback, so approval is a
//!   plain event on the existing stream — no hooks file, no socket callback.
//! * **`setModel`** is a real control-protocol call, so a model switch actually
//!   takes effect instead of only updating bookkeeping.
//!
//! The bridge owns a second session identifier (`sessionKey`) because the SDK's
//! own `session_id` only exists after `system/init` arrives, while events start
//! The bridge owns a second session identifier (`sessionKey`) because the SDK's
//! own `session_id` only exists after `system/init` arrives, while events start
//! flowing immediately. `session_routes` maps `(bridge_id, sessionKey)` to the
//! TeamClu ACP session id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{ClaudeAgentConfig, DaemonConfig};
use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::backend::{AcpCommand, AcpStartupMetadata, AgentBackend};
use crate::runtime::manager::AgentLaunchConfig;
use crate::runtime::opencode_http::translate::status_change;
use crate::runtime::permission_policy::PermissionPolicy;
use crate::runtime::sidecar::mcp;

mod events;
pub use events::available_commands_from_slash_commands_event;
pub mod permission;
pub mod process;
mod types;
pub mod translate;

use permission::PendingPermission;
use process::ClaudeProcessPool;
use types::{BridgeInstanceId, BridgeRouteKey};

pub const SESSION_ID_PREFIX: &str = "claude:";

/// TeamClu model ids are `provider/model`; the SDK speaks the bare id.
pub fn flat_model_id(sdk_model: &str) -> String {
    if sdk_model.starts_with("claude/") {
        sdk_model.to_string()
    } else {
        format!("claude/{sdk_model}")
    }
}

pub fn sdk_model_id(flat: &str) -> String {
    flat.strip_prefix("claude/").unwrap_or(flat).to_string()
}

pub(crate) struct Route {
    pub(crate) event_tx: mpsc::Sender<AcpEventFrame>,
    pub(crate) permission: PermissionPolicy,
    pub(crate) worktree: String,
    pub(crate) bridge_id: BridgeInstanceId,
    pub(crate) route_key: BridgeRouteKey,
    /// False after the owning bridge process exits or is respawned.
    pub(crate) connected: bool,
    /// Bridge-side handle used to address `send` / `cancel` / `set_model`.
    pub(crate) session_key: String,
    pub(crate) turn_active: bool,
    pub(crate) turn_reply_to: Option<String>,
    pub(crate) turn_requester: Option<String>,
    pub(crate) model: String,
}

pub(crate) struct Shared {
    pub(crate) pool: ClaudeProcessPool,
    pub(crate) routes: parking_lot::Mutex<HashMap<String, Route>>,
    pub(crate) permissions: parking_lot::Mutex<HashMap<String, PendingPermission>>,
    /// Encoded [`BridgeRouteKey`] → ACP session id.
    pub(crate) session_routes: parking_lot::Mutex<HashMap<String, String>>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            pool: ClaudeProcessPool::new(),
            routes: parking_lot::Mutex::new(HashMap::new()),
            permissions: parking_lot::Mutex::new(HashMap::new()),
            session_routes: parking_lot::Mutex::new(HashMap::new()),
        })
    }
}

pub(crate) fn canonical_dir(worktree: &str) -> String {
    std::fs::canonicalize(worktree)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| worktree.to_string())
}

fn apply_claude_config(pool: &ClaudeProcessPool, claude: Option<&ClaudeAgentConfig>) {
    // Personal credential from the personal secret store; absent means the
    // Agent SDK falls back to the host's own `claude` login.
    let personal = crate::runtime::personal_api_key("ANTHROPIC_API_KEY");
    match claude {
        Some(cfg) => pool.configure(
            cfg.bridge_command.clone(),
            personal,
            cfg.default_model.clone(),
        ),
        None => pool.configure(None, personal, None),
    }
}

fn load_claude_pool_config(pool: &ClaudeProcessPool) {
    let cfg = DaemonConfig::load(&DaemonConfig::default_path()).ok();
    apply_claude_config(pool, cfg.as_ref().and_then(|c| c.agents.claude.as_ref()));
}

fn models_from_list(result: &serde_json::Value) -> Vec<amux::ModelInfo> {
    result
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if id.is_empty() {
                        return None;
                    }
                    Some(amux::ModelInfo {
                        id: id.to_string(),
                        display_name: m
                            .get("displayName")
                            .and_then(|v| v.as_str())
                            .unwrap_or(id)
                            .to_string(),
                        provider_name: "claude".to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Same ordering as the pi and opencode backends: an explicit override wins,
/// then the device MRU (availability-checked), then whatever the SDK picks —
/// we say nothing rather than pinning an arbitrary catalog entry.
fn pick_initial_model(
    available: &[amux::ModelInfo],
    override_model: Option<&str>,
    model_mru: &[String],
    default_model: &str,
) -> Option<String> {
    if let Some(m) = override_model.filter(|s| !s.is_empty()) {
        return Some(m.to_string());
    }
    let catalog: Vec<String> = available.iter().map(|m| m.id.clone()).collect();
    let configured = Some(default_model)
        .filter(|d| !d.is_empty())
        .map(flat_model_id);
    crate::config::first_available(
        configured.into_iter().chain(model_mru.iter().cloned()),
        &catalog,
    )
}

/// The bridge's permission mode for a policy. `bypassPermissions` is what makes
/// gateway/cron turns run unattended — the SDK then never calls `canUseTool`.
fn permission_mode(policy: PermissionPolicy) -> &'static str {
    if policy.is_full_access() {
        "bypassPermissions"
    } else {
        "default"
    }
}

struct AttachArgs {
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
}

async fn attach(shared: &Arc<Shared>, args: AttachArgs) -> Result<AcpStartupMetadata, String> {
    load_claude_pool_config(&shared.pool);
    let worktree = canonical_dir(&args.worktree);
    let mcp_servers = mcp::assemble_stamped_managed(
        &worktree,
        args.mcp_config_path.as_deref(),
        &args.teamclu_session_id,
    );
    if !mcp::managed_introspect_stamped(&mcp_servers) {
        warn!(
            session_id = %args.teamclu_session_id,
            "managed session context: teamclu-introspect missing or unstamped in mcpServers"
        );
    }
    let proc = shared
        .pool
        .ensure(shared, &worktree)
        .map_err(|e| e.to_string())?;
    let bridge_id = proc.bridge_id.clone();

    // The catalog needs a live session, so it is only populated once one
    // exists; an empty list on the very first attach is expected, not an error.
    let available_models = proc
        .client
        .request("list_models", serde_json::json!({}))
        .await
        .map(|resp| models_from_list(&resp))
        .unwrap_or_default();

    let default_model = DaemonConfig::load(&DaemonConfig::default_path())
        .ok()
        .and_then(|c| c.agents.claude.and_then(|x| x.default_model))
        .unwrap_or_default();
    let initial_flat = pick_initial_model(
        &available_models,
        args.initial_model_override.as_deref(),
        &args.model_mru,
        &default_model,
    );

    let mut params = serde_json::json!({
        "cwd": worktree,
        "mcpServers": serde_json::Value::Object(mcp_servers),
        "permissionMode": permission_mode(args.permission),
        "initialPrompt": args.initial_prompt,
    });
    if let Some(flat) = initial_flat.as_deref() {
        params["model"] = serde_json::json!(sdk_model_id(flat));
    }

    let resume_session_id = args
        .resume_acp_session_id
        .as_deref()
        .and_then(|id| id.strip_prefix(SESSION_ID_PREFIX))
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let resp = if let Some(sdk_session) = resume_session_id {
        let mut resume_params = params.clone();
        resume_params["sessionId"] = serde_json::json!(sdk_session);
        match proc.client.request("resume_session", resume_params).await {
            Ok(resp) => resp,
            Err(e) => {
                if args.forbid_new_session_fallback {
                    return Err(format!(
                        "claude session {sdk_session} not resumable (new-session fallback forbidden): {e}"
                    ));
                }
                warn!(sdk_session, error = %e, "claude resume failed; creating new session");
                proc.client
                    .request("create_session", params)
                    .await
                    .map_err(|e| e.to_string())?
            }
        }
    } else {
        proc.client
            .request("create_session", params)
            .await
            .map_err(|e| e.to_string())?
    };

    let session_key = resp
        .get("sessionKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "claude create_session missing sessionKey".to_string())?
        .to_string();
    let sdk_session_id = resp
        .get("sessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "claude create_session missing sessionId".to_string())?
        .to_string();
    let acp_session_id = format!("{SESSION_ID_PREFIX}{sdk_session_id}");
    let model = resp
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .map(flat_model_id)
        .or_else(|| initial_flat.clone())
        .unwrap_or_default();

    let route_key = BridgeRouteKey::new(bridge_id.clone(), session_key.clone());
    shared
        .session_routes
        .lock()
        .insert(route_key.encode(), acp_session_id.clone());
    shared.routes.lock().insert(
        acp_session_id.clone(),
        Route {
            event_tx: args.event_tx,
            permission: args.permission,
            worktree: worktree.clone(),
            bridge_id,
            route_key,
            connected: true,
            session_key,
            // startSession opens a visible turn only when it carried an
            // initial prompt. With an empty prompt the bridge runs a hidden
            // priming turn (to obtain the SDK session id) and suppresses all
            // of its events, so no turn is active from our point of view.
            turn_active: !args.initial_prompt.is_empty(),
            turn_reply_to: None,
            turn_requester: None,
            model: model.clone(),
        },
    );

    info!(
        session_id = %acp_session_id,
        worktree = %worktree,
        models = available_models.len(),
        model = %model,
        "claude session attached"
    );
    Ok(AcpStartupMetadata {
        available_models,
        initial_model: (!model.is_empty()).then_some(model),
        acp_session_id,
        host_generation_id: String::new(),
        route_lease: None,
    })
}

async fn emit_frame(
    event_tx: &mpsc::Sender<AcpEventFrame>,
    session_id: &str,
    ev: amux::AcpEvent,
    reply_to: Option<String>,
) {
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id.to_string(), ev).with_reply_to(reply_to))
        .await;
}

async fn do_prompt(
    shared: &Arc<Shared>,
    session_id: &str,
    text: String,
    attachment_urls: Vec<String>,
    requester_actor_id: Option<String>,
    reply_to_message_id: Option<String>,
) {
    let reply_to = reply_to_message_id.filter(|id| !id.is_empty());
    let resolved =
        crate::runtime::prompt_attachments::resolve_all(&attachment_urls, session_id).await;
    let prompt_target = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            warn!(session_id, "prompt for unknown claude session");
            return;
        };
        if !route.connected {
            Some((
                route.event_tx.clone(),
                route.turn_reply_to.clone(),
                None::<(String, String, BridgeInstanceId, String)>,
            ))
        } else {
            route.turn_active = true;
            route.turn_reply_to = reply_to.clone();
            route.turn_requester = requester_actor_id.filter(|id| !id.is_empty());
            Some((
                route.event_tx.clone(),
                route.turn_reply_to.clone(),
                Some((
                    route.worktree.clone(),
                    route.session_key.clone(),
                    route.bridge_id.clone(),
                    route.model.clone(),
                )),
            ))
        }
    };
    let Some((event_tx, reply_to_frame, send_target)) = prompt_target else {
        return;
    };
    let Some((worktree, session_key, bridge_id, model)) = send_target else {
        emit_frame(
            &event_tx,
            session_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: "claude session disconnected".into(),
                    details: "re-attach to continue".into(),
                })),
                model: String::new(),
            },
            reply_to_frame,
        )
        .await;
        return;
    };

    crate::runtime::agent_trace::log_prompt_begin(session_id, &text, attachment_urls.len());
    emit_frame(
        &event_tx,
        session_id,
        status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
        reply_to.clone(),
    )
    .await;

    let mut message = text;
    crate::runtime::prompt_attachments::substitute_in_message(&mut message, &resolved);
    crate::runtime::prompt_attachments::append_unreferenced(&mut message, &resolved, true);

    let result = match shared.pool.ensure(shared, &worktree) {
        Ok(proc) if proc.bridge_id == bridge_id => {
            let mut params = serde_json::json!({
                "sessionKey": session_key,
                "text": message,
            });
            if !model.is_empty() {
                params["model"] = serde_json::json!(sdk_model_id(&model));
            }
            proc.client.request("send", params).await
        }
        Ok(_) => Err(crate::error::AmuxError::Agent(
            "claude bridge generation changed; re-attach to continue".into(),
        )),
        Err(e) => Err(e),
    };

    if let Err(e) = result {
        let details = e.to_string();
        crate::runtime::agent_trace::log_prompt_end(session_id, false, &details, 0);
        emit_frame(
            &event_tx,
            session_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: "claude prompt failed".to_string(),
                    details,
                })),
                model: String::new(),
            },
            reply_to.clone(),
        )
        .await;
        {
            let mut routes = shared.routes.lock();
            if let Some(route) = routes.get_mut(session_id) {
                route.turn_active = false;
                route.turn_reply_to = None;
                route.turn_requester = None;
            }
        }
        emit_frame(
            &event_tx,
            session_id,
            status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle),
            reply_to,
        )
        .await;
    }
}

/// Look up a route's (worktree, sessionKey, bridge_id, connected) for a bridge call.
fn target_for(
    shared: &Arc<Shared>,
    session_id: &str,
) -> Option<(String, String, BridgeInstanceId, bool)> {
    let routes = shared.routes.lock();
    let route = routes.get(session_id)?;
    Some((
        route.worktree.clone(),
        route.session_key.clone(),
        route.bridge_id.clone(),
        route.connected,
    ))
}

async fn command_loop(shared: Arc<Shared>, mut cmd_rx: mpsc::Receiver<AcpCommand>) {
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
                teamclu_session_id,
            } => {
                let result = attach(
                    &shared,
                    AttachArgs {
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
                    },
                )
                .await;
                let _ = startup_tx.send(result);
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
                if let Some((worktree, session_key, bridge_id, connected)) =
                    target_for(&shared, &acp_session_id)
                {
                    if connected {
                        if let Ok(proc) = shared.pool.ensure(&shared, &worktree) {
                            if proc.bridge_id == bridge_id {
                                let _ = proc
                                    .client
                                    .request(
                                        "cancel",
                                        serde_json::json!({ "sessionKey": session_key }),
                                    )
                                    .await;
                            }
                        }
                    }
                }
                // interrupt() does not always produce a terminal result
                // message; close_turn is idempotent so a later one is a no-op.
                events::close_turn(&shared, &acp_session_id).await;
            }
            AcpCommand::ResolvePermission {
                request_id,
                granted,
                option_id,
            } => permission::resolve(&shared, &request_id, granted, option_id.as_deref()).await,
            AcpCommand::SetModel {
                acp_session_id,
                model_id,
            } => {
                let target = {
                    let routes = shared.routes.lock();
                    routes.get(&acp_session_id).map(|route| {
                        (
                            route.worktree.clone(),
                            route.session_key.clone(),
                            route.bridge_id.clone(),
                            route.connected,
                            route.model.clone(),
                        )
                    })
                };
                let Some((worktree, session_key, bridge_id, connected, previous_model)) = target
                else {
                    warn!(acp_session_id, "set_model for unknown claude session");
                    continue;
                };
                if !connected {
                    warn!(acp_session_id, "set_model for disconnected claude session");
                    continue;
                }
                let desired = flat_model_id(&model_id);
                if let Ok(proc) = shared.pool.ensure(&shared, &worktree) {
                    if proc.bridge_id != bridge_id {
                        warn!(acp_session_id, "set_model for stale claude bridge generation");
                        continue;
                    }
                    match proc
                        .client
                        .request(
                            "set_model",
                            serde_json::json!({
                                "sessionKey": session_key,
                                "model": sdk_model_id(&model_id),
                            }),
                        )
                        .await
                    {
                        Ok(_) => {
                            if let Some(route) = shared.routes.lock().get_mut(&acp_session_id) {
                                route.model = desired;
                            }
                            info!(acp_session_id, model_id = %model_id, "claude model set");
                        }
                        Err(e) => warn!(
                            acp_session_id,
                            previous_model = %previous_model,
                            error = %e,
                            "claude set_model failed; route model unchanged"
                        ),
                    }
                }
            }
            AcpCommand::DetachSession {
                acp_session_id,
                ack,
            } => {
                let removed = shared.routes.lock().remove(&acp_session_id);
                if let Some(route) = removed {
                    shared
                        .session_routes
                        .lock()
                        .remove(&route.route_key.encode());
                    shared.permissions.lock().retain(|_, pending| {
                        pending.route_key.bridge_id != route.bridge_id
                            || pending.route_key.session_key != route.session_key
                    });
                    if let Ok(proc) = shared.pool.ensure(&shared, &route.worktree) {
                        let _ = proc
                            .client
                            .request(
                                "close_session",
                                serde_json::json!({ "sessionKey": route.session_key }),
                            )
                            .await;
                    }
                }
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
            }
            AcpCommand::AnswerQuestion { request_id, .. } => {
                // Claude Code has no blocking `question` tool; nothing to route.
                warn!(request_id, "claude backend: AnswerQuestion unsupported");
            }
            AcpCommand::Shutdown => {
                shared.pool.kill_all();
            }
        }
    }
}

pub struct ClaudeAgentBackend {
    shared: Arc<Shared>,
    cmd_tx: std::sync::OnceLock<mpsc::Sender<AcpCommand>>,
}

impl ClaudeAgentBackend {
    pub fn new() -> Self {
        let shared = Shared::new();
        load_claude_pool_config(&shared.pool);
        Self {
            shared,
            cmd_tx: std::sync::OnceLock::new(),
        }
    }

    /// Override the claude-bridge spawn command (integration tests only).
    pub fn set_bridge_command(&mut self, command: Vec<String>) {
        self.shared
            .pool
            .configure(Some(command), None, None);
    }

    fn command_sender(&self) -> mpsc::Sender<AcpCommand> {
        self.cmd_tx
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<AcpCommand>(64);
                tokio::spawn(command_loop(Arc::clone(&self.shared), rx));
                tx
            })
            .clone()
    }
}

impl Default for ClaudeAgentBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentBackend for ClaudeAgentBackend {
    async fn attach_session(
        &mut self,
        _agent_type: amux::AgentType,
        _launch: &AgentLaunchConfig,
        _isolation_domain: crate::runtime::execution_context::IsolationDomainKey,
        _process_env_revision: crate::runtime::execution_context::ProcessEnvRevision,
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
        load_claude_pool_config(&self.shared.pool);
        self.shared
            .pool
            .merge_extra_env(&extra_env, force_env_override);
        let cmd_tx = self.command_sender();
        // The opening prompt rides the create_session call — the SDK's
        // streaming-input mode needs a first message to start the session at
        // all, so there is no separate follow-up Prompt to send.
        let startup = attach(
            &self.shared,
            AttachArgs {
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
            },
        )
        .await
        .map_err(crate::error::AmuxError::Agent)?;
        Ok((cmd_tx, startup))
    }

    async fn prewarm(&mut self, _launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        load_claude_pool_config(&self.shared.pool);
    }

    async fn prewarm_with_env(
        &mut self,
        _launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        load_claude_pool_config(&self.shared.pool);
        self.shared
            .pool
            .merge_extra_env(&extra_env, force_env_override);
        if let Some(worktree) = worktree.filter(|w| !w.is_empty()) {
            let worktree = canonical_dir(worktree);
            if let Err(e) = self.shared.pool.ensure(&self.shared, &worktree) {
                warn!(worktree, error = %e, "claude prewarm failed");
            } else {
                info!(worktree, "claude bridge prewarmed");
            }
        }
    }

    fn evict_agent_types(&mut self, _agent_types: &[amux::AgentType]) -> usize {
        self.shared.pool.kill_all()
    }

    fn host_count(&self) -> usize {
        self.shared.pool.live_count()
    }

    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        load_claude_pool_config(&self.shared.pool);
        let worktree = canonical_dir(&workspace_path.to_string_lossy());
        let proc = match self
            .shared
            .pool
            .get(&worktree)
            .or_else(|| self.shared.pool.any_live())
        {
            Some(proc) => proc,
            None => self.shared.pool.ensure(&self.shared, &worktree)?,
        };
        let resp = proc
            .client
            .request("list_models", serde_json::json!({}))
            .await?;
        Ok(models_from_list(&resp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> amux::ModelInfo {
        amux::ModelInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            provider_name: "claude".to_string(),
        }
    }

    #[test]
    fn model_ids_round_trip_through_the_flat_form() {
        assert_eq!(flat_model_id("claude-opus-5"), "claude/claude-opus-5");
        // Already flat ids are left alone rather than double-prefixed.
        assert_eq!(
            flat_model_id("claude/claude-opus-5"),
            "claude/claude-opus-5"
        );
        assert_eq!(sdk_model_id("claude/claude-opus-5"), "claude-opus-5");
        assert_eq!(sdk_model_id("claude-opus-5"), "claude-opus-5");
    }

    #[test]
    fn permission_mode_maps_full_access_to_bypass() {
        assert_eq!(permission_mode(PermissionPolicy::Full), "bypassPermissions");
        assert_eq!(permission_mode(PermissionPolicy::Ask), "default");
    }

    #[test]
    fn pick_initial_model_prefers_override_then_config_then_mru() {
        let available = vec![
            model("claude/claude-opus-5"),
            model("claude/claude-sonnet-5"),
        ];

        assert_eq!(
            pick_initial_model(
                &available,
                Some("claude/claude-sonnet-5"),
                &[],
                "claude-opus-5"
            ),
            Some("claude/claude-sonnet-5".to_string())
        );
        // Configured default wins over the MRU when it is actually available.
        assert_eq!(
            pick_initial_model(
                &available,
                None,
                &["claude/claude-sonnet-5".to_string()],
                "claude-opus-5"
            ),
            Some("claude/claude-opus-5".to_string())
        );
        // An unavailable default falls through to the MRU.
        assert_eq!(
            pick_initial_model(
                &available,
                None,
                &["claude/claude-sonnet-5".to_string()],
                "claude-retired-9"
            ),
            Some("claude/claude-sonnet-5".to_string())
        );
    }

    #[test]
    fn pick_initial_model_says_nothing_when_nothing_resolves() {
        // Deliberately None rather than "first in the catalog": with no signal
        // we let the SDK apply its own default (same as the pi backend).
        assert_eq!(
            pick_initial_model(&[model("claude/claude-opus-5")], None, &[], ""),
            None
        );
        assert_eq!(pick_initial_model(&[], None, &[], ""), None);
    }

    #[test]
    fn an_empty_catalog_does_not_discard_a_configured_model() {
        // The catalog needs a live session, so the first attach always sees an
        // empty one. Empty means "unknown", not "unavailable" — dropping the
        // user's configured model there would silently ignore their setting.
        assert_eq!(
            pick_initial_model(&[], None, &[], "claude-opus-5"),
            Some("claude/claude-opus-5".to_string())
        );
        assert_eq!(
            pick_initial_model(&[], None, &["claude/claude-sonnet-5".to_string()], ""),
            Some("claude/claude-sonnet-5".to_string())
        );
    }

    #[test]
    fn models_from_list_skips_entries_without_an_id() {
        let resp = serde_json::json!({"models": [
            {"id": "claude/claude-opus-5", "displayName": "Opus 5"},
            {"displayName": "no id"},
            {"id": ""}
        ]});
        let models = models_from_list(&resp);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude/claude-opus-5");
        assert_eq!(models[0].display_name, "Opus 5");
        assert_eq!(models[0].provider_name, "claude");
        assert!(models_from_list(&serde_json::json!({})).is_empty());
    }

    #[tokio::test]
    async fn host_count_zero_without_processes() {
        let backend = ClaudeAgentBackend::new();
        assert_eq!(backend.host_count(), 0);
    }
}
