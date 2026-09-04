//! Cursor SDK backend (`cursor-bridge` + `@cursor/sdk`).
//!
//! Peer of `runtime/pi_rpc/` behind [`AgentBackend`]: one Node sidecar per
//! worktree (JSONL over stdin/stdout), sessions keyed as `cursor:<agentId>`.

// Nothing constructs this backend since pi became the only runtime (#1247 /
// #1250). The module is compiled until #1247 deletes it, so dead-code lints
// are silenced here rather than chased through every function.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{CursorAgentConfig, DaemonConfig};
use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::backend::{AcpCommand, AcpStartupMetadata, AgentBackend};
use crate::runtime::manager::AgentLaunchConfig;
use crate::runtime::opencode_http::translate::status_change;
use crate::runtime::permission_policy::PermissionPolicy;

mod events;
pub mod hooks;
pub mod permission;
pub mod process;
pub mod translate;

use crate::runtime::sidecar::mcp;

use permission::PendingPermission;
use process::CursorProcessPool;
use translate::TranslateState;

pub const SESSION_ID_PREFIX: &str = "cursor:";

pub(crate) struct Route {
    pub(crate) event_tx: mpsc::Sender<AcpEventFrame>,
    pub(crate) permission: PermissionPolicy,
    pub(crate) worktree: String,
    pub(crate) agent_id: String,
    pub(crate) turn_active: bool,
    pub(crate) turn_reply_to: Option<String>,
    pub(crate) turn_requester: Option<String>,
    pub(crate) translate: TranslateState,
    pub(crate) model: String,
}

pub(crate) struct Shared {
    pub(crate) pool: CursorProcessPool,
    pub(crate) routes: parking_lot::Mutex<HashMap<String, Route>>,
    pub(crate) permissions: parking_lot::Mutex<HashMap<String, PendingPermission>>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            pool: CursorProcessPool::new(),
            routes: parking_lot::Mutex::new(HashMap::new()),
            permissions: parking_lot::Mutex::new(HashMap::new()),
        })
    }
}

/// Process-global backend state.
///
/// The `preToolUse` hook arrives on `amuxd.sock`, which is served by the daemon
/// loop — it has no handle on the `AgentBackend` box owned by `RuntimeManager`.
/// There is at most one local backend per daemon, so the route + pending tables
/// live here instead, reachable from both sides.
static SHARED: std::sync::OnceLock<Arc<Shared>> = std::sync::OnceLock::new();

pub(crate) fn shared() -> Arc<Shared> {
    Arc::clone(SHARED.get_or_init(Shared::new))
}

pub(crate) fn canonical_dir(worktree: &str) -> String {
    std::fs::canonicalize(worktree)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| worktree.to_string())
}

fn apply_cursor_config(pool: &CursorProcessPool, cursor: Option<&CursorAgentConfig>) {
    // The key is personal, not machine config — resolved from the personal
    // secret store even when daemon.toml has no [agents.cursor] section at
    // all. `CURSOR_API_KEY` in the process env still wins at spawn.
    let personal = crate::runtime::personal_api_key("CURSOR_API_KEY");
    match cursor {
        Some(cfg) => pool.configure(
            cfg.bridge_command.clone(),
            personal,
            cfg.default_model.clone(),
        ),
        None => pool.configure(None, personal, None),
    }
}

fn load_cursor_pool_config(pool: &CursorProcessPool) {
    let cfg = DaemonConfig::load(&DaemonConfig::default_path()).ok();
    apply_cursor_config(pool, cfg.as_ref().and_then(|c| c.agents.cursor.as_ref()));
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
                        provider_name: m
                            .get("providerName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("cursor")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pick_initial_model(
    available: &[amux::ModelInfo],
    override_model: Option<&str>,
    model_mru: &[String],
    default_model: &str,
) -> String {
    if let Some(m) = override_model.filter(|s| !s.is_empty()) {
        return m.to_string();
    }
    for mru in model_mru {
        if available.iter().any(|m| &m.id == mru) {
            return mru.clone();
        }
    }
    if available
        .iter()
        .any(|m| m.id == format!("cursor/{default_model}"))
    {
        return format!("cursor/{default_model}");
    }
    available
        .first()
        .map(|m| m.id.clone())
        .unwrap_or_else(|| format!("cursor/{default_model}"))
}

struct AttachArgs {
    worktree: String,
    resume_acp_session_id: Option<String>,
    mcp_config_path: Option<PathBuf>,
    initial_model_override: Option<String>,
    model_mru: Vec<String>,
    event_tx: mpsc::Sender<AcpEventFrame>,
    permission: PermissionPolicy,
    forbid_new_session_fallback: bool,
    teamclu_session_id: String,
}

/// Install the `preToolUse` gate in the worktree. Best-effort: a worktree we
/// cannot write to loses interactive approval (the SDK simply finds no hook),
/// which is no worse than the state before the gate existed.
fn install_permission_hook(worktree: &str) {
    let amuxd_bin = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "cursor: current_exe() failed; permission hook not installed");
            return;
        }
    };
    let sock = DaemonConfig::sock_path();
    match hooks::ensure(worktree, &amuxd_bin, &sock) {
        Ok(path) => info!(path = %path.display(), "cursor permission hook installed"),
        Err(e) => warn!(worktree, error = %e, "cursor permission hook install failed"),
    }
}

