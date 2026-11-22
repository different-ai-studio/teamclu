use serde_json::{json, Value};

pub async fn handle(_workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        // The desktop reads the active team's gateway config. The workspace
        // file is not that config, and this tool does not open it.
        "get" => {
            let mut body = json!({});
            if let Some(channel) = arguments
                .get("channel")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                body["channel"] = json!(channel);
            }
            post_api(api_port, "/channel-get", &body).await
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

async fn post_api(api_port: u16, path: &str, body: &Value) -> Result<Value, String> {
    crate::desktop_api::post(api_port, path, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn test_get_missing_action() {
        let result = handle(".", 13144, &json!({})).await;
        assert!(result.unwrap_err().contains("Missing field: action"));
    }
}
