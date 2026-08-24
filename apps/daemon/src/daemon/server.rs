use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use teamclu_transport::MessagePublisher;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::backend::{
    credential_in_proactive_refresh_window, proactive_reconnect_delay, Backend, WorkspaceUpsert,
};
use crate::channels::{AmuxdAgentHandle, AmuxdChannelStore, ChannelManager};
use crate::collab::{AuthManager, AuthResult, PeerState, PeerTracker, PermissionManager};
use crate::config::{DaemonConfig, SessionBinding, SessionStore};
use crate::daemon::binding_target::parse_binding_to_target;
use crate::daemon::runtime_cursor::{
    compute_effective_cursor_from_messages, last_unanswered_mention_idx,
    messages_strictly_after_cursor, slice_has_actionable_inbound,
};
use crate::daemon::runtime_resolution::{
    agent_type_from_name, default_advertised_agent_type, resolve_requested_agent_type,
    runtime_start_initial_model_override, session_message_model_override,
    supported_agent_type_names,
};
use crate::daemon::session_events::{
    format_idea_prompt, message_attachment_urls, parse_mention_actor_ids, resolve_mention_actor_ids,
};
use crate::daemon::session_resume::resolve_backend_session_id;

#[path = "cloud_token_file.rs"]
mod cloud_token_file;
#[path = "collab_runtime_ensure.rs"]
mod collab_runtime_ensure;
#[path = "runtime_env.rs"]
pub(crate) mod runtime_env;
// Cron-style prompt-await handling (`handle_prompt_await` + the cron session
// cache) lives in `server/cron.rs` as a child module so it can reach the
// server's private fields directly.
mod channels;
mod command_executor;
mod cron;
mod messaging;
mod peers_workspaces;
mod remote_tools;
mod rpc;
mod runtime_lifecycle;
use crate::history::EventHistory;
#[cfg(test)]
use crate::mqtt::MqttClient;
use crate::mqtt::{
    publisher::Publisher, subscriber, MqttPublisher, MqttSupervisor, MqttSupervisorEvent,
};
use crate::proto::amux;
use crate::provider_config::ProviderConfig;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::{apply_workspace_system_instructions, AgentLaunchConfig, RuntimeManager};
use teamclu_gateway::{AgentHandle, ChannelStore};

/// Outcome of apply_start_runtime. Success path returns the allocated
/// runtime_id + the session_id (echoed from request or freshly created).
/// Failure path returns a (error_code, error_message, failed_stage) tuple
/// — the caller formats this into whatever wire envelope it emits
/// (legacy AgentStartResult or new RuntimeStartResult).
pub(crate) struct StartRuntimeOutcome {
    runtime_id: String,
    session_id: String,
}

pub(crate) struct StartRuntimeError {
    #[allow(dead_code)]
    error_code: String,
    error_message: String,
    failed_stage: String,
}

fn mark_mqtt_connected(flag: &Option<Arc<std::sync::atomic::AtomicBool>>, connected: bool) {
    if let Some(flag) = flag {
        flag.store(connected, std::sync::atomic::Ordering::Relaxed);
    }
}

pub(crate) use crate::config::workspace_path::is_linkable_workspace_path;

/// Filter cloud `workspaces` rows down to paths that (a) have a non-empty,
/// linkable path and (b) actually exist as a directory *on this machine*.
/// The cloud list spans every device on the team, so most rows will not
/// resolve locally — those are silently skipped, never symlinked.
pub(crate) fn cloud_rows_to_local_linkable_paths(
    rows: &[crate::backend::WorkspaceRow],
) -> Vec<String> {
    rows.iter()
        .filter_map(|row| {
            let path = row.path.as_deref()?.trim();
            if path.is_empty() || !is_linkable_workspace_path(path) {
                return None;
            }
            if !Path::new(path).is_dir() {
                return None;
            }
            Some(path.to_string())
        })
        .collect()
}

/// Per-session plan emitted by
/// [`DaemonServer::plan_auto_restart_offline_sessions`]. Sessions that pass
/// every filter (have a prior runtime, have unread from someone other than
/// this daemon, no live runtime currently serving them) end up in the
/// returned `Vec`.
pub(crate) struct OfflineRestartPlan {
    pub session_id: String,
    pub backend: amux::AgentType,
    pub local_workspace_id: String,
    pub unread_count: usize,
}

pub struct DaemonServer {
    config: DaemonConfig,
    /// Path the daemon's `daemon.toml` was loaded from. Stashed so
    /// `channel-reload` (over `amuxd.sock`) can re-read the latest config
    /// without callers having to thread the path through every helper.
    config_path: PathBuf,
    /// Receiver consumed exactly once by the MQTT supervisor. The publisher
    /// proxy itself is shared with every business module and survives all
    /// connection generations.
    mqtt_command_rx: Option<mpsc::Receiver<crate::mqtt::MqttCommand>>,
    /// Set when running on the NATS transport (`config.transport.kind = "nats"`).
    /// Mutually exclusive with the MQTT supervisor.
    nats: Option<crate::nats::NatsBackend>,
    /// Unified publisher handle. On MQTT it is the generation-independent
    /// supervisor proxy; on NATS it is the active NATS client. All publishing
    /// downstream (Publisher::new_from_handle, teamclu, channels) reads
    /// this so the same handler code works for both backends.
    publisher_handle: Arc<dyn MessagePublisher>,
    /// Mirror of the active backend's `Topics`. Updated alongside
    /// `publisher_handle` during connect/reconnect.
    topics: crate::mqtt::Topics,
    agents: Arc<AsyncMutex<RuntimeManager>>,
    auth: AuthManager,
    peers: PeerTracker,
    permissions: PermissionManager,
    /// Cloud-backed workspace UUID -> {path, team_id} cache. Consumed by
    /// `apply_start_runtime` to resolve `workspace_id` to a filesystem path.
    workspace_resolver: Arc<crate::config::WorkspaceResolver>,
    /// Daemon-owned per-team sync engine (git/OSS). The 300s autonomous timer
    /// and the HTTP `/v1/team/sync` trigger both run through this dispatcher.
    sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    sessions: SessionStore,
    sessions_path: PathBuf,
    history: EventHistory,
    teamclu: Option<crate::teamclu::SessionManager>,
    backend: Arc<dyn Backend>,
    /// The same object as `backend`, typed concretely so the setup endpoint can
    /// install real credentials into an unclaimed daemon at runtime. Every other
    /// caller holds it as `Arc<dyn Backend>` and is unaware of the wrapper.
    deferred_backend: Arc<crate::backend::deferred::DeferredBackend>,
    actor_id: String,
    /// Channel manager (Discord/WeCom/Feishu/Kook/WeChat/Email gateways).
    /// `None` until `start_channels()` runs; held as `Option` so `shutdown(self)`
    /// can be `.take()`n on graceful exit.
    channel_mgr: Option<ChannelManager>,
    /// Maps cron's logical `session_key` (e.g. `"cron/<job_id>/<run_id>"`) to
    /// the acp_session_id of a live agent spawned for that key. With the
    /// current "per-run new session" cron semantics, every prompt-await call
    /// hits the "absent → create" branch, but the lookup-first shape stays
    /// so future code can adopt session reuse without changing the handler.
    cron_sessions: cron::CronSessionCache,
    refresh_watch_registry:
        Option<std::sync::Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
    refresh_coordinator: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    /// Shared flag written by the MQTT event loop and read by `/v1/info`.
    mqtt_connected_flag: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Recovery signal receiver is installed into the supervisor exactly once.
    mqtt_recovery_rx: Option<mpsc::Receiver<crate::mqtt::MqttRecoveryRequest>>,
    mqtt_recovery_handle: crate::mqtt::MqttRecoveryHandle,
    mqtt_snapshot: crate::mqtt::MqttSnapshotHandle,
    /// Resolves the team's cloud-sourced managed (shared) LLM on a short TTL.
    /// Shared with the HTTP layer (`GET /v1/workspaces/:id/providers`) so a
    /// provider read can re-materialize `provider.team` off the same throttled
    /// fetch. Replaces the old disk-mirrored `_meta/provider.json`.
    managed_llm: Arc<crate::runtime::managed_llm::ManagedLlmResolver>,
    /// Local fast-path tee: every session/live publish (same bytes as MQTT,
    /// same event_id) is mirrored here for `GET /v1/live/events` SSE
    /// subscribers, so a same-machine UI is not gated on broker RTT. Held on
    /// the server so re-built `SessionManager`s (reconnect/re-onboard) can be
    /// re-attached via `set_local_tee`.
    live_tee: tokio::sync::broadcast::Sender<crate::teamclu::live::LiveTeeEvent>,
    session_remote_targets: Arc<AsyncMutex<crate::remote_tools::SessionRemoteTargetStore>>,
    remote_tool_turn_contexts: Arc<AsyncMutex<crate::remote_tools::RemoteToolTurnContextStore>>,
    rpc_client: Arc<AsyncMutex<crate::teamclu::rpc::RpcClient>>,
    team_skill_reconciler: Arc<crate::runtime::team_skills::TeamSkillReconciler>,
    /// Answered capability-management requests, keyed on the authorized
    /// (requester, request_id) pair. Shared rather than owned so the handler
    /// can run on its own task instead of on the message pump.
    agent_management_results:
        Arc<AsyncMutex<HashMap<String, (Instant, crate::proto::teamclu::RpcResponse)>>>,
    /// Sender for completed cron turns. `handle_prompt_await` runs the (long)
    /// ACP turn on a background task; when it finishes the task sends the result
    /// here so the active run loop can persist the AgentReply and reply to the
    /// sock client. This keeps the main select loop from being blocked for the
    /// whole turn — otherwise a running cron turn stalls every other sock command
    /// (notably the next run's `cron-prepare-session`, delaying its session_id
    /// stamp and the desktop "Run Now" jump).
    cron_turn_done_tx: mpsc::Sender<cron::CronTurnDone>,
    /// Receiver half, `take()`n by whichever run loop (MQTT or NATS) is active.
    cron_turn_done_rx: Option<mpsc::Receiver<cron::CronTurnDone>>,
    /// Sender for the ACP events of an in-flight cron turn. The turn task owns
    /// the agent's event channel, so nothing else can publish them to
    /// `session/live`; the loop drains this and does it (see
    /// `publish_cron_turn_event`). Bounded and `try_send`-only — the UI must
    /// never be able to stall a model turn.
    cron_turn_event_tx: mpsc::Sender<cron::CronTurnEvent>,
    /// Receiver half, `take()`n by whichever run loop is active.
    cron_turn_event_rx: Option<mpsc::Receiver<cron::CronTurnEvent>>,
}

