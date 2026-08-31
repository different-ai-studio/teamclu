//! pi coding-agent backend (badlogic/pi-mono, `@earendil-works`).
//!
//! Peer of `runtime/opencode_http/` behind the [`AgentBackend`] trait. One pi
//! child per (isolation domain, env revision, worktree); sessions persisted
//! under `<state>/pi-sessions/<worktree-hash>/`; events translated into the
//! same `amux::AcpEvent` vocabulary. See
//! `docs/architecture/pi-agent-backend.md`.
//!
//! Two child modes (see `process.rs`):
//!
//! - **Host** (default): the TeamClu multi-session host (`host.mjs`) running N
//!   concurrent `AgentSession`s over the pi SDK. Commands and events carry a
//!   `sessionId`, so several TeamClu sessions on one worktree prompt, stream,
//!   and cancel independently — capability parity with opencode.
//! - **LegacyRpc**: `pi --mode rpc`, single active session per process. Kept
//!   as the fallback for pi installs with no importable npm package (Bun
//!   single binary) and as the `[agents.pi] session_host = "rpc"` rollback.
//!
//! Permission approvals ride the pi extension UI dialog channel: the TeamClu
//! pi extension emits `extension_ui_request(confirm)`; this backend surfaces
//! those as `AcpPermissionRequest` and writes the resolution back as
//! `extension_ui_response`. The extension's `question` tool rides the same
//! channel as a marked `select` dialog (see `translate::QUESTION_MARKER`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::backend::{AcpCommand, AcpStartupMetadata, AgentBackend};
use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use crate::runtime::manager::AgentLaunchConfig;
use crate::runtime::opencode_http::translate::status_change;
use crate::runtime::permission_policy::PermissionPolicy;

pub mod client;
mod events;
pub mod process;
pub mod translate;

use process::{PiProcess, PiProcessPool, PiSessionMode, PoolKey, SpawnEnv};
use translate::TranslateState;

/// Prefix for pi acp session ids; the remainder is the pi session file path
/// (self-contained, so resume after a daemon restart needs no extra state).
const SESSION_ID_PREFIX: &str = "pi:";

pub(crate) struct Route {
    pub(crate) event_tx: mpsc::Sender<AcpEventFrame>,
    /// Permission handling for this session; `Full` (gateway / cron) means
    /// confirmation requests are auto-approved instead of waiting on a human.
    pub(crate) permission: PermissionPolicy,
    /// Which pool child serves this session.
    pub(crate) pool_key: PoolKey,
    /// pi session file path (open_session / switch_session target).
    pub(crate) session_path: String,
    pub(crate) turn_active: bool,
    pub(crate) turn_reply_to: Option<String>,
    pub(crate) turn_requester: Option<String>,
    pub(crate) translate: TranslateState,
    /// Leaf entry id after the last completed turn — the `get_entries since`
    /// cursor for crash backfill (see `events::backfill_and_close`).
    pub(crate) last_entry_id: Option<String>,
}

/// Bookkeeping for a pending `extension_ui_request(confirm)`: enough to route
/// the reply and to persist an "always allow" grant.
pub(crate) struct PendingPermission {
    pub(crate) session_id: String,
    /// `teamclu.always-pattern=` trailer from the confirm message; written to
    /// the worktree's rules file when the host resolves with option "always".
    pub(crate) always_pattern: Option<String>,
}

pub(crate) struct Shared {
    pub(crate) pool: PiProcessPool,
    /// acp session id → route.
    pub(crate) routes: parking_lot::Mutex<HashMap<String, Route>>,
    /// extension_ui_request id → pending permission bookkeeping.
    pub(crate) permissions: parking_lot::Mutex<HashMap<String, PendingPermission>>,
    /// extension_ui_request id → session, for pending `question` selects
    /// (answered via `AcpCommand::AnswerQuestion`).
    pub(crate) questions: parking_lot::Mutex<HashMap<String, String>>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            pool: PiProcessPool::new(),
            routes: parking_lot::Mutex::new(HashMap::new()),
            permissions: parking_lot::Mutex::new(HashMap::new()),
            questions: parking_lot::Mutex::new(HashMap::new()),
        })
    }
}

fn canonical_dir(worktree: &str) -> String {
    std::fs::canonicalize(worktree)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| worktree.to_string())
}

/// Stamp a `sessionId` onto a command for host-mode children; legacy children
/// address their single active session implicitly.
fn with_session(
    mut cmd: serde_json::Value,
    mode: PiSessionMode,
    session_id: &str,
) -> serde_json::Value {
    if mode == PiSessionMode::Host {
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("sessionId".to_string(), serde_json::json!(session_id));
        }
    }
    cmd
}

/// Flatten a `get_available_models` response into `amux::ModelInfo`s with
/// `provider/model` ids (the id shape clients and manager already use).
fn models_from_response(response: &serde_json::Value) -> Vec<amux::ModelInfo> {
    let Some(models) = response.pointer("/data/models").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|m| {
            let provider = m.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let model_id = m
                .get("id")
                .or_else(|| m.get("modelId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if model_id.is_empty() {
                return None;
            }
            let id = if provider.is_empty() {
                model_id.to_string()
            } else {
                format!("{provider}/{model_id}")
            };
            Some(amux::ModelInfo {
                display_name: m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(model_id)
                    .to_string(),
                provider_name: provider.to_string(),
                id,
            })
        })
        .collect()
}

/// Flatten a `get_commands` response into the slash commands clients render.
/// pi is the only backend that can enumerate its real command set at runtime
/// (extension commands + prompt templates + pi skills), so unlike opencode
/// there is no static table to maintain — see `builtin_commands.rs`.
pub fn commands_from_get_commands_response(
    response: &serde_json::Value,
) -> Vec<amux::AcpAvailableCommand> {
    commands_from_response(response)
}

fn commands_from_response(response: &serde_json::Value) -> Vec<amux::AcpAvailableCommand> {
    let Some(commands) = response
        .pointer("/data/commands")
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };
    commands
        .iter()
        .filter_map(|c| {
            let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return None;
            }
            Some(amux::AcpAvailableCommand {
                name: name.to_string(),
                description: c
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                input_hint: String::new(),
            })
        })
        .collect()
}

/// `provider/model` id → pi `set_model` fields (split at the first '/').
fn split_model_id(model_id: &str) -> Option<(String, String)> {
    let (provider, model) = model_id.split_once('/')?;
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider.to_string(), model.to_string()))
}

/// Extract the `amuxd-remote-tools` server launch command from an amuxd MCP
/// config value (`{"mcpServers": {"amuxd-remote-tools": {"command", "args"}}}`,
/// the shape `remote_tools::mcp_config` writes). Returned as a JSON array
/// string, the `TEAMCLU_REMOTE_TOOLS_CMD` contract of the pi extension.
fn remote_tools_cmd_from_value(root: &serde_json::Value) -> Option<String> {
    // Literal name (= remote_tools::REMOTE_TOOLS_MCP_SERVER_NAME); kept local
    // so the integration-test harness need not pull in the remote_tools tree.
    let server = root.get("mcpServers")?.get("amuxd-remote-tools")?;
    let command = server.get("command").and_then(|v| v.as_str())?;
    let mut cmd = vec![serde_json::json!(command)];
    if let Some(args) = server.get("args").and_then(|v| v.as_array()) {
        cmd.extend(args.iter().filter(|a| a.is_string()).cloned());
    }
    Some(serde_json::Value::Array(cmd).to_string())
}

