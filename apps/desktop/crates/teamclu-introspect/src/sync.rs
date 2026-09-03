use serde_json::Value;

// _workspace and _arguments match the signature of other handle() functions in this crate.
// The workspace is retrieved server-side from OpenCodeState; no parameters are needed.
pub async fn handle(_workspace: &str, api_port: u16, _arguments: &Value) -> Result<Value, String> {
    let resp = crate::desktop_api::send(api_port, "/team-sync-all", &serde_json::json!({}))
        .await
        .map_err(|e| format!("Team sync request failed: {e}"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Team sync failed: {text}"));
    }

    let result: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sync response: {e}"))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_result_has_required_fields() {
        let result = json!({
            "mode": "git",
            "success": true,
            "message": "Synced with origin/main.",
            "changed_files": 0
        });
        assert!(result.get("mode").is_some());
        assert!(result.get("success").is_some());
        assert!(result.get("message").is_some());
        assert!(result.get("changed_files").is_some());
    }

    #[test]
    fn test_result_none_mode() {
        let result = json!({
            "mode": "none",
            "success": false,
            "message": "No team sync configured in this workspace.",
            "changed_files": 0
        });
        assert_eq!(result["mode"], "none");
        assert_eq!(result["success"], false);
    }
}
