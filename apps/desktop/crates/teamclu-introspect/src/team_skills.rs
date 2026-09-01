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
        return Err(
            "action must be list, install, uninstall, get_draft, or update_draft".into(),
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
    daemon_request(method, &path, &scopes, body.as_ref()).await
}

async fn daemon_request(
    method: reqwest::Method,
    path: &str,
    scopes: &[&str],
    body: Option<&Value>,
) -> Result<Value, String> {
    let run_dir =
        teamclu_runtime_env::amuxd_layout::run_dir(&teamclu_runtime_env::amuxd_home_from_env());
    let port = std::fs::read_to_string(run_dir.join("amuxd.http.port"))
        .map_err(|e| format!("amuxd HTTP port unavailable: {e}"))?;
    let root_token = std::fs::read_to_string(run_dir.join("amuxd.http.token"))
        .map_err(|e| format!("amuxd HTTP token unavailable: {e}"))?;
    let base = format!("http://127.0.0.1:{}", port.trim());
    let client = reqwest::Client::new();
    let exchange = client
        .post(format!("{base}/v1/auth/exchange"))
        .bearer_auth(root_token.trim())
        .json(&json!({ "scopes": scopes, "ttl_seconds": 60 }))
        .send()
        .await
        .map_err(|e| format!("amuxd auth exchange failed: {e}"))?;
    if !exchange.status().is_success() {
        return Err(format!(
            "amuxd auth exchange failed: {}",
            exchange.text().await.unwrap_or_default()
        ));
    }
    let session = exchange
        .json::<Value>()
        .await
        .map_err(|e| format!("amuxd auth response is invalid: {e}"))?["token"]
        .as_str()
        .ok_or_else(|| "amuxd auth response has no token".to_string())?
        .to_string();
    let mut request = client
        .request(method, format!("{base}{path}"))
        .bearer_auth(session);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("amuxd request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "amuxd request failed: {}",
            response.text().await.unwrap_or_default()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("amuxd response is invalid: {e}"))
}

fn urlencode(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}
