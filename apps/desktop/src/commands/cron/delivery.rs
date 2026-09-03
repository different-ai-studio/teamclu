use super::amuxd_client;
use super::types::DeliveryChannel;
use crate::commands::gateway;
use crate::commands::gateway::email_config::EmailConfig;

/// Manages delivery of cron job results to channels.
/// Delegates to gateway modules for actual sending — no reimplementation.
/// Most channels still read credentials from the workspace `.teamclu/teamclu.json`.
/// WeCom and SeaTalk are routed through the amuxd-owned gateway; WeCom also reads
/// ownerId from the daemon config dir when no explicit target is set.
#[derive(Debug, Clone)]
pub struct DeliveryManager {
    workspace_path: String,
}

impl DeliveryManager {
    pub fn new(workspace_path: String) -> Self {
        Self { workspace_path }
    }

    /// Send a notification through the specified channel.
    /// Reads fresh config from teamclu.json each time so channel setting changes
    /// are picked up without requiring a restart.
    pub async fn send_notification(
        &self,
        channel: &DeliveryChannel,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        // These two are amuxd-owned and carry their own credentials, so they
        // must not go through `read_teamclu_config` — a workspace without
        // `teamclu.json` would fail a delivery that needs nothing from it.
        match channel {
            DeliveryChannel::Wecom => return self.send_wecom(target, message).await,
            DeliveryChannel::Seatalk => return self.send_seatalk(target, message).await,
            _ => {}
        }

        let config = self.read_teamclu_config()?;
        match channel {
            DeliveryChannel::Discord => self.send_discord(&config, target, message).await,
            DeliveryChannel::Feishu => self.send_feishu(&config, target, message).await,
            DeliveryChannel::Email => self.send_email(&config, target, message).await,
            DeliveryChannel::Kook => self.send_kook(&config, target, message).await,
            DeliveryChannel::Wechat => self.send_wechat(&config, target, message).await,
            // Both returned above; an arm is still required for exhaustiveness.
            DeliveryChannel::Wecom | DeliveryChannel::Seatalk => Ok(()),
        }
    }

    /// Read the teamclu.json config file from workspace
    fn read_teamclu_config(&self) -> Result<serde_json::Value, String> {
        let path = format!(
            "{}/{}/{}",
            self.workspace_path,
            crate::commands::TEAMCLU_DIR,
            crate::commands::CONFIG_FILE_NAME
        );
        let content = std::fs::read_to_string(&path).map_err(|e| {
            format!(
                "Failed to read {}: {}",
                crate::commands::CONFIG_FILE_NAME,
                e
            )
        })?;
        serde_json::from_str(&content).map_err(|e| {
            format!(
                "Failed to parse {}: {}",
                crate::commands::CONFIG_FILE_NAME,
                e
            )
        })
    }

    // ==================== Discord ====================

