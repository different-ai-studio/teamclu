use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};

use crate::feishu_config::{FeishuConfig, FeishuGatewayStatus, FeishuGatewayStatusResponse};

use crate::{
    AgentHandle, ChannelStore, FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES,
};

/// Feishu API base URL
const FEISHU_API_BASE: &str = "https://open.feishu.cn";

// ==================== Protobuf Frame Codec ====================
// Feishu WS uses a custom protobuf binary frame protocol (pbbp2).
// We implement manual encode/decode to avoid heavy proto codegen.

/// Frame header key-value pair (proto field 1=key, 2=value)
#[derive(Debug, Clone, Default)]
struct PbHeader {
    key: String,
    value: String,
}

/// WebSocket binary frame (proto: pbbp2.Frame)
#[derive(Debug, Clone, Default)]
struct PbFrame {
    seq_id: u64,              // field 1, varint
    log_id: u64,              // field 2, varint
    service: i32,             // field 3, varint
    method: i32,              // field 4, varint (0=control, 1=data)
    headers: Vec<PbHeader>,   // field 5, repeated
    payload_encoding: String, // field 6
    payload_type: String,     // field 7
    payload: Vec<u8>,         // field 8
    log_id_new: String,       // field 9
}

impl PbFrame {
    /// Get a header value by key
    fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    /// Get header as int
    #[allow(dead_code)]
    fn get_header_int(&self, key: &str) -> i32 {
        self.get_header(key)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }
}

// ---------- Protobuf encoding helpers ----------

fn encode_varint(buf: &mut Vec<u8>, mut val: u64) {
    loop {
        if val < 0x80 {
            buf.push(val as u8);
            return;
        }
        buf.push((val as u8 & 0x7F) | 0x80);
        val >>= 7;
    }
}

fn encode_tag(buf: &mut Vec<u8>, field: u32, wire_type: u32) {
    encode_varint(buf, ((field as u64) << 3) | wire_type as u64);
}

fn encode_varint_field(buf: &mut Vec<u8>, field: u32, val: u64) {
    encode_tag(buf, field, 0); // wire type 0 = varint
    encode_varint(buf, val);
}

fn encode_bytes_field(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
    encode_tag(buf, field, 2); // wire type 2 = length-delimited
    encode_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

fn encode_string_field(buf: &mut Vec<u8>, field: u32, s: &str) {
    encode_bytes_field(buf, field, s.as_bytes());
}

impl PbHeader {
    fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_string_field(&mut buf, 1, &self.key);
        encode_string_field(&mut buf, 2, &self.value);
        buf
    }
}

impl PbFrame {
    fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_varint_field(&mut buf, 1, self.seq_id);
        encode_varint_field(&mut buf, 2, self.log_id);
        encode_varint_field(&mut buf, 3, self.service as u64);
        encode_varint_field(&mut buf, 4, self.method as u64);
        for h in &self.headers {
            let h_bytes = h.encode();
            encode_bytes_field(&mut buf, 5, &h_bytes);
        }
        if !self.payload_encoding.is_empty() {
            encode_string_field(&mut buf, 6, &self.payload_encoding);
        }
        if !self.payload_type.is_empty() {
            encode_string_field(&mut buf, 7, &self.payload_type);
        }
        if !self.payload.is_empty() {
            encode_bytes_field(&mut buf, 8, &self.payload);
        }
        if !self.log_id_new.is_empty() {
            encode_string_field(&mut buf, 9, &self.log_id_new);
        }
        buf
    }
}

// ---------- Protobuf decoding helpers ----------

fn decode_varint(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        if *pos >= data.len() {
            return Err("unexpected EOF in varint".to_string());
        }
        let b = data[*pos];
        *pos += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if b < 0x80 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint too long".to_string());
        }
    }
}

fn decode_bytes<'a>(data: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let len = decode_varint(data, pos)? as usize;
    if *pos + len > data.len() {
        return Err("unexpected EOF in bytes field".to_string());
    }
    let result = &data[*pos..*pos + len];
    *pos += len;
    let _ = result.len();
    Ok(result)
}

fn decode_string(data: &[u8], pos: &mut usize) -> Result<String, String> {
    let bytes = decode_bytes(data, pos)?;
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("invalid utf8: {}", e))
}

impl PbHeader {
    fn decode(data: &[u8]) -> Result<Self, String> {
        let mut pos = 0;
        let mut header = PbHeader::default();
        while pos < data.len() {
            let tag = decode_varint(data, &mut pos)?;
            let field = (tag >> 3) as u32;
            let wire = (tag & 0x7) as u32;
            match (field, wire) {
                (1, 2) => header.key = decode_string(data, &mut pos)?,
                (2, 2) => header.value = decode_string(data, &mut pos)?,
                (_, 0) => {
                    decode_varint(data, &mut pos)?;
                }
                (_, 2) => {
                    decode_bytes(data, &mut pos)?;
                }
                _ => return Err(format!("unexpected wire type {} for field {}", wire, field)),
            }
        }
        Ok(header)
    }
}

