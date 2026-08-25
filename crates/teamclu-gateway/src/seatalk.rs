use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{oneshot, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

use crate::seatalk_config::{SeaTalkConfig, SeaTalkGatewayStatus, SeaTalkGatewayStatusResponse};
use crate::{
    AgentHandle, ChannelStore, FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES,
};

const SEATALK_API_BASE: &str = "https://openapi.seatalk.io";
const SEATALK_WS_URL: &str = "wss://ws-openapi.haiserve.com/ws/bot";
const TOKEN_REFRESH_MARGIN_SECS: u64 = 600;
const TEXT_CHUNK_LIMIT: usize = 4000;
const INITIAL_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 30_000;
const DEFAULT_PING_INTERVAL_MS: u64 = 15_000;
const STALE_TIMEOUT_MS: u64 = 75_000;

#[derive(Debug, Clone)]
struct SeaTalkTokenInfo {
    token: String,
    expire_at: u64,
}

struct SeaTalkClient {
    app_id: String,
    app_secret: String,
    http: reqwest::Client,
    token: RwLock<Option<SeaTalkTokenInfo>>,
}

impl SeaTalkClient {
    fn new(app_id: String, app_secret: String) -> Self {
        Self {
            app_id,
            app_secret,
            http: crate::http_client_secs(10),
            token: RwLock::new(None),
        }
    }

    async fn get_access_token(&self) -> Result<String, String> {
        {
            let guard = self.token.read().await;
            if let Some(info) = guard.as_ref() {
                let now = chrono::Utc::now().timestamp() as u64;
                if info.expire_at.saturating_sub(now) > TOKEN_REFRESH_MARGIN_SECS {
                    return Ok(info.token.clone());
                }
            }
        }
        self.refresh_token().await.map(|t| t.token)
    }

    async fn refresh_token(&self) -> Result<SeaTalkTokenInfo, String> {
        let resp = self
            .http
            .post(format!("{SEATALK_API_BASE}/auth/app_access_token"))
            .json(&json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret,
            }))
            .send()
            .await
            .map_err(|e| format!("token request failed: {e}"))?;

        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("token parse failed: {e}"))?;

        let code = data["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            return Err(format!(
                "SeaTalk token error: code={code} message={}",
                data["message"].as_str().unwrap_or("unknown")
            ));
        }

        let token = data["app_access_token"]
            .as_str()
            .ok_or_else(|| "token response missing app_access_token".to_string())?
            .to_string();
        let expire_at = data["expire"]
            .as_u64()
            .ok_or_else(|| "token response missing expire".to_string())?;

        let info = SeaTalkTokenInfo { token, expire_at };
        *self.token.write().await = Some(info.clone());
        Ok(info)
    }

    async fn api_call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        retry: bool,
    ) -> Result<serde_json::Value, String> {
        let token = self.get_access_token().await?;
        let url = format!("{SEATALK_API_BASE}{path}");
        let mut req = self
            .http
            .request(method.clone(), &url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json");
        if let Some(ref b) = body {
            req = req.json(b);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("SeaTalk API request failed: {e}"))?;
        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("SeaTalk API parse failed: {e}"))?;

        let code = data["code"].as_i64().unwrap_or(-1);
        if code == 100 && retry {
            self.refresh_token().await?;
            return Box::pin(self.api_call(method, path, body.clone(), false)).await;
        }
        if code != 0 {
            return Err(format!(
                "SeaTalk API error: code={code} message={}",
                data["message"].as_str().unwrap_or("unknown")
            ));
        }
        Ok(data)
    }

    async fn send_group_text(
        &self,
        group_id: &str,
        text: &str,
        thread_id: Option<&str>,
    ) -> Result<(), String> {
        for chunk in chunk_text(text, TEXT_CHUNK_LIMIT) {
            let mut message = json!({
                "tag": "text",
                "text": { "format": 1, "content": chunk }
            });
            if let Some(tid) = thread_id {
                message["thread_id"] = json!(tid);
            }
            self.api_call(
                reqwest::Method::POST,
                "/messaging/v2/group_chat",
                Some(json!({
                    "group_id": group_id,
                    "message": message,
                })),
                true,
            )
            .await?;
        }
        Ok(())
    }

    async fn send_single_text(
        &self,
        employee_code: &str,
        text: &str,
        thread_id: Option<&str>,
    ) -> Result<(), String> {
        for chunk in chunk_text(text, TEXT_CHUNK_LIMIT) {
            let mut message = json!({
                "tag": "text",
                "text": { "format": 1, "content": chunk }
            });
            if let Some(tid) = thread_id {
                message["thread_id"] = json!(tid);
            }
            self.api_call(
                reqwest::Method::POST,
                "/messaging/v2/single_chat",
                Some(json!({
                    "employee_code": employee_code,
                    "message": message,
                })),
                true,
            )
            .await?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct WsEnvelope {
    cmd: String,
    header: Option<serde_json::Value>,
    data: Option<serde_json::Value>,
    code: Option<i64>,
    message: Option<String>,
}

/// What the callback loop needs. The agent/store/actor fields went away with
/// the inline turn path — the core owns all of that now, and this is left with
/// the connection, the policy config, and the sink to push into.
#[derive(Clone)]
struct HandlerContext {
    config: Arc<RwLock<SeaTalkConfig>>,
    client: Arc<SeaTalkClient>,
    processed_events: Arc<RwLock<ProcessedMessageTracker>>,
    inbound_sink: Option<Arc<dyn crate::driver::InboundSink>>,
}

pub struct SeaTalkGateway {
    config: Arc<RwLock<SeaTalkConfig>>,
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<SeaTalkGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    processed_events: Arc<RwLock<ProcessedMessageTracker>>,
    inbound_sink: Arc<RwLock<Option<Arc<dyn crate::driver::InboundSink>>>>,
}

impl SeaTalkGateway {
    pub fn new(
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(SeaTalkConfig::default())),
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(SeaTalkGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            processed_events: Arc::new(RwLock::new(ProcessedMessageTracker::new(
                MAX_PROCESSED_MESSAGES,
            ))),
            inbound_sink: Arc::new(RwLock::new(None)),
        }
    }

    /// Hand inbound messages to the core instead of the inline handler.
    pub async fn use_core_pipeline(&self, sink: Arc<dyn crate::driver::InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    /// A driver for the core to render replies through.
    pub async fn as_driver(&self) -> SeaTalkDriver {
        let cfg = self.config.read().await.clone();
        SeaTalkDriver::new(cfg.app_id.clone(), cfg.app_secret.clone())
    }

    pub async fn set_config(&self, config: SeaTalkConfig) {
        *self.config.write().await = config;
    }

    pub async fn get_status(&self) -> SeaTalkGatewayStatusResponse {
        self.status.read().await.clone()
    }

    /// Proactive DM send for cron / MCP `send` (HTTP OpenAPI, no WS required).
    pub async fn send_to_user(&self, employee_code: &str, text: &str) -> Result<(), String> {
        let client = self.messaging_client().await?;
        client.send_single_text(employee_code, text, None).await
    }

    /// Proactive group send for cron / MCP `send`.
    pub async fn send_to_chat(&self, group_id: &str, text: &str) -> Result<(), String> {
        let client = self.messaging_client().await?;
        client.send_group_text(group_id, text, None).await
    }

    async fn messaging_client(&self) -> Result<SeaTalkClient, String> {
        let config = self.config.read().await.clone();
        if config.app_id.trim().is_empty() || config.app_secret.trim().is_empty() {
            return Err("SeaTalk app_id and app_secret are required".to_string());
        }
        Ok(SeaTalkClient::new(config.app_id, config.app_secret))
    }

    /// Probe SeaTalk Open Platform credentials by requesting an app access token.
    pub async fn test_credentials(app_id: &str, app_secret: &str) -> Result<String, String> {
        if app_id.trim().is_empty() || app_secret.trim().is_empty() {
            return Err("App ID and App Secret are required".to_string());
        }
        let client = SeaTalkClient::new(app_id.trim().to_string(), app_secret.trim().to_string());
        let _token = client.refresh_token().await?;
        Ok("Credentials valid".to_string())
    }

    pub async fn start(&self) -> Result<(), String> {
        {
            let running = self.is_running.read().await;
            if *running {
                return Err("SeaTalk gateway is already running".to_string());
            }
        }

        let config = self.config.read().await.clone();
        if config.app_id.is_empty() || config.app_secret.is_empty() {
            return Err("SeaTalk app_id and app_secret are required".to_string());
        }

        {
            let mut status = self.status.write().await;
            status.status = SeaTalkGatewayStatus::Connecting;
            status.error_message = None;
            status.app_id = Some(config.app_id.clone());
        }

        *self.is_running.write().await = true;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let gateway = self.clone();
        tokio::spawn(async move {
            if let Err(e) = gateway.run_gateway_loop(shutdown_rx).await {
                eprintln!("[SeaTalk] Gateway error: {e}");
                let mut status = gateway.status.write().await;
                status.status = SeaTalkGatewayStatus::Error;
                status.error_message = Some(e);
            }
            *gateway.is_running.write().await = false;
        });

        Ok(())
    }

    pub async fn shutdown(self) {
        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());
        }
        let mut status = self.status.write().await;
        status.status = SeaTalkGatewayStatus::Disconnected;
    }

    async fn run_gateway_loop(&self, mut shutdown_rx: oneshot::Receiver<()>) -> Result<(), String> {
        let config = self.config.read().await.clone();
        let client = Arc::new(SeaTalkClient::new(
            config.app_id.clone(),
            config.app_secret.clone(),
        ));

        let ctx = HandlerContext {
            inbound_sink: self.inbound_sink.read().await.clone(),
            config: Arc::clone(&self.config),
            client,
            processed_events: Arc::clone(&self.processed_events),
        };

        let mode = config.mode.clone();
        if mode == "webhook" {
            return self.run_webhook_server(ctx, shutdown_rx).await;
        }

        let mut backoff = INITIAL_BACKOFF_MS;
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    println!("[SeaTalk] Gateway shutting down");
                    return Ok(());
                }
                result = self.connect_websocket(&ctx) => {
                    match result {
                        Ok(()) => {
                            backoff = INITIAL_BACKOFF_MS;
                        }
                        Err(e) => {
                            eprintln!("[SeaTalk] WebSocket disconnected: {e}");
                            let mut status = self.status.write().await;
                            status.status = SeaTalkGatewayStatus::Connecting;
                            status.error_message = Some(e);
                        }
                    }
                }
            }

            tokio::select! {
                _ = &mut shutdown_rx => return Ok(()),
                _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
            }
            backoff = (backoff * 2).min(MAX_BACKOFF_MS);
        }
    }

    async fn connect_websocket(&self, ctx: &HandlerContext) -> Result<(), String> {
        let (ws_stream, _) = connect_async(SEATALK_WS_URL)
            .await
            .map_err(|e| format!("WebSocket connect failed: {e}"))?;
        let (mut write, mut read) = ws_stream.split();

        let cfg = ctx.config.read().await.clone();
        let register = json!({
            "cmd": "register",
            "header": {
                "rid": uuid::Uuid::new_v4().to_string(),
                "app_id": cfg.app_id,
                "app_secret": cfg.app_secret,
            }
        });
        write
            .send(WsMessage::Text(register.to_string().into()))
            .await
            .map_err(|e| format!("register send failed: {e}"))?;

        let mut token = String::new();
        let mut registered = false;
        let mut ping_ms = DEFAULT_PING_INTERVAL_MS;
        let mut stale_ms = STALE_TIMEOUT_MS;
        let mut last_activity = Instant::now();

        loop {
            if last_activity.elapsed() > Duration::from_millis(stale_ms) {
                return Err("WebSocket stale timeout".to_string());
            }

            tokio::select! {
                msg = read.next() => {
                    let Some(msg) = msg else {
                        return Err("WebSocket closed".to_string());
                    };
                    last_activity = Instant::now();
                    let msg = msg.map_err(|e| format!("WebSocket read error: {e}"))?;
                    if !msg.is_text() {
                        continue;
                    }
                    let env: WsEnvelope = serde_json::from_str(msg.to_text().unwrap_or(""))
                        .map_err(|e| format!("invalid ws json: {e}"))?;

                    if !registered {
                        if env.cmd != "register" {
                            if env.cmd == "kick" {
                                return Err(format!("connection kicked: {}", env.message.unwrap_or_default()));
                            }
                            // SeaTalk may send non-register frames before the
                            // register ack; ignore them (official SDK treats
                            // unexpected frames more strictly, but "ok" replies
                            // without a code field are common enough that we
                            // keep waiting for the register response).
                            continue;
                        }
                        // Missing `code` means success — match SeaTalk/OpenClaw:
                        // `(env.code ?? 0) !== 0`.
                        let code = env.code.unwrap_or(0);
                        let reg_token = env
                            .header
                            .as_ref()
                            .and_then(|h| h["token"].as_str())
                            .map(str::to_string);
                        if code != 0 || reg_token.is_none() {
                            return Err(format!(
                                "register rejected: code={code} {} (token={})",
                                env.message.unwrap_or_default(),
                                if reg_token.is_some() { "present" } else { "missing" }
                            ));
                        }
                        token = reg_token.unwrap();
                        registered = true;
                        let settings = env.data.clone().unwrap_or_default();
                        if let Some(interval) = settings["heartbeat_interval"].as_u64() {
                            if interval > 0 {
                                ping_ms = interval * 1000;
                            }
                        }
                        stale_ms = stale_ms.max(ping_ms * 2);
                        let mut status = self.status.write().await;
                        status.status = SeaTalkGatewayStatus::Connected;
                        status.error_message = None;
                        println!("[SeaTalk] WebSocket registered (ping={ping_ms}ms)");
                        continue;
                    }

                    match env.cmd.as_str() {
                        "event" => {
                            let callback_id = env.header.as_ref().and_then(|h| h["callback_id"].as_str()).map(str::to_string);
                            if let Some(data) = env.data.clone() {
                                let preview = data.to_string();
                                let preview = if preview.len() > 500 {
                                    format!("{}…", &preview[..500])
                                } else {
                                    preview
                                };
                                println!(
                                    "[SeaTalk] ws event received callback_id={} data={}",
                                    callback_id.as_deref().unwrap_or("-"),
                                    preview
                                );
                                let ctx_clone = ctx.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = handle_callback_event(&ctx_clone, &data).await {
                                        eprintln!("[SeaTalk] event handler failed: {e}");
                                    }
                                });
                            } else {
                                eprintln!("[SeaTalk] ws event missing data (callback_id={:?})", callback_id);
                            }
                            if let Some(cid) = callback_id {
                                let ack = json!({
                                    "cmd": "ack",
                                    "header": {
                                        "rid": uuid::Uuid::new_v4().to_string(),
                                        "token": token,
                                        "callback_id": cid,
                                    }
                                });
                                let _ = write.send(WsMessage::Text(ack.to_string().into())).await;
                            }
                        }
                        "pong" => {}
                        "kick" => {
                            return Err(format!("connection kicked: {}", env.message.unwrap_or_default()));
                        }
                        other => {
                            println!("[SeaTalk] ws cmd={other} code={:?} msg={:?}", env.code, env.message);
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(ping_ms)) => {
                    if registered {
                        let ping = json!({
                            "cmd": "ping",
                            "header": {
                                "rid": uuid::Uuid::new_v4().to_string(),
                                "token": token,
                            }
                        });
                        write
                            .send(WsMessage::Text(ping.to_string().into()))
                            .await
                            .map_err(|e| format!("ping send failed: {e}"))?;
                    }
                }
            }
        }
    }

    async fn run_webhook_server(
        &self,
        _ctx: HandlerContext,
        _shutdown_rx: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        Err("SeaTalk webhook mode is not implemented yet; use websocket mode".to_string())
    }
}

