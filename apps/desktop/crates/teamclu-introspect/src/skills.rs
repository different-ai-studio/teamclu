use crate::daemon_sock;
use serde_json::{json, Value};

pub async fn handle(workspace: &str, sock: &std::path::Path, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .ok_or("Missing field: action")?;

    if !matches!(action, "create" | "update" | "get") {
        return Err("action must be create, update, or get".into());
    }

    if action == "create" || action == "update" {
        arguments
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .ok_or_else(|| "Missing field: slug".to_string())?;
        arguments
            .get("content")
            .and_then(Value::as_str)
            .filter(|content| !content.is_empty())
            .ok_or_else(|| "Missing field: content".to_string())?;
    }

    let mut payload = arguments.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("cmd".to_string(), json!("skills-manage"));
        obj.insert("workspace_path".to_string(), json!(workspace));
    }

    let raw = daemon_sock::skills_manage_via_daemon(sock.to_path_buf(), payload).await?;
    if raw.get("ok").and_then(Value::as_bool) == Some(false) {
        let code = raw
            .get("errorCode")
            .and_then(Value::as_str)
            .unwrap_or("skill_write_failed");
        let message = raw
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("skill operation failed");
        return Err(format!("{code}: {message}"));
    }
    raw.get("result")
        .cloned()
        .ok_or_else(|| "amuxd returned no result".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_unknown_action() {
        let args = json!({ "action": "delete" });
        let err = handle("/tmp/ws", std::path::Path::new("/no/sock"), &args)
            .await
            .unwrap_err();
        assert!(err.contains("create, update, or get"));
    }
}