impl PbFrame {
    fn decode(data: &[u8]) -> Result<Self, String> {
        let mut pos = 0;
        let mut frame = PbFrame::default();
        while pos < data.len() {
            let tag = decode_varint(data, &mut pos)?;
            let field = (tag >> 3) as u32;
            let wire = (tag & 0x7) as u32;
            match (field, wire) {
                (1, 0) => frame.seq_id = decode_varint(data, &mut pos)?,
                (2, 0) => frame.log_id = decode_varint(data, &mut pos)?,
                (3, 0) => frame.service = decode_varint(data, &mut pos)? as i32,
                (4, 0) => frame.method = decode_varint(data, &mut pos)? as i32,
                (5, 2) => {
                    let h_bytes = decode_bytes(data, &mut pos)?;
                    frame.headers.push(PbHeader::decode(h_bytes)?);
                }
                (6, 2) => frame.payload_encoding = decode_string(data, &mut pos)?,
                (7, 2) => frame.payload_type = decode_string(data, &mut pos)?,
                (8, 2) => frame.payload = decode_bytes(data, &mut pos)?.to_vec(),
                (9, 2) => frame.log_id_new = decode_string(data, &mut pos)?,
                (_, 0) => {
                    decode_varint(data, &mut pos)?;
                }
                (_, 2) => {
                    decode_bytes(data, &mut pos)?;
                }
                (_, 1) => {
                    pos += 8;
                } // 64-bit
                (_, 5) => {
                    pos += 4;
                } // 32-bit
                _ => return Err(format!("unexpected wire type {} for field {}", wire, field)),
            }
        }
        Ok(frame)
    }
}

/// Create a Ping frame
fn new_ping_frame(service_id: i32) -> PbFrame {
    PbFrame {
        method: 0, // FrameTypeControl
        service: service_id,
        headers: vec![PbHeader {
            key: "type".to_string(),
            value: "ping".to_string(),
        }],
        ..Default::default()
    }
}

/// Create a response frame for an event
fn new_response_frame(original: &PbFrame, status_code: i32, biz_rt: &str) -> PbFrame {
    let mut headers: Vec<PbHeader> = original.headers.clone();
    headers.push(PbHeader {
        key: "biz_rt".to_string(),
        value: biz_rt.to_string(),
    });

    let resp_payload = serde_json::json!({
        "code": status_code,
        "headers": {},
        "data": null
    });

    PbFrame {
        seq_id: original.seq_id,
        log_id: original.log_id,
        service: original.service,
        method: original.method,
        headers,
        payload_encoding: original.payload_encoding.clone(),
        payload_type: original.payload_type.clone(),
        payload: resp_payload.to_string().into_bytes(),
        log_id_new: original.log_id_new.clone(),
    }
}

// ==================== Token Manager ====================

/// Token manager for Feishu app access token with auto-refresh
struct TokenManager {
    app_id: String,
    app_secret: String,
    token: Arc<RwLock<Option<String>>>,
    expires_at: Arc<RwLock<u64>>,
}

impl TokenManager {
    fn new(app_id: &str, app_secret: &str) -> Self {
        Self {
            app_id: app_id.to_string(),
            app_secret: app_secret.to_string(),
            token: Arc::new(RwLock::new(None)),
            expires_at: Arc::new(RwLock::new(0)),
        }
    }

    /// Get a valid access token, refreshing if necessary
    #[allow(dead_code)]
    async fn get_token(&self) -> Result<String, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let expires_at = *self.expires_at.read().await;
        if let Some(token) = self.token.read().await.as_ref() {
            if now + 300 < expires_at {
                return Ok(token.clone());
            }
        }
        self.refresh_token().await
    }

    /// Refresh the app access token (used for WebSocket auth)
    async fn refresh_token(&self) -> Result<String, String> {
        let client = crate::http_client_secs(30);
        let url = format!(
            "{}/open-apis/auth/v3/app_access_token/internal",
            FEISHU_API_BASE
        );

        println!("[Feishu] Refreshing app_access_token...");
        let response = client
            .post(&url)
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&serde_json::json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to request token: {}", e))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse token response: {}", e))?;

        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = body["msg"].as_str().unwrap_or("Unknown error");
            return Err(format!("Feishu token error (code {}): {}", code, msg));
        }

        let token = body["app_access_token"]
            .as_str()
            .ok_or("No app_access_token in response")?
            .to_string();
        let expire = body["expire"].as_u64().unwrap_or(7200);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        *self.token.write().await = Some(token.clone());
        *self.expires_at.write().await = now + expire;

        println!("[Feishu] Token refreshed, expires in {} seconds", expire);
        Ok(token)
    }

    /// Also get a tenant_access_token for API calls (sending messages, etc.)
    async fn get_tenant_token(&self) -> Result<String, String> {
        let client = crate::http_client_secs(30);
        let url = format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            FEISHU_API_BASE
        );

        let response = client
            .post(&url)
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&serde_json::json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to request tenant token: {}", e))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse tenant token response: {}", e))?;

        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = body["msg"].as_str().unwrap_or("Unknown error");
            return Err(format!(
                "Feishu tenant token error (code {}): {}",
                code, msg
            ));
        }

        body["tenant_access_token"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No tenant_access_token in response".to_string())
    }
}

// ==================== Feishu Gateway ====================

/// Feishu gateway manager
pub struct FeishuGateway {
    config: Arc<RwLock<FeishuConfig>>,
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<FeishuGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    /// Set by the daemon to route inbound messages through the core pipeline;
    /// absent keeps the inline handler. See the WeCom field of the same name.
    inbound_sink: Arc<RwLock<Option<Arc<dyn crate::driver::InboundSink>>>>,
}

