//! Stamp `metadata.backend_session` on agent replies for thread fork anchors.

pub(crate) fn stamp_pi_backend_session_metadata(
    existing_metadata_json: &str,
    acp_session_id: &str,
    pi_leaf_id: Option<&str>,
) -> String {
    let session_path = acp_session_id
        .strip_prefix("pi:")
        .unwrap_or(acp_session_id);
    let mut root: serde_json::Value = serde_json::from_str(existing_metadata_json)
        .unwrap_or_else(|_| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let mut fork_point = serde_json::json!({
        "pi_session_path": session_path,
    });
    if let Some(leaf) = pi_leaf_id.filter(|s| !s.is_empty()) {
        fork_point["pi_leaf_id"] = serde_json::json!(leaf);
    }
    root["backend_session"] = serde_json::json!({
        "kind": "pi",
        "session_id": acp_session_id,
        "fork_point": fork_point,
    });
    root.to_string()
}

pub(crate) fn stamp_opencode_backend_session_metadata(
    existing_metadata_json: &str,
    acp_session_id: &str,
    opencode_message_id: Option<&str>,
) -> String {
    let mut root: serde_json::Value = serde_json::from_str(existing_metadata_json)
        .unwrap_or_else(|_| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let mut fork_point = serde_json::json!({});
    if let Some(msg_id) = opencode_message_id.filter(|s| !s.is_empty()) {
        fork_point["opencode_message_id"] = serde_json::json!(msg_id);
    }
    root["backend_session"] = serde_json::json!({
        "kind": "opencode",
        "session_id": acp_session_id,
        "fork_point": fork_point,
    });
    root.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_opencode_fork_point() {
        let out = stamp_opencode_backend_session_metadata(
            "{}",
            "ses_abc123",
            Some("msg_xyz"),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["backend_session"]["kind"], "opencode");
        assert_eq!(
            v["backend_session"]["fork_point"]["opencode_message_id"],
            "msg_xyz"
        );
    }

    #[test]
    fn stamps_pi_fork_point() {
        let out = stamp_pi_backend_session_metadata(
            "{}",
            "pi:/tmp/s.jsonl",
            Some("leaf-1"),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["backend_session"]["fork_point"]["pi_leaf_id"],
            "leaf-1"
        );
    }
}
