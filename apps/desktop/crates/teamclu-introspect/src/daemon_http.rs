//! Authenticated calls into the local amuxd HTTP API.
//!
//! Skills and session tools must keep working with no desktop app (cron /
//! headless). The sidecar reads the daemon's port + root token from the run
//! dir, exchanges a short-lived scoped token, and forwards the request.

use serde_json::{json, Value};

pub async fn request(
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

pub fn urlencode(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_leaves_uuid_alone() {
        let id = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";
        assert_eq!(urlencode(id), id);
    }

    #[test]
    fn urlencode_escapes_query_delimiters() {
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("x&y"), "x%26y");
    }
}