/// Single control command parsed off `amuxd.sock`. Variants correspond to the
/// `cmd` strings written by `cli::process::send_control`.
#[derive(Debug)]
pub(crate) enum SockCommand {
    /// Graceful daemon exit, requested over the control endpoint. This is the
    /// Windows substitute for SIGTERM (`amuxd stop` sends it); on unix it is
    /// an additional equivalent trigger.
    Shutdown,
    /// Tear down the running channel manager and rebuild from the latest
    /// `daemon.toml`. One-way (no reply).
    ChannelReload,
    /// Reply with a JSON `[{platform, enabled, connected, last_error}, ...]`
    /// snapshot of the six supported channels. `reply_tx` carries the JSON
    /// body back to the listener task so it can write it to the sock client.
    ChannelStatus {
        reply_tx: oneshot::Sender<String>,
    },
    /// Reply with a JSON `[{botId, connected, error}, ...]` snapshot of the
    /// per-bot WeCom gateway slots (one entry per `resolved_bots()`). `reply_tx`
    /// carries the JSON body back to the listener task.
    WecomBotsStatus {
        reply_tx: oneshot::Sender<String>,
    },
    /// Reply with `{keys:[...]}` — the dotted paths of credential fields that
    /// already hold a value, so the settings form can show "configured"
    /// instead of an empty box that looks unset.
    ChannelSecretKeys {
        reply_tx: oneshot::Sender<String>,
    },
    /// Reply with `{chats:[...], errors:[...]}` — every conversation the
    /// configured WeCom bots can be addressed in, asked of each bot's MCP
    /// endpoint. The long connection cannot answer this, which is why a cron
    /// job's target had to be typed in by hand.
    WecomChatList {
        reply_tx: oneshot::Sender<String>,
    },
    /// Replace `daemon_config.channels.<platform>` with the JSON in `config_json`,
    /// persist to `daemon.toml`, and reload the channel manager so the change
    /// takes effect. One-way (no reply).
    ChannelSave {
        platform: String,
        config_json: String,
    },
    /// Replace `daemon_config.channels.model` — the model every gateway session
    /// starts on when the chat has not set its own with `/model` — persist to
    /// team.toml, and reload the channel manager. An empty string clears it,
    /// restoring the unpinned spawn. One-way (no reply).
    GatewayModelSave {
        model: String,
    },
    /// Replace `daemon_config.locale` — the language every gateway replies in,
    /// mirroring the desktop app's UI language — persist to daemon.toml, and
    /// apply it to the running gateways. An empty string clears it, which reads
    /// back as English. Channels are not reloaded: the language is read per
    /// reply. One-way (no reply).
    GatewayLocaleSave {
        locale: String,
    },
    /// Proactive send request from the `amuxd mcp-server` bridge running
    /// as a child of an ACP agent. `payload` is the raw JSON envelope the
    /// bridge wrote to the sock; the daemon parses out binding + channel
    /// + target overrides + content. `reply_tx` receives a single line of
    ///   JSON (`{ "ok": true, "result": ... }` or
    ///   `{ "ok": false, "error": ... }`) the listener writes back.
    McpSend {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Push one message straight at a channel, no reply token involved.
    ///
    /// The desktop's cron delivery is the caller: it is announcing a run's
    /// result, not answering anybody, so there is no chat whose token it could
    /// carry. It used to borrow `mcp-send` with a placeholder binding, which
    /// stopped working the moment that path started demanding a real token —
    /// and demanding one is right, because `mcp-send` speaks for an agent.
    ChannelSend {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Local fast-path RPC from `POST /v1/rpc`. `payload` is the raw
    /// `teamclu.RpcRequest` protobuf bytes (identical to what a client
    /// would publish on `amux/{team}/{actor}/rpc/req`); `reply_tx` receives
    /// the encoded `teamclu.RpcResponse` bytes or a dispatch error.
    LocalRpc {
        payload: Vec<u8>,
        reply_tx: oneshot::Sender<Result<Vec<u8>, String>>,
    },
    /// Local fast-path session/live ingest from `POST /v1/session-live/ingest`.
    /// `payload` is the raw `teamclu.LiveEventEnvelope` protobuf bytes.
    LocalLiveIngest {
        session_id: String,
        payload: Vec<u8>,
        reply_tx: oneshot::Sender<Result<(), String>>,
    },
    /// Remote tool invoke from `amuxd remote-tools-mcp` stdio bridge.
    RemoteToolCall {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Cursor `preToolUse` approval from `amuxd cursor-permission-hook`. The
    /// handler blocks on a human, so it must never run inline on this loop.
    CursorPermission {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Drive one ACP turn to completion for a cron-style logical session.
    /// `payload` is the raw JSON envelope; `handle_prompt_await` parses it
    /// and runs the turn against the local primary agent. `reply_tx`
    /// receives a single line of JSON (`{ "ok": true, "result": { "text": ..., "acp_session_id": ... }}` or
    /// `{ "ok": false, "error": ... }`).
    PromptAwait {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Eagerly create the cloud session for a cron run (no ACP turn), so the
    /// desktop can stamp `session_id` into the run record and navigate to the
    /// session within seconds of "Run Now". Reply is
    /// `{ "ok": true, "result": { "session_id": ... } }` or `{ "ok": false, "error": ... }`.
    CronPrepareSession {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Re-prewarm ACP hosts for a workspace after a provider/env reload evicted
    /// them (bridged from `RuntimeSupervisor`'s prewarm notifier). One-way.
    PrewarmWorkspace {
        workspace_id: String,
        path: String,
    },
    /// Fetch a fresh WeChat (iLink) bot QR code. One-shot HTTP call to the
    /// ilink backend via `teamclu_gateway::wechat::fetch_qr_code`. Reply is
    /// `{ok, result?, error?}` where result is the raw `WeChatQrLoginResponse`.
    WechatQrStart {
        reply_tx: oneshot::Sender<String>,
    },
    /// Poll the status of a previously-started WeChat QR code.
    /// Reply shape: `{ok, result?, error?}` with `WeChatQrStatusResponse`.
    WechatQrPoll {
        qrcode: String,
        reply_tx: oneshot::Sender<String>,
    },
    /// Generate a WeCom QR auth start payload (scode + auth_url).
    /// Reply shape: `{ok, result?, error?}` with `WeComQrAuthStart`.
    WecomQrStart {
        reply_tx: oneshot::Sender<String>,
    },
    /// Poll the status of a WeCom QR auth scode.
    /// Reply shape: `{ok, result?, error?}` with `WeComQrAuthPollResult`.
    WecomQrPoll {
        scode: String,
        reply_tx: oneshot::Sender<String>,
    },
    /// Register a workspace into the cloud `amux.workspaces` table,
    /// idempotently. Fed by the HTTP control plane (`POST /v1/workspaces`)
    /// via the register-workspace bridge — the actor command loop owns all
    /// cloud upserts, so the HTTP task cannot race a direct write. Reply is
    /// a single JSON line (`{ok, result?, error?}`) with
    /// `{workspace_id, path, display_name}`.
    AddWorkspace {
        path: String,
        reply_tx: oneshot::Sender<String>,
    },
    Unknown(String),
}

/// Load onboarding config, or `None` when this daemon has never been onboarded.
///
/// `None` is a first-run state, not a failure: the daemon starts unclaimed so
/// its HTTP control plane can serve the setup UI that performs the onboarding.
/// A *corrupt* config still errors — see [`ProviderConfig::exists_at`].
fn load_provider_config_from_default_paths() -> crate::error::Result<Option<ProviderConfig>> {
    let backend_path = ProviderConfig::default_path()
        .map_err(|e| crate::error::AmuxError::Config(format!("backend config path failed: {e}")))?;

    if !ProviderConfig::exists_at(&backend_path) {
        return Ok(None);
    }

    ProviderConfig::load_from_path(&backend_path)
        .map(Some)
        .map_err(|e| crate::error::AmuxError::Config(format!("backend config init failed: {e}")))
}

pub fn backend_from_provider_config(
    config: ProviderConfig,
) -> crate::error::Result<Arc<dyn Backend>> {
    match config {
        ProviderConfig::CloudApi(config) => {
            // Rotated refresh tokens are written back to the same backend.toml
            // we loaded from, so the daemon survives restarts.
            let persist_path = ProviderConfig::default_path().map_err(|e| {
                crate::error::AmuxError::Config(format!("backend config path failed: {e}"))
            })?;
            Ok(Arc::new(
                crate::backend::cloud_api::CloudApiBackend::with_persist_path(config, persist_path),
            ))
        }
    }
}

/// Persist a bootstrap-resolved broker to `daemon.toml` so it survives a
/// restart. Without this the address lives only in memory, and a Cloud API that
/// answers 200 *without* an `mqtt` block after the restart leaves the daemon
/// with no broker at all — the 2026-07-28 outage (issue #634).
///
/// Best-effort: a read-only or malformed `daemon.toml` must not take MQTT down,
/// since the in-memory value already works for this process.
fn persist_broker_url(config_path: &std::path::Path, broker_url: &str) {
    match crate::config::edit::set_config_toml_value(
        config_path,
        "mqtt.broker_url",
        toml::Value::String(broker_url.to_string()),
    ) {
        Ok(()) => info!(
            broker = %broker_url,
            path = %config_path.display(),
            "persisted bootstrap broker to daemon.toml as last-known"
        ),
        Err(e) => warn!(
            error = %e,
            path = %config_path.display(),
            "could not persist bootstrap broker; it stays in-memory only and \
             will be lost on restart"
        ),
    }
}

/// Resolve the MQTT broker from `/v1/config/bootstrap`. The Cloud API is the
/// authoritative source: a fetched value wins (so operators can rotate the
/// broker without redeploying daemons), and falls back to whatever
/// `daemon.toml` already holds — an invite `?broker=` override, or the
/// last-known address persisted by an earlier successful bootstrap.
///
/// Never fails: if neither yields a broker URL the daemon warns and continues
/// with an empty `broker_url`, which puts MQTT on a placeholder client while
/// the HTTP/local control plane stays up. That degraded mode is what lets an
/// un-onboarded daemon serve its own setup UI.
async fn apply_bootstrap_overrides(
    backend: &Arc<dyn Backend>,
    config: &mut DaemonConfig,
    config_path: &std::path::Path,
) -> crate::error::Result<()> {
    match backend.fetch_bootstrap_mqtt().await {
        Ok(Some(mqtt)) if !mqtt.url.trim().is_empty() => {
            let previous = std::mem::replace(&mut config.mqtt.broker_url, mqtt.url);
            if mqtt.username.is_some() {
                config.mqtt.username = mqtt.username;
            }
            if mqtt.password.is_some() {
                config.mqtt.password = mqtt.password;
            }
            info!(
                previous_broker = %previous,
                broker = %config.mqtt.broker_url,
                "applied bootstrap mqtt override from cloud api"
            );
            // Only rewrite when the address actually moved — a steady-state
            // daemon re-fetching bootstrap should not touch the file.
            if previous != config.mqtt.broker_url {
                persist_broker_url(config_path, &config.mqtt.broker_url);
            }
        }
        // A 200 with no `mqtt` block (or an empty url) is the failure mode that
        // reads as success. Keep whatever daemon.toml holds and say so loudly —
        // silently continuing here is what made the outage invisible.
        Ok(_) => {
            if config.mqtt.broker_url.trim().is_empty() {
                warn!(
                    "cloud api bootstrap returned no MQTT broker and no last-known \
                     address is on disk; MQTT stays down until the cloud config is fixed"
                );
            } else {
                warn!(
                    broker = %config.mqtt.broker_url,
                    "cloud api bootstrap returned no MQTT broker; continuing with the \
                     last-known address from daemon.toml (cloud config may be misconfigured)"
                );
            }
        }
        Err(e) => {
            // Keep the on-disk address (if any); the empty-check below decides.
            tracing::warn!(error = %e, "bootstrap mqtt fetch failed; relying on last-known broker in daemon.toml if present");
        }
    }

    if config.mqtt.broker_url.trim().is_empty() {
        warn!(
            "no MQTT broker configured (bootstrap fetch failed or invite had no `?broker=`); \
             HTTP/local control plane will start and MQTT/collab will retry once a broker is known"
        );
    }
    Ok(())
}

/// The daemon's real onboarding, exposed to `/v1/setup/*`.
///
/// Lives here rather than in `http::setup` because it reaches into
/// `crate::onboarding` and `backend_from_provider_config`, which the
/// `#[path]`-included HTTP test crates do not have.
struct DaemonOnboarding {
    deferred: Arc<crate::backend::deferred::DeferredBackend>,
}

#[async_trait::async_trait]
impl crate::http::setup::OnboardingService for DaemonOnboarding {
    fn is_claimed(&self) -> bool {
        self.deferred.is_claimed()
    }

    fn identity(&self) -> Option<(String, String)> {
        self.deferred.is_claimed().then(|| {
            (
                self.deferred.actor_id().to_string(),
                self.deferred.team_id().to_string(),
            )
        })
    }

    async fn claim(&self, invite_url: &str) -> Result<crate::http::setup::ClaimOutcome, String> {
        // Same path `amuxd init` takes (writes backend.toml + daemon.toml), so
        // the CLI and the setup UI cannot drift on what onboarding means.
        let outcome = crate::onboarding::init::run(invite_url, None)
            .await
            .map_err(|e| e.to_string())?;

        // Build a real backend from the config just written and install it, so
        // the running daemon has credentials immediately: the run loop's
        // bootstrap re-fetch and token retry both go through this handle.
        let path = ProviderConfig::default_path().map_err(|e| format!("backend path: {e}"))?;
        let provider_config = ProviderConfig::load_from_path(&path)
            .map_err(|e| format!("read new backend.toml: {e}"))?;
        let backend = backend_from_provider_config(provider_config)
            .map_err(|e| format!("build backend: {e}"))?;

        self.deferred.install(backend);

        Ok(crate::http::setup::ClaimOutcome {
            actor_id: outcome.actor_id,
            team_id: outcome.team_id,
            display_name: outcome.display_name,
        })
    }
}

/// Adopt the backend's routing identity into the in-memory config.
///
/// `backend.toml` is the only owner of `actor_id` on disk; `daemon.toml`
/// carries a pointer (`active_team`) and no identity at all. This replaces the
/// old `validate_config_identity`, which existed to catch the two files
/// drifting apart — with one owner there is nothing left to drift, except the
/// one structural mistake still worth rejecting: a `backend.toml` whose
/// `team_id` disagrees with the directory it sits in, which can only mean the
/// file was hand-copied into the wrong `teams/<id>/`.
fn hydrate_identity_from_backend(
    config: &mut DaemonConfig,
    backend: &dyn Backend,
) -> crate::error::Result<()> {
    let pointer = config.team_id.as_deref().unwrap_or("<none>");
    if pointer != backend.team_id() {
        return Err(crate::error::AmuxError::Config(format!(
            "active_team points at {pointer} but teams/{pointer}/state/backend.toml says \
             team_id={} — that backend.toml belongs to a different team's directory. \
             Stop amuxd and run `amuxd init` to re-onboard",
            backend.team_id(),
        )));
    }
    config.actor.id = backend.actor_id().to_string();
    Ok(())
}

impl DaemonServer {
    pub async fn new(
        mut config: DaemonConfig,
        config_path: &std::path::Path,
    ) -> crate::error::Result<Self> {
        // Always wrap in a DeferredBackend so the daemon has one backend type
        // regardless of onboarding state, and so the setup endpoint can install
        // real credentials into a running daemon without a restart.
        let deferred_backend = Arc::new(match load_provider_config_from_default_paths()? {
            Some(provider_config) => {
                let provider_kind = provider_config.kind();
                let inner = backend_from_provider_config(provider_config)?;

                info!(
                    backend_kind = ?provider_kind,
                    actor_id = %inner.actor_id(),
                    team_id  = %inner.team_id(),
                    "backend client initialised"
                );

                crate::backend::deferred::DeferredBackend::claimed(inner)
            }
            None => {
                warn!(
                    "no backend.toml — starting unclaimed; the HTTP control plane will serve \
                     setup at /v1/setup (run `amuxd setup` for the URL), or run \
                     `amuxd init <invite-url>`"
                );
                crate::backend::deferred::DeferredBackend::unclaimed()
            }
        });
        let backend: Arc<dyn Backend> = deferred_backend.clone();

        // Routing identity: from the backend when claimed; a per-boot
        // placeholder otherwise. The placeholder never reaches a broker — an
        // unclaimed daemon has an empty broker URL and runs the placeholder
        // MQTT client — it exists so log lines and in-process consumers always
        // have *some* stable id for this run.
        if deferred_backend.is_claimed() {
            hydrate_identity_from_backend(&mut config, backend.as_ref())?;
        } else if config.actor.id.trim().is_empty() {
            config.actor.id = uuid::Uuid::new_v4().to_string();
        }
        let actor_id = backend.actor_id().to_string();

        // Authoritative: resolve the MQTT broker from /v1/config/bootstrap.
        // When bootstrap is unreachable or answers without an `mqtt` block, keep
        // the last-known address already in daemon.toml (invite `?broker=` or a
        // previously persisted bootstrap value) and continue in degraded mode
        // (HTTP/local APIs stay up).
        apply_bootstrap_overrides(&backend, &mut config, config_path).await?;

        let mut launch_configs = RuntimeManager::default_launch_configs();
        if let Some(claude) = config.agents.claude_code.as_ref() {
            launch_configs.insert(
                amux::AgentType::ClaudeCode,
                AgentLaunchConfig::new(
                    claude.binary.clone(),
                    claude.default_flags.clone(),
                    "claude",
                ),
            );
        }
        if let Some(opencode) = config.agents.opencode.as_ref() {
            launch_configs.insert(
                amux::AgentType::Opencode,
                AgentLaunchConfig::new(
                    opencode.binary.clone(),
                    opencode.default_flags.clone(),
                    "opencode",
                ),
            );
        }
        if let Some(codex) = config.agents.codex.as_ref() {
            launch_configs.insert(
                amux::AgentType::Codex,
                AgentLaunchConfig::new(codex.binary.clone(), codex.default_flags.clone(), "codex"),
            );
        }
        // pi runs its own per-worktree process (the pi_rpc backend builds that
        // command itself), so this entry only carries the binary name. Without
        // it, launch_config_for(Pi) falls back to the ClaudeCode config and the
        // pi backend would spawn `claude` instead of `pi`. The literal "pi"
        // lets pi_rpc's resolve_binary find it on PATH / ~/.pi/bin rather than
        // treating it as an explicit path override; a configured
        // `[agents.pi].binary` becomes exactly such an override.
        let pi_binary = config
            .agents
            .pi
            .as_ref()
            .and_then(|pi| pi.binary.clone())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "pi".to_string());
        launch_configs.insert(
            amux::AgentType::Pi,
            AgentLaunchConfig::new(pi_binary, Vec::new(), "pi"),
        );
        if config.agents.local_agent == "cursor" {
            launch_configs.insert(
                amux::AgentType::Cursor,
                AgentLaunchConfig::new("cursor-bridge", Vec::new(), "cursor"),
            );
        }

        // Team-scoped, all three: a member list, a runtime index and an event
        // history all describe one team's work and follow it when it changes.
        let state_dir = crate::config::layout::active_state_dir();
        let members_path = state_dir.join("members.toml");
        let auth = AuthManager::new(members_path)?;
        let peers = PeerTracker::new();
        let permissions = PermissionManager::new();

        let workspace_resolver = Arc::new(crate::config::WorkspaceResolver::new(backend.clone()));

        // `runtimes.toml`, not `sessions.toml`: it indexes runtimes, and the
        // old name collided with the collab session store one directory over.
        let sessions_path = state_dir.join("runtimes.toml");
        let sessions = SessionStore::load(&sessions_path)?;

        let history_dir = state_dir.join("history");
        let history = EventHistory::new(&history_dir);

        let agents = Arc::new(AsyncMutex::new(RuntimeManager::with_local_agent(
            &config.agents.local_agent,
            launch_configs,
            Some(backend.clone()),
        )));

        let (mqtt_publisher, mqtt_command_rx) = MqttPublisher::channel();
        let (mqtt_recovery_handle, mqtt_recovery_rx) = crate::mqtt::MqttRecoveryHandle::channel();
        let mqtt_snapshot = Arc::new(parking_lot::RwLock::new(
            crate::mqtt::MqttSnapshot::default(),
        ));
        let publisher_handle: Arc<dyn MessagePublisher> = mqtt_publisher;
        let topics =
            crate::mqtt::Topics::new(config.team_id.as_deref().unwrap_or_default(), &actor_id);

        // Local fast-path broadcast (SSE tee). Capacity sized for bursts of
        // coalesced deltas; a lagging subscriber skips events, which the MQTT
        // copy then backfills (frontend dedupes by event_id).
        let (live_tee, _) =
            tokio::sync::broadcast::channel::<crate::teamclu::live::LiveTeeEvent>(1024);

        let team_id_for_rpc = config.team_id.clone().unwrap_or_default();
        let rpc_client = Arc::new(AsyncMutex::new(crate::teamclu::rpc::RpcClient::new(
            publisher_handle.clone(),
            team_id_for_rpc,
            actor_id.clone(),
        )));

        let teamclu = if let Some(team_id) = &config.team_id {
            let mut sm = crate::teamclu::SessionManager::new(
                publisher_handle.clone(),
                team_id,
                &config.actor.id,
                Some(actor_id.clone()),
                crate::config::DaemonConfig::config_dir(),
            )?;
            sm.set_local_tee(live_tee.clone());
            Some(sm)
        } else {
            None
        };

        // Bounded queue of completed cron turns handed back to the run loop for
        // persistence + sock reply (see `cron_turn_done_tx`).
        let (cron_turn_done_tx, cron_turn_done_rx) = mpsc::channel(64);
        // Streaming events of in-flight cron turns. Deeper than the done queue
        // because a single turn emits one frame per delta; overflow drops
        // frames (the UI catches up on the next one) instead of applying
        // backpressure to the turn.
        let (cron_turn_event_tx, cron_turn_event_rx) = mpsc::channel(1024);

        let team_skill_reconciler = Arc::new(
            crate::runtime::team_skills::TeamSkillReconciler::new(backend.clone()),
        );
        Ok(Self {
            config,
            config_path: config_path.to_path_buf(),
            mqtt_command_rx: Some(mqtt_command_rx),
            mqtt_recovery_rx: Some(mqtt_recovery_rx),
            mqtt_recovery_handle,
            mqtt_snapshot,
            nats: None,
            publisher_handle,
            topics,
            agents,
            auth,
            peers,
            permissions,
            workspace_resolver,
            sync_dispatcher: crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                Some(backend.clone()),
            ),
            sessions,
            sessions_path,
            history,
            teamclu,
            backend: backend.clone(),
            deferred_backend,
            actor_id,
            channel_mgr: None,
            cron_sessions: cron::CronSessionCache::new(),
            refresh_watch_registry: None,
            refresh_coordinator: None,
            mqtt_connected_flag: None,
            managed_llm: Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(
                backend,
            )),
            live_tee,
            session_remote_targets: Arc::new(AsyncMutex::new(
                crate::remote_tools::SessionRemoteTargetStore::default(),
            )),
            remote_tool_turn_contexts: Arc::new(AsyncMutex::new(
                crate::remote_tools::RemoteToolTurnContextStore::default(),
            )),
            rpc_client,
            team_skill_reconciler,
            agent_management_results: Arc::new(AsyncMutex::new(HashMap::new())),
            cron_turn_done_tx,
            cron_turn_done_rx: Some(cron_turn_done_rx),
            cron_turn_event_tx,
            cron_turn_event_rx: Some(cron_turn_event_rx),
        })
    }

    fn refresh_rpc_client_publisher(&self) {
        if let Ok(mut rpc) = self.rpc_client.try_lock() {
            rpc.client = self.publisher_handle.clone();
        }
    }

    pub(crate) fn suppress_internal_opencode_writes(&self, worktree: &str) {
        if let Some(ref refresh) = self.refresh_coordinator {
            crate::runtime::refresh::refresh_watch::suppress_for_workspace_path(
                refresh,
                Path::new(worktree),
                &crate::runtime::refresh::INTERNAL_OPENCODE_KINDS,
                crate::runtime::refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
    }

    /// Team-link sweep: reads the cloud `workspaces` table (all of this
    /// team's workspaces, across every device — the sole source of truth),
    /// then filters to paths that exist on *this* machine before symlinking
    /// `<workspace>/teamclu-team`. This is mandatory —
    /// the cloud list intentionally includes other devices' workspace paths,
    /// which must never be touched by a daemon that doesn't own them.
    pub(crate) async fn sync_team_shared_dirs_for_known_workspaces(&self) {
        let team_id = self.backend.team_id().to_string();
        if team_id.trim().is_empty() {
            return;
        }
        let rows = match self.backend.get_workspaces_by_team(&team_id).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::debug!(
                    team_id,
                    "team-link sweep: get_workspaces_by_team failed: {e}"
                );
                return;
            }
        };
        let workspace_paths = cloud_rows_to_local_linkable_paths(&rows);
        if workspace_paths.is_empty() {
            return;
        }
        let gate = crate::team_link::team_share_gate(self.backend.as_ref(), &team_id).await;
        for ws_path in &workspace_paths {
            crate::team_link::materialize_or_teardown(gate, &team_id, ws_path);
        }
    }

    /// Re-subscribe team topics and re-announce presence after MQTT CONNACK.
    /// Returns `Err(())` when the caller should break to the outer reconnect
    /// loop (same semantics as the first-connect path).
    async fn mqtt_resubscribe_after_connack(
        &mut self,
        context: &str,
        subscribe: bool,
        mqtt_supervisor: &MqttSupervisor,
        generation: u64,
        worker_generation: u64,
    ) -> Result<(), String> {
        let current = || mqtt_supervisor.is_generation_current(generation, worker_generation);
        if !current() {
            warn!(
                context,
                generation, worker_generation, "discarding stale MQTT restore attempt"
            );
            return Err("stale MQTT generation".to_string());
        }
        if subscribe {
            let runtime_topic = self.topics.runtime_commands_wildcard();
            if let Err(e) = self
                .publisher_handle
                .subscribe(
                    &runtime_topic,
                    teamclu_transport::DeliveryGuarantee::AtLeastOnce,
                )
                .await
            {
                warn!(
                    context,
                    error = %e,
                    "subscribe_all failed after CONNACK, reconnecting"
                );
                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                return Err(format!("MQTT runtime subscription failed: {e}"));
            }
            if !current() {
                return Err("stale MQTT generation after runtime subscription".to_string());
            }
            if let Some(tc) = &mut self.teamclu {
                if let Err(e) = tc.subscribe_all().await {
                    warn!(
                        context,
                        error = %e,
                        "teamclu subscribe failed after CONNACK, reconnecting"
                    );
                    mark_mqtt_connected(&self.mqtt_connected_flag, false);
                    return Err(format!("teamclu subscription failed: {e}"));
                }
            }
        }
        if !current() {
            return Err("stale MQTT generation before state restore".to_string());
        }
        if self.config.team_id.is_some() {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            if let Err(e) = publisher
                // Presence only. The catalog / live-session fields of this
                // retain are filled by `publish_actor_state`, which owns the
                // full snapshot; this path runs before that data exists.
                .publish_actor_presence(&crate::proto::amux::ActorPresence {
                    online: true,
                    display_name: self.config.actor.name.clone(),
                    timestamp: chrono::Utc::now().timestamp(),
                    ..Default::default()
                })
                .await
            {
                warn!(
                    context,
                    error = %e,
                    "publish_actor_presence failed after CONNACK, reconnecting"
                );
                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                return Err(format!("MQTT actor presence publish failed: {e}"));
            }
            if !current() {
                return Err("stale MQTT generation after actor presence".to_string());
            }
            // That publish is presence-only, so it overwrites the retained
            // snapshot with an empty catalog and no live sessions — measured
            // 7346 bytes down to 19 across a daemon restart. Every reader then
            // sees an actor holding nothing while it is in fact serving a
            // session. Re-publishing the real snapshot is not optional on
            // reconnect: `apply_start_runtime` takes its dedup path for an
            // attachment that already exists, so nothing else would restore it.
            if let Err(error) = self.publish_actor_state().await {
                warn!(%error, "failed to publish actor state after MQTT reconnect");
                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                let reason = if matches!(
                    &error,
                    teamclu_transport::PublisherError::Unavailable(message)
                        if message.starts_with("could not persist MQTT publish")
                ) {
                    format!("durable_store:actor_state_publish_failed: {error}")
                } else {
                    format!("MQTT actor state publish failed: {error}")
                };
                return Err(reason);
            }
            if !current() {
                return Err("stale MQTT generation after actor state".to_string());
            }
        } else {
            warn!("no team_id yet; skipping presence announce until onboarding completes");
            if let Err(error) = self.publish_actor_state().await {
                warn!(%error, "failed to publish actor state before onboarding");
                mark_mqtt_connected(&self.mqtt_connected_flag, false);
                let reason = if matches!(
                    &error,
                    teamclu_transport::PublisherError::Unavailable(message)
                        if message.starts_with("could not persist MQTT publish")
                ) {
                    format!("durable_store:actor_state_publish_failed: {error}")
                } else {
                    format!("MQTT actor state publish failed: {error}")
                };
                return Err(reason);
            }
        }
        if !current() {
            return Err("stale MQTT generation before readiness".to_string());
        }
        Ok(())
    }

    /// Run the daemon. When `shutdown` resolves, the inner loop exits
    /// gracefully — channels are shut down (consuming `shutdown(self)`) and
    /// `Ok(())` is returned. Without a shutdown signal the daemon runs
    /// forever; callers that want signal-based exit should pass
    /// `tokio::signal`-derived futures.
    pub async fn run<F>(mut self, shutdown: F) -> crate::error::Result<()>
    where
        F: Future<Output = ()>,
    {
        info!("amuxd v0.1.0 starting");

        // NOTE: channel-gateway start, team-shared-dir sync, and the sync-timer
        // seed (which each make serial, cloud-dependent calls) are deliberately
        // deferred until *after* the HTTP listener binds below. Running them here
        // gated `/v1/healthz` behind cloud latency, which tripped the desktop's
        // "failed to start the background service" health-poll timeout when FC
        // was slow. They still run before the MQTT reconnect loop, so collab
        // connectivity ordering is preserved.

        // NOTE: ACP host prewarming is deliberately deferred to a background
        // task spawned *after* the HTTP listener binds (see below). Prewarming
        // claude+opencode ACP hosts can take 20s+ on a cold start; doing it
        // synchronously here gated `/v1/healthz` (and MQTT) behind that delay,
        // which made the desktop's daemon-onboarding health poll time out and
        // report "failed to start the background service" even though the
        // daemon was seconds from being ready. Prewarm is a first-turn latency
        // optimization — it must not block readiness.

        // Browser-facing HTTP+SSE listener. Desktop TeamClu requires this
        // control plane; when `[http]` is absent from daemon.toml we still
        // bind loopback with `HttpConfig::default()`. Failure to bind is
        // logged but does NOT abort the daemon — the Unix socket path remains
        // usable for legacy clients.
        let http_cfg = self.config.http.clone().unwrap_or_default();
        // Bridge: `POST /v1/workspaces` (HTTP) → the actor command loop, which
        // owns all cloud `amux.workspaces` upserts. The HTTP handler sends a
        // `RegisterWorkspaceRequest`; the forwarder task below (spawned once the
        // sock command channel exists) re-publishes it as
        // `SockCommand::AddWorkspace` so the existing main-loop handler runs it.
        // Bridge for `POST /v1/config/reload`. Created here (not at the sock
        // channel below) because `http::spawn` runs first and needs the sender;
        // the receiver is forwarded into the command loop alongside
        // register-workspace. Same shape, same reason: the actor loop owns the
        // channel manager, so the HTTP task cannot reload it directly.
        let (config_reload_tx, mut config_reload_rx) = mpsc::channel::<()>(4);

        let (register_workspace_tx, mut register_workspace_rx) =
            mpsc::channel::<crate::http::state::RegisterWorkspaceRequest>(16);
        // Bridge: `POST /v1/rpc` (HTTP, local fast-path) → the actor command
        // loop, which owns the same dispatch the MQTT `rpc/req` topic feeds.
        let (local_rpc_tx, mut local_rpc_rx) =
            mpsc::channel::<crate::http::state::LocalRpcRequest>(32);
        let (local_live_ingest_tx, mut local_live_ingest_rx) =
            mpsc::channel::<crate::http::state::LocalLiveIngestRequest>(32);
        // Shared status for the background agent_types advertise (below). Held
        // here so `/v1/info` (via `meta`) and the advertise task both reference
        // the same cell — a failed advertise surfaces instead of being swallowed.
        let agent_types_advertise = std::sync::Arc::new(parking_lot::Mutex::new(
            crate::http::state::AgentTypesAdvertise::default(),
        ));
        let mqtt_connected_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.mqtt_connected_flag = Some(mqtt_connected_flag.clone());
        // Escapes the HTTP-setup block so the prewarm notifier can be installed
        // once the sock command channel exists (below).
        let mut supervisor_for_prewarm: Option<Arc<crate::runtime::RuntimeSupervisor>> = None;
        let team_skill_reconciler = self.team_skill_reconciler.clone();
        let _http_handle = {
            let mut meta = crate::http::server::metadata(self.actor_id.clone(), "amuxd");
            // Expose configured backends so the model-catalog endpoint can
            // group models per backend (opencode / pi / cursor / claude-code).
            meta.configured_agent_types = supported_agent_type_names(&self.config);
            meta.agent_types_advertise = agent_types_advertise.clone();
            meta.mqtt_connected = mqtt_connected_flag.clone();
            meta.mqtt_recovery = Some(self.mqtt_recovery_handle.clone());
            meta.mqtt_snapshot = self.mqtt_snapshot.clone();
            // The HTTP workspace runtime endpoints share this supervisor's
            // refresh coordinator for status + apply-intent semantics.
            let execution_context_assembler = Arc::new(self.execution_context_assembler());
            let opencode_host_pool = {
                let manager = self.agents.lock().await;
                manager.opencode_host_pool().await
            };
            let runtime_supervisor = if let Some(pool) = opencode_host_pool.clone() {
                crate::runtime::RuntimeSupervisor::new_with_workspace_services(
                    self.agents.clone(),
                    pool,
                    execution_context_assembler.clone(),
                )
            } else {
                crate::runtime::RuntimeSupervisor::new(self.agents.clone())
            };
            supervisor_for_prewarm = Some(runtime_supervisor.clone());
            runtime_supervisor.clone().start_refresh_auto_applier();
            let refresh_coordinator = runtime_supervisor.refresh_coordinator();
            self.refresh_coordinator = Some(refresh_coordinator.clone());
            {
                let mut manager = self.agents.lock().await;
                manager.attach_refresh_coordinator(refresh_coordinator.clone());
            }
            let runtime: Arc<dyn crate::http::runtime_adapter::RuntimeAdapter> =
                crate::http::runtime_adapter::RuntimeManagerAdapter::new_with_execution_context_assembler(
                    self.agents.clone(),
                    http_cfg.max_event_backlog,
                    Some(refresh_coordinator),
                    Some(execution_context_assembler.clone()),
                );
            // Start the refresh watchers with an empty workspace set so the
            // (cloud-dependent) `cloud_workspace_list()` fetch does not delay the
            // HTTP listener bind. The set is populated on a background task after
            // bind (see below), and the watcher poll loop reads the registry live.
            let refresh_watch_registry =
                crate::runtime::refresh::refresh_watch::start_refresh_watchers(
                    runtime_supervisor.clone(),
                    Vec::new(),
                    dirs::home_dir(),
                );
            self.refresh_watch_registry = Some(refresh_watch_registry);
            let workspace_control: Option<
                std::sync::Arc<dyn crate::config::WorkspaceControlStore>,
            > = Some(std::sync::Arc::new(
                crate::config::OpenCodeCompatStore::new(),
            ));
            let opencode_settings = opencode_host_pool.map(|pool| {
                std::sync::Arc::new(
                    crate::opencode_settings::OpenCodeSettingsService::with_host_pool(
                        pool,
                        execution_context_assembler,
                    ),
                )
            });
            match crate::http::spawn(
                http_cfg,
                meta,
                runtime,
                workspace_control,
                Some(runtime_supervisor),
                opencode_settings,
                self.sync_dispatcher.clone(),
                Some(register_workspace_tx),
                Some(self.backend.clone()),
                Some(self.live_tee.clone()),
                Some(self.config_path.clone()),
                Some(config_reload_tx),
                Some(Arc::new(DaemonOnboarding {
                    deferred: self.deferred_backend.clone(),
                })),
                Some(local_rpc_tx),
                Some(local_live_ingest_tx),
                Some(team_skill_reconciler.clone()),
            )
            .await
            {
                Ok(h) => {
                    info!(addr = %h.local_addr, "http listener bound");
                    Some(h)
                }
                Err(e) => {
                    warn!("http listener failed to start: {e}");
                    None
                }
            }
        };

        // Prewarm ACP hosts in the background now that the HTTP control plane is
        // bound. This warms claude/opencode ACP hosts (20s+ cold) without gating
        // `/v1/healthz`, the Unix socket, or the MQTT loop on it — the daemon
        // reports healthy immediately while first-turn latency is still primed.
        // Spawned here (after the HTTP setup released its `self.agents` lock) so
        // the long-held prewarm lock can't stall the listener bind.
        {
            // Resolve *real* spawn envs for the two most relevant workspaces
            // (writes provider.team, warms the managed-LLM cache, and yields the
            // exact extra_env the first session will use). Each workspace gets
            // its own current pooled generation. Falls back to empty-env when no
            // workspace exists yet (fresh install).
            let prewarm_envs = self.resolve_all_prewarm_envs().await;
            let agents = self.agents.clone();
            tokio::spawn(async move {
                if prewarm_envs.is_empty() {
                    let mut mgr = agents.lock().await;
                    mgr.prewarm_agent_backend().await;
                    return;
                }
                // Sequential, one manager-lock scope per workspace: cold host
                // spawns take 20s+ each, and re-acquiring the lock between
                // workspaces lets real session/cron traffic interleave instead
                // of queueing behind the whole prewarm sweep.
                for (workspace_id, worktree, extra_env, force_env_override) in prewarm_envs {
                    let mut mgr = agents.lock().await;
                    mgr.prewarm_agent_backend_for_workspace(
                        &workspace_id,
                        extra_env,
                        force_env_override,
                        worktree.as_str(),
                    )
                    .await;
                }
            });
        }

        // Keep the cloud access-token file fresh for long-running agents. Only
        // cloud backends have an auth surface to source it from; the env
        // injection in `assemble_spawn_runtime_env_for_worktree` is gated the
        // same way, so `TC_ACCESS_TOKEN_FILE` is only advertised when this task
        // is actually maintaining the file.
        if self.backend.cloud_auth_health().is_some() {
            cloud_token_file::spawn(
                self.backend.clone(),
                crate::config::DaemonConfig::cloud_token_path(),
            );
        }

        // Deferred (post-bind) cloud-dependent startup, moved here so the HTTP
        // health endpoint bound promptly above. Channel gateways + shared-dir
        // sync + sync-timer seed each make serial cloud calls; running them now
        // keeps `/v1/healthz` responsive under FC latency while still preceding
        // the MQTT reconnect loop.
        self.start_channels().await;
        self.sync_team_shared_dirs_for_known_workspaces().await;
        {
            let team_id = self.backend.team_id().to_string();
            let grouped = if team_id.trim().is_empty() {
                Vec::new()
            } else {
                match self.backend.get_workspaces_by_team(&team_id).await {
                    Ok(rows) => {
                        let paths = cloud_rows_to_local_linkable_paths(&rows);
                        if paths.is_empty() {
                            Vec::new()
                        } else {
                            vec![(team_id, paths)]
                        }
                    }
                    Err(e) => {
                        tracing::debug!("sync timer: get_workspaces_by_team failed: {e}");
                        Vec::new()
                    }
                }
            };
            crate::sync::timer::spawn(self.sync_dispatcher.clone(), grouped);
        }

        // Populate the refresh watchers from the cloud workspace list on a
        // background task (moved off the pre-bind path above). The watcher poll
        // loop reads the registry live via `snapshot()`, so upserting here takes
        // effect on the next tick without a restart.
        if let Some(registry) = self.refresh_watch_registry.clone() {
            let workspaces = self.cloud_workspace_list().await;
            tokio::spawn(async move {
                for workspace in workspaces {
                    registry
                        .upsert_workspace(
                            crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                                workspace_id: workspace.workspace_id,
                                workspace_path: PathBuf::from(&workspace.path),
                            },
                        )
                        .await;
                }
            });
        }

        // Bind the control socket and spawn a listener that funnels parsed
        // commands into the main loop via mpsc. Done after channel start so
        // any error in `start_channels` surfaces first; failure to bind the
        // sock is logged but does NOT abort the daemon — operators can still
        // use SIGTERM / signal handlers to stop it.
        let (sock_tx, mut sock_rx) = mpsc::channel::<SockCommand>(16);
        let sock_path = DaemonConfig::sock_path();
        spawn_sock_listener(sock_path.clone(), sock_tx.clone());

        // Bridge the supervisor's "provider hosts evicted" notifications into
        // the command loop, where `kick_prewarm_for_workspace` re-warms the
        // evicted hosts in the background. Same shape as register-workspace.
        if let Some(supervisor) = &supervisor_for_prewarm {
            let (prewarm_tx, mut prewarm_rx) = mpsc::channel::<(String, String)>(8);
            supervisor.set_prewarm_notifier(prewarm_tx);
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while let Some((workspace_id, path)) = prewarm_rx.recv().await {
                    if bridge_tx
                        .send(SockCommand::PrewarmWorkspace { workspace_id, path })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        // Forward HTTP register-workspace requests into the command loop. Runs
        // for the lifetime of the daemon; exits if either channel closes.
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while let Some(req) = register_workspace_rx.recv().await {
                    if bridge_tx
                        .send(SockCommand::AddWorkspace {
                            path: req.path,
                            reply_tx: req.reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        // Forward HTTP `/v1/rpc` dispatches into the command loop, where they
        // land on the same `dispatch_rpc_request` the MQTT rpc/req path uses.
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while let Some(req) = local_rpc_rx.recv().await {
                    if bridge_tx
                        .send(SockCommand::LocalRpc {
                            payload: req.payload,
                            reply_tx: req.reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        // Forward HTTP `/v1/session-live/ingest` into the command loop, where
        // they land on the same `ingest_session_live` the MQTT session/live
        // path uses (message_id dedup included).
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while let Some(req) = local_live_ingest_rx.recv().await {
                    if bridge_tx
                        .send(SockCommand::LocalLiveIngest {
                            session_id: req.session_id,
                            payload: req.payload,
                            reply_tx: req.reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        // Forward HTTP config-reload requests into the command loop, where they
        // land on the same handler as `amuxd channel reload`.
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while config_reload_rx.recv().await.is_some() {
                    if bridge_tx.send(SockCommand::ChannelReload).await.is_err() {
                        break;
                    }
                }
            });
        }

        // One-time setup before the reconnect loop.
        // Heartbeat runs independently of MQTT session.
        {
            let sb = self.backend.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    if let Err(e) = sb.heartbeat().await {
                        warn!("cloud heartbeat error: {e}");
                    }
                }
            });
        }

        // Idle ACP runtime sweeper. Opt-in via DaemonConfig.idle_runtime_timeout_secs.
        // The sweeper holds an `Arc<AsyncMutex<RuntimeManager>>` clone and calls
        // `evict_idle` once a minute. The terminal MQTT publish is done by the
        // main event loop draining `mgr.drain_evicted()` per tick (see Task 7).
        {
            let threshold_secs = self.config.idle_timeout_secs();
            let max_attachments = self.config.max_attachments();
            let mgr = self.agents.clone();
            info!(
                threshold_secs,
                max_attachments, "attachment detach policy active"
            );
            let threshold = i64::try_from(threshold_secs).unwrap_or(i64::MAX);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    let host_pool = {
                        let guard = mgr.lock().await;
                        guard.opencode_host_pool().await
                    };
                    if let Some(pool) = host_pool {
                        pool.evict_idle(std::time::Instant::now()).await;
                    }
                    let mut guard = mgr.lock().await;
                    let _idle = guard.evict_idle(threshold).await;
                    let _over = guard.evict_over_capacity(max_attachments).await;
                    // No publish here — main loop drains mgr.evicted_pending_publish.
                }
            });
        }

        // Mirror the team config that lives in the Cloud API (team MCP, team
        // env) onto the local cache the synchronous readers use.
        //
        // A background tick rather than a fetch on the read path: both readers
        // are synchronous and sit on the runtime spawn path, and agents have to
        // start while offline. See `runtime::team_cloud_config`.
        //
        // Desktop also triggers an immediate reconcile via
        // `POST /v1/team/cloud-config/reconcile` after a Cloud API write; that
        // path shares the same fan-out so a cache update surfaces "runtime
        // needs restart" without waiting for this tick.
        if let Some(team_id) = self
            .config
            .team_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
        {
            use crate::runtime::team_cloud_config::apply_team_cloud_outcome;
            let resolver = Arc::new(
                crate::runtime::team_cloud_config::TeamCloudConfigResolver::new(
                    self.backend.clone(),
                ),
            );
            let backend = Some(self.backend.clone());
            let refresh = self.refresh_coordinator.clone();
            tokio::spawn(async move {
                // Once up front so a freshly started daemon converges without
                // waiting out the first tick, then on the TTL cadence.
                let outcome = resolver.reconcile_now(&team_id).await;
                apply_team_cloud_outcome(&team_id, outcome, backend.as_ref(), refresh.as_ref())
                    .await;
                let mut tick = tokio::time::interval(Duration::from_secs(300));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    let outcome = resolver.reconcile(&team_id).await;
                    apply_team_cloud_outcome(&team_id, outcome, backend.as_ref(), refresh.as_ref())
                        .await;
                }
            });
        }

        // Materialise the skills an admin assigned to this hosted agent.
        //
        // Separate tick from the team config mirror above, on a much longer
        // cadence: that one moves a few KB of JSON, this one downloads and
        // unpacks archives. See `runtime::team_skills` for why it installs into
        // its own root rather than the desktop's `~/.agents/skills`.
        if let Some(team_id) = self
            .config
            .team_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
        {
            use crate::runtime::team_skills::apply_team_skill_outcome;
            let reconciler = team_skill_reconciler.clone();
            let backend = Some(self.backend.clone());
            let refresh = self.refresh_coordinator.clone();
            tokio::spawn(async move {
                // Once at startup so a daemon that was offline while an admin
                // made a change converges immediately rather than after a full
                // interval.
                let outcome = reconciler.reconcile_now(&team_id).await;
                apply_team_skill_outcome(&team_id, outcome, backend.as_ref(), refresh.as_ref())
                    .await;
                let mut tick = tokio::time::interval(crate::runtime::team_skills::TEAM_SKILLS_TTL);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    // `reconcile_now`, not `reconcile`: this timer *is* the
                    // schedule. The TTL guard exists for the nudge path, and
                    // going through it here would compare an interval against
                    // itself — `last_fetch` is stamped after the download, so
                    // every tick lands a few seconds short of the TTL and skips,
                    // silently halving the cadence to 20 minutes.
                    let outcome = reconciler.reconcile_now(&team_id).await;
                    apply_team_skill_outcome(&team_id, outcome, backend.as_ref(), refresh.as_ref())
                        .await;
                }
            });
        }

        // Advertise supported agent backend types on the cloud `agents` row
        // (background, with retries). Routing identity is the actor_id; no
        // separate device-id upsert. Skip when daemon.toml has no `[agents.*]`
        // sections — do not invent a claude fallback.
        {
            let sb = self.backend.clone();
            let supported_agent_types = supported_agent_type_names(&self.config);
            let default_agent_type = default_advertised_agent_type(&supported_agent_types);
            let advertise_status = agent_types_advertise.clone();
            // Advertised unconditionally, including the empty case. "This
            // device currently runs nothing" is an answer the cloud row has to
            // carry: skipping the call left the previous answer in place, so a
            // machine whose team points at an uninstalled runtime went on
            // showing that runtime's badge in every client — a stale value that
            // reads as a confident one.
            {
                tokio::spawn(async move {
                    let mut delay = Duration::from_secs(2);
                    for attempt in 1..=12 {
                        match sb
                            .ensure_agent_types(
                                &supported_agent_types,
                                default_agent_type.as_deref(),
                            )
                            .await
                        {
                            Ok(()) => {
                                info!(
                                    types = ?supported_agent_types,
                                    default = ?default_agent_type,
                                    "advertised agent backend types to cloud"
                                );
                                let mut s = advertise_status.lock();
                                s.advertised = true;
                                s.last_error = None;
                                break;
                            }
                            Err(e) if attempt < 12 => {
                                warn!(
                                    attempt,
                                    error = %e,
                                    "cloud agents.agent_types advertise failed; retrying"
                                );
                                advertise_status.lock().last_error = Some(e.to_string());
                                tokio::time::sleep(delay).await;
                                delay = (delay * 2).min(Duration::from_secs(60));
                            }
                            Err(e) => {
                                // Terminal: don't swallow it. Record on the status
                                // cell (surfaced via /v1/info) and log at ERROR so
                                // an advertise that never lands is visible.
                                error!(
                                    error = %e,
                                    "cloud agents.agent_types advertise failed; giving up after retries"
                                );
                                advertise_status.lock().last_error = Some(e.to_string());
                            }
                        }
                    }
                });
            }
        }

        // Report daemon client version once at startup (ops telemetry; non-fatal).
        {
            let sb = self.backend.clone();
            let device_id = crate::device_id::daemon_device_id();
            tokio::spawn(async move {
                if let Err(e) = sb.report_client_version(&device_id).await {
                    warn!("failed to report daemon client version: {e}");
                }
            });
        }

        // Dispatch to the NATS transport when the operator opted in via
        // `[transport] kind = "nats"`. The MQTT path below is unchanged.
        if matches!(
            self.config.transport.as_ref().map(|t| t.kind),
            Some(crate::config::TransportKind::Nats)
        ) {
            return self.run_nats(shutdown, sock_rx, sock_path).await;
        }

        tokio::pin!(shutdown);
        let mut first_connect = true;

        // Owned for the whole run: the `finalize_cron_turn` select arm drains
        // completed background cron turns off it. Taken once here (before the
        // reconnect loop) so a reconnect never re-takes an already-moved value.
        let mut cron_done_rx = self
            .cron_turn_done_rx
            .take()
            .expect("cron_turn_done_rx already taken (MQTT run loop entered twice)");
        let mut cron_event_rx = self
            .cron_turn_event_rx
            .take()
            .expect("cron_turn_event_rx already taken (MQTT run loop entered twice)");

        'outer: loop {
            // ── 0. Self-heal team_id from daemon.toml ──
            // A daemon that started before onboarding wrote the team keeps
            // `team_id = None` for its whole process lifetime. It would then
            // publish presence + LWT under the `"teamclu"` fallback topic
            // (see mqtt/client.rs) that no subscriber listens on, so it appears
            // permanently OFFLINE until a full process restart re-reads config.
            // Re-read daemon.toml here so a running daemon adopts the team on
            // its next reconnect cycle and converges without a restart.
            if self.config.team_id.is_none() {
                if let Ok(fresh) =
                    crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
                {
                    if let Some(team_id) = fresh.team_id {
                        // The pointer alone is not an identity: EMQX keys its
                        // topic ACLs on the cloud actor_id, and that lives in
                        // the team's backend.toml. Onboarding writes the
                        // credentials before it points daemon.toml at them, so
                        // a readable pointer with an unreadable backend.toml is
                        // onboarding caught mid-write — skip the cycle and
                        // re-check rather than adopt half an identity.
                        match ProviderConfig::load_from_path(&ProviderConfig::path_for_team(
                            &team_id,
                        )) {
                            Ok(ProviderConfig::CloudApi(cloud)) => {
                                info!(
                                    %team_id,
                                    actor_id = %cloud.actor_id,
                                    "adopted team + identity from backend.toml (self-heal)"
                                );
                                // The runtime index follows the team: claim
                                // renamed teams/_unclaimed/ underneath us, and
                                // saving to the boot-captured path would
                                // resurrect it — those writes would then be
                                // stranded forever, because promote refuses to
                                // merge into a team that already has state.
                                self.sessions_path =
                                    crate::config::layout::team_state_dir(&team_id)
                                        .join("runtimes.toml");
                                self.config.team_id = Some(team_id);
                                // Only the MQTT identity converges here: the
                                // topics and client are rebuilt each cycle.
                                // Startup-captured consumers
                                // (teamclu::SessionManager, members, history)
                                // still hold the old paths, which is why
                                // POST /v1/setup/claim reports requiresRestart
                                // for a daemon that booted unclaimed.
                                self.config.actor.id = cloud.actor_id;
                            }
                            Err(e) => {
                                warn!(
                                    %team_id,
                                    error = %e,
                                    "daemon.toml names a team whose backend.toml is unreadable; \
                                     re-checking next cycle"
                                );
                            }
                        }
                    }
                }
                // Still teamless: there is nothing team-scoped to do on MQTT
                // (no presence topic, no teamclu command channel). Rather than
                // hold a connection open forever in a state onboarding can't
                // heal, back off and re-check daemon.toml on the next cycle.
                if self.config.team_id.is_none() {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        _ = &mut shutdown => {
                            info!("shutdown signal received while awaiting team_id");
                            let _ = std::fs::remove_file(&sock_path);
                            return Ok(());
                        }
                    }
                    continue 'outer;
                }
            }

            // ── 0b. Self-heal MQTT broker from bootstrap ──
            // If FC was unreachable at startup and daemon.toml had no invite
            // `?broker=` override, `config.mqtt.broker_url` stays empty forever
            // and the client below is rebuilt from an unusable broker every tick.
            // Re-fetch the bootstrap broker here — but only when it is actually
            // missing, so we don't hammer FC every cycle once a broker is known.
            if self.config.mqtt.broker_url.trim().is_empty() {
                let config_path = self.config_path.clone();
                if let Err(e) =
                    apply_bootstrap_overrides(&self.backend, &mut self.config, &config_path).await
                {
                    warn!(error = %e, "bootstrap mqtt re-fetch failed; will retry next cycle");
                }
                if self.config.mqtt.broker_url.trim().is_empty() {
                    // Still no broker: back off (honoring shutdown) rather than
                    // spin rebuilding a placeholder client against an empty URL.
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                        _ = &mut shutdown => {
                            info!("shutdown signal received while awaiting MQTT broker");
                            let _ = std::fs::remove_file(&sock_path);
                            return Ok(());
                        }
                    }
                    continue 'outer;
                }
            }

            // ── 1. Get fresh access_token (retry indefinitely on cloud backend errors) ──
            let token = loop {
                match self.backend.auth_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        // Race the sleep against shutdown so SIGTERM is honored
                        // during a cloud outage instead of forcing SIGKILL.
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                            _ = &mut shutdown => {
                                info!("shutdown signal received while retrying token fetch");
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                    }
                }
            };
            if credential_in_proactive_refresh_window(self.backend.cached_credential_expiry_epoch())
            {
                info!(
                    "cached JWT within proactive refresh window, forcing token refresh before MQTT connect"
                );
                self.backend.invalidate_cached_credential();
                continue 'outer;
            }