impl FeishuGateway {
    pub fn new(
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(FeishuConfig::default())),
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(FeishuGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            inbound_sink: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_config(&self, config: FeishuConfig) {
        *self.config.write().await = config;
    }

    /// Route inbound messages through the core pipeline. Set by the daemon at
    /// boot; unset leaves the pre-driver path.
    pub async fn use_core_pipeline(&self, sink: Arc<dyn crate::driver::InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    /// A driver for the core to render replies through.
    pub async fn as_driver(&self) -> FeishuDriver {
        let cfg = self.config.read().await.clone();
        FeishuDriver::new(cfg.app_id, cfg.app_secret)
    }

    pub async fn get_status(&self) -> FeishuGatewayStatusResponse {
        self.status.read().await.clone()
    }

    pub async fn start(&self) -> Result<(), String> {
        let config = self.config.read().await.clone();

        if !config.enabled {
            return Err("Feishu is not enabled".to_string());
        }
        if config.app_id.is_empty() || config.app_secret.is_empty() {
            return Err("Feishu app_id and app_secret are required".to_string());
        }

        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Err("Feishu gateway is already running".to_string());
            }
            *is_running = true;
        }

        {
            let mut status = self.status.write().await;
            status.status = FeishuGatewayStatus::Connecting;
            status.app_id = Some(config.app_id.clone());
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // Read once at start: switching pipelines mid-connection would leave
        // half a conversation on each path.
        let inbound_sink = self.inbound_sink.read().await.clone();
        let config_arc = Arc::clone(&self.config);
        let status_arc = Arc::clone(&self.status);
        let is_running_arc = Arc::clone(&self.is_running);
        let agent = Arc::clone(&self.agent);
        let store = Arc::clone(&self.store);
        let team_id = self.team_id.clone();
        let primary_agent_actor_id = self.primary_agent_actor_id.clone();
        let agent_owner_actor_ids = self.agent_owner_actor_ids.clone();

        tokio::spawn(async move {
            let result = run_feishu_gateway(
                config_arc,
                status_arc.clone(),
                agent,
                store,
                team_id,
                primary_agent_actor_id,
                agent_owner_actor_ids,
                inbound_sink,
                shutdown_rx,
            )
            .await;

            if let Err(e) = result {
                eprintln!("[Feishu] Gateway error: {}", e);
                let mut status = status_arc.write().await;
                *status = FeishuGatewayStatusResponse {
                    status: FeishuGatewayStatus::Error,
                    error_message: Some(e),
                    app_id: None,
                };
            }

            *is_running_arc.write().await = false;
            println!("[Feishu] Gateway stopped, is_running set to false");
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        if !*self.is_running.read().await {
            return Err("Feishu gateway is not running".to_string());
        }

        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());

            // Wait for the spawned task to finish (is_running becomes false)
            for _ in 0..50 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                if !*self.is_running.read().await {
                    break;
                }
            }

            // Force reset state in case the wait timed out
            {
                let mut is_running = self.is_running.write().await;
                *is_running = false;
            }
            {
                let mut status = self.status.write().await;
                *status = FeishuGatewayStatusResponse::default();
            }
            println!("[Feishu] Gateway fully stopped");
            Ok(())
        } else {
            *self.is_running.write().await = false;
            Err("Feishu gateway shutdown channel not found".to_string())
        }
    }

    pub async fn test_credentials(app_id: &str, app_secret: &str) -> Result<String, String> {
        let tm = TokenManager::new(app_id, app_secret);
        tm.refresh_token().await?;
        Ok("Credentials valid".to_string())
    }

    /// Consuming shutdown used by the amuxd channel manager.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[Feishu] shutdown: {e}");
        }
    }
}

impl Clone for FeishuGateway {
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
            // Shared, not copied: wiring the pipeline on one handle has to be
            // visible to every clone, or a clone starts on the inline path.
            inbound_sink: Arc::clone(&self.inbound_sink),
        }
    }
}

// ==================== Gateway Main Loop ====================