    /// Send via Discord — delegates to gateway::discord utilities
    async fn send_discord(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let token = config["channels"]["discord"]["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                format!(
                    "Discord bot token not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;

        // Determine the Discord channel ID to send to
        let channel_id = if target.starts_with("dm:") {
            let user_id = target.strip_prefix("dm:").unwrap_or(target);
            println!("[Cron Delivery] Discord DM to user: {}", user_id);
            gateway::discord::create_dm_channel(token, user_id).await?
        } else if target.starts_with("channel:") {
            let ch_id = target
                .strip_prefix("channel:")
                .unwrap_or(target)
                .to_string();
            println!("[Cron Delivery] Discord channel: {}", ch_id);
            ch_id
        } else {
            // No prefix: assume user ID, try creating DM
            println!(
                "[Cron Delivery] Discord target '{}' without prefix, trying as DM",
                target
            );
            gateway::discord::create_dm_channel(token, target).await.map_err(|e| {
                format!(
                    "Could not create DM with '{}': {}. Use 'dm:<user_id>' or 'channel:<channel_id>' format.",
                    target, e
                )
            })?
        };

        // Split message if too long (Discord limit is 2000 chars)
        let chunks = split_message(message, 2000);
        for chunk in chunks {
            gateway::discord::send_channel_message(token, &channel_id, &chunk).await?;
        }

        println!("[Cron Delivery] Discord message sent to {}", target);
        Ok(())
    }

    // ==================== Feishu ====================

    /// Send via Feishu — delegates to gateway::feishu::send_chat_message
    async fn send_feishu(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let app_id = config["channels"]["feishu"]["appId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!(
                    "Feishu app ID not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;
        let app_secret = config["channels"]["feishu"]["appSecret"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!(
                    "Feishu app secret not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;

        let chunks = split_message(message, 4000);
        for chunk in chunks {
            gateway::feishu::send_chat_message(app_id, app_secret, target, &chunk).await?;
        }

        println!("[Cron Delivery] Feishu message sent to {}", target);
        Ok(())
    }

    // ==================== Email ====================

    /// Send via Email — delegates to gateway::email::send_notification_email.
    /// Properly handles Gmail OAuth2 (XOAUTH2) and custom SMTP.
    ///
    /// A reply to this mail does NOT come back to the job's session: nothing
    /// indexes the outgoing Message-ID. See the note in `send_notification_email`.
    async fn send_email(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let email_val = &config["channels"]["email"];
        if email_val.is_null() {
            return Err(format!(
                "Email not configured in {}",
                crate::commands::CONFIG_FILE_NAME
            ));
        }

        // Parse into the gateway's EmailConfig type (same struct used by the email gateway)
        let email_config: EmailConfig = serde_json::from_value(email_val.clone())
            .map_err(|e| format!("Failed to parse email config: {}", e))?;

        gateway::email::send_notification_email(
            &email_config,
            &self.workspace_path,
            target,
            "[TeamClu] Cron Job Notification",
            message,
        )
        .await
    }

    // ==================== Kook ====================

    /// Send via KOOK — delegates to gateway::kook::send_kook_message_http
    async fn send_kook(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let token = config["channels"]["kook"]["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                format!(
                    "KOOK bot token not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;

        let (target_id, is_dm) = if target.starts_with("dm:") {
            let user_id = target.strip_prefix("dm:").unwrap_or(target);
            println!("[Cron Delivery] KOOK DM to user: {}", user_id);
            (user_id.to_string(), true)
        } else if target.starts_with("channel:") {
            let ch_id = target
                .strip_prefix("channel:")
                .unwrap_or(target)
                .to_string();
            println!("[Cron Delivery] KOOK channel: {}", ch_id);
            (ch_id, false)
        } else {
            println!(
                "[Cron Delivery] KOOK target '{}' without prefix, trying as DM",
                target
            );
            (target.to_string(), true)
        };

        // KOOK message limit is ~8000 chars for text type
        let chunks = split_message(message, 8000);
        for chunk in chunks {
            gateway::kook::send_kook_message_http(token, &target_id, &chunk, is_dm).await?;
        }

        println!("[Cron Delivery] KOOK message sent to {}", target);
        Ok(())
    }

    // ==================== WeChat ====================

    /// Send via WeChat — delegates to gateway::wechat::send_text_message
    async fn send_wechat(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let bot_token = config["channels"]["wechat"]["botToken"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or("WeChat bot token not configured")?;
        let base_url = config["channels"]["wechat"]["baseUrl"]
            .as_str()
            .unwrap_or("https://ilinkai.weixin.qq.com");

        // Look up context_token from persisted config
        let context_token = config["channels"]["wechat"]["contextTokens"][target]
            .as_str()
            .ok_or_else(|| format!(
                "No context_token for WeChat user '{}'. The user must send a message to the gateway first.",
                target
            ))?;

        use crate::commands::gateway::wechat;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        wechat::send_text_message(&client, base_url, bot_token, target, message, context_token)
            .await
    }
    // ==================== WeCom ====================

    /// Send via WeCom through amuxd's running gateway (not the desktop process).
    /// Target format: "single:{userid}" or "group:{chatid}" or raw "{userid}"
    /// If target is empty, falls back to ownerId auto-recorded by the amuxd WeCom gateway.
    async fn send_wecom(&self, target: &str, message: &str) -> Result<(), String> {
        let dispatch_target = if target.is_empty() {
            format!("user:{}", self.resolve_wecom_owner_id()?)
        } else {
            wecom_cron_target_to_dispatch(target)?
        };

        let chunks = split_message(message, 4000);
        for chunk in chunks {
            amuxd_client::channel_send("wecom", &dispatch_target, &chunk).await?;
        }

        println!(
            "[Cron Delivery] WeCom message sent via amuxd to {}",
            dispatch_target
        );
        Ok(())
    }

    // ==================== SeaTalk ====================

    /// Send via SeaTalk through amuxd's running gateway.
    /// Target format: "single:{employee_code}" or "group:{group_id}" or raw employee_code.
    async fn send_seatalk(&self, target: &str, message: &str) -> Result<(), String> {
        let dispatch_target = seatalk_cron_target_to_dispatch(target)?;
        let chunks = split_message(message, 4000);
        for chunk in chunks {
            amuxd_client::channel_send("seatalk", &dispatch_target, &chunk).await?;
        }

        println!(
            "[Cron Delivery] SeaTalk message sent via amuxd to {}",
            dispatch_target
        );
        Ok(())
    }

    /// Resolve WeCom ownerId from amuxd's persisted gateway state, with a legacy
    /// fallback to the workspace teamclu.json for pre-migration installs.
    fn resolve_wecom_owner_id(&self) -> Result<String, String> {
        let daemon_root = crate::commands::amuxd_home_dir()
            .to_string_lossy()
            .into_owned();
        // The gateway's ChannelManager runs sessions in the team's own
        // worktree now, so that is where wecom.rs records ownerId; the home
        // root and the cron job's workspace stay as legacy fallbacks.
        let team_workspace = crate::commands::amuxd_active_team()
            .map(|t| {
                crate::commands::amuxd_team_workspace_dir(&t)
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_default();

        for root in [
            team_workspace.as_str(),
            daemon_root.as_str(),
            self.workspace_path.as_str(),
        ]
        .into_iter()
        .filter(|r| !r.is_empty())
        {
            let Ok(config) = gateway::read_config(root) else {
                continue;
            };
            if let Some(owner_id) = config
                .channels
                .as_ref()
                .and_then(|ch| ch.wecom.as_ref())
                .and_then(|w| w.owner_id.as_ref())
                .filter(|s| !s.is_empty())
            {
                return Ok(owner_id.clone());
            }
        }

        Err("No WeCom target specified and ownerId is not set. \
             Send a DM to the bot first so ownerId is auto-recorded."
            .to_string())
    }
}

/// Map cron UI target strings to amuxd `dispatch_send` shape.
fn wecom_cron_target_to_dispatch(target: &str) -> Result<String, String> {
    if let Some(id) = target.strip_prefix("single:") {
        return Ok(format!("user:{id}"));
    }
    if let Some(id) = target.strip_prefix("group:") {
        return Ok(format!("chat:{id}"));
    }
    if target.is_empty() {
        return Err("WeCom target is empty".into());
    }
    Ok(format!("user:{target}"))
}

/// Map SeaTalk cron UI targets (`single:` / `group:` / raw) to amuxd dispatch.
fn seatalk_cron_target_to_dispatch(target: &str) -> Result<String, String> {
    if let Some(id) = target.strip_prefix("single:") {
        if id.trim().is_empty() {
            return Err("SeaTalk employee_code is empty".into());
        }
        return Ok(format!("user:{id}"));
    }
    if let Some(id) = target.strip_prefix("group:") {
        if id.trim().is_empty() {
            return Err("SeaTalk group_id is empty".into());
        }
        return Ok(format!("chat:{id}"));
    }
    if target.trim().is_empty() {
        return Err("SeaTalk target is empty".into());
    }
    Ok(format!("user:{target}"))
}

#[cfg(test)]
mod tests {
    use super::{seatalk_cron_target_to_dispatch, wecom_cron_target_to_dispatch};

    #[test]
    fn maps_single_and_group_targets() {
        assert_eq!(
            wecom_cron_target_to_dispatch("single:alice").unwrap(),
            "user:alice"
        );
        assert_eq!(
            wecom_cron_target_to_dispatch("group:chat-1").unwrap(),
            "chat:chat-1"
        );
        assert_eq!(wecom_cron_target_to_dispatch("bob").unwrap(), "user:bob");
    }

    #[test]
    fn maps_seatalk_single_and_group_targets() {
        assert_eq!(
            seatalk_cron_target_to_dispatch("single:E001").unwrap(),
            "user:E001"
        );
        assert_eq!(
            seatalk_cron_target_to_dispatch("group:g-abc").unwrap(),
            "chat:g-abc"
        );
        assert_eq!(
            seatalk_cron_target_to_dispatch("E002").unwrap(),
            "user:E002"
        );
        assert!(seatalk_cron_target_to_dispatch("group:").is_err());
        assert!(seatalk_cron_target_to_dispatch("").is_err());
    }
}

/// Split a message into chunks, respecting UTF-8 character boundaries.
/// `max_len` is measured in bytes.
fn split_message(text: &str, max_len: usize) -> Vec<String> {
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

        // Find a safe byte boundary at or before max_len
        let mut split_at = max_len;
        // Walk backwards to a valid UTF-8 char boundary
        while split_at > 0 && !remaining.is_char_boundary(split_at) {
            split_at -= 1;
        }

        // Try to split at a newline within the safe range
        let actual_split = remaining[..split_at].rfind('\n').unwrap_or_else(|| {
            // Try to split at a space
            remaining[..split_at].rfind(' ').unwrap_or(split_at)
        });

        if actual_split == 0 {
            // Edge case: no good split point found, force split at char boundary
            chunks.push(remaining[..split_at].to_string());
            remaining = &remaining[split_at..];
        } else {
            chunks.push(remaining[..actual_split].to_string());
            remaining = remaining[actual_split..].trim_start();
        }
    }

    chunks
}