            // ── 2. Start the generation-independent MQTT supervisor ──
            // The supervisor owns every AsyncClient/EventLoop generation. The
            // publisher proxy held by SessionManager and all channel modules is
            // intentionally left untouched across reconnects.
            if let Some(team_id) = self.config.team_id.clone() {
                self.topics = crate::mqtt::Topics::new(&team_id, &self.config.actor.id);
                self.refresh_rpc_client_publisher();
                self.teamclu = match crate::teamclu::SessionManager::new(
                    self.publisher_handle.clone(),
                    &team_id,
                    &self.config.actor.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(mut tc) => {
                        tc.set_local_tee(self.live_tee.clone());
                        Some(tc)
                    }
                    Err(e) => {
                        warn!("teamclu rebuild failed: {e}");
                        None
                    }
                };
            }

            let command_rx = self
                .mqtt_command_rx
                .take()
                .expect("MQTT command receiver already taken");
            let recovery_rx = self
                .mqtt_recovery_rx
                .take()
                .expect("MQTT recovery receiver already taken");
            let mut mqtt_supervisor = MqttSupervisor::spawn(
                self.config.clone(),
                self.actor_id.clone(),
                token,
                self.backend.clone(),
                command_rx,
                recovery_rx,
                self.mqtt_connected_flag
                    .clone()
                    .expect("MQTT connected flag must be installed before run"),
                self.mqtt_snapshot.clone(),
            );