/// Get the WebSocket endpoint URL from Feishu API
/// Uses AppID + AppSecret in body (no bearer token), matching Go SDK behavior.
async fn get_ws_endpoint(app_id: &str, app_secret: &str) -> Result<(String, i32), String> {
    let client = crate::http_client_secs(30);
    let url = format!("{}/callback/ws/endpoint", FEISHU_API_BASE);

    println!("[Feishu] Getting WS endpoint from: {}", url);
    let response = client
        .post(&url)
        .header("locale", "zh")
        .json(&serde_json::json!({
            "AppID": app_id,
            "AppSecret": app_secret
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to get WS endpoint: {}", e))?;

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse WS endpoint response: {}", e))?;

    let code = body["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = body["msg"].as_str().unwrap_or("Unknown error");
        return Err(format!("Feishu WS endpoint error (code {}): {}", code, msg));
    }

    let ws_url = body["data"]["URL"]
        .as_str()
        .ok_or("No URL in WS endpoint response")?
        .to_string();

    // Extract service_id from client config or URL
    let service_id = body["data"]["ClientConfig"]["ServiceID"]
        .as_i64()
        .unwrap_or(0) as i32;

    println!(
        "[Feishu] Got WS URL (service_id={}): {}...",
        service_id,
        &ws_url[..ws_url.len().min(80)]
    );
    Ok((ws_url, service_id))
}

/// Bundle of state passed to spawned message handler tasks.
///
/// The agent / store / actor fields are inert since the inline turn path went
/// away — the core owns all of that now. They stay only because the caller
/// still threads them in; dropping them means reshaping `FeishuGateway::new`
/// too, which is cleanup for its own commit (#933).
#[allow(dead_code)]
#[derive(Clone)]
struct HandlerContext {
    config: Arc<RwLock<FeishuConfig>>,
    agent: Arc<dyn AgentHandle>,
    store: Arc<dyn ChannelStore>,
    team_id: String,
    primary_agent_actor_id: String,
    agent_owner_actor_ids: Vec<String>,
    app_id: String,
    app_secret: String,
    /// When present, inbound messages go to the core pipeline instead of being
    /// handled inline. See the WeCom field of the same name.
    inbound_sink: Option<Arc<dyn crate::driver::InboundSink>>,
}

// ─── Feishu → InboundMessage ────────────────────────────────────────────────

/// What a Feishu bot can do.
///
/// `streaming_edit` is true because Feishu *can* edit a sent message
/// (`update_feishu_message`) — the inline path simply never used it, which is
/// why Feishu users see a reply appear all at once today. Routing through the
/// core turns that capability on without any new Feishu code.
///
/// `media_upload` stays false until the file/image upload APIs are wired: the
/// core then renders attachments as links rather than silently dropping them,
/// which is what happens now.
pub fn feishu_caps() -> crate::driver::ChannelCaps {
    crate::driver::ChannelCaps {
        streaming_edit: true,
        media_upload: false,
        interactive: false,
        threading: crate::driver::Threading::ReplyTo,
        // Feishu rejects oversized text bodies; the core splits above this.
        max_chars: 4000,
        // Same ten minutes as WeCom: same medium, same kind of task.
        turn_timeout_secs: 600,
    }
}

#[cfg(test)]
mod normalize_tests {
    use super::*;
    use serde_json::json;

    fn event(v: serde_json::Value) -> serde_json::Value {
        v
    }

    fn text_event(
        chat_type: &str,
        content: &str,
        mentions: serde_json::Value,
    ) -> serde_json::Value {
        event(json!({
            "sender": { "sender_type": "user", "sender_id": { "open_id": "ou-1" } },
            "message": {
                "message_id": "om-1",
                "chat_id": "oc-1",
                "chat_type": chat_type,
                "message_type": "text",
                "content": json!({ "text": content }).to_string(),
                "mentions": mentions,
            }
        }))
    }

    #[test]
    fn a_dm_becomes_a_direct_conversation_keyed_on_the_chat() {
        let msg = normalize_event(&text_event("p2p", "hello", json!([])), "cli_app").unwrap();
        assert_eq!(
            msg.conversation.kind,
            crate::driver::ConversationKind::Direct
        );
        assert_eq!(msg.conversation.id, "oc-1");
        assert_eq!(msg.conversation.bot_id.as_deref(), Some("cli_app"));
        assert_eq!(msg.sender.external_id, "ou-1");
        assert_eq!(msg.text, "hello");
        assert!(msg.addressed_to_bot);
    }

    #[test]
    fn a_group_message_without_a_mention_is_marked_unaddressed() {
        // Feishu's subscription usually filters these out, but that is
        // configuration — the guard has to be in the data, not in a hope.
        let msg = normalize_event(&text_event("group", "chatter", json!([])), "cli_app").unwrap();
        assert_eq!(
            msg.conversation.kind,
            crate::driver::ConversationKind::Group
        );
        assert!(!msg.addressed_to_bot);
    }

    #[test]
    fn a_group_message_with_a_mention_is_addressed() {
        let msg = normalize_event(
            &text_event("group", "@bot do it", json!([{ "key": "@_user_1" }])),
            "cli_app",
        )
        .unwrap();
        assert!(msg.addressed_to_bot);
    }

    #[test]
    fn the_bots_own_message_is_refused_because_it_would_loop() {
        let mut e = text_event("p2p", "echo", json!([]));
        e["sender"]["sender_type"] = json!("app");
        assert!(normalize_event(&e, "cli_app").is_none());
    }

    #[test]
    fn the_reply_context_is_the_message_being_answered() {
        // Feishu replies reference the original, which is what keeps the answer
        // threaded under it instead of loose in the chat.
        let msg = normalize_event(&text_event("p2p", "hi", json!([])), "cli_app").unwrap();
        assert_eq!(msg.reply_context.as_deref(), Some("om-1"));
    }

    #[test]
    fn a_media_message_is_reported_as_unusable_rather_than_as_empty_text() {
        // Feishu file support is not wired yet. Returning None lets the caller
        // say so; an empty-text message would look like the user sent nothing.
        let mut e = text_event("p2p", "", json!([]));
        e["message"]["message_type"] = json!("image");
        assert!(normalize_event(&e, "cli_app").is_none());
    }

    #[test]
    fn an_event_missing_its_ids_is_refused() {
        let mut e = text_event("p2p", "hi", json!([]));
        e["message"]["message_id"] = json!("");
        assert!(normalize_event(&e, "cli_app").is_none());
    }
}

/// Feishu as a transport driver.
///
/// Stateless apart from its credentials: replies address a message id, and
/// Feishu's own API is what holds the conversation together — unlike WeCom,
/// there is no per-connection sink to keep.
pub struct FeishuDriver {
    tokens: TokenManager,
    app_id: String,
    /// Message id → the reply we are editing, so `update` knows what to patch.
    /// Feishu's update API addresses the *reply's* id, not the original's.
    replies: tokio::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl FeishuDriver {
    pub fn new(app_id: String, app_secret: String) -> Self {
        Self {
            tokens: TokenManager::new(&app_id, &app_secret),
            app_id,
            replies: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    async fn token(&self) -> Result<String, crate::driver::DriverError> {
        self.tokens
            .get_tenant_token()
            .await
            .map_err(crate::driver::DriverError::Transport)
    }
}

#[async_trait::async_trait]
impl crate::driver::ChannelDriver for FeishuDriver {
    fn id(&self) -> crate::driver::ChannelId {
        "feishu"
    }

    fn caps(&self) -> crate::driver::ChannelCaps {
        feishu_caps()
    }

    fn binding(&self, conversation: &crate::driver::Conversation) -> String {
        // Same shape the inline path used, so an existing chat keeps resolving
        // to the session it already has.
        format!("feishu://{}/{}", self.app_id, conversation.id)
    }

    fn sender_urn(
        &self,
        _conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        format!("urn:feishu:user:{}", sender.external_id)
    }

    fn session_title(
        &self,
        conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        match conversation.kind {
            crate::driver::ConversationKind::Group => {
                format!("Feishu group: {}", conversation.id)
            }
            _ => format!("Feishu DM: {}", sender.external_id),
        }
    }

    async fn deliver(
        &self,
        to: &crate::driver::Conversation,
        reply_context: Option<&str>,
        msg: &crate::driver::OutboundMessage,
    ) -> Result<crate::driver::DeliveryId, crate::driver::DriverError> {
        let token = self.token().await?;

        // Feishu cannot upload files here yet (`media_upload: false`), so the
        // core has already degraded attachments into the text. Nothing is
        // dropped silently — but nothing is uploaded either, which is why the
        // capability says false.
        let text = if msg.text.trim().is_empty() {
            // The opening frame of a streaming reply. Feishu rejects an empty
            // body, so it carries the same placeholder WeCom shows.
            "💭 正在思考…"
        } else {
            msg.text.as_str()
        };

        match reply_context {
            Some(message_id) => {
                let reply_id = reply_feishu_message(&token, message_id, text)
                    .await
                    .map_err(crate::driver::DriverError::Transport)?;
                self.replies
                    .lock()
                    .await
                    .insert(reply_id.clone(), reply_id.clone());
                Ok(crate::driver::DeliveryId(reply_id))
            }
            None => {
                send_feishu_message(&token, &to.id, text)
                    .await
                    .map_err(crate::driver::DriverError::Transport)?;
                Ok(crate::driver::DeliveryId(format!("chat:{}", to.id)))
            }
        }
    }

    async fn update(
        &self,
        id: &crate::driver::DeliveryId,
        text: &str,
        end: Option<crate::driver::TurnEnd>,
    ) -> Result<(), crate::driver::DriverError> {
        let token = self.token().await?;
        update_feishu_message(&token, &id.0, text)
            .await
            .map_err(crate::driver::DriverError::Transport)?;
        if end.is_some() {
            self.replies.lock().await.remove(&id.0);
        }
        Ok(())
    }
}

/// Normalize a Feishu message event. Pure — no token, no network.
pub(crate) fn normalize_event(
    event: &serde_json::Value,
    bot_app_id: &str,
) -> Option<crate::driver::InboundMessage> {
    let sender = &event["sender"];
    // A bot's own message must never start a turn; that is a loop.
    if sender["sender_type"].as_str().unwrap_or("") == "app" {
        return None;
    }
    let sender_open_id = sender["sender_id"]["open_id"].as_str().unwrap_or("");

    let message = &event["message"];
    let message_id = message["message_id"].as_str().unwrap_or("");
    let chat_id = message["chat_id"].as_str().unwrap_or("");
    let chat_type = message["chat_type"].as_str().unwrap_or("");
    let msg_type = message["message_type"].as_str().unwrap_or("");
    if message_id.is_empty() || chat_id.is_empty() {
        return None;
    }

    let content_json: serde_json::Value =
        serde_json::from_str(message["content"].as_str().unwrap_or("{}")).unwrap_or_default();
    let text = match msg_type {
        "text" => content_json["text"].as_str().unwrap_or("").to_string(),
        "post" => extract_post_text(&content_json),
        // Media arrives as its own message type. Reported as unusable rather
        // than dropped silently, so the caller can say so.
        _ => return None,
    };
    let text = clean_at_mentions(&text);

    let kind = if chat_type == "group" {
        crate::driver::ConversationKind::Group
    } else {
        crate::driver::ConversationKind::Direct
    };
    // Feishu only delivers group messages that mention the bot, but the guard
    // is explicit: the subscription is configuration, not a guarantee.
    let addressed_to_bot = kind != crate::driver::ConversationKind::Group
        || message["mentions"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false);

    Some(crate::driver::InboundMessage {
        conversation: crate::driver::Conversation {
            channel: "feishu",
            bot_id: (!bot_app_id.is_empty()).then(|| bot_app_id.to_string()),
            kind,
            id: chat_id.to_string(),
        },
        sender: crate::driver::ExternalSender {
            external_id: sender_open_id.to_string(),
            display_name: String::new(),
            email: None,
        },
        external_message_id: message_id.to_string(),
        text,
        attachments: Vec::new(),
        addressed_to_bot,
        quoted_text: None,
        // Feishu replies reference the message being answered, which keeps the
        // reply threaded under it instead of loose in the chat.
        reply_context: Some(message_id.to_string()),
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_feishu_gateway(
    config: Arc<RwLock<FeishuConfig>>,
    status: Arc<RwLock<FeishuGatewayStatusResponse>>,
    agent: Arc<dyn AgentHandle>,
    store: Arc<dyn ChannelStore>,
    team_id: String,
    primary_agent_actor_id: String,
    agent_owner_actor_ids: Vec<String>,
    inbound_sink: Option<Arc<dyn crate::driver::InboundSink>>,
    mut shutdown_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let cfg = config.read().await.clone();
    let token_manager = TokenManager::new(&cfg.app_id, &cfg.app_secret);

    // Validate credentials first
    token_manager.refresh_token().await?;

    let ctx = HandlerContext {
        config: Arc::clone(&config),
        agent,
        store,
        team_id,
        primary_agent_actor_id,
        agent_owner_actor_ids,
        app_id: cfg.app_id.clone(),
        app_secret: cfg.app_secret.clone(),
        inbound_sink,
    };

    let processed_messages: Arc<RwLock<ProcessedMessageTracker>> = Arc::new(RwLock::new(
        ProcessedMessageTracker::new(MAX_PROCESSED_MESSAGES),
    ));

    let mut retry_delay = std::time::Duration::from_secs(1);
    let max_retry_delay = std::time::Duration::from_secs(60);

    loop {
        // Get WebSocket endpoint (uses AppID/AppSecret directly, no bearer token)
        let (ws_url, service_id) = match get_ws_endpoint(&cfg.app_id, &cfg.app_secret).await {
            Ok(result) => {
                retry_delay = std::time::Duration::from_secs(1);
                result
            }
            Err(e) => {
                println!("[Feishu] Failed to get WS endpoint: {}", e);
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        *status.write().await = FeishuGatewayStatusResponse::default();
                        return Ok(());
                    }
                    _ = tokio::time::sleep(retry_delay) => {}
                }
                retry_delay = (retry_delay * 2).min(max_retry_delay);
                continue;
            }
        };

        println!("[Feishu] Connecting to WebSocket...");
        let ws_result = tokio_tungstenite::connect_async(&ws_url).await;
        let ws_stream = match ws_result {
            Ok((stream, _)) => {
                println!("[Feishu] WebSocket connected");
                {
                    let mut s = status.write().await;
                    s.status = FeishuGatewayStatus::Connected;
                    s.error_message = None;
                    s.app_id = Some(cfg.app_id.clone());
                }
                retry_delay = std::time::Duration::from_secs(1);
                stream
            }
            Err(e) => {
                println!("[Feishu] WebSocket connection failed: {}", e);
                {
                    let mut s = status.write().await;
                    s.status = FeishuGatewayStatus::Connecting;
                    s.error_message = Some(format!("Connection failed: {}", e));
                }
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        *status.write().await = FeishuGatewayStatusResponse::default();
                        return Ok(());
                    }
                    _ = tokio::time::sleep(retry_delay) => {}
                }
                retry_delay = (retry_delay * 2).min(max_retry_delay);
                continue;
            }
        };

        let ws_result = handle_ws_connection(
            ws_stream,
            &ctx,
            &processed_messages,
            &mut shutdown_rx,
            service_id,
        )
        .await;

        match ws_result {
            Ok(WsExitReason::Shutdown) => {
                *status.write().await = FeishuGatewayStatusResponse::default();
                return Ok(());
            }
            Ok(WsExitReason::Disconnected) | Err(_) => {
                println!("[Feishu] Reconnecting...");
                {
                    let mut s = status.write().await;
                    s.status = FeishuGatewayStatus::Connecting;
                    s.error_message = Some("Reconnecting...".to_string());
                }
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        *status.write().await = FeishuGatewayStatusResponse::default();
                        return Ok(());
                    }
                    _ = tokio::time::sleep(retry_delay) => {}
                }
                retry_delay = (retry_delay * 2).min(max_retry_delay);
            }
        }
    }
}

#[derive(Debug)]
enum WsExitReason {
    Shutdown,
    Disconnected,
}

// ==================== WebSocket Connection Handler ====================

async fn handle_ws_connection(
    ws_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    ctx: &HandlerContext,
    processed_messages: &Arc<RwLock<ProcessedMessageTracker>>,
    shutdown_rx: &mut oneshot::Receiver<()>,
    service_id: i32,
) -> Result<WsExitReason, String> {
    use futures::sink::SinkExt;
    use futures::stream::StreamExt;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Spawn ping loop (send ping every 2 minutes, matching Go SDK)
    let ping_interval = std::time::Duration::from_secs(120);
    let (ping_shutdown_tx, mut ping_shutdown_rx) = oneshot::channel::<()>();

    // Use a channel to send messages from ping loop and handler
    let (send_tx, mut send_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let send_tx_ping = send_tx.clone();

    // Ping loop task
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut ping_shutdown_rx => {
                    println!("[Feishu] Ping loop stopped");
                    return;
                }
                _ = tokio::time::sleep(ping_interval) => {
                    let ping_frame = new_ping_frame(service_id);
                    let data = ping_frame.encode();
                    if send_tx_ping.send(data).await.is_err() {
                        return;
                    }
                    println!("[Feishu] Ping sent");
                }
            }
        }
    });

    // Send loop - forwards binary messages to WS
    let (ws_done_tx, mut ws_done_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = send_rx.recv() => {
                    match msg {
                        Some(data) => {
                            if ws_sender.send(WsMessage::Binary(data.into())).await.is_err() {
                                return;
                            }
                        }
                        None => return,
                    }
                }
                _ = &mut ws_done_rx => {
                    let _ = ws_sender.close().await;
                    return;
                }
            }
        }
    });

    let result = loop {
        tokio::select! {
            _ = &mut *shutdown_rx => {
                println!("[Feishu] Shutdown signal received");
                break Ok(WsExitReason::Shutdown);
            }
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(WsMessage::Binary(data))) => {
                        match PbFrame::decode(&data) {
                            Ok(frame) => {
                                handle_binary_frame(
                                    frame, ctx, processed_messages, &send_tx,
                                ).await;
                            }
                            Err(e) => {
                                println!("[Feishu] Failed to decode frame: {}", e);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Text(text))) => {
                        // Some Feishu implementations may send text frames
                        println!("[Feishu] Received text frame: {}", &text[..text.len().min(200)]);
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = send_tx.send(data.to_vec()).await; // send as pong
                    }
                    Some(Ok(WsMessage::Pong(_))) => {}
                    Some(Ok(WsMessage::Close(_))) => {
                        println!("[Feishu] WebSocket closed by server");
                        break Ok(WsExitReason::Disconnected);
                    }
                    Some(Ok(WsMessage::Frame(_))) => {}
                    Some(Err(e)) => {
                        println!("[Feishu] WebSocket error: {}", e);
                        break Err(format!("WebSocket error: {}", e));
                    }
                    None => {
                        println!("[Feishu] WebSocket stream ended");
                        break Ok(WsExitReason::Disconnected);
                    }
                }
            }
        }
    };

    // Cleanup
    let _ = ping_shutdown_tx.send(());
    let _ = ws_done_tx.send(());
    drop(send_tx);

    result
}

