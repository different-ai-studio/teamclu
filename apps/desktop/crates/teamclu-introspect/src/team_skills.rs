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
    if !matches!(action, "list" | "install" | "uninstall") {
        return Err("action must be list, install, or uninstall".into());
    }
    let mut body = json!({});
    if action != "list" {
        let slug = arguments
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .ok_or_else(|| "Missing field: slug".to_string())?;
        body["slug"] = json!(slug);
    }
    if action == "install" {
        let version = arguments
            .get("version")
            .and_then(Value::as_i64)
            .filter(|version| *version > 0)
            .ok_or_else(|| "version must be at least 1".to_string())?;
        body["version"] = json!(version);
    }
    let (method, path, scopes) = match action {
        "list" => (
            reqwest::Method::GET,
            "/v1/team/skills".to_string(),
            vec!["workspace:read"],
        ),
        "install" => (
            reqwest::Method::PUT,
            format!(
                "/v1/team/skills/{}/install",
                urlencode(body["slug"].as_str().unwrap_or_default())
            ),
            vec!["workspace:write"],
        ),
        "uninstall" => (
            reqwest::Method::DELETE,
            format!(
                "/v1/team/skills/{}/install",
                urlencode(body["slug"].as_str().unwrap_or_default())
            ),
            vec!["workspace:write"],
        ),
        _ => unreachable!(),
    };
    daemon_request(
        method,
        &path,
        &scopes,
        (action == "install").then_some(&body),
    )
    .await
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