            // ── 3. Wait for the first generation to become ready ──
            loop {
                tokio::select! {
                    _ = &mut shutdown => {
                        mqtt_supervisor.shutdown().await;
                        self.shutdown_for_exit().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    event = mqtt_supervisor.events.recv() => match event {
                        Some(MqttSupervisorEvent::TransportConnected { generation, worker_generation }) => {
                            info!(generation, "MQTT first generation transport connected; restoring subscriptions and daemon state");
                            let restore_reason = match tokio::time::timeout(
                                Duration::from_secs(15),
                                    self.mqtt_resubscribe_after_connack(
                                        "initial",
                                        true,
                                        &mqtt_supervisor,
                                        generation,
                                        worker_generation,
                                    ),
                            )
                            .await
                            {
                                Ok(Ok(())) => None,
                                Ok(Err(reason)) => Some(reason),
                                Err(_) => Some("MQTT state restore timed out".to_string()),
                            };
                            if restore_reason.is_none()
                                && mqtt_supervisor
                                    .mark_generation_ready(generation, worker_generation)
                                    .await
                            {
                                break;
                            }
                            mqtt_supervisor
                                .request_rebuild_for_generation(
                                    generation,
                                    worker_generation,
                                    restore_reason.as_deref().unwrap_or(
                                        "initial MQTT subscription/state restore failed",
                                    ),
                                )
                                .await;
                        }
                        Some(MqttSupervisorEvent::Terminated) | None => {
                            self.shutdown_for_exit().await;
                            let _ = std::fs::remove_file(&sock_path);
                            return Ok(());
                        }
                        Some(MqttSupervisorEvent::SubscriptionsReady { .. })
                        | Some(MqttSupervisorEvent::GenerationReady { .. })
                        | Some(MqttSupervisorEvent::Disconnected { .. })
                        | Some(MqttSupervisorEvent::Rebuilt { .. }) => {}
                    }
                }
            }

            // ── 4. Subscribe and announce ──
            info!(actor_id = %self.config.actor.id, "MQTT connected, listening for commands");

            if first_connect {
                // Drain messages that landed in the cloud backend while the daemon
                // process was down. MQTT lives are dropped by the broker
                // when clean_session=true clients are offline, so anything
                // posted by desktop/iOS/expo between daemon stop and start
                // exists only in the `messages` table and would otherwise
                // never reach any agent.
                self.auto_restart_offline_sessions().await;
                first_connect = false;
            }

            // ── 5. Business/control loop ──
            // MQTT polling and connection recovery are now owned by the
            // supervisor. This loop dispatches only decoded frames and local
            // control commands, so a business await cannot freeze MQTT IO.
            loop {
                tokio::select! {
                    _ = &mut shutdown => {
                        info!("shutdown signal received, draining channels");
                        mqtt_supervisor.shutdown().await;
                        self.shutdown_for_exit().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    sock_cmd = sock_rx.recv() => {
                        match sock_cmd {
                            Some(SockCommand::Shutdown) => {
                                info!("shutdown control command received, draining channels");
                                mqtt_supervisor.shutdown().await;
                                self.shutdown_for_exit().await;
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                            Some(SockCommand::ChannelReload) => {
                                self.reload_channels().await;
                            }
                            Some(SockCommand::ChannelStatus { reply_tx }) => {
                                let body = self.channel_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::WecomBotsStatus { reply_tx }) => {
                                let body = self.wecom_bots_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::WecomChatList { reply_tx }) => {
                                let body = self.wecom_chat_list_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::ChannelSecretKeys { reply_tx }) => {
                                let _ = reply_tx.send(self.channel_secret_keys_payload());
                            }
                            Some(SockCommand::ChannelSave { platform, config_json }) => {
                                self.save_channel_config(&platform, &config_json).await;
                            }
                            Some(SockCommand::GatewayModelSave { model }) => {
                                self.save_gateway_model(&model).await;
                            }
                            Some(SockCommand::GatewayLocaleSave { locale }) => {
                                self.save_gateway_locale(&locale);
                            }
                            Some(SockCommand::McpSend { payload, reply_tx }) => {
                                let resp = match self.handle_mcp_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::ChannelSend { payload, reply_tx }) => {
                                let resp = match self.handle_channel_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::RemoteToolCall { payload, reply_tx }) => {
                                self.spawn_remote_tool_sock_handler(payload, reply_tx)
                                    .await;
                            }
                            Some(SockCommand::CursorPermission { payload, reply_tx }) => {
                                tokio::spawn(async move {
                                    let result =
                                        crate::runtime::cursor_sdk::permission::handle(&payload)
                                            .await;
                                    let _ = reply_tx.send(
                                        serde_json::json!({ "ok": true, "result": result })
                                            .to_string(),
                                    );
                                });
                            }
                            Some(SockCommand::LocalRpc { payload, reply_tx }) => {
                                let reply = self.dispatch_local_rpc(&payload).await;
                                let _ = reply_tx.send(reply);
                            }
                            Some(SockCommand::LocalLiveIngest {
                                session_id,
                                payload,
                                reply_tx,
                            }) => {
                                let reply = self.ingest_session_live(&session_id, &payload).await;
                                let _ = reply_tx.send(reply);
                            }
                            Some(SockCommand::PromptAwait { payload, reply_tx }) => {
                                // Fast setup inline; the turn runs on a task and
                                // its result comes back via `cron_turn_done_rx`
                                // (see the `finalize_cron_turn` select arm below).
                                self.handle_prompt_await(&payload, reply_tx).await;
                            }
                            Some(SockCommand::CronPrepareSession { payload, reply_tx }) => {
                                let resp = match self.handle_cron_prepare_session(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::PrewarmWorkspace { workspace_id, path }) => {
                                // Env assembly runs inline (fast); the host
                                // spawn itself is detached inside.
                                self.kick_prewarm_for_workspace(&path, &workspace_id).await;
                            }
                            Some(SockCommand::WechatQrStart { reply_tx }) => {
                                let base_url = teamclu_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclu_gateway::wechat::fetch_qr_code(&base_url).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrPoll { qrcode, reply_tx }) => {
                                let base_url = teamclu_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclu_gateway::wechat::poll_qr_status(&base_url, &qrcode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrStart { reply_tx }) => {
                                let resp = match teamclu_gateway::wecom::fetch_wecom_qr_code().await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrPoll { scode, reply_tx }) => {
                                let resp = match teamclu_gateway::wecom::poll_wecom_qr_result(&scode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::AddWorkspace { path, reply_tx }) => {
                                let body = self.handle_add_workspace_sock(&path).await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::Unknown(line)) => {
                                warn!("amuxd.sock: unknown control command: {line:?}");
                            }
                            None => {
                                // Sender dropped — listener task died. Log and
                                // keep running; we just lose the sock control
                                // path until next restart.
                                warn!("amuxd.sock: listener channel closed; control commands unavailable until restart");
                            }
                        }
                    }
                    done = cron_done_rx.recv() => {
                        // A background cron turn finished: persist its AgentReply
                        // and answer the waiting sock client. `None` only if all
                        // senders dropped (never — `self` holds the sender).
                        if let Some(done) = done {
                            self.finalize_cron_turn(done).await;
                        }
                    }
                    ev = cron_event_rx.recv() => {
                        // An in-flight cron turn emitted an ACP event; publish it
                        // so the desktop streams the run instead of sitting still
                        // until the finished reply lands.
                        if let Some(ev) = ev {
                            self.publish_cron_turn_event(ev).await;
                        }
                    }
                    event = mqtt_supervisor.events.recv() => {
                        match event {
                            Some(MqttSupervisorEvent::TransportConnected { generation, worker_generation }) => {
                                info!(generation, "MQTT generation transport connected; worker is restoring subscriptions");
                            }
                            Some(MqttSupervisorEvent::SubscriptionsReady { generation, worker_generation }) => {
                                info!(generation, "MQTT subscriptions ready; restoring daemon state");
                                let restore_reason = match tokio::time::timeout(
                                    Duration::from_secs(15),
                                    self.mqtt_resubscribe_after_connack(
                                        "auto-reconnect",
                                        false,
                                        &mqtt_supervisor,
                                        generation,
                                        worker_generation,
                                    ),
                                )
                                .await
                                {
                                    Ok(Ok(())) => None,
                                    Ok(Err(reason)) => Some(reason),
                                    Err(_) => Some("MQTT state restore timed out".to_string()),
                                };
                                if restore_reason.is_none()
                                    && mqtt_supervisor
                                        .mark_generation_ready(generation, worker_generation)
                                        .await
                                {
                                    info!(generation, "MQTT generation readiness acknowledged");
                                } else {
                                    warn!(generation, "MQTT state restore failed; requesting generation rebuild");
                                    mqtt_supervisor
                                        .request_rebuild_for_generation(
                                            generation,
                                            worker_generation,
                                            restore_reason
                                                .as_deref()
                                                .unwrap_or("MQTT subscription/state restore failed"),
                                        )
                                        .await;
                                }
                            }
                            Some(MqttSupervisorEvent::GenerationReady { generation, .. }) => {
                                info!(generation, "MQTT generation ready for business traffic");
                            }
                            Some(MqttSupervisorEvent::Disconnected { generation, reason, .. }) => {
                                warn!(generation, %reason, "MQTT generation disconnected; recovery is owned by supervisor");
                            }
                            Some(MqttSupervisorEvent::Rebuilt { generation, reason, .. }) => {
                                info!(generation, %reason, "MQTT generation rebuilt");
                            }
                            Some(MqttSupervisorEvent::Terminated) | None => {
                                self.shutdown_for_exit().await;
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                    }
                    inbound = mqtt_supervisor.inbound.recv() => {
                        if let Some(envelope) = inbound {
                            command_executor::DaemonCommandExecutor::new(&mut self)
                                .execute_mqtt(envelope, &mqtt_supervisor)
                                .await;
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {
                        let mqtt_up = self
                            .mqtt_connected_flag
                            .as_ref()
                            .map(|f| f.load(std::sync::atomic::Ordering::Relaxed))
                            .unwrap_or(true);
                        if mqtt_up {
                            let (agent_events, evicted_runtime_ids, actor_state_dirty): (
                                Vec<_>,
                                Vec<String>,
                                bool,
                            ) = {
                                let mut mgr = self.agents.lock().await;
                                (
                                    mgr.poll_events(),
                                    mgr.drain_evicted(),
                                    mgr.take_actor_state_dirty(),
                                )
                            };
                            for runtime_id in evicted_runtime_ids {
                                self.publish_runtime_detached(&runtime_id).await;
                            }
                            // Covers every attach/detach, including the gateway
                            // and cron spawns that never reach
                            // `apply_start_runtime` and so were invisible in the
                            // retain until an unrelated reconnect.
                            if actor_state_dirty {
                                let _ = self.publish_actor_state().await;
                            }
                            for (agent_id, acp_event) in coalesce_text_events(agent_events) {
                                self.forward_agent_event(&agent_id, acp_event).await;
                            }
                        }
                    }
                }
            }
            // loop exited → outer: get fresh token and reconnect
        }
    }

    /// NATS transport main loop. Parallel to the MQTT path in `run()` above —
    /// same token-refresh outer cadence, but the inner loop polls the NATS
    /// inbound channel (mpsc Receiver fed by per-subscription tasks inside
    /// `teamclu_transport::nats::NatsClient`).
    ///
    /// Differences vs MQTT:
    /// - No CONNACK wait: async_nats returns from `connect` only after the
    ///   server has accepted the connection.
    /// - No LWT: graceful offline state is written to JetStream KV during
    ///   shutdown / reconnect; ungraceful disconnects are detected by the
    ///   server-side auth callout.
    /// - No `eventloop.poll()` to cancel — async_nats reconnects internally
    ///   on transport-level errors, so the proactive-reconnect path just
    ///   builds a fresh `NatsBackend` rather than draining a half-closed
    ///   socket.
    pub(crate) async fn run_nats<F>(
        mut self,
        shutdown: F,
        mut sock_rx: mpsc::Receiver<SockCommand>,
        sock_path: PathBuf,
    ) -> crate::error::Result<()>
    where
        F: Future<Output = ()>,
    {
        use teamclu_transport::DeliveryGuarantee;
        tokio::pin!(shutdown);

        let url = self
            .config
            .transport
            .as_ref()
            .map(|t| t.url.clone())
            .ok_or_else(|| {
                crate::error::AmuxError::Config(
                    "[transport] section requires `url` when kind = nats".into(),
                )
            })?;

        let mut first_connect = true;

        // See the MQTT path: taken once before the reconnect loop so the
        // `finalize_cron_turn` select arm can drain completed cron turns.
        let mut cron_done_rx = self
            .cron_turn_done_rx
            .take()
            .expect("cron_turn_done_rx already taken (NATS run loop entered twice)");
        let mut cron_event_rx = self
            .cron_turn_event_rx
            .take()
            .expect("cron_turn_event_rx already taken (NATS run loop entered twice)");

        'outer: loop {
            // 1. Fresh backend access_token; same retry cadence as MQTT path.
            let token = loop {
                match self.backend.auth_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        // Race the sleep against shutdown so SIGTERM is honored
                        // during a cloud outage instead of forcing SIGKILL.
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                            _ = &mut shutdown => {
                                info!("shutdown signal received while retrying token fetch");
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                        }
                    }
                }
            };
            if credential_in_proactive_refresh_window(self.backend.cached_credential_expiry_epoch())
            {
                info!(
                    "cached JWT within proactive refresh window, forcing token refresh before NATS connect"
                );
                self.backend.invalidate_cached_credential();
                continue 'outer;
            }

            // 2. Connect.
            info!(
                actor_id = %self.actor_id,
                %url,
                "NATS connecting with access_token"
            );
            let backend = match crate::nats::NatsBackend::connect(&self.config, &url, &token).await
            {
                Ok(b) => b,
                Err(e) => {
                    warn!("NATS connect failed: {e}, retrying in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue 'outer;
                }
            };

            // 3. Re-wire publisher_handle + topics so all downstream
            //    Publisher::new_from_handle / SessionManager publishes route
            //    through the NATS backend instead of the MQTT one.
            self.publisher_handle = Arc::new(backend.client.clone());
            self.topics = backend.topics.clone();
            self.refresh_rpc_client_publisher();
            if let Some(team_id) = self.config.team_id.clone() {
                self.teamclu = match crate::teamclu::SessionManager::new(
                    self.publisher_handle.clone(),
                    &team_id,
                    &self.config.actor.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(mut tc) => {
                        tc.set_local_tee(self.live_tee.clone());
                        Some(tc)
                    }
                    Err(e) => {
                        warn!("teamclu rebuild on NATS failed: {e}");
                        None
                    }
                };
            }
            self.nats = Some(backend);

            // 4. Subscribe + announce online.
            if let Err(e) = self.nats.as_ref().unwrap().subscribe_all().await {
                warn!("nats subscribe_all failed: {e}, reconnecting");
                continue 'outer;
            }
            if let Some(tc) = &mut self.teamclu {
                if let Err(e) = tc.subscribe_all().await {
                    warn!("teamclu subscribe failed on NATS: {e}, reconnecting");
                    continue 'outer;
                }
            }
            if let Err(e) = self
                .nats
                .as_ref()
                .unwrap()
                .announce_online(&self.config.actor.name)
                .await
            {
                warn!("nats announce_online failed: {e}, reconnecting");
                continue 'outer;
            }
            self.publish_all_agent_states().await;
            info!(actor_id = %self.config.actor.id, "NATS connected, listening for runtime commands");

            if first_connect {
                self.auto_restart_offline_sessions().await;
                first_connect = false;
            }

            // 5. Proactive reconnect timer (mirrors MQTT path: refresh ~5min
            //    before cached JWT expiry). On NATS this means tearing down
            //    the current client and reconnecting with the new token —
            //    async_nats keeps the auth token only at connect time, so an
            //    in-place refresh isn't possible without a fresh connection.
            let proactive_reconnect_in =
                proactive_reconnect_delay(self.backend.cached_credential_expiry_epoch());
            info!(
                reconnect_in_secs = proactive_reconnect_in.as_secs(),
                "scheduled proactive NATS reconnect before token expiry"
            );
            let proactive_sleep = tokio::time::sleep(proactive_reconnect_in);
            tokio::pin!(proactive_sleep);

            // 6. Inner select loop — three arms: shutdown, sock command,
            //    inbound NATS frame. The inbound receiver is moved out of
            //    `self.nats` once for the duration of this select cycle and
            //    re-attached on reconnect.
            //
            //    We can't borrow `&mut self.nats.inbound` *and* call
            //    `&mut self` methods inside the same select arm, so the
            //    receiver is owned locally and the backend reference goes
            //    along with it. SessionManager and Publisher reads happen
            //    via the cloned `publisher_handle`, which doesn't touch
            //    `self.nats`.
            let mut inbound = self.nats.as_mut().unwrap().inbound_take();
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        info!("shutdown signal received, draining channels");
                        if let Some(nats) = &self.nats {
                            let _ = nats.announce_offline(&self.config.actor.name).await;
                        }
                        self.shutdown_for_exit().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    sock_cmd = sock_rx.recv() => {
                        match sock_cmd {
                            Some(SockCommand::Shutdown) => {
                                info!("shutdown control command received, draining channels");
                                if let Some(nats) = &self.nats {
                                    let _ = nats.announce_offline(&self.config.actor.name).await;
                                }
                                self.shutdown_for_exit().await;
                                let _ = std::fs::remove_file(&sock_path);
                                return Ok(());
                            }
                            Some(SockCommand::ChannelReload) => self.reload_channels().await,
                            Some(SockCommand::ChannelStatus { reply_tx }) => {
                                let body = self.channel_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::WecomBotsStatus { reply_tx }) => {
                                let body = self.wecom_bots_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::WecomChatList { reply_tx }) => {
                                let body = self.wecom_chat_list_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::ChannelSecretKeys { reply_tx }) => {
                                let _ = reply_tx.send(self.channel_secret_keys_payload());
                            }
                            Some(SockCommand::ChannelSave { platform, config_json }) => {
                                self.save_channel_config(&platform, &config_json).await;
                            }
                            Some(SockCommand::GatewayModelSave { model }) => {
                                self.save_gateway_model(&model).await;
                            }
                            Some(SockCommand::GatewayLocaleSave { locale }) => {
                                self.save_gateway_locale(&locale);
                            }
                            Some(SockCommand::McpSend { payload, reply_tx }) => {
                                let resp = match self.handle_mcp_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::ChannelSend { payload, reply_tx }) => {
                                let resp = match self.handle_channel_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::RemoteToolCall { payload, reply_tx }) => {
                                self.spawn_remote_tool_sock_handler(payload, reply_tx)
                                    .await;
                            }
                            Some(SockCommand::CursorPermission { payload, reply_tx }) => {
                                tokio::spawn(async move {
                                    let result =
                                        crate::runtime::cursor_sdk::permission::handle(&payload)
                                            .await;
                                    let _ = reply_tx.send(
                                        serde_json::json!({ "ok": true, "result": result })
                                            .to_string(),
                                    );
                                });
                            }
                            Some(SockCommand::LocalRpc { payload, reply_tx }) => {
                                let reply = self.dispatch_local_rpc(&payload).await;
                                let _ = reply_tx.send(reply);
                            }
                            Some(SockCommand::LocalLiveIngest {
                                session_id,
                                payload,
                                reply_tx,
                            }) => {
                                let reply = self.ingest_session_live(&session_id, &payload).await;
                                let _ = reply_tx.send(reply);
                            }
                            Some(SockCommand::PromptAwait { payload, reply_tx }) => {
                                // Fast setup inline; the turn runs on a task and
                                // its result comes back via `cron_turn_done_rx`
                                // (see the `finalize_cron_turn` select arm below).
                                self.handle_prompt_await(&payload, reply_tx).await;
                            }
                            Some(SockCommand::CronPrepareSession { payload, reply_tx }) => {
                                let resp = match self.handle_cron_prepare_session(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::PrewarmWorkspace { workspace_id, path }) => {
                                // Env assembly runs inline (fast); the host
                                // spawn itself is detached inside.
                                self.kick_prewarm_for_workspace(&path, &workspace_id).await;
                            }
                            Some(SockCommand::WechatQrStart { reply_tx }) => {
                                let base_url = teamclu_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclu_gateway::wechat::fetch_qr_code(&base_url).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrPoll { qrcode, reply_tx }) => {
                                let base_url = teamclu_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclu_gateway::wechat::poll_qr_status(&base_url, &qrcode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrStart { reply_tx }) => {
                                let resp = match teamclu_gateway::wecom::fetch_wecom_qr_code().await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrPoll { scode, reply_tx }) => {
                                let resp = match teamclu_gateway::wecom::poll_wecom_qr_result(&scode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::AddWorkspace { path, reply_tx }) => {
                                let body = self.handle_add_workspace_sock(&path).await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::Unknown(line)) => warn!("amuxd.sock: unknown control command: {line:?}"),
                            None => warn!("amuxd.sock: listener channel closed; control commands unavailable until restart"),
                        }
                    }
                    done = cron_done_rx.recv() => {
                        // Background cron turn finished — persist + reply. See the
                        // matching arm in the MQTT loop.
                        if let Some(done) = done {
                            self.finalize_cron_turn(done).await;
                        }
                    }
                    ev = cron_event_rx.recv() => {
                        // Streaming events of an in-flight cron turn. See the
                        // matching arm in the MQTT loop.
                        if let Some(ev) = ev {
                            self.publish_cron_turn_event(ev).await;
                        }
                    }
                    frame = inbound.recv() => {
                        match frame {
                            Some(f) => {
                                if let Some(msg) = crate::mqtt::subscriber::parse_frame(&f) {
                                    self.handle_incoming(msg).await;
                                }
                            }
                            None => {
                                warn!("NATS inbound channel closed, reconnecting");
                                break;
                            }
                        }
                    }
                    _ = &mut proactive_sleep => {
                        info!(
                            expiry = ?self.backend.cached_credential_expiry_epoch(),
                            "JWT nearing expiry, proactively reconnecting NATS"
                        );
                        self.backend.invalidate_cached_credential();
                        // Mark offline before tearing down so subscribers see
                        // the presence change immediately rather than waiting
                        // for the next online publish.
                        if let Some(nats) = &self.nats {
                            let _ = nats.announce_offline(&self.config.actor.name).await;
                        }
                        break;
                    }
                }
            }
            // Put the inbound receiver back so the next reconnect can take it.
            self.nats.as_mut().unwrap().inbound_put_back(inbound);
            // loop exited → outer: get fresh token and reconnect
            let _ = DeliveryGuarantee::AtLeastOnce; // touch import so it stays
        }
    }

    /// Re-engage with sessions that had a runtime before the daemon was
    /// last shut down so we can replay messages that landed in the cloud backend
    /// while the daemon was offline.
    ///
    /// Daemon-owned runtimes are subprocesses; they die when the daemon
    /// process exits. MQTT live publishes against those sessions are
    /// dropped by the broker (clean_session=true), so the only record of
    /// those messages is the `messages` table. The user-facing symptom is
    /// "messages I sent while the daemon was off never get a reply"
    /// (mentions go unanswered, silent messages never enter the runtime's
    /// pending_silent queue).
    ///
    /// Strategy: for each session this daemon is a member of, look up the
    /// most recent `agent_runtimes` row owned by this daemon. If the row
    /// has unread messages strictly after the row's
    /// `last_processed_message_id` cursor, spawn the runtime (reusing the
    /// row's `workspace_id` + `backend_type`). The existing
    /// `catchup_runtime` path then routes those messages through
    /// `route_session_message`, which sends `[Context]` prefixes for
    /// un-mentioned rows and a real prompt for mentions.
    ///
    /// Self-authored rows are filtered out — they are the daemon's own
    /// prior agent replies, not user input that needs processing.
    pub(crate) async fn auto_restart_offline_sessions(&mut self) {
        let plan = self.plan_auto_restart_offline_sessions().await;
        if plan.is_empty() {
            return;
        }
        info!(
            count = plan.len(),
            "auto_restart_offline_sessions: spawning {} runtime(s) for sessions with offline messages",
            plan.len()
        );
        for entry in plan {
            info!(
                session_id = %entry.session_id,
                workspace_id = %entry.local_workspace_id,
                backend = ?entry.backend,
                unread = entry.unread_count,
                "auto_restart_offline_sessions: spawning runtime to drain offline messages"
            );
            match self
                .apply_start_runtime(
                    entry.backend,
                    &entry.local_workspace_id,
                    "",
                    &entry.session_id,
                    "",
                    None,
                    "",
                    false,
                )
                .await
            {
                Ok(outcome) => {
                    info!(
                        session_id = %entry.session_id,
                        runtime_id = %outcome.runtime_id,
                        "auto_restart_offline_sessions: runtime spawned, catchup_runtime engaged"
                    );
                }
                Err(err) => {
                    warn!(
                        session_id = %entry.session_id,
                        error = %err.error_message,
                        stage = %err.failed_stage,
                        "auto_restart_offline_sessions: apply_start_runtime failed"
                    );
                }
            }
        }
    }

    /// Pure-decision half of [`auto_restart_offline_sessions`]: walks
    /// membership sessions, queries the cloud backend, and returns the subset that
    /// should be re-spawned. Extracted so unit tests can drive the
    /// branching logic (no prior row → skip, only self-authored unread →
    /// skip, already-running runtime → skip, etc.) without booting a real
    /// ACP backend.
    pub(crate) async fn plan_auto_restart_offline_sessions(&self) -> Vec<OfflineRestartPlan> {
        let session_ids: Vec<String> = match self.teamclu.as_ref() {
            Some(tc) => tc.membership_session_ids(),
            None => return Vec::new(),
        };
        if session_ids.is_empty() {
            return Vec::new();
        }
        info!(
            count = session_ids.len(),
            "plan_auto_restart_offline_sessions: scanning membership sessions for offline messages"
        );

        let mut plan = Vec::new();
        let my_actor = self.actor_id.clone();
        for session_id in session_ids {
            // The cursor comes from this actor's participant row (ADR-0005).
            // `None` means "never read anything here", which is materially
            // different from the old "no runtime row → skip the session": a
            // session this daemon has joined but never answered in should still
            // be planned for restart, from the beginning.
            let prior_cursor = match self
                .backend
                .fetch_session_cursor(&session_id, &my_actor)
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    warn!(
                        ?e,
                        session_id = %session_id,
                        "plan_auto_restart_offline_sessions: fetch_session_cursor failed"
                    );
                    continue;
                }
            };

            // If a live runtime is already serving this session (e.g. a
            // network blip rather than a full daemon restart), skip — the
            // live MQTT path will deliver the messages directly.
            let already_running = !self
                .agents
                .lock()
                .await
                .runtime_ids_for_session(&session_id)
                .is_empty();
            if already_running {
                continue;
            }

            let cursor = prior_cursor.as_deref().filter(|s| !s.is_empty());
            let messages = match self
                .backend
                .messages_after_cursor(&session_id, cursor)
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    warn!(
                        ?e,
                        session_id = %session_id,
                        "plan_auto_restart_offline_sessions: messages_after_cursor failed"
                    );
                    continue;
                }
            };

            if !slice_has_actionable_inbound(&messages, &my_actor) {
                continue;
            }

            let unread_count = messages
                .iter()
                .filter(|m| m.sender_actor_id != my_actor)
                .count();

            // One backend is active per actor at a time (ADR-0002), so the
            // restart uses the daemon's own rather than replaying whatever a
            // prior spawn happened to record.
            let backend = resolve_requested_agent_type(&self.config, amux::AgentType::Unknown);

            // Workspace comes from the participant row that owns it (ADR-0005).
            // Empty means "resolve at spawn from the agent's default", the same
            // fallback a session with no prior runtime always took.
            let local_workspace_id = self
                .backend
                .fetch_session_workspace(&session_id, &my_actor)
                .await
                .unwrap_or_default()
                .unwrap_or_default();

            plan.push(OfflineRestartPlan {
                session_id,
                backend,
                local_workspace_id,
                unread_count,
            });
        }
        plan
    }
}

fn reject_stop(
    request: &crate::proto::teamclu::RpcRequest,
    reason: &str,
) -> crate::proto::teamclu::RpcResponse {
    use crate::proto::teamclu::{rpc_response, RpcResponse, RuntimeStopResult};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: reason.to_string(),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
            accepted: false,
            rejected_reason: reason.to_string(),
        })),
    }
}