async fn attach(shared: &Arc<Shared>, args: AttachArgs) -> Result<AcpStartupMetadata, String> {
    load_cursor_pool_config(&shared.pool);
    let worktree = canonical_dir(&args.worktree);
    install_permission_hook(&worktree);
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

    let models_resp = proc
        .client
        .request("list_models", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;
    let available_models = models_from_list(&models_resp);

    let default_model = DaemonConfig::load(&DaemonConfig::default_path())
        .ok()
        .and_then(|c| c.agents.cursor.and_then(|x| x.default_model))
        .unwrap_or_else(|| "composer-2.5".to_string());

    let initial_flat = pick_initial_model(
        &available_models,
        args.initial_model_override.as_deref(),
        &args.model_mru,
        &default_model,
    );
    let resume_agent_id = args
        .resume_acp_session_id
        .as_deref()
        .and_then(|id| id.strip_prefix(SESSION_ID_PREFIX))
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // The SDK does not persist inline MCP, so resume has to re-send the whole
    // manifest exactly like create does.
    let mcp_servers = serde_json::Value::Object(mcp_servers);
    let create_params = |extra: serde_json::Value| {
        let mut params = serde_json::json!({
            "cwd": worktree,
            "model": initial_flat,
            "mcpServers": mcp_servers,
        });
        if let (Some(obj), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                obj.insert(k.clone(), v.clone());
            }
        }
        params
    };

    let create_resp = if let Some(agent_id) = resume_agent_id {
        match proc
            .client
            .request(
                "resume_agent",
                create_params(serde_json::json!({ "agentId": agent_id })),
            )
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                if args.forbid_new_session_fallback {
                    return Err(format!(
                        "cursor agent {agent_id} not resumable (new-session fallback forbidden): {e}"
                    ));
                }
                warn!(agent_id, error = %e, "cursor resume failed; creating new agent");
                proc.client
                    .request("create_agent", create_params(serde_json::json!({})))
                    .await
                    .map_err(|e| e.to_string())?
            }
        }
    } else {
        proc.client
            .request("create_agent", create_params(serde_json::json!({})))
            .await
            .map_err(|e| e.to_string())?
    };

    let agent_id = create_resp
        .get("agentId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "cursor create_agent missing agentId".to_string())?
        .to_string();
    let session_id = format!("{SESSION_ID_PREFIX}{agent_id}");

    shared.routes.lock().insert(
        session_id.clone(),
        Route {
            event_tx: args.event_tx,
            permission: args.permission,
            worktree: worktree.clone(),
            agent_id: agent_id.clone(),
            turn_active: false,
            turn_reply_to: None,
            turn_requester: None,
            translate: TranslateState::default(),
            model: initial_flat.clone(),
        },
    );

    Ok(AcpStartupMetadata {
        available_models,
        initial_model: Some(initial_flat),
        acp_session_id: session_id,
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
    let (event_tx, worktree, agent_id, model) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            warn!(session_id, "prompt for unknown cursor session");
            return;
        };
        route.turn_active = true;
        route.turn_reply_to = reply_to.clone();
        route.turn_requester = requester_actor_id.filter(|id| !id.is_empty());
        (
            route.event_tx.clone(),
            route.worktree.clone(),
            route.agent_id.clone(),
            route.model.clone(),
        )
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
        Ok(proc) => {
            proc.client
                .request(
                    "send",
                    // The daemon's route is the source of truth for the model,
                    // exactly as in the opencode backend's `PromptBody`.
                    serde_json::json!({
                        "agentId": agent_id,
                        "text": message,
                        "model": model,
                    }),
                )
                .await
        }
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
                    message: "cursor prompt failed".to_string(),
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
                        event_tx,
                        permission,
                        forbid_new_session_fallback,
                        teamclu_session_id,
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
                let (worktree, agent_id) = {
                    let routes = shared.routes.lock();
                    let Some(route) = routes.get(&acp_session_id) else {
                        continue;
                    };
                    (route.worktree.clone(), route.agent_id.clone())
                };
                if let Ok(proc) = shared.pool.ensure(&shared, &worktree) {
                    let _ = proc
                        .client
                        .request("cancel", serde_json::json!({ "agentId": agent_id }))
                        .await;
                }
                events::close_turn(&shared, &acp_session_id).await;
            }
            AcpCommand::ResolvePermission {
                request_id,
                granted,
                option_id,
            } => permission::resolve(&shared, &request_id, granted, option_id.as_deref()),
            AcpCommand::SetModel {
                acp_session_id,
                model_id,
            } => {
                let (worktree, agent_id) = {
                    let mut routes = shared.routes.lock();
                    let Some(route) = routes.get_mut(&acp_session_id) else {
                        continue;
                    };
                    route.model = model_id.clone();
                    (route.worktree.clone(), route.agent_id.clone())
                };
                if let Ok(proc) = shared.pool.ensure(&shared, &worktree) {
                    let _ = proc
                        .client
                        .request(
                            "set_model",
                            serde_json::json!({ "agentId": agent_id, "model": model_id }),
                        )
                        .await;
                }
            }
            AcpCommand::DetachSession {
                acp_session_id,
                ack,
            } => {
                shared.routes.lock().remove(&acp_session_id);
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
            }
            AcpCommand::AnswerQuestion { .. } => {
                warn!("cursor backend: AnswerQuestion unsupported");
            }
            AcpCommand::Shutdown => {
                shared.pool.kill_all();
            }
        }
    }
}

