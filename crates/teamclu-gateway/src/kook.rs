use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

use crate::kook_config::{KookConfig, KookGatewayStatus, KookGatewayStatusResponse};

use crate::{
    AgentHandle, ChannelStore, FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES,
};

/// Maximum number of buffered out-of-order messages
const MAX_BUFFER_SIZE: usize = 100;

/// KOOK API base URL
pub const KOOK_API_BASE: &str = "https://www.kookapp.cn/api/v3";

/// Heartbeat interval (30s ± 5s random)
const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Heartbeat timeout (6s)
const HEARTBEAT_TIMEOUT_SECS: u64 = 6;

/// WebSocket connection exit reason
#[derive(Debug)]
enum WsExitReason {
    Shutdown,
    Disconnected,
}

/// KOOK WebSocket signal types
#[derive(Debug)]
enum Signal {
    Event = 0,
    Hello = 1,
    Ping = 2,
    Pong = 3,
    #[allow(dead_code)]
    Resume = 4,
    Reconnect = 5,
    ResumeAck = 6,
}

/// KOOK event structure
#[derive(Debug, Clone, Deserialize)]
struct KookEvent {
    #[serde(rename = "s")]
    signal: u8,
    #[serde(rename = "d", default)]
    data: serde_json::Value,
    #[serde(rename = "sn")]
    sn: Option<u64>,
}

/// KOOK message event data
#[derive(Debug, Clone, Deserialize)]
struct KookMessageData {
    channel_type: String,
    #[serde(rename = "type")]
    msg_type: u8,
    target_id: String,
    author_id: String,
    content: String,
    msg_id: String,
    msg_timestamp: u64,
    extra: serde_json::Value,
}

impl KookMessageData {
    fn to_json(&self) -> serde_json::Value {
        json!({
            "channel_type": self.channel_type,
            "type": self.msg_type,
            "target_id": self.target_id,
            "author_id": self.author_id,
            "content": self.content,
            "msg_id": self.msg_id,
            "msg_timestamp": self.msg_timestamp,
            "extra": self.extra,
        })
    }
}

/// KOOK gateway implementation
pub struct KookGateway {
    config: Arc<RwLock<KookConfig>>,
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    #[allow(dead_code)]
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<KookGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    /// WebSocket session ID from HELLO
    ws_session_id: Arc<RwLock<Option<String>>>,
    /// Last processed sequence number
    last_sn: Arc<AtomicU64>,
    /// Tracker for processed message IDs to prevent duplicates
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    /// Bot's own user ID (fetched via /user/me on startup)
    bot_user_id: Arc<RwLock<Option<String>>>,
    /// Set once the daemon wires the core pipeline; the inline path is skipped.
    inbound_sink: Arc<RwLock<Option<Arc<dyn crate::driver::InboundSink>>>>,
}

