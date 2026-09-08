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
        "list" | "install" | "uninstall" | "get_draft" | "read_draft_file" | "update_draft"
    ) {
        return Err(
            "action must be list, install, uninstall, get_draft, read_draft_file, or update_draft"
                .into(),
        );
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
        "read_draft_file" => {
            let file_path = arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "path is required for read_draft_file".to_string())?;
            let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let mut qs = format!(
                "/v1/team/skills/{}/draft/file?path={}",
                urlencode(slug),
                urlencode(file_path)
            );
            if offset > 0 {
                qs.push_str(&format!("&offset={offset}"));
            }
            if let Some(limit) = arguments.get("limit").and_then(Value::as_u64) {
                qs.push_str(&format!("&limit={limit}"));
            }
            (reqwest::Method::GET, qs, vec!["workspace:read"], None)
        }
        "update_draft" => {
            let files = arguments.get("files").cloned().unwrap_or(json!([]));
            let delete_files = arguments.get("deleteFiles").cloned().unwrap_or(json!([]));
            let has_content = arguments
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|c| !c.is_empty());
            let has_files = files.as_array().is_some_and(|a| !a.is_empty());
            let has_deletes = delete_files.as_array().is_some_and(|a| !a.is_empty());
            if !has_content && !has_files && !has_deletes {
                return Err(
                    "update_draft requires at least one of content, files, or deleteFiles".into(),
                );
            }
            let mut body = json!({
                "slug": slug,
                "files": files,
                "deleteFiles": delete_files,
            });
            if has_content {
                body["content"] = arguments.get("content").cloned().unwrap_or(Value::Null);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_unknown_action() {
        let err = handle(0, &json!({ "action": "delete" })).await.unwrap_err();
        assert!(err.contains("read_draft_file"));
    }

    #[tokio::test]
    async fn read_draft_file_requires_path() {
        let err = handle(0, &json!({ "action": "read_draft_file", "slug": "demo" }))
            .await
            .unwrap_err();
        assert!(err.contains("path is required"));
    }

    #[tokio::test]
    async fn update_draft_requires_a_change() {
        let err = handle(
            0,
            &json!({
                "action": "update_draft",
                "slug": "demo",
                "expectedDigest": "sha256:abc"
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("content, files, or deleteFiles"));
    }
}