fn remote_tools_cmd_from_mcp_config(path: &Path) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&body).ok()?;
    remote_tools_cmd_from_value(&root)
}

/// Build the `TEAMCLU_MCP_SERVERS` payload for the pi extension from a
/// workspace `opencode.json` (the MCP SSOT: team + inherent + user servers all
/// merge into its `mcp` map). pi has no native MCP, so the extension connects
/// to each enabled server with the official MCP SDK and proxies its tools.
///
/// Returns a JSON string keyed by server name, carrying the same two shapes
/// opencode understands, normalized so the extension does not have to repeat
/// opencode's defaulting rules:
///
/// - local (stdio):  `{ "type": "local",  "command": [...], "environment": {...} }`
/// - remote (HTTP):  `{ "type": "remote", "url": "...",     "headers": {...} }`
///
/// None when there is nothing to bridge. Excluded: disabled servers, local
/// servers whose command path does not exist on this machine, remote servers
/// with no URL, and `amuxd-remote-tools` (already bridged via
/// `TEAMCLU_REMOTE_TOOLS_CMD`).
/// The `command[0]` of an MCP server entry when it names a path that does not
/// exist on this machine.
///
/// Only *paths* are checked. A bare name (`npx`, `uvx`, `node`) is resolved by
/// the OS through the child's enriched PATH, which this process cannot
/// faithfully reproduce, so second-guessing it here would drop servers that
/// work fine.
fn missing_command_path(command: &[serde_json::Value]) -> Option<String> {
    let first = command.first()?.as_str()?;
    if !first.contains(std::path::MAIN_SEPARATOR) {
        return None;
    }
    if Path::new(first).exists() {
        return None;
    }
    Some(first.to_string())
}

/// One `opencode.json` `mcp` entry → the extension's server spec, or None when
/// it cannot be bridged.
fn pi_server_spec(
    name: &str,
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Option<serde_json::Value> {
    if obj.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        return None;
    }
    if obj.get("type").and_then(|v| v.as_str()) == Some("remote") {
        let url = obj.get("url").and_then(|v| v.as_str()).unwrap_or_default();
        if url.is_empty() {
            warn!(server = %name, "remote MCP server has no url; not bridging it into pi");
            return None;
        }
        let mut entry = serde_json::Map::new();
        entry.insert(
            "type".to_string(),
            serde_json::Value::String("remote".into()),
        );
        entry.insert(
            "url".to_string(),
            serde_json::Value::String(url.to_string()),
        );
        if let Some(headers) = obj.get("headers").and_then(|v| v.as_object()) {
            entry.insert(
                "headers".to_string(),
                serde_json::Value::Object(headers.clone()),
            );
        }
        return Some(serde_json::Value::Object(entry));
    }
    let command = match obj.get("command").and_then(|v| v.as_array()) {
        Some(c) if !c.is_empty() && c.iter().all(|a| a.is_string()) => c.clone(),
        _ => return None,
    };
    if let Some(missing) = missing_command_path(&command) {
        // A path that is not there cannot become a working bridge, and a
        // whole workspace was once taken down by one of these: a leftover
        // `teamclaw-introspect` entry from before the rename, pointing into
        // an app bundle that no longer has that binary. Drop it here rather
        // than hand pi a server it can only fail to spawn.
        warn!(
            server = %name,
            path = %missing,
            "MCP server command not found on this machine; not bridging it into pi"
        );
        return None;
    }
    let mut entry = serde_json::Map::new();
    entry.insert(
        "type".to_string(),
        serde_json::Value::String("local".into()),
    );
    entry.insert("command".to_string(), serde_json::Value::Array(command));
    if let Some(env) = obj.get("environment").and_then(|v| v.as_object()) {
        entry.insert(
            "environment".to_string(),
            serde_json::Value::Object(env.clone()),
        );
    }
    Some(serde_json::Value::Object(entry))
}

fn mcp_servers_from_value(root: &serde_json::Value) -> Option<String> {
    let mcp = root.get("mcp")?.as_object()?;
    let mut out = serde_json::Map::new();
    for (name, server) in mcp {
        if name == "amuxd-remote-tools" {
            continue;
        }
        let obj = match server.as_object() {
            Some(o) => o,
            None => continue,
        };
        if let Some(entry) = pi_server_spec(name, obj) {
            out.insert(name.clone(), entry);
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(out).to_string())
}

fn mcp_servers_from_opencode_json(worktree: &str) -> Option<String> {
    let mut mcp = serde_json::Map::new();
    // Device layer first, team over it, workspace last — the precedence
    // `team_mcp::load_merged_mcp` applies, so pi ends up with the same servers
    // the settings view and the other runtimes report.
    //
    // pi used to skip this layer entirely, which was survivable only because
    // every device server also had a stale copy in some workspace config. It
    // stops being survivable the moment one of them exists *only* here:
    // `teamclu-introspect` moved to this file, `amuxd-send` has always lived
    // here, and without it a cron run on pi is told to call a `send` tool that
    // was never registered.
    //
    // Same `{"mcp": …}` shape as a workspace config, so the entries go in
    // verbatim.
    if let Ok(body) = std::fs::read_to_string(crate::config::device_mcp::device_mcp_file()) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(servers) = json.get("mcp").and_then(|v| v.as_object()) {
                for (name, server) in servers {
                    mcp.insert(name.clone(), server.clone());
                }
            }
        }
    }
    if let Some(team_id) = crate::config::team_mcp::onboarded_team_id() {
        let path = crate::runtime::team_cloud_config::team_cloud_mcp_file(&team_id);
        if let Ok(body) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, raw) in servers {
                        let Ok(parsed) = serde_json::from_value::<
                            crate::config::team_mcp::CursorMcpServer,
                        >(raw.clone()) else {
                            continue;
                        };
                        let cfg = crate::config::team_mcp::convert_cursor_server(&parsed);
                        if let Ok(val) = serde_json::to_value(cfg) {
                            mcp.insert(name.clone(), val);
                        }
                    }
                }
            }
        }
    }
    let path = Path::new(worktree).join("opencode.json");
    if let Ok(body) = std::fs::read_to_string(&path) {
        if let Ok(root) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(ws) = root.get("mcp").and_then(|v| v.as_object()) {
                for (name, server) in ws {
                    mcp.insert(name.clone(), server.clone());
                }
            }
        }
    }
    mcp_servers_from_value(&serde_json::json!({ "mcp": mcp }))
}

/// Current model id (`provider/model`) from a `get_state` response.
fn model_from_state(state: &serde_json::Value) -> Option<String> {
    let model = state.pointer("/data/model")?;
    let provider = model.get("provider").and_then(|v| v.as_str())?;
    let id = model
        .get("id")
        .or_else(|| model.get("modelId"))
        .and_then(|v| v.as_str())?;
    Some(format!("{provider}/{id}"))
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
    isolation_domain: IsolationDomainKey,
    process_env_revision: ProcessEnvRevision,
    extra_env: HashMap<String, String>,
    force_env_override: bool,
}

