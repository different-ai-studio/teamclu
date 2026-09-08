use serde_json::{json, Value};

/// Self-only team Skill management. There is deliberately no actor_id argument:
/// this process talks only to its local daemon, whose Cloud token is the
/// subject of every mutation. This also works on a headless remote host where
/// the desktop introspection bridge is not running.
pub async fn handle(_api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("list");
    if !matches!(
        action,
        "list" | "install" | "uninstall" | "get_draft" | "update_draft"
    ) {
        return Err("action must be list, install, uninstall, get_draft, or update_draft".into());
    }
    let slug = arguments
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|slug| !slug.is_empty());
    if action != "list" && slug.is_none() {
        return Err("Missing field: slug".to_string());
    }
    let slug = slug.unwrap_or_default();

    let (method, path, scopes, body) = match action {
        "list" => (
            reqwest::Method::GET,
            "/v1/team/skills".to_string(),
            vec!["workspace:read"],
            None,
        ),
        "install" => {
            let version = arguments
                .get("version")
                .and_then(Value::as_i64)
                .filter(|version| *version > 0)
                .ok_or_else(|| "version must be at least 1".to_string())?;
            (
                reqwest::Method::PUT,
                format!("/v1/team/skills/{}/install", urlencode(slug)),
                vec!["workspace:write"],
                Some(json!({ "slug": slug, "version": version })),
            )
        }
        "uninstall" => (
            reqwest::Method::DELETE,
            format!("/v1/team/skills/{}/install", urlencode(slug)),
            vec!["workspace:write"],
            None,
        ),
        "get_draft" => (
            reqwest::Method::GET,
            format!("/v1/team/skills/{}/draft", urlencode(slug)),
            vec!["workspace:read"],
            None,
        ),
        "update_draft" => {
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "content is required for update_draft".to_string())?;
            let mut body = json!({
                "slug": slug,
                "content": content,
                "files": arguments.get("files").cloned().unwrap_or(json!([])),
                "deleteFiles": arguments.get("deleteFiles").cloned().unwrap_or(json!([])),
            });
            if let Some(digest) = arguments.get("expectedDigest") {
                body["expectedDigest"] = digest.clone();
            }
            (
                reqwest::Method::PUT,
                format!("/v1/team/skills/{}/draft", urlencode(slug)),
                vec!["workspace:write"],
                Some(body),
            )
        }
        _ => unreachable!(),
    };
    crate::daemon_http::request(method, &path, &scopes, body.as_ref()).await
}

fn urlencode(value: &str) -> String {
    crate::daemon_http::urlencode(value)
}