impl KookGateway {
    pub fn new(
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
        workspace_path: String,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(KookConfig::default())),
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(KookGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            ws_session_id: Arc::new(RwLock::new(None)),
            last_sn: Arc::new(AtomicU64::new(0)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(
                MAX_PROCESSED_MESSAGES,
            ))),
            bot_user_id: Arc::new(RwLock::new(None)),
            inbound_sink: Arc::new(RwLock::new(None)),
        }
    }

    /// Hand inbound messages to the core instead of the inline handler.
    pub async fn use_core_pipeline(&self, sink: Arc<dyn crate::driver::InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    /// A driver for the core to render replies through.
    pub async fn as_driver(&self) -> KookDriver {
        KookDriver::new(self.config.read().await.token.clone())
    }

    pub async fn set_config(&self, config: KookConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    pub async fn get_status(&self) -> KookGatewayStatusResponse {
        self.status.read().await.clone()
    }

    pub async fn start(&self) -> Result<(), String> {
        {
            let running = self.is_running.read().await;
            if *running {
                return Err("KOOK gateway is already running".to_string());
            }
        }

        let config = self.config.read().await.clone();

        if config.token.is_empty() {
            return Err("KOOK bot token is required".to_string());
        }

        // Set status to connecting
        {
            let mut status = self.status.write().await;
            status.status = KookGatewayStatus::Connecting;
            status.error_message = None;
        }

        // Set running flag
        {
            let mut running = self.is_running.write().await;
            *running = true;
        }

        // Create shutdown channel
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        {
            let mut tx = self.shutdown_tx.write().await;
            *tx = Some(shutdown_tx);
        }

        // Clone necessary data for the async task
        let gateway = self.clone();
        let token = config.token.clone();

        // Spawn gateway loop
        tokio::spawn(async move {
            if let Err(e) = gateway.run_gateway_loop(token, shutdown_rx).await {
                println!("[KOOK] Gateway error: {}", e);
                let mut status = gateway.status.write().await;
                status.status = KookGatewayStatus::Error;
                status.error_message = Some(e);
            }

            // Set running to false when task exits
            let mut running = gateway.is_running.write().await;
            *running = false;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let running = {
            let r = self.is_running.read().await;
            *r
        };

        if !running {
            return Ok(());
        }

        // Trigger shutdown
        {
            let mut tx_guard = self.shutdown_tx.write().await;
            if let Some(tx) = tx_guard.take() {
                let _ = tx.send(());
            }
        }

        // Wait for gateway to stop
        for _ in 0..50 {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            let running = self.is_running.read().await;
            if !*running {
                println!("[KOOK] Gateway stopped successfully");
                return Ok(());
            }
        }

        println!("[KOOK] Warning: Gateway did not stop within timeout, forcing stop");

        // Force reset state in case the wait timed out
        {
            let mut is_running = self.is_running.write().await;
            *is_running = false;
        }
        {
            let mut status = self.status.write().await;
            status.status = KookGatewayStatus::Disconnected;
            status.error_message = None;
            status.connected_guilds.clear();
        }

        println!("[KOOK] Gateway forcefully stopped");
        Ok(())
    }

    /// Consuming shutdown used by the amuxd channel manager.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[KOOK] shutdown: {e}");
        }
    }

    /// Main gateway loop: connect, handle events, reconnect on failure
    async fn run_gateway_loop(
        &self,
        token: String,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let mut backoff_secs = 2u64;
        let max_backoff = 60u64;

        loop {
            println!("[KOOK] Starting gateway connection...");

            match self.connect_and_run(&token, &mut shutdown_rx).await {
                Ok(WsExitReason::Shutdown) => {
                    println!("[KOOK] Shutdown requested, exiting gateway loop");
                    break;
                }
                Ok(WsExitReason::Disconnected) => {
                    println!("[KOOK] Connection ended, will reconnect...");
                    backoff_secs = 2;

                    {
                        let mut status = self.status.write().await;
                        status.status = KookGatewayStatus::Connecting;
                        status.error_message = Some("Reconnecting...".to_string());
                    }

                    tokio::select! {
                        _ = &mut shutdown_rx => {
                            println!("[KOOK] Shutdown during reconnect wait");
                            break;
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(backoff_secs)) => {}
                    }
                }
                Err(e) => {
                    println!("[KOOK] Connection error: {}", e);

                    {
                        let mut status = self.status.write().await;
                        status.status = KookGatewayStatus::Connecting;
                        status.error_message = Some(format!("Reconnecting after error: {}", e));
                    }

                    println!("[KOOK] Reconnecting in {} seconds...", backoff_secs);
                    tokio::select! {
                        _ = &mut shutdown_rx => {
                            println!("[KOOK] Shutdown during backoff wait");
                            break;
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(backoff_secs)) => {}
                    }
                    backoff_secs = std::cmp::min(backoff_secs * 2, max_backoff);
                }
            }
        }

        // Update status to disconnected
        let mut status = self.status.write().await;
        status.status = KookGatewayStatus::Disconnected;
        status.error_message = None;
        status.connected_guilds.clear();

        Ok(())
    }

    /// Fetch the bot's own user ID via /api/v3/user/me
    async fn fetch_bot_user_id(&self, token: &str) -> Result<String, String> {
        let client = crate::http_client_secs(30);
        let url = format!("{}/user/me", KOOK_API_BASE);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bot {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch bot user info: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse user/me response: {}", e))?;

        let user_id = body["data"]["id"]
            .as_str()
            .ok_or_else(|| "No user ID in /user/me response".to_string())?
            .to_string();

        let username = body["data"]["username"].as_str().unwrap_or("Unknown");

        println!("[KOOK] Bot user ID: {}, username: {}", user_id, username);
        Ok(user_id)
    }

    /// Strip KOOK mention syntax from message content
    fn strip_mentions(&self, content: &str, bot_id: Option<&str>) -> String {
        let mut result = content.to_string();
        if let Some(id) = bot_id {
            result = result.replace(&format!("(met){}(met)", id), "");
        }
        result.trim().to_string()
    }

    /// Connect to KOOK WebSocket and handle events
    async fn connect_and_run(
        &self,
        token: &str,
        shutdown_rx: &mut oneshot::Receiver<()>,
    ) -> Result<WsExitReason, String> {
        // Reset sequence number for new connection
        self.last_sn.store(0, Ordering::SeqCst);
        println!("[KOOK] Reset sequence number for new connection");

        // Fetch bot user ID
        match self.fetch_bot_user_id(token).await {
            Ok(id) => {
                let mut bot_id = self.bot_user_id.write().await;
                *bot_id = Some(id);
            }
            Err(e) => {
                println!(
                    "[KOOK] Warning: Failed to fetch bot user ID: {}. Mentions won't be stripped.",
                    e
                );
            }
        }

        // Get gateway URL
        let gateway_url = self.get_gateway_url(token).await?;
        println!("[KOOK] Gateway URL: {}", gateway_url);

        // Connect to WebSocket
        let (ws_stream, _) = connect_async(&gateway_url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        let (write, mut read) = ws_stream.split();

        println!("[KOOK] WebSocket connected, waiting for HELLO...");

        // Wait for HELLO signal (s=1) within 6 seconds
        let hello_timeout = tokio::time::Duration::from_secs(6);
        let session_id = tokio::time::timeout(hello_timeout, async {
            while let Some(msg_result) = read.next().await {
                match msg_result {
                    Ok(WsMessage::Text(text)) => {
                        if let Ok(event) = serde_json::from_str::<KookEvent>(&text) {
                            if event.signal == Signal::Hello as u8 {
                                return self.handle_hello(event).await;
                            }
                        }
                    }
                    Ok(WsMessage::Binary(_)) => {
                        // Compressed message, we use compress=0 so this shouldn't happen
                        println!("[KOOK] Warning: Received binary message (compression enabled?)");
                    }
                    Ok(WsMessage::Close(_)) => {
                        return Err("Connection closed during HELLO".to_string());
                    }
                    Err(e) => {
                        return Err(format!("WebSocket error during HELLO: {}", e));
                    }
                    _ => {}
                }
            }
            Err("No HELLO received".to_string())
        })
        .await
        .map_err(|_| "HELLO timeout (6s)".to_string())??;

        println!("[KOOK] HELLO received, session_id: {}", session_id);

        // Store session ID
        {
            let mut ws_session = self.ws_session_id.write().await;
            *ws_session = Some(session_id.clone());
        }

        // Update status to connected
        {
            let mut status = self.status.write().await;
            status.status = KookGatewayStatus::Connected;
            status.error_message = None;
        }

        // Start heartbeat task
        let (heartbeat_tx, mut heartbeat_rx) = mpsc::channel::<()>(1);
        let last_sn_clone = self.last_sn.clone();
        let write_clone = Arc::new(tokio::sync::Mutex::new(write));
        let write_for_heartbeat = write_clone.clone();

        let heartbeat_task = tokio::spawn(async move {
            loop {
                // Wait for 30s ± 5s
                // Simple pseudo-random jitter using timestamp
                let jitter = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    % 11) as i64
                    - 5; // -5 to +5
                let wait_secs = (HEARTBEAT_INTERVAL_SECS as i64 + jitter).max(1) as u64;

                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(wait_secs)) => {
                        // Send PING
                        let sn = last_sn_clone.load(Ordering::SeqCst);
                        let ping = json!({
                            "s": Signal::Ping as u8,
                            "sn": sn
                        });

                        let mut writer = write_for_heartbeat.lock().await;
                        if let Err(e) = writer.send(WsMessage::Text(ping.to_string().into())).await {
                            println!("[KOOK] Failed to send heartbeat: {}", e);
                            break;
                        }
                        drop(writer);

                        // Wait for PONG (6s timeout)
                        match tokio::time::timeout(
                            tokio::time::Duration::from_secs(HEARTBEAT_TIMEOUT_SECS),
                            heartbeat_rx.recv()
                        ).await {
                            Ok(Some(())) => {
                                // PONG received
                            }
                            _ => {
                                println!("[KOOK] Heartbeat timeout");
                                break;
                            }
                        }
                    }
                    _ = heartbeat_rx.recv() => {
                        // Shutdown signal
                        break;
                    }
                }
            }
        });

        // Message buffer for out-of-order handling
        let mut message_buffer: VecDeque<(u64, KookMessageData)> = VecDeque::new();

        // Main event loop
        let mut exit_reason = WsExitReason::Disconnected;
        let mut _shutdown_fired = false;
        loop {
            tokio::select! {
                msg_result = read.next() => {
                    match msg_result {
                        Some(Ok(WsMessage::Text(text))) => {
                            if let Err(e) = self.handle_ws_message(&text, &heartbeat_tx, &mut message_buffer).await {
                                println!("[KOOK] Error handling message: {}", e);
                                if e.contains("Reconnect requested") {
                                    println!("[KOOK] Server requested reconnection, closing connection");
                                    break;
                                }
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            println!("[KOOK] WebSocket closed by server");
                            break;
                        }
                        Some(Err(e)) => {
                            println!("[KOOK] WebSocket error: {}", e);
                            break;
                        }
                        None => {
                            println!("[KOOK] WebSocket stream ended");
                            break;
                        }
                        _ => {}
                    }
                }
                _ = &mut *shutdown_rx, if !_shutdown_fired => {
                    println!("[KOOK] Shutdown requested");
                    _shutdown_fired = true;
                    exit_reason = WsExitReason::Shutdown;
                    break;
                }
            }
        }

        // Cleanup
        heartbeat_task.abort();
        let mut writer = write_clone.lock().await;
        let _ = writer.close().await;

        Ok(exit_reason)
    }

    /// Get gateway WebSocket URL from KOOK API
    async fn get_gateway_url(&self, token: &str) -> Result<String, String> {
        let client = crate::http_client_secs(30);
        let url = format!("{}/gateway/index?compress=0", KOOK_API_BASE);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bot {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to get gateway: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse gateway response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Gateway API error ({}): {}", code, message));
            }
        }

        body.get("data")
            .and_then(|d| d.get("url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "No gateway URL in response".to_string())
    }

    /// Handle HELLO signal (s=1)
    async fn handle_hello(&self, event: KookEvent) -> Result<String, String> {
        let code = event
            .data
            .get("code")
            .and_then(|c| c.as_i64())
            .unwrap_or(-1);

        if code != 0 {
            return Err(format!("HELLO failed with code: {}", code));
        }

        let session_id = event
            .data
            .get("session_id")
            .and_then(|s| s.as_str())
            .ok_or("No session_id in HELLO")?
            .to_string();

        Ok(session_id)
    }

    /// Handle incoming WebSocket message
    async fn handle_ws_message(
        &self,
        text: &str,
        heartbeat_tx: &mpsc::Sender<()>,
        message_buffer: &mut VecDeque<(u64, KookMessageData)>,
    ) -> Result<(), String> {
        let event: KookEvent =
            serde_json::from_str(text).map_err(|e| format!("Failed to parse event: {}", e))?;

        match event.signal {
            s if s == Signal::Event as u8 => {
                // Message or system event
                if let Some(sn) = event.sn {
                    self.handle_event(sn, event.data, message_buffer).await?;
                }
            }
            s if s == Signal::Pong as u8 => {
                // Heartbeat PONG
                let _ = heartbeat_tx.try_send(());
            }
            s if s == Signal::Reconnect as u8 => {
                // Server requests reconnection
                println!("[KOOK] Received RECONNECT signal");
                return Err("Reconnect requested by server".to_string());
            }
            s if s == Signal::ResumeAck as u8 => {
                // Resume successful
                println!("[KOOK] Resume ACK received");
            }
            _ => {
                println!("[KOOK] Unknown signal: {}", event.signal);
            }
        }

        Ok(())
    }

    /// Handle EVENT signal (s=0) - messages and system events
    async fn handle_event(
        &self,
        sn: u64,
        data: serde_json::Value,
        message_buffer: &mut VecDeque<(u64, KookMessageData)>,
    ) -> Result<(), String> {
        let last_sn = self.last_sn.load(Ordering::SeqCst);

        // Check message ordering
        if sn <= last_sn {
            // Already processed, skip
            println!("[KOOK] Skipping duplicate sn: {}", sn);
            return Ok(());
        }

        if sn == last_sn + 1 {
            // In-order message, process immediately
            match self.process_message_data(sn, data).await {
                Ok(_) => {}
                Err(e) => {
                    println!("[KOOK] Error handling message: {}", e);
                }
            }
            // Update last_sn even if processing failed to maintain sequence continuity
            self.last_sn.store(sn, Ordering::SeqCst);

            // Process any buffered messages that are now in order
            while let Some((buffered_sn, _)) = message_buffer.front() {
                if *buffered_sn == self.last_sn.load(Ordering::SeqCst) + 1 {
                    if let Some((sn, data_value)) = message_buffer.pop_front() {
                        let data_json = data_value.to_json();
                        match self.process_message_data(sn, data_json).await {
                            Ok(_) => {}
                            Err(e) => {
                                println!("[KOOK] Error handling buffered message: {}", e);
                            }
                        }
                        // Update last_sn even if processing failed
                        self.last_sn.store(sn, Ordering::SeqCst);
                    }
                } else {
                    break;
                }
            }
        } else {
            // Out-of-order message, buffer it
            println!(
                "[KOOK] Buffering out-of-order message: sn={} (expected={})",
                sn,
                last_sn + 1
            );

            if let Ok(msg_data) = serde_json::from_value::<KookMessageData>(data) {
                message_buffer.push_back((sn, msg_data));

                // Sort buffer by sn
                message_buffer.make_contiguous().sort_by_key(|(sn, _)| *sn);

                // Limit buffer size
                if message_buffer.len() > MAX_BUFFER_SIZE {
                    println!("[KOOK] Warning: Message buffer full, dropping oldest");
                    message_buffer.pop_front();
                }
            }
        }

        Ok(())
    }

    /// Process a message event
    async fn process_message_data(&self, sn: u64, data: serde_json::Value) -> Result<(), String> {
        let msg_data: KookMessageData = serde_json::from_value(data)
            .map_err(|e| format!("Failed to parse message data: {}", e))?;

        println!(
            "[KOOK] Event sn={}, channel_type={}, msg_id={}",
            sn, msg_data.channel_type, msg_data.msg_id
        );

        // Check if already processed
        if self.mark_message_processed(&msg_data.msg_id).await {
            println!("[KOOK] Skipping duplicate message: {}", msg_data.msg_id);
            return Ok(());
        }

        // Filter message
        let filter_result = self.filter_message(&msg_data).await;

        match filter_result {
            FilterResult::Allow => {
                // Everything a session needs happens in the core.
                let Some(sink) = self.inbound_sink.read().await.clone() else {
                    eprintln!("[KOOK] no core pipeline wired; dropping message");
                    return Ok(());
                };
                let bot_id = self.bot_user_id.read().await.clone();
                let content = self.strip_mentions(&msg_data.content, bot_id.as_deref());
                if let Some(inbound) = normalize_message(&msg_data, &content) {
                    sink.accept(inbound).await;
                }
            }
            FilterResult::Ignore => {
                println!("[KOOK] Message filtered (ignore)");
            }
            FilterResult::UserNotAllowed => {
                println!("[KOOK] User not in allowlist: {}", msg_data.author_id);
                self.send_rejection_reply(&msg_data).await?;
            }
            FilterResult::ChannelNotConfigured => {
                println!("[KOOK] Channel not configured");
                self.send_config_hint(&msg_data).await?;
            }
        }

        Ok(())
    }

    /// Check if a message has been processed, and mark it if not
    async fn mark_message_processed(&self, msg_id: &str) -> bool {
        let mut tracker = self.processed_messages.write().await;
        tracker.is_duplicate(msg_id)
    }

    /// Filter message based on configuration
    async fn filter_message(&self, msg: &KookMessageData) -> FilterResult {
        let config = self.config.read().await;

        // Ignore bot messages
        if let Some(author) = msg.extra.get("author") {
            if author.get("bot").and_then(|b| b.as_bool()).unwrap_or(false) {
                return FilterResult::Ignore;
            }
        }

        match msg.channel_type.as_str() {
            "PERSON" => {
                // Direct message
                if !config.dm.enabled {
                    return FilterResult::Ignore;
                }

                match config.dm.policy.as_str() {
                    "open" => FilterResult::Allow,
                    "allowlist" => {
                        if config.dm.allow_from.contains(&msg.author_id)
                            || config.dm.allow_from.contains(&"*".to_string())
                        {
                            FilterResult::Allow
                        } else {
                            FilterResult::UserNotAllowed
                        }
                    }
                    _ => FilterResult::Allow,
                }
            }
            "GROUP" => {
                // Guild channel message
                let guild_id = msg
                    .extra
                    .get("guild_id")
                    .and_then(|g| g.as_str())
                    .unwrap_or("");

                println!(
                    "[KOOK] GROUP message: guild_id={}, channel_id={}",
                    guild_id, msg.target_id
                );
                println!(
                    "[KOOK] Configured guilds: {:?}",
                    config.guilds.keys().collect::<Vec<_>>()
                );

                if guild_id.is_empty() {
                    return FilterResult::Ignore;
                }

                // Check if guild is configured (exact match or wildcard)
                let guild_cfg = config
                    .guilds
                    .get(guild_id)
                    .or_else(|| config.guilds.get("*"));

                let Some(guild_cfg) = guild_cfg else {
                    return FilterResult::ChannelNotConfigured;
                };

                if !guild_cfg.enabled {
                    return FilterResult::Ignore;
                }

                // Check channel configuration (exact match or wildcard)
                let channel_rule = guild_cfg
                    .channels
                    .get(&msg.target_id)
                    .or_else(|| guild_cfg.channels.get("*"));

                if let Some(rule) = channel_rule {
                    if !rule.enabled {
                        return FilterResult::Ignore;
                    }

                    // Check user allowlist (channel-specific)
                    if !rule.allowed_users.is_empty()
                        && !rule.allowed_users.contains(&msg.author_id)
                        && !rule.allowed_users.contains(&"*".to_string())
                    {
                        return FilterResult::UserNotAllowed;
                    }

                    // Group-only flows when @-mentioned (per spec). Always enforce this
                    // for GROUP channels regardless of rule.require_mention setting.
                    let bot_id = self.bot_user_id.read().await;
                    let bot_mentioned = if let Some(ref id) = *bot_id {
                        msg.content.contains(&format!("(met){}(met)", id))
                    } else {
                        msg.content.contains("(met)")
                    };
                    drop(bot_id);
                    if !bot_mentioned && !msg.content.starts_with('/') {
                        return FilterResult::Ignore;
                    }

                    FilterResult::Allow
                } else {
                    // No specific channel rule, but guild is configured. Still require
                    // @-mention for group messages per spec.
                    let bot_id = self.bot_user_id.read().await;
                    let bot_mentioned = if let Some(ref id) = *bot_id {
                        msg.content.contains(&format!("(met){}(met)", id))
                    } else {
                        msg.content.contains("(met)")
                    };
                    drop(bot_id);
                    if !bot_mentioned && !msg.content.starts_with('/') {
                        return FilterResult::Ignore;
                    }
                    FilterResult::Allow
                }
            }
            _ => FilterResult::Ignore,
        }
    }

    /// Send reply via KOOK HTTP API using card message for rich formatting
    async fn send_reply(&self, original: &KookMessageData, reply_text: &str) -> Result<(), String> {
        let config = self.config.read().await;
        let client = crate::http_client_secs(30);

        let card = json!([
            {
                "type": "card",
                "theme": "primary",
                "size": "lg",
                "modules": [
                    {
                        "type": "section",
                        "text": {
                            "type": "kmarkdown",
                            "content": reply_text
                        }
                    }
                ]
            }
        ]);

        let (endpoint, payload) = if original.channel_type == "PERSON" {
            let url = format!("{}/direct-message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,
                "target_id": original.author_id,
                "content": serde_json::to_string(&card).unwrap(),
                "quote": original.msg_id,
            });
            (url, body)
        } else {
            let url = format!("{}/message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,
                "target_id": original.target_id,
                "content": serde_json::to_string(&card).unwrap(),
                "quote": original.msg_id,
            });
            (url, body)
        };

        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bot {}", config.token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse reply response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Reply API error ({}): {}", code, message));
            }
        }

        Ok(())
    }

    /// Send rejection reply for users not in allowlist
    async fn send_rejection_reply(&self, msg: &KookMessageData) -> Result<(), String> {
        let reply = "This is an automated response from TeamClu. \
            Your user ID is not in the allowed list. \
            Please contact the administrator if you believe this is an error.";
        self.send_reply(msg, reply).await
    }

    /// Send configuration hint
    async fn send_config_hint(&self, msg: &KookMessageData) -> Result<(), String> {
        let reply = "This channel is not configured for TeamClu bot. \
            Please configure it in the TeamClu settings.";
        self.send_reply(msg, reply).await
    }
}