/// Append the child's stderr tail to an establish failure.
///
/// A pi child that dies during startup answers nothing and prints nothing to
/// stdout — the reason is on stderr and only there. Reporting the bare
/// "process exited before responding" cost two people half a day each: the
/// actual cause (an MCP bridge whose binary had been renamed) was one line
/// away the whole time.
fn with_stderr_tail(proc: &Arc<PiProcess>, error: String) -> String {
    let tail = proc.stderr_tail();
    if tail.trim().is_empty() {
        return error;
    }
    format!("{error}\n--- pi stderr (last lines) ---\n{tail}")
}

/// The session a child established for us, mode-independently.
struct EstablishedSession {
    acp_session_id: String,
    session_path: String,
    /// Host mode: the session's current leaf entry id (crash-backfill cursor).
    leaf_id: Option<String>,
}

async fn attach(shared: &Arc<Shared>, args: AttachArgs) -> Result<AcpStartupMetadata, String> {
    let worktree = canonical_dir(&args.worktree);
    let key = PoolKey {
        domain: args.isolation_domain,
        env_revision: args.process_env_revision,
        worktree: worktree.clone(),
    };
    let env = SpawnEnv {
        extra_env: args.extra_env,
        force_env_override: args.force_env_override,
        remote_tools_cmd: args
            .mcp_config_path
            .as_deref()
            .and_then(remote_tools_cmd_from_mcp_config),
        mcp_servers: mcp_servers_from_opencode_json(&worktree),
    };
    let proc = shared
        .pool
        .ensure_with_env(shared, &key, env)
        .map_err(|e| e.to_string())?;

    // Resume: acp session id encodes the pi session file path.
    let resume_path = args
        .resume_acp_session_id
        .as_deref()
        .and_then(|id| id.strip_prefix(SESSION_ID_PREFIX))
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    let established = match proc.mode {
        PiSessionMode::Host => {
            host_establish_session(shared, &proc, resume_path, args.forbid_new_session_fallback)
                .await
        }
        PiSessionMode::LegacyRpc => {
            legacy_establish_session(&proc, resume_path, args.forbid_new_session_fallback).await
        }
    }
    .map_err(|e| with_stderr_tail(&proc, e))?;
    let acp_session_id = established.acp_session_id.clone();

    // Model catalog + initial model.
    // A failed catalog read must not fail the attach: the list only populates a
    // picker, and the session is perfectly usable without it — `fill_catalog`
    // backfills from this device's persisted catalog, and `record_catalog`
    // ignores an empty result rather than overwriting a good list with it.
    let available_models = match proc
        .client
        .request(serde_json::json!({"type": "get_available_models"}))
        .await
    {
        Ok(resp) => models_from_response(&resp),
        Err(e) => {
            warn!(error = %e, "pi get_available_models failed");
            Vec::new()
        }
    };
    let mut initial_model = args.initial_model_override.filter(|m| !m.is_empty());
    if let Some((provider, model)) = initial_model.as_deref().and_then(split_model_id) {
        if let Err(e) = proc
            .client
            .request(with_session(
                serde_json::json!({
                    "type": "set_model", "provider": provider, "modelId": model
                }),
                proc.mode,
                &acp_session_id,
            ))
            .await
        {
            warn!(error = %e, "pi initial set_model failed; keeping default");
            initial_model = None;
        }
    }
    if initial_model.is_none() {
        // Same ordering as the opencode backend: pi's own current model (its
        // equivalent of a session's last-used), then the device MRU, then
        // nothing — pi keeps its default if we say nothing. Availability is
        // checked against pi's live catalog so a model it no longer offers
        // falls through instead of being set and failing on the first turn.
        let catalog: Vec<String> = available_models.iter().map(|m| m.id.clone()).collect();
        let pi_current = proc
            .client
            .request(with_session(
                serde_json::json!({"type": "get_state"}),
                proc.mode,
                &acp_session_id,
            ))
            .await
            .ok()
            .and_then(|state| model_from_state(&state));
        initial_model =
            crate::config::first_available(pi_current.into_iter().chain(args.model_mru), &catalog);
    }

    let event_tx = args.event_tx.clone();
    shared.routes.lock().insert(
        acp_session_id.clone(),
        Route {
            event_tx: args.event_tx,
            permission: args.permission,
            pool_key: key,
            session_path: established.session_path,
            turn_active: false,
            turn_reply_to: None,
            turn_requester: None,
            translate: TranslateState::default(),
            last_entry_id: established.leaf_id,
        },
    );

    // Advertise the backend's real slash-command set (extension commands,
    // prompt templates, pi skills). pi can enumerate it at runtime via
    // `get_commands` — unlike opencode, whose set is a static table — so this
    // is the honest list rather than a guess. The frame lands in the handle's
    // event channel and `set_available_commands` caches it for retained state.
    let commands = match proc
        .client
        .request(with_session(
            serde_json::json!({"type": "get_commands"}),
            proc.mode,
            &acp_session_id,
        ))
        .await
    {
        Ok(resp) => commands_from_response(&resp),
        Err(e) => {
            debug!(error = %e, "pi get_commands failed; advertising none");
            Vec::new()
        }
    };
    if !commands.is_empty() {
        emit_frame(
            &event_tx,
            &acp_session_id,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::AvailableCommands(
                    amux::AcpAvailableCommands { commands },
                )),
                model: String::new(),
            },
            None,
        )
        .await;
    }

    info!(
        session_id = %acp_session_id,
        worktree = %worktree,
        mode = ?proc.mode,
        models = available_models.len(),
        initial_model = initial_model.as_deref().unwrap_or(""),
        "pi session attached"
    );
    Ok(AcpStartupMetadata {
        available_models,
        initial_model,
        acp_session_id,
        // Fresh per child spawn, so "same worktree, respawned process" is
        // observable — the pi analogue of an opencode host generation.
        host_generation_id: proc.generation_id.clone(),
        // N/A for pi: `RouteLease` is a counted reservation inside the
        // opencode host pool's drain-then-stop lifecycle. The pi pool has no
        // draining — eviction is kill + lazy respawn, and dead children are
        // dropped by `get()` — so there is no reservation to hold.
        route_lease: None,
    })
}

// ---------------------------------------------------------------------------
// Host mode session handling
// ---------------------------------------------------------------------------

/// Open (or create) a session inside a multi-session host child.
async fn host_establish_session(
    shared: &Arc<Shared>,
    proc: &Arc<PiProcess>,
    resume_path: Option<String>,
    forbid_new_session_fallback: bool,
) -> Result<EstablishedSession, String> {
    evict_over_session_cap(shared, proc).await;
    let response = match resume_path {
        Some(path) => {
            match proc
                .client
                .request(serde_json::json!({"type": "open_session", "sessionPath": path}))
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    if forbid_new_session_fallback {
                        return Err(format!(
                            "pi session {path} not resumable (new-session fallback forbidden): {e}"
                        ));
                    }
                    warn!(path, error = %e, "pi session not resumable; creating a new one");
                    proc.client
                        .request(serde_json::json!({"type": "new_session"}))
                        .await
                        .map_err(|e| format!("pi new_session failed: {e}"))?
                }
            }
        }
        None => proc
            .client
            .request(serde_json::json!({"type": "new_session"}))
            .await
            .map_err(|e| format!("pi new_session failed: {e}"))?,
    };
    let acp_session_id = response
        .pointer("/data/sessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "pi host returned no sessionId".to_string())?;
    let session_path = response
        .pointer("/data/sessionFile")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            acp_session_id
                .strip_prefix(SESSION_ID_PREFIX)
                .map(str::to_string)
        })
        .ok_or_else(|| "pi host returned no sessionFile".to_string())?;
    let leaf_id = response
        .pointer("/data/leafId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    proc.open_sessions
        .lock()
        .insert(acp_session_id.clone(), std::time::Instant::now());
    Ok(EstablishedSession {
        acp_session_id,
        session_path,
        leaf_id,
    })
}