/// Handle a decoded protobuf binary frame
async fn handle_binary_frame(
    frame: PbFrame,
    ctx: &HandlerContext,
    processed_messages: &Arc<RwLock<ProcessedMessageTracker>>,
    send_tx: &tokio::sync::mpsc::Sender<Vec<u8>>,
) {
    let method = frame.method; // 0=control, 1=data
    let msg_type = frame.get_header("type").unwrap_or("").to_string();

    match method {
        0 => {
            // Control frame
            match msg_type.as_str() {
                "pong" => {
                    println!("[Feishu] Received pong");
                }
                _ => {
                    println!("[Feishu] Unknown control frame type: {}", msg_type);
                }
            }
        }
        1 => {
            // Data frame
            let message_id = frame.get_header("message_id").unwrap_or("").to_string();
            let trace_id = frame.get_header("trace_id").unwrap_or("").to_string();
            let start = std::time::Instant::now();

            println!(
                "[Feishu] Received data frame: type={}, message_id={}, trace_id={}",
                msg_type, message_id, trace_id
            );

            match msg_type.as_str() {
                "event" => {
                    // Payload is JSON event data
                    let payload_str = String::from_utf8_lossy(&frame.payload);
                    println!(
                        "[Feishu] Event payload: {}",
                        &payload_str[..payload_str.len().min(300)]
                    );

                    // Parse the event JSON
                    if let Ok(event_json) =
                        serde_json::from_slice::<serde_json::Value>(&frame.payload)
                    {
                        // Check for duplicate
                        let event_id = event_json["header"]["event_id"]
                            .as_str()
                            .unwrap_or(&message_id)
                            .to_string();

                        let is_dup = {
                            let mut tracker = processed_messages.write().await;
                            tracker.is_duplicate(&event_id)
                        };

                        // Send response frame back IMMEDIATELY to acknowledge the event
                        // (Feishu requires quick acknowledgment, or it will retry)
                        let elapsed = start.elapsed().as_millis().to_string();
                        let resp = new_response_frame(&frame, 200, &elapsed);
                        let _ = send_tx.send(resp.encode()).await;

                        if is_dup {
                            println!("[Feishu] Duplicate event {}, skipping", event_id);
                        } else {
                            let event_type = event_json["header"]["event_type"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();

                            if event_type == "im.message.receive_v1" {
                                // Spawn message handling as a separate task so we don't block the WS loop
                                let event_data = event_json["event"].clone();
                                let ctx_clone = ctx.clone();
                                tokio::spawn(async move {
                                    println!("[Feishu] Spawned message handler task");
                                    handle_message_event(&event_data, &ctx_clone).await;
                                    println!("[Feishu] Message handler task completed");
                                });
                            } else {
                                println!("[Feishu] Unhandled event type: {}", event_type);
                            }
                        }
                    } else {
                        // Failed to parse event JSON, still send ack
                        let elapsed = start.elapsed().as_millis().to_string();
                        let resp = new_response_frame(&frame, 200, &elapsed);
                        let _ = send_tx.send(resp.encode()).await;
                    }
                }
                _ => {
                    println!("[Feishu] Unknown data frame type: {}", msg_type);
                }
            }
        }
        _ => {
            println!("[Feishu] Unknown frame method: {}", method);
        }
    }
}

// ==================== Message Event Handler ====================

/// Handle an im.message.receive_v1 event
async fn handle_message_event(event: &serde_json::Value, ctx: &HandlerContext) {
    let Some(sink) = ctx.inbound_sink.clone() else {
        println!("[Feishu] no core pipeline wired; dropping event");
        return;
    };

    // The allowlist stays here, not in the core: it is per-channel config and
    // the core has no policy layer. Losing it with the inline handler would
    // have quietly opened the bot to every chat it is in.
    let chat_id = event["message"]["chat_id"].as_str().unwrap_or("");
    let sender_id = event["sender"]["sender_id"]["open_id"]
        .as_str()
        .unwrap_or("");
    let cfg = ctx.config.read().await.clone();
    match check_feishu_allowed(&cfg, chat_id, sender_id) {
        FilterResult::Allow => {}
        other => {
            println!("[Feishu] chat={chat_id} blocked by policy: {other:?}");
            return;
        }
    }

    match normalize_event(event, &ctx.app_id) {
        Some(inbound) => sink.accept(inbound).await,
        None => println!("[Feishu] Event carried nothing actionable; ignoring"),
    }
}

// ==================== Helpers ====================

fn check_feishu_allowed(config: &FeishuConfig, chat_id: &str, sender_id: &str) -> FilterResult {
    let chat_config = config.chats.get(chat_id).or_else(|| config.chats.get("*"));

    let chat_config = match chat_config {
        Some(c) => c,
        None => {
            if config.chats.is_empty() {
                return FilterResult::Allow;
            }
            return FilterResult::ChannelNotConfigured;
        }
    };

    if !chat_config.allow {
        return FilterResult::ChannelNotConfigured;
    }

    if !chat_config.users.is_empty()
        && !chat_config.users.contains(&sender_id.to_string())
        && !chat_config.users.contains(&"*".to_string())
    {
        return FilterResult::UserNotAllowed;
    }

    FilterResult::Allow
}

fn clean_at_mentions(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '@' {
            if chars.peek() == Some(&'_') {
                // Skip @_user_N or @_all mentions
                while let Some(&next) = chars.peek() {
                    if next == ' ' || next == '\n' {
                        break;
                    }
                    chars.next();
                }
            } else {
                result.push(c);
            }
        } else {
            result.push(c);
        }
    }
    result.trim().to_string()
}

