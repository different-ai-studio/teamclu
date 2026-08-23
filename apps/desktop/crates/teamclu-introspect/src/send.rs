use serde_json::{json, Value};

pub async fn handle(
    workspace: &str,
    api_port: u16,
    sock: &std::path::Path,
    arguments: &Value,
) -> Result<Value, String> {
    let message = arguments
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let target = arguments.get("target").and_then(|v| v.as_str());
    let file_path = arguments.get("file_path").and_then(|v| v.as_str());

    // A reply token addresses the chat this run is already talking to, and only
    // the daemon can resolve one (it is derived from a binding and salted with
    // the device id). Taking that branch first is also what keeps unattended
    // sends working: cron and gateway runs have a daemon but no desktop app,
    // and the `wecom` path below goes through the app's local API.
    if let Some(token) = arguments
        .get("reply_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        if message.is_empty() && file_path.is_none() {
            return Err("At least one of 'message' or 'file_path' is required.".to_string());
        }
        return crate::daemon_sock::send_via_daemon(
            sock.to_path_buf(),
            token.to_string(),
            (!message.is_empty()).then(|| message.to_string()),
            file_path.map(str::to_string),
            target.map(str::to_string),
            arguments
                .get("channel")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        )
        .await
        .map(|_| json!({ "content": [{ "type": "text", "text": "Message sent." }] }));
    }

    let channel = arguments
        .get("channel")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "Missing required parameter: channel (or pass 'reply_token' to reply to this chat)"
                .to_string()
        })?;

    // Read media file if provided
    let image_data = if let Some(path) = file_path {
        let bytes =
            std::fs::read(path).map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
        let filename = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.jpg")
            .to_string();
        Some((bytes, filename))
    } else {
        None
    };

    if message.is_empty() && image_data.is_none() {
        return Err("At least one of 'message' or 'file_path' is required.".to_string());
    }

    if channel == "all" {
        send_broadcast(workspace, api_port, message, target).await
    } else {
        send_single(
            workspace,
            api_port,
            channel,
            message,
            target,
            image_data.as_ref(),
        )
        .await
    }
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

async fn send_broadcast(
    workspace: &str,
    api_port: u16,
    message: &str,
    target: Option<&str>,
) -> Result<Value, String> {
    let config = crate::config::read_teamclu_config(workspace)?;
    let channels_val = config.get("channels").cloned().unwrap_or(json!({}));

    let channel_names = ["wecom", "discord", "feishu", "kook", "wechat", "seatalk"];
    let mut results = serde_json::Map::new();
    let mut sent_count = 0usize;
    let mut failed_count = 0usize;

    for name in channel_names {
        if !crate::capabilities::is_channel_bound_pub(name, &channels_val) {
            results.insert(
                name.to_string(),
                json!({"status": "skipped", "reason": "not bound"}),
            );
            continue;
        }

        match send_single(workspace, api_port, name, message, target, None).await {
            Ok(_) => {
                results.insert(name.to_string(), json!({"status": "ok"}));
                sent_count += 1;
            }
            Err(e) => {
                results.insert(name.to_string(), json!({"status": "error", "error": e}));
                failed_count += 1;
            }
        }
    }

    // email is never included in broadcast
    results.insert(
        "email".to_string(),
        json!({"status": "skipped", "reason": "email not supported in broadcast"}),
    );

    Ok(json!({
        "broadcast": true,
        "sent": sent_count,
        "failed": failed_count,
        "channels": Value::Object(results)
    }))
}

// ─── Single channel send ──────────────────────────────────────────────────────

async fn send_single(
    workspace: &str,
    api_port: u16,
    channel: &str,
    message: &str,
    target: Option<&str>,
    image_data: Option<&(Vec<u8>, String)>,
) -> Result<Value, String> {
    let config = crate::config::read_teamclu_config(workspace)?;
    let channels_val = config.get("channels").cloned().unwrap_or(json!({}));

    // Verify bound
    if channel != "email" && !crate::capabilities::is_channel_bound_pub(channel, &channels_val) {
        return Err(format!("Channel '{channel}' is not configured / bound"));
    }

    match channel {
        "discord" => send_discord(&channels_val, message, target).await,
        "feishu" => send_feishu(&channels_val, message, target).await,
        "kook" => send_kook(&channels_val, message, target).await,
        "wechat" => send_wechat(&channels_val, message, target).await,
        "wecom" => send_wecom(api_port, message, target, image_data).await,
        "email" => Err("Email sending from MCP is not yet supported.".to_string()),
        other => Err(format!("Unknown channel: {other}")),
    }
}

// ─── Discord ──────────────────────────────────────────────────────────────────

