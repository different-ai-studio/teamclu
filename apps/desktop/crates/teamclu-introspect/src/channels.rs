use crate::config;
use serde_json::{json, Value};

/// Fields that must never be returned to the AI (replace with "[configured]").
const SENSITIVE: &[(&str, &[&str])] = &[
    ("wecom", &["secret", "encodingAesKey"]),
    ("discord", &["token"]),
    ("feishu", &["appSecret"]),
    ("seatalk", &["appSecret"]),
    ("email", &["gmailClientSecret", "password"]),
    ("kook", &["token"]),
    ("wechat", &["botToken"]),
];

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        "get" => {
            let channel = arguments.get("channel").and_then(|v| v.as_str());
            get_channels(workspace, channel)
        }

        "set" => {
            let channel = arguments
                .get("channel")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: channel")?;
            let config = arguments.get("config").ok_or("Missing field: config")?;

            post_api(
                api_port,
                "/channel-set",
                &json!({ "channel": channel, "config": config }),
            )
            .await
        }

        unknown => Err(format!(
            "Unknown action: '{}'. Valid actions: get, set",
            unknown
        )),
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn get_channels(workspace: &str, channel: Option<&str>) -> Result<Value, String> {
    let cfg = config::read_teamclu_config(workspace)?;
    let empty = json!({});
    let channels = cfg.get("channels").unwrap_or(&empty);

    if let Some(name) = channel {
        let ch_cfg = channels.get(name).unwrap_or(&empty);
        Ok(json!({
            "channel": name,
            "bound": is_bound(name, channels),
            "config": redact(name, ch_cfg),
        }))
    } else {
        let all_channels = [
            "wecom", "discord", "feishu", "email", "kook", "wechat", "seatalk",
        ];
        let result: serde_json::Map<String, Value> = all_channels
            .iter()
            .map(|name| {
                let ch_cfg = channels.get(*name).unwrap_or(&empty);
                let v = json!({
                    "bound": is_bound(name, channels),
                    "config": redact(name, ch_cfg),
                });
                (name.to_string(), v)
            })
            .collect();
        Ok(Value::Object(result))
    }
}

/// Replace sensitive field values with "[configured]" if non-empty, remove if empty.
fn redact(channel: &str, config: &Value) -> Value {
    let Some(obj) = config.as_object() else {
        return config.clone();
    };

    let sensitive_keys: &[&str] = SENSITIVE
        .iter()
        .find(|(ch, _)| *ch == channel)
        .map(|(_, keys)| *keys)
        .unwrap_or(&[]);

    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        if sensitive_keys.contains(&k.as_str()) {
            // Only include if non-empty string — indicate it's configured without revealing value
            let is_set = v.as_str().map(|s| !s.is_empty()).unwrap_or(false);
            if is_set {
                out.insert(k.clone(), json!("[configured]"));
            }
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

fn is_bound(name: &str, channels: &Value) -> bool {
    use crate::capabilities::is_channel_bound_pub;
    is_channel_bound_pub(name, channels)
}

async fn post_api(api_port: u16, path: &str, body: &Value) -> Result<Value, String> {
    crate::desktop_api::post(api_port, path, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_wecom() {
        let cfg = json!({ "botId": "bot123", "secret": "mysecret", "ownerId": "user1" });
        let result = redact("wecom", &cfg);
        assert_eq!(result["botId"], "bot123");
        assert_eq!(result["ownerId"], "user1");
        assert_eq!(result["secret"], "[configured]");
    }

    #[test]
    fn test_redact_empty_secret_omitted() {
        let cfg = json!({ "botId": "bot123", "secret": "" });
        let result = redact("wecom", &cfg);
        assert_eq!(result["botId"], "bot123");
        assert!(result.get("secret").is_none());
    }

    #[test]
    fn test_redact_discord() {
        let cfg = json!({ "token": "abc123", "dm": { "enabled": true } });
        let result = redact("discord", &cfg);
        assert_eq!(result["token"], "[configured]");
        assert_eq!(result["dm"]["enabled"], true);
    }

    #[tokio::test]
    async fn test_unknown_action() {
        let args = json!({ "action": "nope" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown action"));
    }

    #[tokio::test]
    async fn test_set_missing_channel() {
        let args = json!({ "action": "set", "config": {} });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing field: channel"));
    }

    #[tokio::test]
    async fn test_set_missing_config() {
        let args = json!({ "action": "set", "channel": "wecom" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing field: config"));
    }
}
