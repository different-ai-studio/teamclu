use serde_json::{json, Value};

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        "list" => {
            let listings = teamclu_runtime_env::env_catalog::load_agent_env_listings(
                std::path::Path::new(workspace),
                None,
                None,
            );
            let entries: Vec<Value> = listings
                .into_iter()
                .map(|entry| {
                    let mut out = json!({ "key": entry.key });
                    if let Some(description) = entry.description {
                        out["description"] = json!(description);
                    }
                    if let Some(category) = entry.category {
                        out["category"] = json!(category);
                    }
                    out
                })
                .collect();
            Ok(json!({ "env_vars": entries }))
        }

        "set" => {
            let scope = arguments
                .get("scope")
                .and_then(|v| v.as_str())
                .unwrap_or("personal");
            let key = arguments
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: key")?;
            let value = arguments
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: value")?;
            let description = arguments.get("description").and_then(|v| v.as_str());
            let category = arguments.get("category").and_then(|v| v.as_str());
            let node_id = arguments
                .get("nodeId")
                .or_else(|| arguments.get("node_id"))
                .and_then(|v| v.as_str());

            let mut body = json!({
                "scope": scope,
                "key": key,
                "value": value,
            });
            if let Some(d) = description {
                body["description"] = json!(d);
            }
            if let Some(c) = category {
                body["category"] = json!(c);
            }
            if let Some(id) = node_id {
                body["nodeId"] = json!(id);
            }

            post_api(api_port, "/env-var-set", &body).await
        }

        "delete" => {
            let scope = arguments
                .get("scope")
                .and_then(|v| v.as_str())
                .unwrap_or("personal");
            let key = arguments
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: key")?;

            let mut body = json!({ "scope": scope, "key": key });
            if let Some(id) = arguments
                .get("nodeId")
                .or_else(|| arguments.get("node_id"))
                .and_then(|v| v.as_str())
            {
                body["nodeId"] = json!(id);
            }
            if let Some(role) = arguments.get("role").and_then(|v| v.as_str()) {
                body["role"] = json!(role);
            }

            post_api(api_port, "/env-var-delete", &body).await
        }

        unknown => Err(format!(
            "Unknown action: '{}'. Valid actions: list, set, delete",
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
    async fn test_set_missing_key() {
        let args = json!({ "action": "set", "value": "abc" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing field: key"));
    }

    #[tokio::test]
    async fn test_set_missing_value() {
        let args = json!({ "action": "set", "key": "MY_KEY" });
        let result = handle(".", 13144, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing field: value"));
    }
}