async fn send_discord(
    channels: &Value,
    message: &str,
    target: Option<&str>,
) -> Result<Value, String> {
    let ch = &channels["discord"];
    let token = ch
        .get("token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Discord token not configured")?;

    let tgt = target.unwrap_or("");

    let channel_id = if tgt.starts_with("dm:") {
        let user_id = tgt.strip_prefix("dm:").unwrap_or(tgt);
        discord_create_dm(token, user_id).await?
    } else if tgt.starts_with("channel:") {
        tgt.strip_prefix("channel:").unwrap_or(tgt).to_string()
    } else if !tgt.is_empty() {
        // Treat bare target as user ID → DM
        discord_create_dm(token, tgt).await.map_err(|e| {
            format!(
                "Could not create DM with '{tgt}': {e}. Use 'dm:<user_id>' or 'channel:<channel_id>' format."
            )
        })?
    } else {
        return Err(
            "Discord send requires a 'target' (dm:<user_id> or channel:<channel_id>)".to_string(),
        );
    };

    let chunks = split_message(message, 2000);
    let client = reqwest::Client::new();
    for chunk in &chunks {
        discord_send_message(&client, token, &channel_id, chunk).await?;
    }

    Ok(json!({
        "channel": "discord",
        "target": tgt,
        "chunks_sent": chunks.len()
    }))
}

async fn discord_create_dm(token: &str, user_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://discord.com/api/v10/users/@me/channels")
        .header("Authorization", format!("Bot {token}"))
        .json(&json!({"recipient_id": user_id}))
        .send()
        .await
        .map_err(|e| format!("Discord DM create request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Discord DM create failed ({status}): {body}"));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Discord DM create response parse failed: {e}"))?;

    data.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Discord DM create: no id in response".to_string())
}

async fn discord_send_message(
    client: &reqwest::Client,
    token: &str,
    channel_id: &str,
    content: &str,
) -> Result<(), String> {
    let url = format!("https://discord.com/api/v10/channels/{channel_id}/messages");
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bot {token}"))
        .json(&json!({"content": content}))
        .send()
        .await
        .map_err(|e| format!("Discord send request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Discord send failed ({status}): {body}"));
    }
    Ok(())
}

// ─── Feishu ───────────────────────────────────────────────────────────────────