fn check_dm_allowed(cfg: &SeaTalkConfig, employee_code: &str, email: Option<&str>) -> bool {
    match cfg.dm_policy.as_str() {
        "open" => cfg.allow_from.iter().any(|e| e.trim() == "*") || cfg.allow_from.is_empty(),
        _ => is_sender_allowed(employee_code, email, &cfg.allow_from),
    }
}

fn check_group_allowed(
    cfg: &SeaTalkConfig,
    group_id: &str,
    employee_code: &str,
    email: Option<&str>,
) -> FilterResult {
    if cfg.group_policy == "disabled" {
        return FilterResult::Ignore;
    }

    let group_ok = match cfg.group_policy.as_str() {
        "open" => true,
        "allowlist" => {
            if cfg.group_allow_from.is_empty() {
                true
            } else {
                cfg.group_allow_from
                    .iter()
                    .any(|g| g == group_id || g == "*")
            }
        }
        _ => false,
    };

    if !group_ok {
        return FilterResult::ChannelNotConfigured;
    }

    if let Some(group_cfg) = cfg.groups.get(group_id) {
        if !group_cfg.allow {
            return FilterResult::ChannelNotConfigured;
        }
        if !group_cfg.users.is_empty() && !is_sender_allowed(employee_code, email, &group_cfg.users)
        {
            return FilterResult::UserNotAllowed;
        }
    }

    if !cfg.group_sender_allow_from.is_empty()
        && !is_sender_allowed(employee_code, email, &cfg.group_sender_allow_from)
    {
        return FilterResult::UserNotAllowed;
    }

    FilterResult::Allow
}