fn reject_set_model(
    request: &crate::proto::teamclu::RpcRequest,
    reason: &str,
) -> crate::proto::teamclu::RpcResponse {
    use crate::proto::teamclu::{rpc_response, RpcResponse, SetModelResult};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: reason.to_string(),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::SetModelResult(SetModelResult {
            success: false,
            error: reason.to_string(),
        })),
    }
}

/// Shrinks an `AcpAvailableCommands` list in place so the serialized message
/// stays under the broker's per-packet cap. Strategy: walk the description
/// length down (80 → 40 → 20 → 0) until the encoded size fits; if stripping
/// descriptions is still not enough, drop commands from the tail.
///
/// The budget is deliberately well under the 10 240-byte broker limit to
/// leave headroom for the envelope wrapper (actor_id, agent_id, sequence,
/// etc.) and the MQTT topic name / fixed header.
fn fit_available_commands_in_budget(ac: &mut crate::proto::amux::AcpAvailableCommands) {
    use prost::Message;
    const BUDGET: usize = 8_500;

    if ac.encoded_len() <= BUDGET {
        return;
    }

    for &limit in &[80usize, 40, 20, 0] {
        for cmd in &mut ac.commands {
            if cmd.description.chars().count() > limit {
                cmd.description = cmd.description.chars().take(limit).collect();
            }
        }
        if ac.encoded_len() <= BUDGET {
            return;
        }
    }

    while ac.encoded_len() > BUDGET && !ac.commands.is_empty() {
        ac.commands.pop();
    }
}