/// Keep the host's open-session count under the soft cap: `close_session` the
/// least recently used *idle* session. Its route stays; the next prompt
/// reopens it from its jsonl. When every open session is mid-turn nothing is
/// evicted — destroying a live turn to enforce a cap would be the exact
/// failure this backend exists to remove.
async fn evict_over_session_cap(shared: &Arc<Shared>, proc: &Arc<PiProcess>) {
    let victim = {
        let open = proc.open_sessions.lock();
        if open.len() < process::MAX_OPEN_SESSIONS_PER_HOST {
            return;
        }
        let routes = shared.routes.lock();
        open.iter()
            .filter(|(id, _)| {
                routes
                    .get(id.as_str())
                    .map(|r| !r.turn_active)
                    .unwrap_or(true)
            })
            .min_by_key(|(_, last_used)| **last_used)
            .map(|(id, _)| id.clone())
    };
    let Some(victim) = victim else {
        return;
    };
    if let Err(e) = proc
        .client
        .request(serde_json::json!({"type": "close_session", "sessionId": victim}))
        .await
    {
        warn!(session_id = %victim, error = %e, "pi idle session close failed");
    }
    proc.open_sessions.lock().remove(&victim);
    info!(session_id = %victim, "pi idle session evicted from host (over cap)");
}

// ---------------------------------------------------------------------------
// Legacy (--mode rpc) session handling
// ---------------------------------------------------------------------------

/// Establish the session on a single-session child: attach replaces whatever
/// session the child holds, so it is subject to the same guard as a
/// prompt-driven switch — resuming stored sessions one after another is how a
/// live turn got aborted out from under its sender.
async fn legacy_establish_session(
    proc: &Arc<PiProcess>,
    resume_path: Option<String>,
    forbid_new_session_fallback: bool,
) -> Result<EstablishedSession, String> {
    let _switching = proc.switch_lock.lock().await;
    let session_path = match resume_path {
        Some(path) => {
            guard_switch(proc, &path).await.map_err(|e| e.to_string())?;
            let switch = proc
                .client
                .request(serde_json::json!({"type": "switch_session", "sessionPath": path}))
                .await;
            let cancelled = switch
                .as_ref()
                .map(|r| r.pointer("/data/cancelled").and_then(|v| v.as_bool()) == Some(true))
                .unwrap_or(false);
            match switch {
                Ok(_) if !cancelled => path,
                other => {
                    let reason = match other {
                        Err(e) => e.to_string(),
                        Ok(_) => "switch cancelled by extension".to_string(),
                    };
                    if forbid_new_session_fallback {
                        return Err(format!(
                            "pi session {path} not resumable (new-session fallback forbidden): {reason}"
                        ));
                    }
                    warn!(path, reason, "pi session not resumable; creating a new one");
                    legacy_new_session_path(&proc.client).await?
                }
            }
        }
        // `new_session` replaces the held session too, so it needs the same
        // guard — a fresh chat must not abort a turn already running here.
        None => {
            guard_switch(proc, "<new>")
                .await
                .map_err(|e| e.to_string())?;
            legacy_new_session_path(&proc.client).await?
        }
    };
    let acp_session_id = format!("{SESSION_ID_PREFIX}{session_path}");
    *proc.active_acp_session.lock() = Some(acp_session_id.clone());
    Ok(EstablishedSession {
        acp_session_id,
        session_path,
        leaf_id: None,
    })
}

async fn legacy_new_session_path(client: &client::PiClient) -> Result<String, String> {
    client
        .request(serde_json::json!({"type": "new_session"}))
        .await
        .map_err(|e| format!("pi new_session failed: {e}"))?;
    let state = client
        .request(serde_json::json!({"type": "get_state"}))
        .await
        .map_err(|e| format!("pi get_state failed: {e}"))?;
    state
        .pointer("/data/sessionFile")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "pi get_state returned no sessionFile".to_string())
}

/// Is this legacy pi child mid-turn right now?
///
/// Asked of pi rather than tracked locally: `Route::turn_active` is this
/// daemon's own bookkeeping and can disagree with the child (a turn started
/// through another path, a reply that landed between our reads). `get_state`
/// is the child's own answer.
///
/// A failed or malformed probe reports "busy". Refusing to switch costs a
/// retry; switching into a live turn destroys it (see `guard_switch`).
async fn pi_is_busy(proc: &PiProcess) -> bool {
    match proc
        .client
        .request(serde_json::json!({"type": "get_state"}))
        .await
    {
        Ok(state) => {
            let streaming = state
                .pointer("/data/isStreaming")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let compacting = state
                .pointer("/data/isCompacting")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            streaming || compacting
        }
        Err(e) => {
            warn!(error = %e, "pi get_state failed; treating the child as busy");
            true
        }
    }
}

/// Refuse to switch a legacy pi child that is mid-turn.
///
/// `pi --mode rpc` carries one session at a time, and `switch_session` does
/// not park the outgoing session — `teardownCurrent` calls `session.abort()`
/// and disposes it, then re-subscribes to the new one. The aborted turn's
/// `agent_end` is therefore never emitted, so nothing closes the TeamClu turn
/// and the sender waits on a reply that no longer exists.
///
/// The multi-session host does not need (or have) this: sessions there are
/// addressed, not switched.
async fn guard_switch(proc: &PiProcess, target: &str) -> crate::error::Result<()> {
    if pi_is_busy(proc).await {
        let holder = proc.active_acp_session.lock().clone().unwrap_or_default();
        warn!(
            target_session = target,
            holding_session = holder,
            "pi switch refused: child is mid-turn"
        );
        return Err(crate::error::AmuxError::Agent(format!(
            "pi is mid-turn on another session ({holder}); retry when it settles"
        )));
    }
    Ok(())
}