fn is_sender_allowed(employee_code: &str, email: Option<&str>, allow_from: &[String]) -> bool {
    allow_from.iter().any(|entry| {
        let e = entry.trim();
        e == "*" || e == employee_code || email.is_some_and(|mail| e.eq_ignore_ascii_case(mail))
    })
}

// ==================== Transport driver (core pipeline) ====================

/// SeaTalk conversation ids carry the thread inline, because [`Conversation`]
/// has no thread field and SeaTalk replies must go back to the thread they came
/// from. `binding()` decides whether the thread also separates *sessions* (that
/// is config), while `deliver()` always uses it to address the reply.
const THREAD_SEP: &str = "#t=";

fn encode_conv_id(chat_id: &str, thread_id: Option<&str>) -> String {
    match thread_id {
        Some(t) if !t.is_empty() => format!("{chat_id}{THREAD_SEP}{t}"),
        _ => chat_id.to_string(),
    }
}

fn decode_conv_id(id: &str) -> (&str, Option<&str>) {
    match id.split_once(THREAD_SEP) {
        Some((chat, thread)) => (chat, Some(thread)),
        None => (id, None),
    }
}

fn seatalk_caps() -> crate::driver::ChannelCaps {
    crate::driver::ChannelCaps {
        // SeaTalk's OpenAPI posts messages; there is no edit endpoint, so a
        // streamed reply would have to be N messages. The core buffers instead.
        streaming_edit: false,
        // `dispatch_send` has rejected SeaTalk file sends all along; saying so
        // here is what makes the core degrade an attachment into text rather
        // than fail the turn.
        media_upload: false,
        interactive: false,
        threading: crate::driver::Threading::Inline,
        max_chars: 4000,
        turn_timeout_secs: 180,
    }
}

