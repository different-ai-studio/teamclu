//! Announce a run's result on a channel. Ported from the desktop's
//! `commands/cron/delivery.rs`.
//!
//! WeCom and SeaTalk go through the daemon's own running gateway
//! ([`CronExecutor::channel_send`]) and carry their own credentials. The other
//! channels read credentials from a `teamclu.json`: the job's workspace, or the
//! team workspace for a global job.

use std::sync::Arc;

use super::types::DeliveryChannel;
use super::CronExecutor;
use teamclu_gateway as gateway;
use teamclu_gateway::email_config::EmailConfig;

const CONFIG_FILE_NAME: &str = teamclu_gateway::CONFIG_FILE_NAME;

pub struct DeliveryManager {
    /// Where channel credentials are read from.
    config_root: String,
    executor: Arc<dyn CronExecutor>,
}

impl DeliveryManager {
    pub fn new(workspace_path: Option<String>, executor: Arc<dyn CronExecutor>) -> Self {
        let config_root = workspace_path
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| {
                crate::config::layout::team_workspace_dir(&crate::config::layout::active_team())
                    .to_string_lossy()
                    .into_owned()
            });
        Self {
            config_root,
            executor,
        }
    }

    /// Send a notification through the specified channel. Reads fresh config
    /// each time, so a channel settings change needs no restart.
    pub async fn send_notification(
        &self,
        channel: &DeliveryChannel,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        // amuxd-owned channels carry their own credentials: they must not
        // require a teamclu.json the workspace may not have.
        match channel {
            DeliveryChannel::Wecom => return self.send_wecom(target, message).await,
            DeliveryChannel::Seatalk => return self.send_seatalk(target, message).await,
            _ => {}
        }

        // The remaining senders read credentials from the workspace file,
        // which settings no longer writes: a channel set up there has nothing
        // here to send with. Say that, rather than "failed to read
        // teamclu.json" or "token not configured" about a channel the user
        // can see is configured.
        let config = self.read_teamclu_config().unwrap_or_default();
        let key = legacy_channel_key(channel);
        let present = config
            .get("channels")
            .and_then(|c| c.get(key))
            .is_some_and(|c| c.as_object().is_some_and(|o| !o.is_empty()));
        if !present {
            return Err(format!(
                "Scheduled delivery to {key} is not available: only WeCom and SeaTalk \
                 can be delivered to. Change this job's delivery channel."
            ));
        }
        match channel {
            DeliveryChannel::Discord => self.send_discord(&config, target, message).await,
            DeliveryChannel::Feishu => self.send_feishu(&config, target, message).await,
            DeliveryChannel::Email => self.send_email(&config, target, message).await,
            DeliveryChannel::Kook => self.send_kook(&config, target, message).await,
            DeliveryChannel::Wechat => self.send_wechat(&config, target, message).await,
            DeliveryChannel::Wecom | DeliveryChannel::Seatalk => Ok(()),
        }
    }

    fn read_teamclu_config(&self) -> Result<serde_json::Value, String> {
        gateway::read_config_value(&self.config_root)
            .map_err(|e| format!("{CONFIG_FILE_NAME} in {}: {e}", self.config_root))
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
            .ok_or_else(|| format!("Discord bot token not configured in {}", CONFIG_FILE_NAME))?;

        // Determine the Discord channel ID to send to
        let channel_id = if target.starts_with("dm:") {
            let user_id = target.strip_prefix("dm:").unwrap_or(target);
            tracing::info!("[Cron Delivery] Discord DM to user: {}", user_id);
            gateway::discord::create_dm_channel(token, user_id).await?
        } else if target.starts_with("channel:") {
            let ch_id = target
                .strip_prefix("channel:")
                .unwrap_or(target)
                .to_string();
            tracing::info!("[Cron Delivery] Discord channel: {}", ch_id);
            ch_id
        } else {
            // No prefix: assume user ID, try creating DM
            tracing::info!(
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

        tracing::info!("[Cron Delivery] Discord message sent to {}", target);
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
            .ok_or_else(|| format!("Feishu app ID not configured in {}", CONFIG_FILE_NAME))?;
        let app_secret = config["channels"]["feishu"]["appSecret"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Feishu app secret not configured in {}", CONFIG_FILE_NAME))?;

        let chunks = split_message(message, 4000);
        for chunk in chunks {
            gateway::feishu::send_chat_message(app_id, app_secret, target, &chunk).await?;
        }

        tracing::info!("[Cron Delivery] Feishu message sent to {}", target);
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
            return Err(format!("Email not configured in {}", CONFIG_FILE_NAME));
        }

        // Parse into the gateway's EmailConfig type (same struct used by the email gateway)
        let email_config: EmailConfig = serde_json::from_value(email_val.clone())
            .map_err(|e| format!("Failed to parse email config: {}", e))?;

        gateway::email::send_notification_email(
            &email_config,
            &self.config_root,
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
            .ok_or_else(|| format!("KOOK bot token not configured in {}", CONFIG_FILE_NAME))?;

        let (target_id, is_dm) = if target.starts_with("dm:") {
            let user_id = target.strip_prefix("dm:").unwrap_or(target);
            tracing::info!("[Cron Delivery] KOOK DM to user: {}", user_id);
            (user_id.to_string(), true)
        } else if target.starts_with("channel:") {
            let ch_id = target
                .strip_prefix("channel:")
                .unwrap_or(target)
                .to_string();
            tracing::info!("[Cron Delivery] KOOK channel: {}", ch_id);
            (ch_id, false)
        } else {
            tracing::info!(
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

        tracing::info!("[Cron Delivery] KOOK message sent to {}", target);
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

        use teamclu_gateway::wechat;
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
            self.executor
                .channel_send("wecom", &dispatch_target, &chunk)
                .await?;
        }

        tracing::info!(
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
            self.executor
                .channel_send("seatalk", &dispatch_target, &chunk)
                .await?;
        }

        tracing::info!(
            "[Cron Delivery] SeaTalk message sent via amuxd to {}",
            dispatch_target
        );
        Ok(())
    }

    /// Resolve WeCom ownerId from amuxd's persisted gateway state, with a legacy
    /// fallback to the workspace teamclu.json for pre-migration installs.
    fn resolve_wecom_owner_id(&self) -> Result<String, String> {
        let daemon_root = crate::config::layout::root().to_string_lossy().into_owned();
        let team = crate::config::layout::active_team();
        let team_workspace = if team == crate::config::layout::UNCLAIMED_TEAM {
            String::new()
        } else {
            crate::config::layout::team_workspace_dir(&team)
                .to_string_lossy()
                .into_owned()
        };

        for root in [
            team_workspace.as_str(),
            daemon_root.as_str(),
            self.config_root.as_str(),
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

/// The `channels.<key>` name a delivery channel's credentials sit under in the
/// workspace config.
fn legacy_channel_key(channel: &DeliveryChannel) -> &'static str {
    match channel {
        DeliveryChannel::Discord => "discord",
        DeliveryChannel::Feishu => "feishu",
        DeliveryChannel::Email => "email",
        DeliveryChannel::Kook => "kook",
        DeliveryChannel::Wechat => "wechat",
        DeliveryChannel::Wecom => "wecom",
        DeliveryChannel::Seatalk => "seatalk",
    }
}

/// Map SeaTalk cron UI targets (`single:` / `group:` / raw, optional
/// `bot:<app_id>/` prefix) to amuxd dispatch.
pub(crate) fn seatalk_cron_target_to_dispatch(target: &str) -> Result<String, String> {
    let (prefix, body) = match target.strip_prefix("bot:") {
        Some(rest) => {
            let (app, rest) = rest.split_once('/').ok_or_else(|| {
                "SeaTalk target must be bot:<app_id>/single:<id> or bot:<app_id>/group:<id>"
                    .to_string()
            })?;
            if app.trim().is_empty() {
                return Err("SeaTalk app id is empty".into());
            }
            (Some(app), rest)
        }
        None => (None, target),
    };
    let mapped = if let Some(id) = body.strip_prefix("single:") {
        if id.trim().is_empty() {
            return Err("SeaTalk employee_code is empty".into());
        }
        format!("user:{id}")
    } else if let Some(id) = body.strip_prefix("group:") {
        if id.trim().is_empty() {
            return Err("SeaTalk group_id is empty".into());
        }
        format!("chat:{id}")
    } else if body.trim().is_empty() {
        return Err("SeaTalk target is empty".into());
    } else {
        format!("user:{body}")
    };
    Ok(match prefix {
        Some(app) => format!("bot:{app}/{mapped}"),
        None => mapped,
    })
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
        assert_eq!(
            seatalk_cron_target_to_dispatch("bot:app-1/single:E001").unwrap(),
            "bot:app-1/user:E001"
        );
        assert_eq!(
            seatalk_cron_target_to_dispatch("bot:app-1/group:g-abc").unwrap(),
            "bot:app-1/chat:g-abc"
        );
    }
}