/// Handle one control connection: read a newline-terminated command (line
/// protocol or `{`-sniffed JSON envelope) and forward it to the main loop.
/// Generic over the transport: UnixStream on unix, NamedPipeServer on Windows.
async fn handle_control_conn<S>(stream: S, tx: mpsc::Sender<SockCommand>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    match reader.read_line(&mut first_line).await {
        Ok(0) => {}
        Ok(_) => {
            let head = first_line.trim();

            // JSON envelopes (currently just `mcp-send`)
            // are framed differently from the legacy
            // line-based control protocol — sniff the
            // first byte and branch.
            if head.starts_with('{') {
                let parsed: Result<serde_json::Value, _> = serde_json::from_str(head);
                match parsed {
                    Ok(v) => {
                        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
                        if cmd == "channel-send" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::ChannelSend {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: channel-send write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: channel-send reply dropped");
                                }
                            }
                        } else if cmd == "mcp-send" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::McpSend {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: mcp-send write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: mcp-send reply dropped");
                                }
                            }
                        } else if cmd == "remote-tool-call" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::RemoteToolCall {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: remote-tool-call write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: remote-tool-call reply dropped");
                                }
                            }
                        } else if cmd == "cursor-permission" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::CursorPermission {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: cursor-permission write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: cursor-permission reply dropped");
                                }
                            }
                        } else if cmd == "prompt-await" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::PromptAwait {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: prompt-await write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: prompt-await reply dropped");
                                }
                            }
                        } else if cmd == "cron-prepare-session" {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx
                                .send(SockCommand::CronPrepareSession {
                                    payload: v,
                                    reply_tx,
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            match reply_rx.await {
                                Ok(body) => {
                                    let mut stream = reader.into_inner();
                                    if let Err(e) = stream.write_all(body.as_bytes()).await {
                                        warn!("amuxd.sock: cron-prepare-session write failed: {e}");
                                        return;
                                    }
                                    let _ = stream.write_all(b"\n").await;
                                    let _ = stream.shutdown().await;
                                }
                                Err(_) => {
                                    warn!("amuxd.sock: cron-prepare-session reply dropped");
                                }
                            }
                        } else {
                            warn!("amuxd.sock: unknown JSON cmd: {cmd:?}");
                        }
                    }
                    Err(e) => {
                        warn!("amuxd.sock: JSON parse failed: {e}");
                    }
                }
                return;
            }

            match head {
                "channel-reload" => {
                    let _ = tx.send(SockCommand::ChannelReload).await;
                }
                "channel-status" => {
                    // Round-trip: ask the main loop to build a
                    // status snapshot, then write the JSON body
                    // back to the connected client.
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::ChannelStatus { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    match reply_rx.await {
                        Ok(body) => {
                            let mut stream = reader.into_inner();
                            if let Err(e) = stream.write_all(body.as_bytes()).await {
                                warn!("amuxd.sock: channel-status write failed: {e}");
                                return;
                            }
                            let _ = stream.write_all(b"\n").await;
                            let _ = stream.shutdown().await;
                        }
                        Err(_) => {
                            warn!("amuxd.sock: channel-status reply dropped");
                        }
                    }
                }
                "channel-secret-keys" => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::ChannelSecretKeys { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    match reply_rx.await {
                        Ok(body) => {
                            let mut stream = reader.into_inner();
                            if let Err(e) = stream.write_all(body.as_bytes()).await {
                                warn!("amuxd.sock: channel-secret-keys write failed: {e}");
                                return;
                            }
                            let _ = stream.write_all(b"\n").await;
                            let _ = stream.shutdown().await;
                        }
                        Err(_) => {
                            warn!("amuxd.sock: channel-secret-keys reply dropped");
                        }
                    }
                }
                "wecom-chat-list" => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomChatList { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    match reply_rx.await {
                        Ok(body) => {
                            let mut stream = reader.into_inner();
                            if let Err(e) = stream.write_all(body.as_bytes()).await {
                                warn!("amuxd.sock: wecom-chat-list write failed: {e}");
                                return;
                            }
                            let _ = stream.write_all(b"\n").await;
                            let _ = stream.shutdown().await;
                        }
                        Err(_) => {
                            warn!("amuxd.sock: wecom-chat-list reply dropped");
                        }
                    }
                }
                "wecom-bots-status" => {
                    // Round-trip: ask the main loop to build a
                    // per-bot WeCom status snapshot, then write the
                    // JSON body back to the connected client.
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomBotsStatus { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    match reply_rx.await {
                        Ok(body) => {
                            let mut stream = reader.into_inner();
                            if let Err(e) = stream.write_all(body.as_bytes()).await {
                                warn!("amuxd.sock: wecom-bots-status write failed: {e}");
                                return;
                            }
                            let _ = stream.write_all(b"\n").await;
                            let _ = stream.shutdown().await;
                        }
                        Err(_) => {
                            warn!("amuxd.sock: wecom-bots-status reply dropped");
                        }
                    }
                }
                "wechat-qr-start" => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WechatQrStart { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "wechat-qr-poll" => {
                    let mut qrcode = String::new();
                    if reader.read_line(&mut qrcode).await.is_err() {
                        warn!("amuxd.sock: wechat-qr-poll missing qrcode");
                        return;
                    }
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WechatQrPoll {
                            qrcode: qrcode.trim().to_string(),
                            reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "wecom-qr-start" => {
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomQrStart { reply_tx })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "wecom-qr-poll" => {
                    let mut scode = String::new();
                    if reader.read_line(&mut scode).await.is_err() {
                        warn!("amuxd.sock: wecom-qr-poll missing scode");
                        return;
                    }
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if tx
                        .send(SockCommand::WecomQrPoll {
                            scode: scode.trim().to_string(),
                            reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Ok(body) = reply_rx.await {
                        let mut stream = reader.into_inner();
                        let _ = stream.write_all(body.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                        let _ = stream.shutdown().await;
                    }
                }
                "channel-save" => {
                    // Wire format: line 1 = "channel-save",
                    // line 2 = platform, line 3+ = JSON
                    // (single line — JSON has no embedded \n
                    // after `to_string()` serialization).
                    let mut platform = String::new();
                    if reader.read_line(&mut platform).await.is_err() {
                        warn!("amuxd.sock: channel-save missing platform");
                        return;
                    }
                    let mut config_json = String::new();
                    if reader.read_line(&mut config_json).await.is_err() {
                        warn!("amuxd.sock: channel-save missing config json");
                        return;
                    }
                    let _ = tx
                        .send(SockCommand::ChannelSave {
                            platform: platform.trim().to_string(),
                            config_json: config_json.trim().to_string(),
                        })
                        .await;
                }
                "gateway-model" => {
                    // Wire format: line 1 = "gateway-model", line 2 = the
                    // `provider/model` ref (empty line clears the setting).
                    let mut model = String::new();
                    if reader.read_line(&mut model).await.is_err() {
                        warn!("amuxd.sock: gateway-model missing model");
                        return;
                    }
                    let _ = tx
                        .send(SockCommand::GatewayModelSave {
                            model: model.trim().to_string(),
                        })
                        .await;
                }
                "gateway-locale" => {
                    // Wire format: line 1 = "gateway-locale", line 2 = the
                    // language tag (empty line clears the setting).
                    let mut locale = String::new();
                    if reader.read_line(&mut locale).await.is_err() {
                        warn!("amuxd.sock: gateway-locale missing locale");
                        return;
                    }
                    let _ = tx
                        .send(SockCommand::GatewayLocaleSave {
                            locale: locale.trim().to_string(),
                        })
                        .await;
                }
                "shutdown" => {
                    let _ = tx.send(SockCommand::Shutdown).await;
                }
                other => {
                    let _ = tx.send(SockCommand::Unknown(other.to_string())).await;
                }
            }
        }
        Err(e) => {
            warn!("amuxd.sock: read_line failed: {e}");
        }
    }
}

/// Bind `amuxd.sock` and spawn a task that accepts connections, reads a
/// single newline-terminated control command per connection, and forwards
/// the parsed `SockCommand` to the daemon's main loop via `tx`. Stale
/// socket files left over from a crashed previous run are removed before
/// bind. Errors are logged and swallowed — the daemon must keep running
/// even if the sock can't be set up (operators can still kill it via
/// SIGTERM).
#[cfg(unix)]
fn spawn_sock_listener(sock_path: PathBuf, tx: mpsc::Sender<SockCommand>) {
    // Make sure the parent directory exists (e.g. on first run).
    if let Some(parent) = sock_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!(
                "amuxd.sock: failed to create parent dir {}: {e}",
                parent.display()
            );
            return;
        }
    }
    // Remove a stale socket left by an earlier crash; `bind` returns
    // AddrInUse otherwise.
    let _ = std::fs::remove_file(&sock_path);

    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(e) => {
            error!("amuxd.sock: bind {} failed: {e}", sock_path.display());
            return;
        }
    };
    info!("amuxd.sock: listening on {}", sock_path.display());

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tokio::spawn(handle_control_conn(stream, tx.clone()));
                }
                Err(e) => {
                    warn!("amuxd.sock: accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    });
}

/// Windows: serve the same line/JSON control protocol over a named pipe.
/// `sock_path` carries the pipe name (`\\.\pipe\amuxd-<user>`, from
/// `DaemonConfig::sock_path()`). Errors are logged and swallowed — the
/// daemon must keep running even if the pipe can't be set up.
#[cfg(windows)]
fn spawn_sock_listener(sock_path: PathBuf, tx: mpsc::Sender<SockCommand>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    let pipe_name = sock_path.to_string_lossy().into_owned();
    let mut server = match ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
    {
        Ok(s) => s,
        Err(e) => {
            error!("amuxd control pipe: create {pipe_name} failed: {e}");
            return;
        }
    };
    info!("amuxd control pipe: listening on {pipe_name}");
    tokio::spawn(async move {
        loop {
            // A connect() error is typically transient (client vanished mid-
            // handshake, spurious OS error). Mirror the unix accept loop's
            // policy: log and keep serving rather than killing the control
            // channel for the daemon's lifetime.
            if let Err(e) = server.connect().await {
                error!("amuxd control pipe: connect failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Re-creating the next instance failing is unrecoverable (the pipe
            // name itself is unusable), so the listener task exits here.
            let next = match ServerOptions::new().create(&pipe_name) {
                Ok(s) => s,
                Err(e) => {
                    error!("amuxd control pipe: re-create failed: {e}");
                    return;
                }
            };
            let stream = std::mem::replace(&mut server, next);
            tokio::spawn(handle_control_conn(stream, tx.clone()));
        }
    });
}

fn not_yet_implemented(
    request: &crate::proto::teamclu::RpcRequest,
    method_name: &str,
) -> crate::proto::teamclu::RpcResponse {
    crate::proto::teamclu::RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: format!("{} not yet implemented", method_name),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: None,
    }
}

/// Merge runs of consecutive Output (resp. Thinking) events from the SAME
/// agent within one 50ms drain batch into a single event. The drain loop in
/// `run()` already collects these together, so merging adds zero latency
/// while cutting MQTT publish count (one QoS round-trip + ~220B envelope
/// overhead saved per eliminated packet) during fast streaming.
///
/// Boundaries that STOP a merge: different agent, different event kind,
/// any non-text event, or an Output already marked `is_complete` (a finalized
/// reply must not absorb the next turn's first delta). Non-text events
/// (tool_use, status_change, …) pass through untouched, preserving order.
fn coalesce_text_events(events: Vec<(String, AcpEventFrame)>) -> Vec<(String, AcpEventFrame)> {
    let mut out: Vec<(String, AcpEventFrame)> = Vec::with_capacity(events.len());
    for (agent_id, frame) in events {
        if let Some((last_id, last_frame)) = out.last_mut() {
            if *last_id == agent_id && last_frame.acp_session_id == frame.acp_session_id {
                match (&mut last_frame.event.event, &frame.event.event) {
                    (
                        Some(amux::acp_event::Event::Output(prev)),
                        Some(amux::acp_event::Event::Output(next)),
                    ) if !prev.is_complete => {
                        prev.text.push_str(&next.text);
                        prev.is_complete = next.is_complete;
                        continue;
                    }
                    (
                        Some(amux::acp_event::Event::Thinking(prev)),
                        Some(amux::acp_event::Event::Thinking(next)),
                    ) => {
                        prev.text.push_str(&next.text);
                        continue;
                    }
                    _ => {}
                }
            }
        }
        out.push((agent_id, frame));
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::runtime::acp_event_frame::AcpEventFrame;
    use crate::team_link::ensure_team_link;
    use rumqttc::{AsyncClient, MqttOptions};
    use std::io;
    use tempfile::TempDir;

    #[test]
    pub(crate) fn cloud_rows_to_local_linkable_paths_filters_missing_fs_paths() {
        let existing = tempfile::tempdir().unwrap();
        let rows = vec![
            crate::backend::WorkspaceRow {
                id: "ws-exists".into(),
                team_id: "team-1".into(),
                path: Some(existing.path().to_string_lossy().to_string()),
                archived: false,
                agent_id: None,
            },
            crate::backend::WorkspaceRow {
                id: "ws-missing".into(),
                team_id: "team-1".into(),
                path: Some("/definitely/not/on/this/machine/team-link-test".into()),
                archived: false,
                agent_id: None,
            },
            crate::backend::WorkspaceRow {
                id: "ws-no-path".into(),
                team_id: "team-1".into(),
                path: None,
                archived: false,
                agent_id: None,
            },
        ];
        let linkable = cloud_rows_to_local_linkable_paths(&rows);
        assert_eq!(
            linkable,
            vec![existing.path().to_string_lossy().to_string()]
        );
    }

    #[tokio::test]
    pub(crate) async fn sync_team_shared_dirs_sources_from_cloud_and_skips_missing_paths() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        // SAFETY: serialized by TEST_HOME_LOCK.
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-test";
        let existing = tempfile::tempdir().unwrap();
        let existing_path = existing.path().to_string_lossy().to_string();

        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            team_id,
            "agent-actor",
        ));
        {
            let mut st = mock.state();
            st.team_share_configs.insert(
                team_id.to_string(),
                crate::backend::ShareModeConfig {
                    mode: Some("oss".to_string()),
                    ..Default::default()
                },
            );
            st.workspaces_by_id.insert(
                "ws-exists".to_string(),
                crate::backend::WorkspaceRow {
                    id: "ws-exists".to_string(),
                    team_id: team_id.to_string(),
                    path: Some(existing_path.clone()),
                    archived: false,
                    agent_id: None,
                },
            );
            st.workspaces_by_id.insert(
                "ws-missing".to_string(),
                crate::backend::WorkspaceRow {
                    id: "ws-missing".to_string(),
                    team_id: team_id.to_string(),
                    path: Some("/definitely/not/on/this/machine/team-link-test".to_string()),
                    archived: false,
                    agent_id: None,
                },
            );
        }

        let ts = test_server_with_cloud_api(mock.clone());
        ts.server.sync_team_shared_dirs_for_known_workspaces().await;

        assert!(
            existing
                .path()
                .join(crate::config::global_team_store::TEAM_LINK_NAME)
                .exists(),
            "existing on-disk path should get a teamclu-team link"
        );
    }

    #[cfg(unix)]
    #[test]
    pub(crate) fn ensure_team_link_creates_global_dir_and_workspace_symlink() {
        // Serializes with other HOME-mutating tests (config_dir reads $HOME).
        let _guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let ws = tempfile::tempdir().unwrap();
        let ws_path = ws.path().to_str().unwrap();

        ensure_team_link("team-ondemand", ws_path);

        // Global dir + scaffold created under ~/.amuxd/teams/<id>/teamclu-team.
        let global = crate::config::global_team_store::global_team_dir("team-ondemand");
        assert!(global.is_dir(), "global team dir should be created");
        assert!(global.join("knowledge").is_dir());

        // Workspace exposes it via a teamclu-team symlink to that global dir.
        let link = ws.path().join("teamclu-team");
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "workspace entry should be a symlink"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), global);

        // Idempotent: a second call must not error or change the target.
        ensure_team_link("team-ondemand", ws_path);
        assert_eq!(std::fs::read_link(&link).unwrap(), global);

        // Empty team_id is a no-op (no stray dir/link).
        let ws2 = tempfile::tempdir().unwrap();
        ensure_team_link("", ws2.path().to_str().unwrap());
        assert!(std::fs::symlink_metadata(ws2.path().join("teamclu-team")).is_err());
    }

    pub(crate) struct TestServer {
        pub(crate) server: DaemonServer,
        _tmp: TempDir,
        // Keep the event loop alive for the AsyncClient-backed publisher used
        // by these unit-test fixtures. Dropping it closes rumqttc's request
        // channel, making otherwise local subscribe/publish calls fail.
        _mqtt_eventloop: rumqttc::EventLoop,
    }

    #[derive(Clone, Default)]
    struct LogCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct CapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
        type Writer = CapturedLogWriter;

        fn make_writer(&'a self) -> Self::Writer {
            CapturedLogWriter(self.0.clone())
        }
    }

    impl io::Write for CapturedLogWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl LogCapture {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    pub(crate) fn test_config() -> DaemonConfig {
        DaemonConfig {
            actor: crate::config::ActorConfig {
                id: "actor-config-test".to_string(),
                name: "test-host".to_string(),
            },
            mqtt: crate::config::MqttConfig {
                broker_url: "mqtt://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: crate::config::AgentsConfig::default(),
            transport: None,
            team_id: Some("team-test".to_string()),
            channels: crate::config::ChannelsConfig::default(),
            idle_runtime_timeout_secs: None,
            max_attachments: None,
            http: None,
            team_share: crate::config::TeamShareConfig::default(),
            log: None,
            locale: None,
        }
    }

    pub(crate) fn test_cloud_api() -> Arc<dyn Backend> {
        test_cloud_api_with_url("http://localhost".to_string())
    }

    pub(crate) fn test_cloud_api_with_url(url: String) -> Arc<dyn Backend> {
        Arc::new(crate::backend::cloud_api::CloudApiBackend::new(
            crate::provider_config::CloudApiConfig {
                url,
                refresh_token: "refresh".to_string(),
                team_id: "team-test".to_string(),
                actor_id: "agent-actor".to_string(),
            },
        ))
    }

    /// Write `config` to a temp `daemon.toml` and hand back both. The bootstrap
    /// tests below assert on the *file*, not just the in-memory struct — the
    /// whole point of the last-known behaviour is surviving a restart.
    fn config_on_disk(broker_url: &str) -> (TempDir, DaemonConfig, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let mut config = test_config();
        config.mqtt.broker_url = broker_url.to_string();
        config.save(&path).unwrap();
        (dir, config, path)
    }

    fn mock_backend_with_bootstrap(url: Option<&str>) -> Arc<dyn Backend> {
        let mock = crate::backend::mock::MockBackend::new();
        mock.state().bootstrap_mqtt = url.map(|url| crate::backend::BootstrapMqttOverride {
            url: url.to_string(),
            username: None,
            password: None,
        });
        Arc::new(mock)
    }

    #[tokio::test]
    async fn bootstrap_broker_is_persisted_to_daemon_toml() {
        let (_dir, mut config, path) = config_on_disk("mqtt://stale.example:1883");
        let backend = mock_backend_with_bootstrap(Some("mqtt://fresh.example:1883"));

        apply_bootstrap_overrides(&backend, &mut config, &path)
            .await
            .unwrap();

        assert_eq!(config.mqtt.broker_url, "mqtt://fresh.example:1883");
        let reloaded = DaemonConfig::load(&path).unwrap();
        assert_eq!(
            reloaded.mqtt.broker_url, "mqtt://fresh.example:1883",
            "a restart must come back up on the address bootstrap just handed us"
        );
    }

    #[tokio::test]
    async fn bootstrap_without_mqtt_keeps_last_known_broker() {
        // The 2026-07-28 shape: cloud answers 200 with no `mqtt` block.
        let (_dir, mut config, path) = config_on_disk("mqtt://last-known.example:1883");
        let backend = mock_backend_with_bootstrap(None);

        apply_bootstrap_overrides(&backend, &mut config, &path)
            .await
            .unwrap();

        assert_eq!(
            config.mqtt.broker_url, "mqtt://last-known.example:1883",
            "an empty cloud config must not wipe a working broker"
        );
        let reloaded = DaemonConfig::load(&path).unwrap();
        assert_eq!(reloaded.mqtt.broker_url, "mqtt://last-known.example:1883");
    }

    #[tokio::test]
    async fn bootstrap_without_mqtt_and_no_last_known_leaves_broker_empty() {
        let (_dir, mut config, path) = config_on_disk("");
        let backend = mock_backend_with_bootstrap(None);

        apply_bootstrap_overrides(&backend, &mut config, &path)
            .await
            .unwrap();

        // Degraded but alive: HTTP/local control plane still starts, and the run
        // loop keeps re-fetching until the cloud config is fixed.
        assert!(config.mqtt.broker_url.is_empty());
    }

    #[tokio::test]
    async fn bootstrap_with_unchanged_broker_leaves_the_file_alone() {
        let (_dir, mut config, path) = config_on_disk("mqtt://same.example:1883");
        let before = std::fs::read_to_string(&path).unwrap();
        let backend = mock_backend_with_bootstrap(Some("mqtt://same.example:1883"));

        apply_bootstrap_overrides(&backend, &mut config, &path)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "steady-state re-fetches must not rewrite daemon.toml"
        );
    }

    #[test]
    pub(crate) fn backend_from_provider_config_initializes_cloud_api_backend() {
        let config = crate::provider_config::ProviderConfig::CloudApi(
            crate::provider_config::CloudApiConfig {
                url: "http://localhost".to_string(),
                refresh_token: "refresh".to_string(),
                team_id: "team-test".to_string(),
                actor_id: "agent-actor".to_string(),
            },
        );

        let backend = backend_from_provider_config(config).unwrap();

        assert_eq!(backend.team_id(), "team-test");
        assert_eq!(backend.actor_id(), "agent-actor");
    }

    /// The backend is the identity's only owner: hydration copies its actor_id
    /// into the in-memory config unconditionally. The one rejected shape is a
    /// pointer naming one team while the backend.toml inside that directory
    /// says another — a file in the wrong directory, not a drifted copy.
    #[test]
    fn hydration_adopts_backend_actor_and_rejects_a_misplaced_backend_toml() {
        let backend = test_cloud_api();

        let mut config = test_config();
        config.team_id = Some("team-test".to_string());
        hydrate_identity_from_backend(&mut config, backend.as_ref()).unwrap();
        assert_eq!(config.actor.id, "agent-actor");

        let mut config = test_config();
        config.team_id = Some("team-config-test".to_string());
        let error = hydrate_identity_from_backend(&mut config, backend.as_ref()).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("team-config-test"), "{message}");
        assert!(message.contains("team_id=team-test"), "{message}");
    }

    #[test]
    pub(crate) fn mark_mqtt_connected_updates_shared_flag() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));

        mark_mqtt_connected(&Some(flag.clone()), false);

        assert!(!flag.load(std::sync::atomic::Ordering::Relaxed));
        mark_mqtt_connected(&Some(flag.clone()), true);
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
    }

    pub(crate) fn test_mqtt(actor_id: &str) -> MqttClient {
        let mut opts = MqttOptions::new("daemon-server-test", "localhost", 1883);
        opts.set_clean_session(true);
        let (client, eventloop) = AsyncClient::new(opts, 10);
        MqttClient {
            client,
            eventloop,
            topics: crate::mqtt::Topics::new("team-test", actor_id),
        }
    }

    pub(crate) fn test_server() -> TestServer {
        test_server_with_cloud_api(test_cloud_api())
    }

    pub(crate) fn test_server_with_cloud_api(backend: Arc<dyn Backend>) -> TestServer {
        let tmp = TempDir::new().unwrap();
        let config = test_config();
        let mqtt = test_mqtt(&config.actor.id);
        let teamclu = crate::teamclu::SessionManager::new(
            Arc::new(mqtt.client.clone()) as Arc<dyn MessagePublisher>,
            "team-test",
            &config.actor.id,
            Some("agent-actor".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();

        let mut agents = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        agents.add_test_runtime("session-1");

        let publisher_handle: Arc<dyn MessagePublisher> = Arc::new(mqtt.client.clone());
        let topics = mqtt.topics.clone();
        let workspace_resolver = Arc::new(crate::config::WorkspaceResolver::new(backend.clone()));
        let deferred_backend = Arc::new(crate::backend::deferred::DeferredBackend::claimed(
            backend.clone(),
        ));
        let (cron_turn_done_tx, cron_turn_done_rx) = mpsc::channel(64);
        let (cron_turn_event_tx, cron_turn_event_rx) = mpsc::channel(1024);
        TestServer {
            server: DaemonServer {
                config,
                config_path: tmp.path().join("daemon.toml"),
                mqtt_command_rx: None,
                nats: None,
                publisher_handle: publisher_handle.clone(),
                topics,
                agents: Arc::new(AsyncMutex::new(agents)),
                auth: AuthManager::new(tmp.path().join("members.toml")).unwrap(),
                peers: PeerTracker::new(),
                permissions: PermissionManager::new(),
                workspace_resolver,
                sync_dispatcher: crate::sync::dispatch::SyncDispatcher::new(
                    crate::sync::secret_store::SecretStore::new(),
                    None,
                ),
                sessions: SessionStore::default(),
                sessions_path: tmp.path().join("sessions.toml"),
                history: EventHistory::new(&tmp.path().join("history")),
                teamclu: Some(teamclu),
                backend: backend.clone(),
                deferred_backend,
                actor_id: "agent-actor".to_string(),
                channel_mgr: None,
                cron_sessions: cron::CronSessionCache::new(),
                refresh_watch_registry: None,
                refresh_coordinator: None,
                mqtt_connected_flag: None,
                mqtt_recovery_rx: None,
                mqtt_recovery_handle: crate::mqtt::MqttRecoveryHandle::channel().0,
                mqtt_snapshot: Arc::new(parking_lot::RwLock::new(
                    crate::mqtt::MqttSnapshot::default(),
                )),
                managed_llm: Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(
                    backend.clone(),
                )),
                live_tee: tokio::sync::broadcast::channel(64).0,
                session_remote_targets: Arc::new(AsyncMutex::new(
                    crate::remote_tools::SessionRemoteTargetStore::default(),
                )),
                remote_tool_turn_contexts: Arc::new(AsyncMutex::new(
                    crate::remote_tools::RemoteToolTurnContextStore::default(),
                )),
                rpc_client: Arc::new(AsyncMutex::new(crate::teamclu::rpc::RpcClient::new(
                    publisher_handle.clone(),
                    "team-1".to_string(),
                    "agent-actor".to_string(),
                ))),
                team_skill_reconciler: Arc::new(
                    crate::runtime::team_skills::TeamSkillReconciler::new(backend),
                ),
                agent_management_results: Arc::new(AsyncMutex::new(HashMap::new())),
                cron_turn_done_tx,
                cron_turn_done_rx: Some(cron_turn_done_rx),
                cron_turn_event_tx,
                cron_turn_event_rx: Some(cron_turn_event_rx),
            },
            _tmp: tmp,
            _mqtt_eventloop: mqtt.eventloop,
        }
    }

    pub(crate) fn live_message(
        session_id: &str,
        message_id: &str,
        content: &str,
    ) -> subscriber::IncomingMessage {
        let msg = crate::proto::teamclu::Message {
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "human-actor".to_string(),
            kind: 0,
            content: content.to_string(),
            created_at: 1,
            ..Default::default()
        };
        let msg_env = crate::proto::teamclu::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec!["agent-actor".to_string()],
            ..Default::default()
        };
        let live = crate::proto::teamclu::LiveEventEnvelope {
            event_id: format!("event-{message_id}-{content}"),
            event_type: "message.created".to_string(),
            session_id: session_id.to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: msg_env.encode_to_vec(),
        };
        subscriber::IncomingMessage::TeamcluSessionLive {
            session_id: session_id.to_string(),
            payload: live.encode_to_vec(),
        }
    }

    pub(crate) fn seed_teamclu_session(server: &mut DaemonServer, session_id: &str, title: &str) {
        let session = crate::teamclu::StoredSession {
            session_id: session_id.to_string(),
            team_id: "team-test".to_string(),
            title: title.to_string(),
            created_by: "human-actor".to_string(),
            created_at: chrono::Utc::now(),
            summary: String::new(),
            idea_id: String::new(),
            participants: vec![],
            primary_agent_id: String::new(),
        };
        server.teamclu.as_mut().unwrap().sessions.upsert(session);
    }

    #[tokio::test]
    pub(crate) async fn incoming_live_event_log_includes_cached_session_and_daemon_info() {
        let mut fixture = test_server();
        seed_teamclu_session(&mut fixture.server, "session-title-test", "Launch Plan");

        let live = crate::proto::teamclu::LiveEventEnvelope {
            event_id: "event-session-title".to_string(),
            event_type: "unknown.test".to_string(),
            session_id: "session-title-test".to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: vec![],
        };
        let capture = LogCapture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_writer(capture.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        fixture
            .server
            .handle_incoming(subscriber::IncomingMessage::TeamcluSessionLive {
                session_id: "session-title-test".to_string(),
                payload: live.encode_to_vec(),
            })
            .await;

        let logs = capture.text();
        assert!(logs.contains("LiveEventEnvelope decoded"), "{logs}");
        assert!(logs.contains("session_title=Launch Plan"), "{logs}");
        assert!(
            logs.contains("daemon_config_actor_id=actor-config-test"),
            "{logs}"
        );
        assert!(logs.contains("daemon_actor_id=agent-actor"), "{logs}");
        assert!(logs.contains("daemon_team_id=team-test"), "{logs}");
    }

    #[tokio::test]
    pub(crate) async fn auto_restart_offline_sessions_is_noop_without_membership() {
        // The default test fixture has no teamclu memberships (no
        // sessions.toml entries the actor is a participant in), so the
        // method must return early before touching the Cloud API. A real
        // request would fail because `test_cloud_api()` points at
        // http://localhost with no server running, so a successful return
        // here implies the early-exit guard fired.
        let mut fixture = test_server();
        fixture.server.auto_restart_offline_sessions().await;
        // No runtimes added beyond the fixture's seeded "session-1".
        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.get_handle("session-1").is_some(),
            "fixture runtime should be untouched"
        );
    }

    #[tokio::test]
    pub(crate) async fn runtime_start_with_session_id_fails_when_cloud_api_lookup_fails() {
        let mut fixture =
            test_server_with_cloud_api(test_cloud_api_with_url("http://127.0.0.1:1".into()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "",
                ".",
                "session-missing",
                "",
                None,
                "",
                false,
            )
            .await;
        let err = match result {
            Ok(_) => panic!("session-bound RuntimeStart must fail before spawning"),
            Err(err) => err,
        };

        assert_eq!(err.error_code, "SESSION_LOOKUP_FAILED");
        assert_eq!(err.failed_stage, "session_lookup");
    }

    #[tokio::test]
    pub(crate) async fn apply_start_runtime_resolves_cloud_workspace_uuid_via_resolver() {
        // A cloud workspace UUID must resolve through `WorkspaceResolver`
        // (backed by `GET /v1/workspaces/by-ids`). Proof: resolution
        // succeeds (no WORKSPACE_NOT_FOUND) and control reaches the session
        // lookup stage, which then fails against the unmocked
        // `/v1/sessions/...` route — demonstrating the resolver supplied
        // the path.
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    { "id": "ws-cloud-uuid", "name": "Cloud WS", "path": "/tmp/cloud-ws", "slug": null }
                ]
            })))
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "ws-cloud-uuid",
                "",
                "session-missing",
                "",
                None,
                "",
                false,
            )
            .await;

        let err = match result {
            Ok(_) => panic!("session-bound RuntimeStart must fail before spawning"),
            Err(err) => err,
        };
        assert_eq!(
            err.error_code, "SESSION_LOOKUP_FAILED",
            "workspace resolve must have succeeded to reach session lookup: {} / {}",
            err.error_code, err.error_message
        );
    }

    #[tokio::test]
    pub(crate) async fn apply_start_runtime_returns_workspace_not_found_when_resolve_fails_and_no_worktree(
    ) {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "items": [] })),
            )
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "ws-missing-in-cloud",
                "",
                "",
                "",
                None,
                "",
                false,
            )
            .await;

        let err = match result {
            Ok(_) => panic!("unresolvable workspace with no worktree fallback must fail"),
            Err(err) => err,
        };
        assert_eq!(err.error_code, "WORKSPACE_NOT_FOUND");
        assert_eq!(err.failed_stage, "validation");
    }

    #[tokio::test]
    pub(crate) async fn apply_start_runtime_stamps_workspace_id_on_resolve_fail_worktree_fallback()
    {
        // When resolve() fails (cloud unreachable / workspace not yet visible)
        // but the caller supplied a worktree path, `apply_start_runtime`
        // still keeps the client-given `workspace_id` for association metadata.
        // Execution-context assembly then fails closed: it must not spawn with
        // bare env just because a worktree path was supplied.
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        Mock::given(method("POST"))
            .and(path("/v1/workspaces/by-ids"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "items": [] })),
            )
            .mount(&srv)
            .await;

        // Session lookup must succeed so the failure is at env assembly, not
        // session validation. That lookup is two reads: the session row and its
        // roster, which lives on its own collection.
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-offline"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "session-offline",
                "teamId": "team-1",
                "title": "offline",
            })))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/sessions/session-offline/participants"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
            })))
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        let worktree_dir = TempDir::new().unwrap();
        let worktree_path = worktree_dir.path().to_string_lossy().to_string();

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "ws-cloud-uuid-offline",
                &worktree_path,
                "session-offline",
                "",
                None,
                "",
                false,
            )
            .await;

        let err = match result {
            Ok(_) => panic!(
                "unresolved workspace with worktree fallback must fail closed at env assembly"
            ),
            Err(err) => err,
        };
        assert_eq!(err.error_code, "ENV_ASSEMBLE_FAILED");
        assert_eq!(err.failed_stage, "env_setup");
        assert!(
            err.error_message
                .contains("workspace identity resolution failed"),
            "unexpected error message: {}",
            err.error_message
        );

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.runtime_ids_for_session("session-offline").is_empty(),
            "env assembly failure must not spawn a runtime with bare env"
        );
    }

    #[tokio::test]
    pub(crate) async fn runtime_lifecycle_apply_start_runtime_propagates_workspace_attach_context()
    {
        let workspace = TempDir::new().unwrap();
        let backend = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        backend.state().workspaces_by_id.insert(
            "ws-a".into(),
            crate::backend::WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-test".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        backend.state().sessions.insert(
            "desktop-session".into(),
            crate::backend::BackendSessionAndParticipants {
                session: crate::backend::BackendSessionRow {
                    id: "desktop-session".into(),
                    team_id: "team-test".into(),
                    created_by_actor_id: Some("human-actor".into()),
                    primary_agent_id: Some("agent-actor".into()),
                    mode: "chat".into(),
                    title: "Desktop".into(),
                    summary: String::new(),
                    idea_id: None,
                    created_at: chrono::Utc::now(),
                },
                participants: Vec::new(),
            },
        );
        let mut fixture = test_server_with_cloud_api(backend);
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };

        fixture
            .server
            .apply_start_runtime(
                amux::AgentType::Opencode,
                "ws-a",
                workspace.path().to_string_lossy().as_ref(),
                "desktop-session",
                "",
                None,
                "",
                false,
            )
            .await
            .unwrap_or_else(|error| panic!("desktop spawn failed: {}", error.error_message));

        let captures = captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].domain,
            crate::runtime::execution_context::IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(captures[0].working_directory, workspace.path());
        assert_eq!(
            captures[0].process_env_revision,
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(
                &captures[0].extra_env
            )
        );
    }

    #[tokio::test]
    async fn all_actual_entry_points_propagate_identical_workspace_env_and_revision() {
        let workspace = TempDir::new().unwrap();
        let backend = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "actor-config-test",
        ));
        backend.state().workspaces_by_id.insert(
            "ws-a".into(),
            crate::backend::WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-test".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        backend.state().sessions.insert(
            "desktop-cross-entry".into(),
            crate::backend::BackendSessionAndParticipants {
                session: crate::backend::BackendSessionRow {
                    id: "desktop-cross-entry".into(),
                    team_id: "team-test".into(),
                    created_by_actor_id: Some("human-actor".into()),
                    primary_agent_id: Some("actor-config-test".into()),
                    mode: "chat".into(),
                    title: "Cross entry".into(),
                    summary: String::new(),
                    idea_id: None,
                    created_at: chrono::Utc::now(),
                },
                participants: Vec::new(),
            },
        );

        let mut fixture = test_server_with_cloud_api(backend.clone());
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };

        fixture
            .server
            .apply_start_runtime(
                amux::AgentType::Opencode,
                "ws-a",
                workspace.path().to_string_lossy().as_ref(),
                "desktop-cross-entry",
                "",
                None,
                "",
                false,
            )
            .await
            .unwrap_or_else(|error| panic!("desktop spawn failed: {}", error.error_message));

        let cron_context = fixture
            .server
            .assemble_execution_context(
                workspace.path().to_string_lossy().as_ref(),
                None,
                Some("ws-a"),
                true,
                Some(crate::runtime::PermissionPolicy::Full),
            )
            .await
            .unwrap();
        fixture
            .server
            .create_cron_gateway_session_for_propagation_test(cron_context)
            .await
            .unwrap();

        fixture.server.sessions.upsert(SessionBinding::new(
            "resume-session-cross-entry",
            "ws-a",
            amux::AgentType::Opencode as i32,
            "acp-resume-cross-entry",
        ));
        assert!(
            fixture
                .server
                .resume_historical_runtimes_for_session("resume-session-cross-entry", None)
                .await
        );

        let http = crate::http::runtime_adapter::RuntimeManagerAdapter::new_with_execution_context_assembler(
            fixture.server.agents.clone(),
            16,
            None,
            Some(Arc::new(fixture.server.execution_context_assembler())),
        );
        http.spawn_runtime_with_resolved_context(
            uuid::Uuid::new_v4(),
            amux::AgentType::Opencode,
            Some("ws-a".into()),
            None,
            None,
        )
        .await
        .unwrap();

        let (gateway, unscoped_gateway) =
            crate::channels::agent_handle::tests::capture_workspace_and_unscoped_gateway_attaches(
                backend,
                workspace.path(),
            )
            .await;

        let captures = captures.lock().unwrap().clone();
        assert_eq!(captures.len(), 4);
        let desktop = &captures[0];
        for (entry_point, capture) in [
            ("cron", &captures[1]),
            ("resume", &captures[2]),
            ("http", &captures[3]),
            ("workspace gateway", &gateway),
        ] {
            assert_eq!(
                capture.extra_env, desktop.extra_env,
                "{entry_point} env drifted from desktop"
            );
            assert_eq!(
                capture.process_env_revision, desktop.process_env_revision,
                "{entry_point} revision drifted from desktop"
            );
            assert_eq!(
                capture.domain,
                crate::runtime::execution_context::IsolationDomainKey::Workspace("ws-a".into()),
                "{entry_point} must remain workspace scoped"
            );
            assert_eq!(capture.working_directory, workspace.path());
        }
        assert_eq!(
            unscoped_gateway.domain,
            crate::runtime::execution_context::IsolationDomainKey::UnscopedAgent {
                team_id: "team-test".into(),
                actor_id: "actor-config-test".into(),
            }
        );
        assert!(unscoped_gateway.extra_env.is_empty());
    }

    // ── plan_auto_restart_offline_sessions branch coverage ─────────────────
    //
    // The pure-decision half of `auto_restart_offline_sessions` is exposed
    // as `plan_auto_restart_offline_sessions` so we can verify every
    // skip/keep branch without actually booting an ACP backend. The tests
    // below cover:
    //
    //   - membership session has no prior agent_runtimes row → skip
    //   - prior row exists, but no messages newer than cursor → skip
    //   - prior row exists, unread messages are all self-authored → skip
    //   - prior row exists, unread from someone else, no live runtime →
    //     keep with backend/workspace_id resolved from the prior row
    //   - prior row exists, but a live runtime is already serving → skip
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Cloud API `/v1/auth/refresh` mock — every test calls
    /// `access_token()` before any business request.
    pub(crate) async fn auth_token_mock(srv: &MockServer) {
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

    /// `fetch_latest_runtime_for_session` hits
    /// `GET /v1/agents/runtimes/latest?agentId=...&sessionId=...` and expects
    /// a single object (404 → None). Map the legacy PostgREST signature
    /// onto the cloud_api shape.
    pub(crate) async fn mock_agent_runtime_row(
        srv: &MockServer,
        session_id: &str,
        last_processed_message_id: Option<&str>,
        _workspace_id: Option<&str>,
        _backend_type: &str,
    ) {
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .and(query_param("sessionId", session_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": format!("row-{session_id}"),
                "backendSessionId": format!("acp-{session_id}"),
                "lastProcessedMessageId": last_processed_message_id,
            })))
            .mount(srv)
            .await;
    }

    /// `messages_after_cursor` hits `GET /v1/sessions/{id}/messages`. The
    /// legacy PostgREST mocks returned a top-level array of rows in
    /// snake_case; convert each row to the cloud_api camelCase envelope.
    pub(crate) async fn mock_messages_response(
        srv: &MockServer,
        session_id: &str,
        rows: serde_json::Value,
    ) {
        let items: Vec<serde_json::Value> = rows
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(to_cloud_message)
            .collect();
        Mock::given(method("GET"))
            .and(path(format!("/v1/sessions/{session_id}/messages")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": items,
                "nextCursor": null,
            })))
            .mount(srv)
            .await;
    }

    pub(crate) fn to_cloud_message(row: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": row.get("id").cloned().unwrap_or_default(),
            "sessionId": row.get("session_id").cloned().unwrap_or_default(),
            "senderActorId": row.get("sender_actor_id").cloned().unwrap_or_default(),
            "kind": row.get("kind").cloned().unwrap_or(serde_json::json!("text")),
            "content": row.get("content").cloned().unwrap_or_default(),
            "metadata": row.get("metadata").cloned().unwrap_or(serde_json::json!({})),
            "createdAt": row.get("created_at").cloned().unwrap_or_default(),
        })
    }

    pub(crate) async fn add_membership(fixture: &mut TestServer, session_id: &str) {
        let tc = fixture.server.teamclu.as_mut().expect("teamclu set");
        tc.insert_session_from_backend_for_test(
            session_id,
            "team-test",
            None,
            &[("agent-actor", "owner")],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_session_with_no_prior_runtime_row() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // No prior row — Cloud API returns 404 for the "latest" lookup.
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "no runtime row" }
            })))
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-no-row").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(plan.is_empty(), "no prior row should produce empty plan");
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_when_no_unread_messages_after_cursor() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-empty", Some("msg-9"), None, "claude").await;
        // Cloud API honours `messages_after_cursor` by returning an empty
        // list (the drain-through-cursor logic happens client-side, but
        // here we simulate "no messages newer than the cursor").
        mock_messages_response(&srv, "sess-empty", serde_json::json!([])).await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-empty").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "no unread messages should produce empty plan"
        );
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_when_unread_messages_are_all_self_authored() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-self", None, None, "claude").await;
        // Two messages, both sent by the daemon's own actor (e.g. prior
        // agent replies we already emitted). Auto-restart must NOT fire
        // for these — there is no user input to process.
        mock_messages_response(
            &srv,
            "sess-self",
            serde_json::json!([
                {
                    "id": "msg-1",
                    "session_id": "sess-self",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "ok",
                    "metadata": {},
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-self").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "self-authored unread should not trigger restart"
        );
    }

    #[tokio::test]
    pub(crate) async fn plan_keeps_session_with_unread_from_someone_else() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(
            &srv,
            "sess-mention",
            Some("msg-9"),
            Some("ws-cloud-uuid"),
            "claude_code",
        )
        .await;
        // Cloud API's `messages_after_cursor` trims past `after_id`
        // client-side, so include msg-9 (the cursor) at the head of the
        // response. After trimming: msg-10 (self-authored, filtered) +
        // msg-11 (human, kept).
        mock_messages_response(
            &srv,
            "sess-mention",
            serde_json::json!([
                {
                    "id": "msg-9",
                    "session_id": "sess-mention",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "cursor row",
                    "metadata": {},
                    "created_at": "2025-05-22T00:29:00Z"
                },
                {
                    "id": "msg-10",
                    "session_id": "sess-mention",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "prior reply",
                    "metadata": {},
                    "created_at": "2025-05-22T00:30:00Z"
                },
                {
                    "id": "msg-11",
                    "session_id": "sess-mention",
                    "sender_actor_id": "human-actor",
                    "kind": "text",
                    "content": "are you there?",
                    "metadata": { "mention_actor_ids": ["agent-actor"] },
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-mention").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert_eq!(plan.len(), 1, "one session should need restart");
        assert_eq!(plan[0].session_id, "sess-mention");
        assert_eq!(plan[0].unread_count, 1, "self-authored msg-10 was filtered");
        // No local workspace is registered for "ws-cloud-uuid", so the
        // helper falls back to empty (apply_start_runtime will then
        // resolve via the registered workspace lookup or current dir).
        assert!(plan[0].local_workspace_id.is_empty());
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_session_with_live_runtime_already_running() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // The fixture seeds a runtime "session-1" bound to session_id
        // "session-1" via add_test_runtime. Make that the membership
        // session and confirm the planner refuses to schedule a second
        // spawn for the same session.
        mock_agent_runtime_row(&srv, "session-1", None, None, "claude").await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                {
                    "id": "msg-50",
                    "session_id": "session-1",
                    "sender_actor_id": "human-actor",
                    "kind": "text",
                    "content": "hi",
                    "metadata": {},
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "session-1").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "existing live runtime should suppress auto-restart for the same session"
        );
    }

    // ── catchup_runtime stale-mention compaction ──────────────────────────
    //
    // When the daemon comes back online and replays the cursor → now slice
    // through catchup_runtime, only the most recent `@daemon` mention should
    // trigger a real ACP prompt. Earlier @-mentions are demoted to silent
    // context (pending_silent prefix on the eventual prompt) because the
    // conversation already moved past them — firing a fresh turn on those
    // stale mentions would emit out-of-date replies.

    pub(crate) fn make_message_row(
        id: &str,
        session_id: &str,
        sender_actor_id: &str,
        mentions: &[&str],
        content: &str,
        created_at: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": "text",
            "content": content,
            "metadata": { "mention_actor_ids": mentions },
            "created_at": created_at,
        })
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_prompts_only_on_last_mention_compacting_stale_ones() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // 3-message replay: @daemon, @daemon, plain. The latest @daemon is
        // msg-b; msg-a is stale (a later @daemon came in). msg-c is a
        // non-mention follow-up and should also land as silent context.
        // Expected outcome:
        //   - send_prompt fires exactly once, carrying "ask B" (the last
        //     @-mention's content)
        //   - the silent queue holds msg-a only (msg-b is consumed by the
        //     real prompt; msg-c never @-mentions us, hence silent)
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-a",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "ask A",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-b",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "ask B",
                    "2025-05-22T01:00:02Z",
                ),
                make_message_row(
                    "msg-c",
                    "session-1",
                    "human-2",
                    &[],
                    "drive-by chatter",
                    "2025-05-22T01:00:03Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("session-1").await;

        // `send_prompt` (not raw) auto-drains the silent queue via
        // `flush_pending_silent`, so by the time msg-b's prompt fires the
        // stale msg-a is woven into a `[Context — …]` prefix. msg-c is
        // routed AFTER msg-b, so it stays in the silent queue waiting for
        // the next real prompt.
        let agents = fixture.server.agents.lock().await;
        let last = agents
            .last_sent_to("session-1")
            .expect("the last @-mention should trigger send_prompt");
        assert!(
            last.contains("ask B"),
            "send_prompt body should carry the latest @-mention content; got: {last}"
        );
        assert!(
            last.contains("ask A"),
            "the stale @-mention should be folded into the [Context …] prefix; got: {last}"
        );
        assert!(
            !last.contains("drive-by chatter"),
            "msg-c (routed after msg-b) must stay queued for the next turn; got: {last}"
        );

        // After the prompt fires, msg-c sits alone in the silent queue —
        // msg-a was already drained into the prefix above.
        let pending = &agents.get_handle("session-1").unwrap().pending_silent;
        assert_eq!(
            pending
                .iter()
                .map(|p| p.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["msg-c"],
            "only msg-c (post-prompt drive-by) should remain silent"
        );
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_does_not_replay_after_cursor_advanced_in_memory() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([make_message_row(
                "msg-a",
                "session-1",
                "human-1",
                &["agent-actor"],
                "ask once",
                "2025-05-22T01:00:01Z",
            ),]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        assert!(fixture.server.catchup_runtime("session-1").await);
        {
            let agents = fixture.server.agents.lock().await;
            assert_eq!(
                agents.last_sent_to("session-1").as_deref(),
                Some("ask once"),
            );
            assert_eq!(
                agents
                    .get_handle("session-1")
                    .unwrap()
                    .last_processed_message_id
                    .as_deref(),
                Some("msg-a"),
            );
        }

        // Session refresh → runtimeStart dedup → catchup must not re-prompt.
        assert!(!fixture.server.catchup_runtime("session-1").await);
        let agents = fixture.server.agents.lock().await;
        assert_eq!(
            agents.last_sent_to("session-1").as_deref(),
            Some("ask once")
        );
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_skips_prompt_when_last_mention_already_answered() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-user",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "please review",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-agent",
                    "session-1",
                    "agent-actor",
                    &[],
                    "done reviewing",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("session-1").await;

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.last_sent_to("session-1").is_none(),
            "answered @mention must not trigger send_prompt on catchup"
        );
        assert_eq!(
            agents
                .get_handle("session-1")
                .unwrap()
                .last_processed_message_id
                .as_deref(),
            Some("msg-user"),
        );
    }

    #[tokio::test]
    pub(crate) async fn plan_skips_when_last_mention_already_answered() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-answered", None, None, "claude").await;
        mock_messages_response(
            &srv,
            "sess-answered",
            serde_json::json!([
                make_message_row(
                    "msg-user",
                    "sess-answered",
                    "human-1",
                    &["agent-actor"],
                    "ping",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-agent",
                    "sess-answered",
                    "agent-actor",
                    &[],
                    "pong",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-answered").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "already-answered @mention should not schedule auto_restart"
        );
    }

    #[tokio::test]
    pub(crate) async fn catchup_runtime_with_no_mentions_routes_everything_silent() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-a",
                    "session-1",
                    "human-1",
                    &[],
                    "first chatter",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-b",
                    "session-1",
                    "human-2",
                    &[],
                    "second chatter",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("session-1").await;

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.last_sent_to("session-1").is_none(),
            "no @-mention → no send_prompt"
        );
        assert_eq!(
            agents.get_handle("session-1").unwrap().pending_silent.len(),
            2,
            "both messages should land in silent context"
        );
    }

    pub(crate) fn make_session_binding(
        cloud_session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        acp_session_id: &str,
    ) -> SessionBinding {
        SessionBinding::new(
            cloud_session_id,
            workspace_id,
            agent_type as i32,
            acp_session_id,
        )
    }

    #[tokio::test]
    pub(crate) async fn duplicate_live_message_id_is_not_sent_to_runtime_twice() {
        let mut fixture = test_server();

        fixture
            .server
            .handle_incoming(live_message("session-1", "msg-1", "first"))
            .await;
        fixture
            .server
            .handle_incoming(live_message("session-1", "msg-1", "second"))
            .await;

        let agents = fixture.server.agents.lock().await;
        assert_eq!(agents.last_sent_to("session-1").as_deref(), Some("first"));
    }

    #[tokio::test]
    pub(crate) async fn live_message_model_override_is_applied_before_prompt_routing() {
        let mut fixture = test_server();

        let msg = crate::proto::teamclu::Message {
            message_id: "msg-model-1".to_string(),
            session_id: "session-1".to_string(),
            sender_actor_id: "human-actor".to_string(),
            kind: 0,
            content: "which model?".to_string(),
            created_at: 1,
            model: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };
        let msg_env = crate::proto::teamclu::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec!["agent-actor".to_string()],
            ..Default::default()
        };
        let live = crate::proto::teamclu::LiveEventEnvelope {
            event_id: "event-model-1".to_string(),
            event_type: "message.created".to_string(),
            session_id: "session-1".to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: msg_env.encode_to_vec(),
        };

        fixture
            .server
            .handle_incoming(subscriber::IncomingMessage::TeamcluSessionLive {
                session_id: "session-1".to_string(),
                payload: live.encode_to_vec(),
            })
            .await;

        let agents = fixture.server.agents.lock().await;
        assert_eq!(
            agents.current_model("session-1").map(|s| s.as_str()),
            Some("opencode/deepseek-v4-flash-free")
        );
        assert_eq!(
            agents.last_sent_to("session-1").as_deref(),
            Some("which model?")
        );
    }

    pub(crate) fn seed_startup_workspace_sync(
        mock: &Arc<crate::backend::mock::MockBackend>,
        display_name: &str,
        remote_id: &str,
    ) {
        mock.state().workspace_results.insert(
            (
                "team-test".to_string(),
                "agent-actor".to_string(),
                display_name.to_string(),
            ),
            crate::backend::WorkspaceRow {
                id: remote_id.to_string(),
                team_id: "team-test".to_string(),
                path: None,
                archived: false,
                agent_id: None,
            },
        );
    }

    #[tokio::test]
    pub(crate) async fn apply_add_workspace_calls_cloud_upsert_and_sets_default() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        let add = amux::AddWorkspace {
            path: workspace_dir.to_string_lossy().to_string(),
        };
        let (accepted, error, workspace) = ts.server.apply_add_workspace(&add).await;

        assert!(accepted, "add workspace failed: {error}");
        assert!(workspace.is_some());
        assert_eq!(
            mock.state().default_workspace_ids,
            vec!["remote-ws-1".to_string()]
        );
        // apply_add_workspace must call backend.upsert_workspace directly
        // and use the returned cloud row's id as the workspace_id — there
        // is no more local WorkspaceStore mirror.
        let snap = mock.state();
        assert_eq!(snap.upserted_workspaces.len(), 1);
        assert_eq!(snap.upserted_workspaces[0].team_id, "team-test");
        assert_eq!(snap.upserted_workspaces[0].agent_id, "agent-actor");
        assert_eq!(workspace.unwrap().workspace_id, "remote-ws-1");
    }

    #[tokio::test]
    pub(crate) async fn handle_add_workspace_sock_registers_and_is_idempotent() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        let reply = ts
            .server
            .handle_add_workspace_sock(&workspace_dir.to_string_lossy())
            .await;
        let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(value["ok"], serde_json::json!(true), "reply: {reply}");
        assert_eq!(
            value["result"]["path"].as_str().unwrap(),
            workspace_dir.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(!value["result"]["workspace_id"].as_str().unwrap().is_empty());

        // Re-registering the same path is idempotent: still ok. The mock
        // backend dedups by (team_id, path) the same way the real FC
        // `upsertWorkspace` does.
        let reply2 = ts
            .server
            .handle_add_workspace_sock(&workspace_dir.to_string_lossy())
            .await;
        let value2: serde_json::Value = serde_json::from_str(&reply2).unwrap();
        assert_eq!(value2["ok"], serde_json::json!(true));
    }

    #[tokio::test]
    pub(crate) async fn apply_add_workspace_updates_refresh_watch_registry() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let registry =
            crate::runtime::refresh::refresh_watch::RefreshWatchRegistry::new(Vec::new());
        ts.server.refresh_watch_registry = Some(registry.clone());

        let workspace_dir = ts._tmp.path().join("watch-me");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        seed_startup_workspace_sync(&mock, "watch-me", "remote-watch-me");

        let add = amux::AddWorkspace {
            path: workspace_dir.to_string_lossy().to_string(),
        };
        let (accepted, error, _workspace) = ts.server.apply_add_workspace(&add).await;
        assert!(accepted, "add workspace failed: {error}");

        assert_eq!(
            registry.workspace_paths().await,
            vec![workspace_dir.canonicalize().unwrap()]
        );
    }

    #[test]
    pub(crate) fn coalesce_merges_adjacent_output_runs() {
        let ev = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })),
            model: String::new(),
        };
        let frame = |text: &str| AcpEventFrame::new("sid", ev(text));
        let merged = coalesce_text_events(vec![
            ("a".into(), frame("Hel")),
            ("a".into(), frame("lo")),
            ("a".into(), frame(" world")),
        ]);
        assert_eq!(merged.len(), 1);
        match &merged[0].1.event.event {
            Some(amux::acp_event::Event::Output(o)) => assert_eq!(o.text, "Hello world"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    pub(crate) fn coalesce_respects_agent_and_kind_boundaries() {
        let out = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })),
            model: String::new(),
        };
        let think = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking {
                text: text.to_string(),
            })),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        // different agents never merge
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("x"))),
            ("b".into(), frame(out("y"))),
        ]);
        assert_eq!(merged.len(), 2);
        // thinking→output boundary preserved
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(think("t1"))),
            ("a".into(), frame(think("t2"))),
            ("a".into(), frame(out("o1"))),
        ]);
        assert_eq!(merged.len(), 2);
        match &merged[0].1.event.event {
            Some(amux::acp_event::Event::Thinking(t)) => assert_eq!(t.text, "t1t2"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    pub(crate) fn coalesce_never_merges_past_is_complete() {
        let out = |text: &str, complete: bool| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: complete,
            })),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("final", true))),
            ("a".into(), frame(out("next-turn", false))),
        ]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    pub(crate) fn coalesce_preserves_non_text_events() {
        // tool_use and other non-text events pass through unmerged, order kept
        let out = |text: &str| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })),
            model: String::new(),
        };
        let status = amux::AcpEvent {
            event: Some(amux::acp_event::Event::StatusChange(Default::default())),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("x"))),
            ("a".into(), frame(status.clone())),
            ("a".into(), frame(out("y"))),
        ]);
        // x | status | y  → 3 (the two outputs are NOT adjacent)
        assert_eq!(merged.len(), 3);
    }

    #[test]
    pub(crate) fn coalesce_propagates_is_complete_and_splits_after() {
        let out = |text: &str, complete: bool| amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: complete,
            })),
            model: String::new(),
        };
        let frame = |event: amux::AcpEvent| AcpEventFrame::new("sid", event);
        // a(false) + b(true) merge → "ab" complete; c(false) cannot merge into
        // a completed output → separate event.
        let merged = coalesce_text_events(vec![
            ("a".into(), frame(out("a", false))),
            ("a".into(), frame(out("b", true))),
            ("a".into(), frame(out("c", false))),
        ]);
        assert_eq!(merged.len(), 2);
        match &merged[0].1.event.event {
            Some(amux::acp_event::Event::Output(o)) => {
                assert_eq!(o.text, "ab");
                assert!(o.is_complete);
            }
            other => panic!("unexpected: {other:?}"),
        }
        match &merged[1].1.event.event {
            Some(amux::acp_event::Event::Output(o)) => {
                assert_eq!(o.text, "c");
                assert!(!o.is_complete);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