/// Make `session_id` addressable on its child, mode-appropriately:
///
/// - Host: (re)open the session in the host if it is not already open — a
///   respawned child holds nothing, an evicted session was closed. No guard,
///   no switching: other sessions keep running.
/// - Legacy: switch the child's single active session, guarded.
async fn ensure_session_ready(
    shared: &Arc<Shared>,
    session_id: &str,
) -> crate::error::Result<Arc<PiProcess>> {
    let (key, session_path) = {
        let routes = shared.routes.lock();
        let route = routes.get(session_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("unknown pi session {session_id}"))
        })?;
        (route.pool_key.clone(), route.session_path.clone())
    };
    let proc = shared.pool.ensure(shared, &key)?;
    match proc.mode {
        PiSessionMode::Host => {
            let already_open = {
                let mut open = proc.open_sessions.lock();
                match open.get_mut(session_id) {
                    Some(last_used) => {
                        *last_used = std::time::Instant::now();
                        true
                    }
                    None => false,
                }
            };
            if !already_open {
                evict_over_session_cap(shared, &proc).await;
                let opened = proc
                    .client
                    .request(
                        serde_json::json!({"type": "open_session", "sessionPath": session_path}),
                    )
                    .await?;
                let opened_id = opened
                    .pointer("/data/sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if opened_id != session_id {
                    // Would misroute every subsequent event; fail loudly.
                    return Err(crate::error::AmuxError::Agent(format!(
                        "pi host reopened {session_path} as {opened_id}, expected {session_id}"
                    )));
                }
                proc.open_sessions
                    .lock()
                    .insert(session_id.to_string(), std::time::Instant::now());
            }
            Ok(proc)
        }
        PiSessionMode::LegacyRpc => {
            // The whole check-then-switch runs under the lock: two prompts for
            // different sessions could otherwise both see an idle child and
            // both switch, and the second would abort the turn the first just
            // started.
            let _switching = proc.switch_lock.lock().await;
            let is_active = proc.active_acp_session.lock().as_deref() == Some(session_id);
            if !is_active {
                guard_switch(&proc, session_id).await?;
                proc.client
                    .request(
                        serde_json::json!({"type": "switch_session", "sessionPath": session_path}),
                    )
                    .await?;
                *proc.active_acp_session.lock() = Some(session_id.to_string());
            }
            drop(_switching);
            Ok(proc)
        }
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

/// Mid-turn follow-up plan — aligned with opencode_http `do_prompt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PiMidTurnPromptPlan {
    emit_turn_open: bool,
    use_steer: bool,
}

fn pi_mid_turn_prompt_plan(was_turn_active: bool) -> PiMidTurnPromptPlan {
    PiMidTurnPromptPlan {
        emit_turn_open: !was_turn_active,
        use_steer: was_turn_active,
    }
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

    let was_turn_active = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            warn!(session_id, "prompt for unknown pi session");
            return;
        };
        route.turn_active
    };
    let plan = pi_mid_turn_prompt_plan(was_turn_active);

    let event_tx = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            warn!(session_id, "prompt for unknown pi session");
            return;
        };
        route.turn_active = true;
        route.turn_reply_to = reply_to.clone();
        route.turn_requester = requester_actor_id.filter(|id| !id.is_empty());
        route.event_tx.clone()
    };

    crate::runtime::agent_trace::log_prompt_begin(session_id, &text, attachment_urls.len());
    if plan.emit_turn_open {
        emit_frame(
            &event_tx,
            session_id,
            status_change(amux::AgentStatus::Idle, amux::AgentStatus::Active),
            reply_to.clone(),
        )
        .await;
    } else {
        debug!(
            session_id,
            "mid-turn pi prompt: steer without Idle→Active re-emit"
        );
    }

    let mut message = text;
    crate::runtime::prompt_attachments::substitute_in_message(&mut message, &resolved);
    crate::runtime::prompt_attachments::append_unreferenced(&mut message, &resolved, true);

    let mut prompt_body = serde_json::json!({
        "type": "prompt",
        "message": message,
    });
    // pi reads `streamingBehavior` only while a turn is streaming. Mid-turn
    // follow-ups use `steer` (fold into the live run); idle prompts omit it.
    if plan.use_steer {
        prompt_body["streamingBehavior"] = serde_json::json!("steer");
    }

    let result = match ensure_session_ready(shared, session_id).await {
        Ok(proc) => {
            proc.client
                .request(with_session(prompt_body, proc.mode, session_id))
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
                    message: "pi prompt failed".to_string(),
                    details,
                })),
                model: String::new(),
            },
            reply_to.clone(),
        )
        .await;
        // Close the turn — no turn_end/agent_settled arrives for a failed submit.
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

async fn resolve_permission(
    shared: &Arc<Shared>,
    request_id: &str,
    granted: bool,
    option_id: Option<String>,
) {
    let Some(pending) = shared.permissions.lock().remove(request_id) else {
        warn!(request_id, "no pending pi permission request found");
        return;
    };
    let session_id = pending.session_id;
    let pool_key = shared
        .routes
        .lock()
        .get(&session_id)
        .map(|r| r.pool_key.clone());
    let Some(pool_key) = pool_key else {
        warn!(request_id, session_id = %session_id, "permission respond: session unrouted");
        return;
    };
    // The dialog channel only carries a confirmed boolean, so an "always"
    // grant is encoded by writing the pattern into the rules file the
    // extension re-reads per tool call.
    if granted && option_id.as_deref() == Some("always") {
        if let Some(pattern) = pending.always_pattern.as_deref() {
            let rules_file = process::permissions_file_for(&pool_key.worktree);
            match process::append_always_pattern(&rules_file, pattern) {
                Ok(()) => info!(request_id, pattern, "pi always-allow pattern persisted"),
                Err(e) => warn!(request_id, pattern, error = %e,
                                "pi always-allow pattern write failed"),
            }
        }
    }
    let Some(proc) = shared.pool.get(&pool_key) else {
        warn!(request_id, worktree = %pool_key.worktree, "permission respond: pi process gone");
        return;
    };
    if let Err(e) = proc
        .client
        .notify(serde_json::json!({
            "type": "extension_ui_response", "id": request_id, "confirmed": granted
        }))
        .await
    {
        warn!(request_id, session_id = %session_id, error = %e, "pi permission respond failed");
    }
}

/// Forward a user's answer (or rejection) to a pending `question` select.
/// `answers_json` is the client's `[[selected labels], ...]` — passed through
/// as the dialog's `value`; the TeamClu extension parses it back into
/// per-question answers for the model.
async fn answer_question(shared: &Arc<Shared>, request_id: &str, answers_json: &str, reject: bool) {
    let Some(session_id) = shared.questions.lock().remove(request_id) else {
        warn!(request_id, "no pending pi question request found");
        return;
    };
    let pool_key = shared
        .routes
        .lock()
        .get(&session_id)
        .map(|r| r.pool_key.clone());
    let Some(pool_key) = pool_key else {
        warn!(request_id, session_id = %session_id, "question reply: session unrouted");
        return;
    };
    let Some(proc) = shared.pool.get(&pool_key) else {
        warn!(request_id, worktree = %pool_key.worktree, "question reply: pi process gone");
        return;
    };
    let response = if reject {
        serde_json::json!({"type": "extension_ui_response", "id": request_id, "cancelled": true})
    } else {
        serde_json::json!({"type": "extension_ui_response", "id": request_id, "value": answers_json})
    };
    if let Err(e) = proc.client.notify(response).await {
        warn!(request_id, session_id = %session_id, error = %e, "pi question reply failed");
        // Leave a chance to retry: re-register the request.
        shared
            .questions
            .lock()
            .insert(request_id.to_string(), session_id);
    }
}

