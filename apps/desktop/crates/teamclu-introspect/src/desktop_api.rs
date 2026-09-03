//! The one way this sidecar talks to the desktop's loopback introspect API
//! (`127.0.0.1:<api_port>`, see `commands::introspect_api` in the desktop crate).
//!
//! Every call carries the per-launch bearer the desktop writes to
//! `<amuxd home>/run/introspect.http.token` (0600, same directory as the
//! daemon's `amuxd.http.token`). Without it the desktop answers 401 — the API
//! reaches into the user's workspace MCP config and Cloud API identity, so it
//! refuses anything that cannot prove it read a file only this user can read.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Must match `INTROSPECT_TOKEN_FILE` in the desktop crate.
pub const TOKEN_FILE: &str = "introspect.http.token";

/// `<amuxd home>/run/introspect.http.token`, resolved the same way the daemon
/// socket and `amuxd.http.token` are — from `AMUXD_HOME` / the brand, never a
/// hardcoded `~/.amuxd`.
pub fn token_path() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::run_dir(&teamclu_runtime_env::amuxd_home_from_env())
        .join(TOKEN_FILE)
}

/// Read and trim the bearer at `path`. The error names the file: "no token"
/// nearly always means the desktop app is not running.
pub fn read_token_from(path: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        format!(
            "TeamClu desktop token unavailable ({}: {e}). Is the TeamClu app running?",
            path.display()
        )
    })?;
    let token = raw.trim();
    if token.is_empty() {
        return Err(format!(
            "TeamClu desktop token at {} is empty. Is the TeamClu app running?",
            path.display()
        ));
    }
    Ok(token.to_string())
}

fn read_token() -> Result<String, String> {
    read_token_from(&token_path())
}

/// POST `body` to `path` on the desktop API and hand back the raw response.
/// For callers that word their own error around the status code.
pub async fn send(api_port: u16, path: &str, body: &Value) -> Result<reqwest::Response, String> {
    let token = read_token()?;
    let url = format!("http://127.0.0.1:{api_port}{path}");
    reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}. Is the TeamClu app running?"))
}

/// POST `body` to `path` and parse the JSON reply. Non-2xx becomes
/// `API error: <body>`, the wording every tool here already used.
pub async fn post(api_port: u16, path: &str, body: &Value) -> Result<Value, String> {
    let resp = send(api_port, path, body).await?;
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API error: {text}"));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_path_lives_in_the_run_dir_under_the_token_file_name() {
        let path = token_path();
        assert!(
            path.ends_with(Path::new("run").join(TOKEN_FILE)),
            "got {}",
            path.display()
        );
    }

    #[test]
    fn read_token_trims_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE);
        std::fs::write(&path, "  abc123\n").unwrap();
        assert_eq!(read_token_from(&path).unwrap(), "abc123");
    }

    #[test]
    fn missing_token_file_says_the_app_is_probably_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_token_from(&dir.path().join(TOKEN_FILE)).unwrap_err();
        assert!(err.contains("Is the TeamClu app running?"), "{err}");
        assert!(err.contains(TOKEN_FILE), "{err}");
    }

    #[test]
    fn empty_token_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE);
        std::fs::write(&path, "   \n").unwrap();
        assert!(read_token_from(&path).unwrap_err().contains("empty"));
    }
}
