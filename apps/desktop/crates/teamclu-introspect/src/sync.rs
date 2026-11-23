use serde_json::Value;

// _workspace and _arguments match the signature of other handle() functions in this crate.
// The desktop resolves the current workspace itself and asks the daemon to
// sync the team; no parameters are needed.
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
