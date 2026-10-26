//! A small loopback client for the running daemon's HTTP API, for CLI
//! commands that act through it (`manage`, `app`).
//!
//! Cloud credentials stay owned by that process; this side only reads the
//! root token from `amuxd.http.token` (0600, so being able to read it is the
//! authorization) and trades it for a short-lived session token.

use serde::de::DeserializeOwned;

use crate::config::DaemonConfig;

pub(crate) struct LocalDaemonClient {
    client: reqwest::Client,
    base: String,
    session_token: String,
}

impl LocalDaemonClient {
    /// Connect with `workspace:read` + `workspace:write`. `label` names the
    /// session token in `GET /v1/auth/tokens`.
    pub(crate) async fn connect(label: &str) -> anyhow::Result<Self> {
        let port_path = DaemonConfig::http_port_path();
        let token_path = DaemonConfig::http_token_path();
        let port = std::fs::read_to_string(&port_path)
            .map_err(|e| {
                anyhow::anyhow!("read {} ({e}). Is the daemon running?", port_path.display())
            })?
            .trim()
            .to_string();
        let root_token = std::fs::read_to_string(&token_path)
            .map_err(|e| anyhow::anyhow!("read {} ({e})", token_path.display()))?
            .trim()
            .to_string();
        if port.is_empty() || root_token.is_empty() {
            anyhow::bail!("daemon HTTP control files are empty; restart amuxd");
        }

        // No overall timeout: a deploy waits on the daemon's own build bounds
        // (up to ~50 minutes for a container), and a shorter client timeout
        // would report a build that went on to succeed as a failure.
        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{port}");
        let exchange: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root_token)
            .json(&serde_json::json!({
                "scopes": ["workspace:read", "workspace:write"],
                "ttl_seconds": 300,
                "label": label,
            }))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("connect to running daemon: {e}"))?
            .error_for_status()
            .map_err(|e| anyhow::anyhow!("authenticate to running daemon: {e}"))?
            .json()
            .await?;
        let session_token = exchange["token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| anyhow::anyhow!("daemon auth response missing token"))?
            .to_string();

        Ok(Self {
            client,
            base,
            session_token,
        })
    }

    /// One request. A non-2xx comes back as `Err((status, detail))`, the
    /// `detail` of the daemon's problem body when it sent one.
    pub(crate) async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> anyhow::Result<Result<serde_json::Value, (u16, String)>> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(&self.session_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("daemon request {path}: {e}"))?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let detail = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|body| body["detail"].as_str().map(str::to_owned))
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned());
            return Ok(Err((status.as_u16(), detail)));
        }
        if bytes.is_empty() {
            return Ok(Ok(serde_json::Value::Null));
        }
        serde_json::from_slice(&bytes)
            .map(Ok)
            .map_err(|e| anyhow::anyhow!("decode daemon response {path}: {e}"))
    }

    pub(crate) async fn json<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> anyhow::Result<T> {
        match self.send(method, path, body).await? {
            Ok(value) => serde_json::from_value(value)
                .map_err(|e| anyhow::anyhow!("decode daemon response {path}: {e}")),
            Err((status, detail)) => {
                anyhow::bail!("daemon request {path} returned {status}: {detail}")
            }
        }
    }
}