async fn command_loop(shared: Arc<Shared>, mut cmd_rx: mpsc::Receiver<AcpCommand>) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            AcpCommand::AttachSession { startup_tx, .. } => {
                // Attach flows through `PiRpcBackend::attach_session` (the
                // manager calls the trait method directly, and only it carries
                // the isolation domain + env the pool key needs). The channel
                // variant has no sender for pi; answer instead of hanging one.
                let _ = startup_tx.send(Err(
                    "pi backend: attach must go through AgentBackend::attach_session".to_string(),
                ));
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
                let pool_key = shared
                    .routes
                    .lock()
                    .get(&acp_session_id)
                    .map(|r| r.pool_key.clone());
                match pool_key.and_then(|k| shared.pool.get(&k).map(|p| (k, p))) {
                    Some((_key, proc)) => {
                        let cancel = proc
                            .client
                            .request(with_session(
                                serde_json::json!({"type": "abort"}),
                                proc.mode,
                                &acp_session_id,
                            ))
                            .await;
                        match cancel {
                            Ok(_) => {
                                crate::runtime::agent_trace::log_cancel(&acp_session_id, true, "")
                            }
                            Err(e) => {
                                let err = e.to_string();
                                crate::runtime::agent_trace::log_cancel(
                                    &acp_session_id,
                                    false,
                                    &err,
                                );
                                warn!(acp_session_id, error = %err, "pi abort failed");
                                match proc.mode {
                                    // Host children answer commands mid-turn
                                    // (the command loop is not blocked by a
                                    // running turn), so a failed abort means
                                    // the child itself is gone or wedged —
                                    // its EOF sweep settles every session.
                                    // Killing it here would abort every OTHER
                                    // session on this worktree to cancel one.
                                    PiSessionMode::Host => {}
                                    // Legacy: `abort` rides the same stdin the
                                    // turn is streaming over, and a mid-turn
                                    // child does not answer it — which is
                                    // precisely when someone asks to cancel.
                                    // Nothing else can free the session, so
                                    // take the child down; the next message
                                    // respawns it and reloads from jsonl. The
                                    // blast radius is every session on this
                                    // worktree, which is the same set the
                                    // wedged child was already blocking.
                                    PiSessionMode::LegacyRpc => {
                                        proc.kill();
                                        warn!(
                                            acp_session_id,
                                            "pi ignored abort while mid-turn; killed the child so the session is not wedged"
                                        );
                                    }
                                }
                            }
                        }
                    }
                    None => warn!(acp_session_id, "cancel: pi process not running"),
                }
                // Settle the turn ourselves rather than waiting for pi to emit a
                // post-abort `turn_end`/`agent_settled` — pi does not reliably
                // send one, which left the UI hanging in "replying" after an
                // interrupt. close_turn is idempotent (guards on turn_active) so
                // a later lifecycle event is a harmless no-op.
                events::close_turn(&shared, &acp_session_id).await;
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
            } => match split_model_id(&model_id) {
                Some((provider, model)) => {
                    // pi's model is session-level: address (or switch to) the
                    // session, then set.
                    let result = match ensure_session_ready(&shared, &acp_session_id).await {
                        Ok(proc) => {
                            proc.client
                                .request(with_session(
                                    serde_json::json!({
                                        "type": "set_model",
                                        "provider": provider,
                                        "modelId": model,
                                    }),
                                    proc.mode,
                                    &acp_session_id,
                                ))
                                .await
                        }
                        Err(e) => Err(e),
                    };
                    match result {
                        Ok(_) => info!(acp_session_id, model_id = %model_id, "pi model set"),
                        Err(e) => warn!(acp_session_id, error = %e, "pi set_model failed"),
                    }
                }
                None => warn!(model_id = %model_id, "set_model: expected provider/model id"),
            },
            AcpCommand::DetachSession {
                acp_session_id,
                ack,
            } => {
                let removed = shared.routes.lock().remove(&acp_session_id);
                shared
                    .permissions
                    .lock()
                    .retain(|_, p| p.session_id != acp_session_id);
                shared
                    .questions
                    .lock()
                    .retain(|_, sid| sid != &acp_session_id);
                // Host mode: also release the session inside the child —
                // detaching used to only drop routing state, leaving the
                // `AgentSession` (and its memory) resident until process
                // death. `dispose` in the host persists any in-flight work
                // first.
                if let Some(route) = removed {
                    if let Some(proc) = shared.pool.get(&route.pool_key) {
                        if proc.mode == PiSessionMode::Host
                            && proc.open_sessions.lock().remove(&acp_session_id).is_some()
                        {
                            if let Err(e) = proc
                                .client
                                .request(serde_json::json!({
                                    "type": "close_session", "sessionId": acp_session_id
                                }))
                                .await
                            {
                                warn!(acp_session_id, error = %e, "pi close_session on detach failed");
                            }
                        }
                    }
                }
                info!(acp_session_id, "pi session detached");
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
            }
            AcpCommand::Shutdown => {
                shared.pool.kill_all();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// PiRpcBackend
// ---------------------------------------------------------------------------

/// The pi backend behind the backend-neutral [`AgentBackend`] trait.
pub struct PiRpcBackend {
    shared: Arc<Shared>,
    cmd_tx: std::sync::OnceLock<mpsc::Sender<AcpCommand>>,
}

impl PiRpcBackend {
    pub fn new() -> Self {
        Self {
            shared: Shared::new(),
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

    fn apply_binary_hint(&self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        // Only the pi launch config may override the pi binary. Reading every
        // launch config (as before) picked up the claude/codex/opencode full
        // paths and made pi_rpc spawn the wrong binary. A plain "pi" here is
        // treated as unconfigured by `set_binary_hint`, so the override only
        // sticks for a genuine `[agents.pi].binary` path.
        if let Some(pi) = launch_configs.get(&amux::AgentType::Pi) {
            self.shared.pool.set_binary_hint(&pi.binary);
        }
    }
}

impl Default for PiRpcBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentBackend for PiRpcBackend {
    fn attach_context_service(
        &mut self,
        service: std::sync::Arc<crate::runtime::context_service::RuntimeContextService>,
    ) {
        self.shared.pool.attach_context_service(service);
    }

    async fn attach_session(
        &mut self,
        _agent_type: amux::AgentType,
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
        _initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        permission: PermissionPolicy,
        forbid_new_session_fallback: bool,
        _teamclu_session_id: String,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        // NOTE: `launch` is `launch_config_for(agent_type)` for whatever agent
        // type the session carries (possibly a stored claude/codex/opencode
        // session), NOT necessarily pi. Its binary is an unrelated full path, so
        // it must NOT drive the pi binary — doing so made pi_rpc spawn
        // claude/codex and fail with "process exited before responding". The pi
        // binary is resolved independently via `resolve_binary` (PATH / ~/.pi).
        let _ = &launch;
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
                isolation_domain,
                process_env_revision,
                extra_env,
                force_env_override,
            },
        )
        .await
        .map_err(crate::error::AmuxError::Agent)?;
        Ok((cmd_tx, startup))
    }

    async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        // Processes are per (domain, env, worktree); nothing to warm without
        // an execution context. The binary hint is still worth capturing.
        self.apply_binary_hint(launch_configs);
    }

    async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        _extra_env: HashMap<String, String>,
        _force_env_override: bool,
        worktree: Option<&str>,
    ) {
        self.apply_binary_hint(launch_configs);
        // Without an isolation domain there is no pool key to warm — spawning
        // under a made-up key would never match the session's real key and the
        // child would be respawned at attach anyway. The workspace prewarm
        // (`prewarm_workspace`) is the real warm path for pi.
        if let Some(worktree) = worktree.filter(|w| !w.is_empty()) {
            debug!(worktree, "pi prewarm without isolation domain skipped");
        }
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
        self.apply_binary_hint(launch_configs);
        let worktree = canonical_dir(worktree);
        let key = PoolKey {
            domain: isolation_domain,
            env_revision: process_env_revision,
            worktree: worktree.clone(),
        };
        let env = SpawnEnv {
            extra_env,
            force_env_override,
            // The remote-tools command arrives with the session's mcp config
            // at attach; a prewarm that predates it respawns then (fingerprint
            // change), same as before.
            remote_tools_cmd: None,
            mcp_servers: mcp_servers_from_opencode_json(&worktree),
        };
        if let Err(e) = self.shared.pool.ensure_with_env(&self.shared, &key, env) {
            warn!(worktree, error = %e, "pi prewarm failed");
        } else {
            info!(worktree, "pi prewarmed");
        }
    }

    fn evict_agent_types(&mut self, agent_types: &[amux::AgentType]) -> usize {
        // Only a pi eviction concerns this backend — the old `kill_all()` on
        // ANY agent type tore down every pi child when e.g. opencode auth
        // changed.
        if agent_types.contains(&amux::AgentType::Pi) {
            self.shared.pool.kill_all()
        } else {
            0
        }
    }

    fn invalidate_workspace_host(&mut self, domain: &IsolationDomainKey) -> bool {
        // Precise per-domain invalidation; other workspaces' children keep
        // running (the trait default would have evicted nothing for pi).
        self.shared.pool.kill_domain(domain) > 0
    }

    fn invalidate_all_workspace_hosts(&mut self) -> usize {
        self.shared.pool.kill_all()
    }

    fn host_count(&self) -> usize {
        self.shared.pool.live_count()
    }

    async fn model_catalog(
        &mut self,
        workspace_path: &Path,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let worktree = canonical_dir(&workspace_path.to_string_lossy());
        // Prefer any live child (the model catalog is host-level in both
        // modes). If none is live, spawn one for this worktree — pi models
        // come from a running child, and there is no static fallback table, so
        // a catalog request must be allowed to bring a process up (mirrors the
        // opencode backend's `serve.ensure()`). The synthetic domain keeps the
        // probe child from colliding with (or masquerading as) a session's.
        let proc = match self.shared.pool.any_live() {
            Some(proc) => proc,
            None => {
                let key = PoolKey {
                    domain: IsolationDomainKey::Workspace(format!(
                        "pi-catalog:{}",
                        process::worktree_hash(&worktree)
                    )),
                    env_revision: ProcessEnvRevision::from_bindings(&HashMap::new()),
                    worktree,
                };
                self.shared.pool.ensure(&self.shared, &key)?
            }
        };
        let resp = proc
            .client
            .request(serde_json::json!({"type": "get_available_models"}))
            .await?;
        Ok(models_from_response(&resp))
    }

    async fn model_catalog_for_context(
        &mut self,
        workspace_path: &Path,
        isolation_domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let worktree = canonical_dir(&workspace_path.to_string_lossy());
        let key = PoolKey {
            domain: isolation_domain,
            env_revision: process_env_revision,
            worktree: worktree.clone(),
        };
        let env = SpawnEnv {
            extra_env,
            force_env_override: false,
            remote_tools_cmd: None,
            mcp_servers: mcp_servers_from_opencode_json(&worktree),
        };
        // `ensure_for_catalog`, never `ensure_with_env`: this env is missing
        // fields the attach env has, so its fingerprint can never match and
        // `ensure` would kill the session's child to spawn a probe one.
        let proc = self
            .shared
            .pool
            .ensure_for_catalog(&self.shared, &key, env)?;
        let resp = proc
            .client
            .request(serde_json::json!({"type": "get_available_models"}))
            .await?;
        Ok(models_from_response(&resp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mid_turn_prompt_plan_steers_without_turn_open() {
        let idle = pi_mid_turn_prompt_plan(false);
        assert!(idle.emit_turn_open);
        assert!(!idle.use_steer);

        let busy = pi_mid_turn_prompt_plan(true);
        assert!(!busy.emit_turn_open);
        assert!(busy.use_steer);
    }

    #[test]
    fn split_model_id_at_first_slash() {
        assert_eq!(
            split_model_id("anthropic/claude-sonnet-4-5"),
            Some(("anthropic".into(), "claude-sonnet-4-5".into()))
        );
        // model ids may themselves contain '/'
        assert_eq!(
            split_model_id("openrouter/meta/llama-3"),
            Some(("openrouter".into(), "meta/llama-3".into()))
        );
        assert_eq!(split_model_id("nomodel"), None);
        assert_eq!(split_model_id("/x"), None);
    }

    #[test]
    fn models_from_response_maps_provider_slash_id() {
        let resp = serde_json::json!({
            "type": "response", "command": "get_available_models", "success": true,
            "data": { "models": [
                {"provider": "anthropic", "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"},
                {"provider": "openai", "modelId": "gpt-5"},
                {"provider": "x"}
            ]}
        });
        let models = models_from_response(&resp);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-5");
        assert_eq!(models[0].display_name, "Claude Sonnet 4.5");
        assert_eq!(models[0].provider_name, "anthropic");
        assert_eq!(models[1].id, "openai/gpt-5");
        assert_eq!(models[1].display_name, "gpt-5");
    }

    #[test]
    fn commands_from_response_maps_real_list() {
        let resp = serde_json::json!({
            "type": "response", "command": "get_commands", "success": true,
            "data": { "commands": [
                {"name": "review", "description": "Review the diff", "source": "prompt"},
                {"name": "skill:deploy", "description": "Deploy", "source": "skill"},
                {"name": "", "description": "nameless"}
            ]}
        });
        let commands = commands_from_response(&resp);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].description, "Review the diff");
        assert_eq!(commands[1].name, "skill:deploy");
        // Malformed / empty responses degrade to "advertise nothing".
        assert!(commands_from_response(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn model_from_state_formats_provider_slash_id() {
        let state = serde_json::json!({
            "type": "response", "command": "get_state", "success": true,
            "data": { "model": {"provider": "anthropic", "id": "claude-sonnet-4-5"},
                      "sessionFile": "/tmp/s.jsonl", "sessionId": "abc" }
        });
        assert_eq!(
            model_from_state(&state),
            Some("anthropic/claude-sonnet-4-5".to_string())
        );
        assert_eq!(model_from_state(&serde_json::json!({"data": {}})), None);
    }

    #[test]
    fn with_session_stamps_host_commands_only() {
        let host = with_session(
            serde_json::json!({"type": "abort"}),
            PiSessionMode::Host,
            "pi:/s/a.jsonl",
        );
        assert_eq!(host["sessionId"], "pi:/s/a.jsonl");
        let legacy = with_session(
            serde_json::json!({"type": "abort"}),
            PiSessionMode::LegacyRpc,
            "pi:/s/a.jsonl",
        );
        assert!(legacy.get("sessionId").is_none());
    }

    #[test]
    fn remote_tools_cmd_extracted_from_mcp_config_shape() {
        let root = serde_json::json!({
            "mcpServers": {
                "amuxd-remote-tools": {
                    "command": "/usr/local/bin/amuxd",
                    "args": ["remote-tools-mcp", "--sock=/tmp/amuxd.sock"]
                }
            }
        });
        assert_eq!(
            remote_tools_cmd_from_value(&root).as_deref(),
            Some(r#"["/usr/local/bin/amuxd","remote-tools-mcp","--sock=/tmp/amuxd.sock"]"#)
        );
        // Other servers present but no amuxd-remote-tools → None.
        let other = serde_json::json!({"mcpServers": {"something-else": {"command": "x"}}});
        assert_eq!(remote_tools_cmd_from_value(&other), None);
        assert_eq!(remote_tools_cmd_from_value(&serde_json::json!({})), None);
        // Missing command → None.
        let no_cmd = serde_json::json!({"mcpServers": {"amuxd-remote-tools": {"args": ["a"]}}});
        assert_eq!(remote_tools_cmd_from_value(&no_cmd), None);
    }

    #[test]
    fn remote_tools_cmd_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-tools-host.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"amuxd-remote-tools":{"command":"amuxd","args":["remote-tools-mcp"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            remote_tools_cmd_from_mcp_config(&path).as_deref(),
            Some(r#"["amuxd","remote-tools-mcp"]"#)
        );
        assert_eq!(
            remote_tools_cmd_from_mcp_config(&dir.path().join("missing.json")),
            None
        );
    }

    #[tokio::test]
    async fn host_count_zero_without_processes() {
        let backend = PiRpcBackend::new();
        assert_eq!(backend.host_count(), 0);
    }

    #[tokio::test]
    async fn evict_only_reacts_to_pi_agent_type() {
        let mut backend = PiRpcBackend::new();
        // Another backend's auth change must not tear down pi children (the
        // old implementation kill_all()ed regardless of the requested types).
        assert_eq!(backend.evict_agent_types(&[amux::AgentType::Opencode]), 0);
        assert_eq!(
            backend.evict_agent_types(&[amux::AgentType::Pi]),
            0,
            "no live children yet, but the pi arm is reachable"
        );
    }

    #[tokio::test]
    async fn model_catalog_spawns_when_no_process_live() {
        // No static fallback: with no live process the catalog request must try
        // to bring a pi child up. Point the pool at a binary that cannot exist
        // so the spawn fails deterministically (instead of returning a phantom
        // empty list) — proving the code path attempts to spawn rather than
        // short-circuiting to `Ok(vec![])`.
        let mut backend = PiRpcBackend::new();
        backend
            .shared
            .pool
            .set_binary_hint("/nonexistent/teamclu-pi-does-not-exist");
        let result = backend.model_catalog(Path::new("/tmp")).await;
        assert!(
            result.is_err(),
            "expected spawn attempt to fail, got {result:?}"
        );
    }

    #[test]
    fn the_device_layer_reaches_pi_and_the_workspace_still_outranks_it() {
        // pi read only team + workspace, so a server that lives only in the
        // device file — `amuxd-send`, and now `teamclu-introspect` — never
        // reached it. A cron run told to call `send` found no such tool.
        let home = tempfile::tempdir().unwrap();
        let _env = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            crate::config::device_mcp::device_mcp_file(),
            r#"{"mcp":{"amuxd-send":{"type":"local","command":["amuxd","mcp-server"]},
                       "shared":{"type":"local","command":["device","version"]}}}"#,
        )
        .unwrap();

        let worktree = tempfile::tempdir().unwrap();
        std::fs::write(
            worktree.path().join("opencode.json"),
            r#"{"mcp":{"shared":{"type":"local","command":["workspace","version"]}}}"#,
        )
        .unwrap();

        let payload =
            mcp_servers_from_opencode_json(worktree.path().to_str().unwrap()).expect("payload");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            parsed["amuxd-send"]["command"],
            serde_json::json!(["amuxd", "mcp-server"]),
            "device-only server must reach pi"
        );
        // Device first, workspace last: a local override still wins.
        assert_eq!(
            parsed["shared"]["command"],
            serde_json::json!(["workspace", "version"])
        );
    }

    #[test]
    fn dead_command_paths_are_not_bridged_into_pi() {
        // A path that is not on this machine cannot become a working bridge —
        // and one of them (a `teamclaw-introspect` entry left behind by the
        // rename) took every pi session in a workspace down. Bare names are
        // left alone: the child resolves those through its enriched PATH.
        let root = serde_json::json!({
            "mcp": {
                "gone": {"type": "local", "enabled": true,
                         "command": ["/no/such/path/teamclaw-introspect", "--workspace", "/w"]},
                "bare": {"type": "local", "enabled": true,
                         "command": ["npx", "-y", "@scope/server"]},
            }
        });
        let payload = mcp_servers_from_value(&root).expect("bare server survives");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert!(parsed.get("gone").is_none(), "dead path must be dropped");
        assert!(parsed.get("bare").is_some(), "bare name must be kept");
        assert_eq!(parsed["bare"]["type"], serde_json::json!("local"));
    }

    #[test]
    fn remote_servers_are_bridged_with_url_and_headers() {
        // The SDK bridge speaks streamable HTTP / SSE, so a `type: "remote"`
        // entry is no longer dropped: opencode loads these natively and pi has
        // to see the same tool set.
        let root = serde_json::json!({
            "mcp": {
                "hosted": {"type": "remote", "url": "https://example.invalid/mcp",
                           "headers": {"Authorization": "Bearer ${TOKEN}"}},
                "off": {"type": "remote", "enabled": false, "url": "https://example.invalid/mcp"},
                "no-url": {"type": "remote"},
            }
        });
        let payload = mcp_servers_from_value(&root).expect("remote server survives");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["hosted"]["type"], serde_json::json!("remote"));
        assert_eq!(
            parsed["hosted"]["url"],
            serde_json::json!("https://example.invalid/mcp")
        );
        assert_eq!(
            parsed["hosted"]["headers"]["Authorization"],
            serde_json::json!("Bearer ${TOKEN}")
        );
        assert!(parsed.get("off").is_none(), "disabled must be dropped");
        assert!(parsed.get("no-url").is_none(), "url-less must be dropped");
    }

    #[test]
    fn untyped_entries_still_bridge_as_local() {
        // opencode treats a missing `type` with a command as local; the
        // payload must normalize that rather than leave the extension guessing.
        let root = serde_json::json!({
            "mcp": { "bare": {"command": ["npx", "-y", "@scope/server"]} }
        });
        let payload = mcp_servers_from_value(&root).expect("untyped server survives");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["bare"]["type"], serde_json::json!("local"));
        assert_eq!(
            parsed["bare"]["command"],
            serde_json::json!(["npx", "-y", "@scope/server"])
        );
    }

    #[test]
    fn missing_command_path_only_judges_paths() {
        let here = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            missing_command_path(&[serde_json::json!("/no/such/path/x")]).as_deref(),
            Some("/no/such/path/x")
        );
        assert_eq!(missing_command_path(&[serde_json::json!(here)]), None);
        assert_eq!(missing_command_path(&[serde_json::json!("npx")]), None);
        assert_eq!(missing_command_path(&[]), None);
    }
}