fn extract_post_text(content: &serde_json::Value) -> String {
    let mut texts = Vec::new();
    if let Some(title) = content["title"].as_str() {
        if !title.is_empty() {
            texts.push(format!("{}\n", title));
        }
    }
    if let Some(content_arr) = content["content"].as_array() {
        for line in content_arr {
            if let Some(elements) = line.as_array() {
                for elem in elements {
                    match elem["tag"].as_str().unwrap_or("") {
                        "text" | "a" => {
                            if let Some(t) = elem["text"].as_str() {
                                texts.push(t.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            texts.push("\n".to_string());
        }
    }
    texts.join("").trim().to_string()
}

/// Reply to a Feishu message. Returns the reply message_id on success.
async fn reply_feishu_message(token: &str, message_id: &str, text: &str) -> Result<String, String> {
    let client = crate::http_client_secs(30);
    let url = format!(
        "{}/open-apis/im/v1/messages/{}/reply",
        FEISHU_API_BASE, message_id
    );
    let body = serde_json::json!({
        "content": serde_json::json!({"text": text}).to_string(),
        "msg_type": "text"
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reply: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Reply error (code {}): {}", code, msg));
    }
    let reply_msg_id = resp["data"]["message_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    println!(
        "[Feishu] Reply sent to {} (reply_id={})",
        message_id, reply_msg_id
    );
    Ok(reply_msg_id)
}

/// Update (edit) an existing Feishu card message content.
/// The message MUST have been sent as an interactive card; plain text messages cannot be updated.
async fn update_feishu_message(token: &str, message_id: &str, text: &str) -> Result<(), String> {
    let client = crate::http_client_secs(30);
    let url = format!(
        "{}/open-apis/im/v1/messages/{}",
        FEISHU_API_BASE, message_id
    );

    // Build a card with the text content (matching the card format used when sending)
    let card = build_simple_card(text, None);
    let body = serde_json::json!({
        "content": card.to_string(),
        "msg_type": "interactive"
    });

    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to update message: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Update error (code {}): {}", code, msg));
    }
    println!("[Feishu] Message {} updated", message_id);
    Ok(())
}

/// Build a simple Feishu interactive card JSON with text content.
/// Optionally set a card title.
fn build_simple_card(text: &str, title: Option<&str>) -> serde_json::Value {
    let elements = vec![serde_json::json!({
        "tag": "markdown",
        "content": text
    })];

    let mut card = serde_json::json!({
        "elements": elements
    });

    if let Some(t) = title {
        card["header"] = serde_json::json!({
            "title": {
                "tag": "plain_text",
                "content": t
            }
        });
    }

    card
}

/// Send a text message to a Feishu chat using app credentials.
/// Standalone utility — obtains a tenant token internally and sends the message.
/// Used by both the gateway and cron delivery.
pub async fn send_chat_message(
    app_id: &str,
    app_secret: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let tm = TokenManager::new(app_id, app_secret);
    let token = tm.get_tenant_token().await?;
    send_feishu_message(&token, chat_id, text).await
}

async fn send_feishu_message(token: &str, chat_id: &str, text: &str) -> Result<(), String> {
    let client = crate::http_client_secs(30);
    let url = format!(
        "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
        FEISHU_API_BASE
    );
    let body = serde_json::json!({
        "receive_id": chat_id,
        "content": serde_json::json!({"text": text}).to_string(),
        "msg_type": "text"
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Send error (code {}): {}", code, msg));
    }
    Ok(())
}