pub struct CursorSdkBackend {
    shared: Arc<Shared>,
    cmd_tx: std::sync::OnceLock<mpsc::Sender<AcpCommand>>,
}

impl CursorSdkBackend {
    pub fn new() -> Self {
        let shared = shared();
        load_cursor_pool_config(&shared.pool);
        Self {
            shared,
            cmd_tx: std::sync::OnceLock::new(),
        }
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

impl Default for CursorSdkBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentBackend for CursorSdkBackend {
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
        load_cursor_pool_config(&self.shared.pool);
        self.shared
            .pool
            .merge_extra_env(&extra_env, force_env_override);
        let cmd_tx = self.command_sender();
        let startup = attach(
            &self.shared,
            AttachArgs {
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                model_mru,
                event_tx,
                permission,
                forbid_new_session_fallback,
                teamclu_session_id,
            },
        )
        .await
        .map_err(crate::error::AmuxError::Agent)?;
        if !initial_prompt.is_empty() {
            let _ = cmd_tx
                .send(AcpCommand::Prompt {
                    acp_session_id: startup.acp_session_id.clone(),
                    text: initial_prompt,
                    attachment_urls: Vec::new(),
                    requester_actor_id: None,
                    reply_to_message_id: None,
                })
                .await;
        }
        Ok((cmd_tx, startup))
    }

    async fn prewarm(&mut self, _launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        load_cursor_pool_config(&self.shared.pool);
    }

    async fn prewarm_with_env(
        &mut self,
        _launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        load_cursor_pool_config(&self.shared.pool);
        self.shared
            .pool
            .merge_extra_env(&extra_env, force_env_override);
        if let Some(worktree) = worktree.filter(|w| !w.is_empty()) {
            let worktree = canonical_dir(worktree);
            if let Err(e) = self.shared.pool.ensure(&self.shared, &worktree) {
                warn!(worktree, error = %e, "cursor prewarm failed");
            } else {
                info!(worktree, "cursor bridge prewarmed");
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
        load_cursor_pool_config(&self.shared.pool);
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

    #[test]
    fn pick_initial_model_prefers_override() {
        let available = vec![amux::ModelInfo {
            id: "cursor/composer-2.5".into(),
            display_name: "Composer".into(),
            provider_name: "cursor".into(),
        }];
        assert_eq!(
            pick_initial_model(
                &available,
                Some("cursor/claude-sonnet-5"),
                &[],
                "composer-2.5"
            ),
            "cursor/claude-sonnet-5"
        );
    }
}