async fn send_feishu(
    channels: &Value,
    message: &str,
    target: Option<&str>,
) -> Result<Value, String> {
    let ch = &channels["feishu"];
    let app_id = ch
        .get("appId")
        .or_else(|| ch.get("app_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Feishu appId not configured")?;
    let app_secret = ch
        .get("appSecret")
        .or_else(|| ch.get("app_secret"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Feishu appSecret not configured")?;

    let tgt = target.ok_or("Feishu send requires a 'target' (open_id, user_id, chat_id, etc.)")?;

    // Get tenant_access_token
    let access_token = feishu_get_tenant_access_token(app_id, app_secret).await?;
    let client = reqwest::Client::new();

    let chunks = split_message(message, 4000);
    for chunk in &chunks {
        feishu_send_message(&client, &access_token, tgt, chunk).await?;
    }

    Ok(json!({
        "channel": "feishu",
        "target": tgt,
        "chunks_sent": chunks.len()
    }))
}

async fn feishu_get_tenant_access_token(app_id: &str, app_secret: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&json!({"app_id": app_id, "app_secret": app_secret}))
        .send()
        .await
        .map_err(|e| format!("Feishu auth request failed: {e}"))?;

    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Feishu auth response parse failed: {e}"))?;

    let code = data.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = data
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Feishu auth failed (code={code}): {msg}"));
    }

    data.get("tenant_access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Feishu auth: no tenant_access_token in response".to_string())
}

async fn feishu_send_message(
    client: &reqwest::Client,
    token: &str,
    receive_id: &str,
    content: &str,
) -> Result<(), String> {
    // Determine receive_id_type heuristically:
    // chat IDs start with "oc_", open IDs start with "ou_", user IDs with "on_"
    let receive_id_type = if receive_id.starts_with("oc_") {
        "chat_id"
    } else if receive_id.starts_with("ou_") {
        "open_id"
    } else if receive_id.starts_with("on_") {
        "user_id"
    } else {
        "chat_id"
    };

    let url = format!(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}"
    );

    let body = json!({
        "receive_id": receive_id,
        "msg_type": "text",
        "content": serde_json::to_string(&json!({"text": content})).unwrap_or_default()
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Feishu send request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Feishu send failed ({status}): {text}"));
    }
    Ok(())
}

// ─── Kook ─────────────────────────────────────────────────────────────────────

async fn send_kook(channels: &Value, message: &str, target: Option<&str>) -> Result<Value, String> {
    let ch = &channels["kook"];
    let token = ch
        .get("token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("KOOK token not configured")?;

    let tgt =
        target.ok_or("KOOK send requires a 'target' (dm:<user_id> or channel:<channel_id>)")?;

    let (target_id, is_dm) = if tgt.starts_with("dm:") {
        (tgt.strip_prefix("dm:").unwrap_or(tgt), true)
    } else if tgt.starts_with("channel:") {
        (tgt.strip_prefix("channel:").unwrap_or(tgt), false)
    } else {
        // Default to DM
        (tgt, true)
    };

    let client = reqwest::Client::new();
    let chunks = split_message(message, 8000);

    for chunk in &chunks {
        kook_send_message(&client, token, target_id, chunk, is_dm).await?;
    }

    Ok(json!({
        "channel": "kook",
        "target": tgt,
        "chunks_sent": chunks.len()
    }))
}

async fn kook_send_message(
    client: &reqwest::Client,
    token: &str,
    target_id: &str,
    content: &str,
    is_dm: bool,
) -> Result<(), String> {
    let url = if is_dm {
        "https://www.kookapp.cn/api/v3/direct-message/create"
    } else {
        "https://www.kookapp.cn/api/v3/message/create"
    };

    let body = if is_dm {
        json!({
            "target_id": target_id,
            "type": 1,
            "content": content
        })
    } else {
        json!({
            "target_id": target_id,
            "type": 1,
            "content": content
        })
    };

    let resp = client
        .post(url)
        .header("Authorization", format!("Bot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("KOOK send request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("KOOK send failed ({status}): {text}"));
    }
    Ok(())
}

// ─── WeChat ───────────────────────────────────────────────────────────────────

async fn send_wechat(
    channels: &Value,
    message: &str,
    target: Option<&str>,
) -> Result<Value, String> {
    let ch = &channels["wechat"];
    let bot_token = ch
        .get("botToken")
        .or_else(|| ch.get("bot_token"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("WeChat botToken not configured")?;
    let base_url = ch
        .get("baseUrl")
        .or_else(|| ch.get("base_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("https://ilinkai.weixin.qq.com");

    let tgt = target
        .ok_or("WeChat send requires a 'target' (the user identifier for context_token lookup)")?;

    // Look up context_token
    let context_token = ch
        .get("contextTokens")
        .or_else(|| ch.get("context_tokens"))
        .and_then(|v| v.get(tgt))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            format!(
                "No context_token for WeChat user '{tgt}'. The user must send a message to the gateway first."
            )
        })?;

    let client = reqwest::Client::new();
    wechat_send_text(&client, base_url, bot_token, tgt, message, context_token).await?;

    Ok(json!({
        "channel": "wechat",
        "target": tgt
    }))
}

async fn wechat_send_text(
    client: &reqwest::Client,
    base_url: &str,
    bot_token: &str,
    to_user: &str,
    content: &str,
    context_token: &str,
) -> Result<(), String> {
    let url = format!("{base_url}/ilink/bot/send_text_message");
    let body = json!({
        "botToken": bot_token,
        "toUserName": to_user,
        "content": content,
        "contextToken": context_token
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("WeChat send request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("WeChat send failed ({status}): {text}"));
    }
    Ok(())
}

// ─── WeCom ────────────────────────────────────────────────────────────────────

async fn send_wecom(
    api_port: u16,
    message: &str,
    target: Option<&str>,
    image_data: Option<&(Vec<u8>, String)>,
) -> Result<Value, String> {
    use base64::Engine as _;

    let tgt = target.unwrap_or("");
    let url = format!("http://127.0.0.1:{api_port}/send-wecom");

    let mut body = json!({
        "target": tgt,
        "message": message
    });

    // Attach media file as base64 if provided
    if let Some((bytes, filename)) = image_data {
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        body["media_base64"] = json!(b64);
        body["media_filename"] = json!(filename);
    }

    let client = reqwest::Client::new();
    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        format!("WeCom internal API request failed: {e}. Is the TeamClu app running?")
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("WeCom send failed ({status}): {text}"));
    }

    Ok(json!({
        "channel": "wecom",
        "target": tgt,
        "media_sent": image_data.is_some()
    }))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Split `text` into chunks of at most `max_len` bytes, preferring newline
/// then space split points to avoid cutting mid-word.
pub fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a safe UTF-8 char boundary at or before max_len
        let mut split_at = max_len;
        while split_at > 0 && !remaining.is_char_boundary(split_at) {
            split_at -= 1;
        }

        // Prefer newline, then space
        let actual_split = remaining[..split_at]
            .rfind('\n')
            .or_else(|| remaining[..split_at].rfind(' '))
            .unwrap_or(split_at);

        if actual_split == 0 {
            chunks.push(remaining[..split_at].to_string());
            remaining = &remaining[split_at..];
        } else {
            chunks.push(remaining[..actual_split].to_string());
            remaining = remaining[actual_split..].trim_start();
        }
    }

    chunks
}