// ==================== Transport driver (core pipeline) ====================

/// KOOK addresses a DM reply by the *author*, but keys the binding on the DM
/// channel code. [`Conversation`] has one id field, so both ride in it.
const DM_SEP: &str = "|u=";

fn encode_dm_id(target_id: &str, author_id: &str) -> String {
    format!("{target_id}{DM_SEP}{author_id}")
}

fn decode_conv_id(id: &str) -> (&str, Option<&str>) {
    match id.split_once(DM_SEP) {
        Some((target, author)) => (target, Some(author)),
        None => (id, None),
    }
}

fn kook_caps() -> crate::driver::ChannelCaps {
    crate::driver::ChannelCaps {
        // KOOK has a message-update endpoint, but this driver does not speak it
        // yet; claiming the capability would make the core stream edits into a
        // method that returns an error.
        streaming_edit: false,
        media_upload: false,
        interactive: false,
        threading: crate::driver::Threading::ReplyTo,
        max_chars: 4000,
        turn_timeout_secs: 180,
    }
}

/// Normalize a KOOK message into the shape the core consumes.
///
/// `content` is the text with the bot mention already stripped — that needs the
/// bot's own user id, which is connection state rather than a property of the
/// event, so the caller does it.
fn normalize_message(
    msg: &KookMessageData,
    content: &str,
) -> Option<crate::driver::InboundMessage> {
    if msg.msg_id.is_empty() || msg.author_id.is_empty() {
        return None;
    }
    let is_dm = msg.channel_type == "PERSON";
    let scope = if is_dm {
        "dm".to_string()
    } else {
        msg.extra
            .get("guild_id")
            .and_then(|g| g.as_str())
            .unwrap_or("unknown")
            .to_string()
    };
    let display = msg
        .extra
        .get("author")
        .and_then(|a| a.get("username"))
        .and_then(|u| u.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| msg.author_id.clone());

    Some(crate::driver::InboundMessage {
        conversation: crate::driver::Conversation {
            channel: "kook",
            // The guild (or "dm") decides the binding scope, so it travels as
            // the bot_id slot rather than being re-derived downstream.
            bot_id: Some(scope),
            kind: if is_dm {
                crate::driver::ConversationKind::Direct
            } else {
                crate::driver::ConversationKind::Group
            },
            id: if is_dm {
                encode_dm_id(&msg.target_id, &msg.author_id)
            } else {
                msg.target_id.clone()
            },
        },
        sender: crate::driver::ExternalSender {
            external_id: msg.author_id.clone(),
            display_name: display,
            email: None,
        },
        external_message_id: msg.msg_id.clone(),
        text: content.to_string(),
        attachments: Vec::new(),
        // KOOK only pushes DMs and channel messages the bot can see; the inline
        // path treated every delivered message as addressed, and so does this.
        addressed_to_bot: true,
        quoted_text: None,
        reply_context: Some(msg.msg_id.clone()),
    })
}