/// Normalize a SeaTalk callback event into the shape the core consumes.
///
/// Pure: no config, no network. Policy (allowlists, thread-per-session) stays
/// with the driver and the core, which is the whole point of the split.
pub(crate) fn normalize_event(event: &serde_json::Value) -> Option<crate::driver::InboundMessage> {
    let event_type = event["event_type"].as_str().unwrap_or("");
    let event_id = event["event_id"].as_str().unwrap_or("");
    if event_id.is_empty() {
        return None;
    }
    let payload = &event["event"];

    let (kind, chat_id, sender_val, is_dm) = match event_type {
        "message_from_bot_subscriber" => (
            crate::driver::ConversationKind::Direct,
            sender_identity(payload),
            payload.clone(),
            true,
        ),
        "new_mentioned_message_received_from_group_chat" | "new_message_received_from_thread" => {
            let group_id = payload["group_id"]
                .as_str()
                .or_else(|| payload["group"]["group_id"].as_str())
                .unwrap_or("")
                .to_string();
            (
                crate::driver::ConversationKind::Group,
                group_id,
                payload["message"]["sender"].clone(),
                false,
            )
        }
        _ => return None,
    };
    if chat_id.is_empty() {
        return None;
    }

    let message = &payload["message"];
    let employee_code = if is_dm {
        chat_id.clone()
    } else {
        sender_identity(&sender_val)
    };
    if employee_code.is_empty() {
        return None;
    }
    let email = sender_val["email"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let thread_id = optional_id(message["thread_id"].as_str()).map(str::to_string);
    let text = extract_message_text(message);

    Some(crate::driver::InboundMessage {
        conversation: crate::driver::Conversation {
            channel: "seatalk",
            bot_id: None,
            kind,
            id: encode_conv_id(&chat_id, thread_id.as_deref()),
        },
        sender: crate::driver::ExternalSender {
            display_name: email.clone().unwrap_or_else(|| employee_code.clone()),
            external_id: employee_code,
            email,
        },
        external_message_id: event_id.to_string(),
        text,
        attachments: Vec::new(),
        // SeaTalk only delivers group messages the bot was mentioned in, and a
        // DM is addressed by definition.
        addressed_to_bot: true,
        quoted_text: None,
        reply_context: None,
    })
}

/// SeaTalk as a transport driver.
pub struct SeaTalkDriver {
    app_id: String,
    client: SeaTalkClient,
    /// Whether a thread splits the session, mirroring the inline path's config.
    dm_thread_session: bool,
    group_thread_session: bool,
}

impl SeaTalkDriver {
    pub fn new(app_id: String, app_secret: String) -> Self {
        Self {
            client: SeaTalkClient::new(app_id.clone(), app_secret),
            app_id,
            dm_thread_session: false,
            group_thread_session: false,
        }
    }

    pub fn with_thread_sessions(mut self, dm: bool, group: bool) -> Self {
        self.dm_thread_session = dm;
        self.group_thread_session = group;
        self
    }
}

#[async_trait::async_trait]
impl crate::driver::ChannelDriver for SeaTalkDriver {
    fn id(&self) -> crate::driver::ChannelId {
        "seatalk"
    }

    fn caps(&self) -> crate::driver::ChannelCaps {
        seatalk_caps()
    }

    fn binding(&self, conversation: &crate::driver::Conversation) -> String {
        let (chat, thread) = decode_conv_id(&conversation.id);
        match conversation.kind {
            crate::driver::ConversationKind::Group => match thread {
                Some(t) if self.group_thread_session => {
                    crate::binding::seatalk_group_thread(&self.app_id, chat, t)
                }
                _ => crate::binding::seatalk_group(&self.app_id, chat),
            },
            _ => match thread {
                Some(t) if self.dm_thread_session => {
                    crate::binding::seatalk_dm_thread(&self.app_id, chat, t)
                }
                _ => crate::binding::seatalk_dm(&self.app_id, chat),
            },
        }
    }

    fn sender_urn(
        &self,
        _conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        crate::binding::urn_seatalk_user(&self.app_id, &sender.external_id)
    }

    fn session_title(
        &self,
        conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        let (chat, _) = decode_conv_id(&conversation.id);
        match conversation.kind {
            crate::driver::ConversationKind::Group => format!("SeaTalk group: {chat}"),
            _ => format!(
                "SeaTalk DM: {}",
                if sender.display_name.is_empty() {
                    chat
                } else {
                    sender.display_name.as_str()
                }
            ),
        }
    }

    async fn deliver(
        &self,
        to: &crate::driver::Conversation,
        _reply_context: Option<&str>,
        msg: &crate::driver::OutboundMessage,
    ) -> Result<crate::driver::DeliveryId, crate::driver::DriverError> {
        let (chat, thread) = decode_conv_id(&to.id);
        let text = if msg.text.trim().is_empty() {
            return Ok(crate::driver::DeliveryId(to.id.clone()));
        } else {
            msg.text.as_str()
        };
        let result = match to.kind {
            crate::driver::ConversationKind::Group => {
                self.client.send_group_text(chat, text, thread).await
            }
            _ => self.client.send_single_text(chat, text, thread).await,
        };
        result.map_err(crate::driver::DriverError::Transport)?;
        Ok(crate::driver::DeliveryId(to.id.clone()))
    }
}

async fn handle_callback_event(
    ctx: &HandlerContext,
    event: &serde_json::Value,
) -> Result<(), String> {
    let event_id = event["event_id"].as_str().unwrap_or("").to_string();
    let event_type = event["event_type"].as_str().unwrap_or("").to_string();
    if event_id.is_empty() {
        eprintln!(
            "[SeaTalk] dropping event without event_id type={} keys={:?}",
            event_type,
            event
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
        );
        return Ok(());
    }
    {
        let mut tracker = ctx.processed_events.write().await;
        if tracker.is_duplicate(&event_id) {
            println!("[SeaTalk] duplicate event_id={event_id}, skip");
            return Ok(());
        }
    }

    println!("[SeaTalk] handle event_id={event_id} type={event_type}");

    // Lifecycle events never open a session; everything else is a message and
    // belongs to the core (dedup, routing, identity, commands, writing, turn).
    match event_type.as_str() {
        "bot_added_to_group_chat" | "bot_removed_from_group_chat" | "new_bot_subscriber" => {
            println!("[SeaTalk] lifecycle event type={event_type} (ignored)");
            return Ok(());
        }
        _ => {}
    }

    let Some(sink) = ctx.inbound_sink.clone() else {
        eprintln!("[SeaTalk] no core pipeline wired; dropping event_id={event_id}");
        return Ok(());
    };

    // The allowlist stays here, not in the core: it is per-channel config and
    // the core has no policy layer. Losing it with the inline handlers would
    // have quietly opened the bot to everyone.
    let cfg = ctx.config.read().await.clone();
    let payload = &event["event"];
    let allowed = if event_type == "message_from_bot_subscriber" {
        let code = sender_identity(payload);
        check_dm_allowed(&cfg, &code, payload["email"].as_str())
    } else {
        let group_id = payload["group_id"]
            .as_str()
            .or_else(|| payload["group"]["group_id"].as_str())
            .unwrap_or("");
        let sender = &payload["message"]["sender"];
        let code = sender_identity(sender);
        match check_group_allowed(&cfg, group_id, &code, sender["email"].as_str()) {
            FilterResult::Allow => true,
            FilterResult::UserNotAllowed => {
                let _ = ctx
                    .client
                    .send_group_text(
                        group_id,
                        "Sorry, you are not authorized to use this bot.",
                        optional_id(payload["message"]["thread_id"].as_str()),
                    )
                    .await;
                false
            }
            _ => false,
        }
    };
    if !allowed {
        println!("[SeaTalk] event_id={event_id} blocked by policy");
        return Ok(());
    }

    match normalize_event(event) {
        Some(inbound) => {
            sink.accept(inbound).await;
            Ok(())
        }
        None => {
            println!("[SeaTalk] event carried nothing actionable; ignoring");
            Ok(())
        }
    }
}

/// Prefer employee_code; fall back to seatalk_id when SeaTalk omits the former.
fn sender_identity(sender: &serde_json::Value) -> String {
    sender["employee_code"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| sender["seatalk_id"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string()
}

fn optional_id(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

#[allow(clippy::too_many_arguments)]
fn extract_message_text(message: &serde_json::Value) -> String {
    let tag = message["tag"].as_str().unwrap_or("");
    match tag {
        "text" => {
            let raw = message["text"]["plain_text"]
                .as_str()
                .or_else(|| message["text"]["content"].as_str())
                .unwrap_or("");
            strip_leading_mentions(raw)
        }
        _ => String::new(),
    }
}

/// Remove leading `@BotName` / `@all` tokens that SeaTalk includes in plain_text
/// for group mention events, so the agent sees the user's question only.
fn strip_leading_mentions(text: &str) -> String {
    let mut rest = text.trim_start();
    while let Some(stripped) = rest.strip_prefix('@') {
        let end = stripped
            .find(|c: char| c.is_whitespace())
            .unwrap_or(stripped.len());
        if end == 0 {
            break;
        }
        rest = stripped[end..].trim_start();
    }
    rest.trim().to_string()
}

fn chunk_text(text: &str, limit: usize) -> Vec<String> {
    if text.len() <= limit {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = (start + limit).min(text.len());
        let split_at = if end == text.len() {
            end
        } else {
            text[start..end]
                .rfind('\n')
                .map(|i| start + i + 1)
                .unwrap_or(end)
        };
        chunks.push(text[start..split_at].to_string());
        start = split_at;
    }
    chunks
}

impl Clone for SeaTalkGateway {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            agent: Arc::clone(&self.agent),
            store: Arc::clone(&self.store),
            team_id: self.team_id.clone(),
            primary_agent_actor_id: self.primary_agent_actor_id.clone(),
            agent_owner_actor_ids: self.agent_owner_actor_ids.clone(),
            shutdown_tx: Arc::clone(&self.shutdown_tx),
            status: Arc::clone(&self.status),
            is_running: Arc::clone(&self.is_running),
            processed_events: Arc::clone(&self.processed_events),
            inbound_sink: Arc::clone(&self.inbound_sink),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seatalk_config::SeaTalkConfig;

    #[test]
    fn strips_leading_bot_mentions() {
        assert_eq!(
            strip_leading_mentions("@TeamClu 帮我查一下状态"),
            "帮我查一下状态"
        );
        assert_eq!(
            strip_leading_mentions("@TeamClu @all please summarize"),
            "please summarize"
        );
        assert_eq!(strip_leading_mentions("no mention here"), "no mention here");
        assert_eq!(strip_leading_mentions("@only"), "");
    }

    #[test]
    fn default_config_allows_group_mentions() {
        let cfg = SeaTalkConfig::default();
        assert_eq!(cfg.mode, "websocket");
        assert_eq!(cfg.group_policy, "open");
        assert_eq!(
            check_group_allowed(&cfg, "g1", "e1", Some("a@b.com")),
            FilterResult::Allow
        );
        assert!(check_dm_allowed(&cfg, "e1", Some("a@b.com")));
    }

    #[test]
    fn extract_text_prefers_plain_text() {
        let message = json!({
            "tag": "text",
            "text": {
                "plain_text": "@Bot hello world",
                "content": "ignored"
            }
        });
        assert_eq!(extract_message_text(&message), "hello world");
    }

    #[test]
    fn sender_identity_falls_back_to_seatalk_id() {
        assert_eq!(
            sender_identity(&json!({"employee_code": "e1", "seatalk_id": "s1"})),
            "e1"
        );
        assert_eq!(sender_identity(&json!({"seatalk_id": "s1"})), "s1");
        assert_eq!(sender_identity(&json!({})), "");
    }

    #[test]
    fn register_success_when_code_omitted() {
        // SeaTalk often replies `{ cmd, message: "ok", header: { token } }`
        // without a numeric `code`. Missing code must be treated as 0.
        let raw = r#"{"cmd":"register","message":"ok","header":{"token":"t1","sid":"s1"},"data":{"heartbeat_interval":15}}"#;
        let env: WsEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.cmd, "register");
        assert_eq!(env.code.unwrap_or(0), 0);
        assert_eq!(
            env.header.as_ref().and_then(|h| h["token"].as_str()),
            Some("t1")
        );
    }
}