/// KOOK as a transport driver.
pub struct KookDriver {
    token: String,
}

impl KookDriver {
    pub fn new(token: String) -> Self {
        Self { token }
    }
}

#[async_trait::async_trait]
impl crate::driver::ChannelDriver for KookDriver {
    fn id(&self) -> crate::driver::ChannelId {
        "kook"
    }

    fn caps(&self) -> crate::driver::ChannelCaps {
        kook_caps()
    }

    fn binding(&self, conversation: &crate::driver::Conversation) -> String {
        let (target, _) = decode_conv_id(&conversation.id);
        let scope = conversation.bot_id.as_deref().unwrap_or("unknown");
        crate::binding::kook(scope, target)
    }

    fn sender_urn(
        &self,
        _conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        crate::binding::urn_kook_user(&sender.external_id)
    }

    fn session_title(
        &self,
        conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        let (target, _) = decode_conv_id(&conversation.id);
        match conversation.kind {
            crate::driver::ConversationKind::Group => format!("Kook: #{target}"),
            _ => format!("Kook DM: {}", sender.display_name),
        }
    }

    async fn deliver(
        &self,
        to: &crate::driver::Conversation,
        reply_context: Option<&str>,
        msg: &crate::driver::OutboundMessage,
    ) -> Result<crate::driver::DeliveryId, crate::driver::DriverError> {
        if msg.text.trim().is_empty() {
            return Ok(crate::driver::DeliveryId(to.id.clone()));
        }
        let (target, dm_author) = decode_conv_id(&to.id);
        let is_dm = matches!(to.kind, crate::driver::ConversationKind::Direct);
        let addressee = if is_dm {
            dm_author.unwrap_or(target)
        } else {
            target
        };

        send_kook_card(&self.token, addressee, &msg.text, reply_context, is_dm)
            .await
            .map_err(crate::driver::DriverError::Transport)?;
        Ok(crate::driver::DeliveryId(to.id.clone()))
    }
}

/// Post one kmarkdown card, to a DM or a channel.
///
/// Shares the card shape with the inline `send_reply` so a reply looks the same
/// whichever path produced it.
async fn send_kook_card(
    token: &str,
    target_id: &str,
    text: &str,
    quote: Option<&str>,
    is_dm: bool,
) -> Result<(), String> {
    let client = crate::http_client_secs(30);
    let card = json!([{
        "type": "card",
        "theme": "primary",
        "size": "lg",
        "modules": [{
            "type": "section",
            "text": { "type": "kmarkdown", "content": text }
        }]
    }]);
    let endpoint = if is_dm {
        format!("{}/direct-message/create", KOOK_API_BASE)
    } else {
        format!("{}/message/create", KOOK_API_BASE)
    };
    let mut body = json!({
        "type": 10,
        "target_id": target_id,
        "content": serde_json::to_string(&card).unwrap(),
    });
    if let Some(q) = quote {
        body["quote"] = json!(q);
    }
    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send reply: {e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse reply response: {e}"))?;
    if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
        if code != 0 {
            let message = body
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("Reply API error ({code}): {message}"));
        }
    }
    Ok(())
}

impl Clone for KookGateway {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            agent: Arc::clone(&self.agent),
            store: Arc::clone(&self.store),
            team_id: self.team_id.clone(),
            primary_agent_actor_id: self.primary_agent_actor_id.clone(),
            agent_owner_actor_ids: self.agent_owner_actor_ids.clone(),
            workspace_path: self.workspace_path.clone(),
            shutdown_tx: Arc::clone(&self.shutdown_tx),
            status: Arc::clone(&self.status),
            is_running: Arc::clone(&self.is_running),
            ws_session_id: Arc::clone(&self.ws_session_id),
            last_sn: Arc::clone(&self.last_sn),
            processed_messages: Arc::clone(&self.processed_messages),
            bot_user_id: Arc::clone(&self.bot_user_id),
            inbound_sink: Arc::clone(&self.inbound_sink),
        }
    }
}

// ==================== Standalone HTTP Message Sender ====================

/// Send a KOOK message via HTTP API (for cron jobs, etc.)
pub async fn send_kook_message_http(
    token: &str,
    target_id: &str,
    content: &str,
    is_dm: bool,
) -> Result<(), String> {
    let client = crate::http_client_secs(30);

    let (endpoint, payload) = if is_dm {
        let url = format!("{}/direct-message/create", KOOK_API_BASE);
        let body = json!({
            "type": 1,
            "target_id": target_id,
            "content": content,
        });
        (url, body)
    } else {
        let url = format!("{}/message/create", KOOK_API_BASE);
        let body = json!({
            "type": 1,
            "target_id": target_id,
            "content": content,
        });
        (url, body)
    };

    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bot {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
        if code != 0 {
            let message = body
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("KOOK API error ({}): {}", code, message));
        }
    }

    Ok(())
}
