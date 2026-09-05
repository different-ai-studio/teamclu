//! HTTP integration tests for `GET /v1/agent/default-workspace`.
//!
//! Mirrors the pattern in `http_workspace_provider_auth.rs`: spawn a real
//! `crate::http::spawn` server (with a `MockBackend` attached) and drive it
//! over reqwest, so the router + auth + handler wiring is exercised end to
//! end, not just the resolution algorithm in isolation (that's already
//! covered by `daemon/server/cron.rs`'s `resolve_cron_default_workspace_*`
//! tests, which this handler now shares logic with via
//! `config::resolve_default_workspace_path`).

include!("support/crate_modules.rs");

use std::sync::Arc;
use std::time::Duration;

use crate::http::runtime_adapter::RuntimeManagerAdapter;
use backend::mock::MockBackend;
use backend::{AgentDefaults, Backend, WorkspaceRow};
use config::HttpConfig;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

struct TestApp {
    _handle: crate::http::HttpHandle,
    client: Client,
    base: String,
    session_token: String,
}

/// Spawn the HTTP server with `backend` attached, then mint a session token
/// carrying exactly `scopes`.
async fn test_app(backend: Arc<dyn Backend>, scopes: &[&str]) -> (TestApp, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let token_path = dir.path().join("token");
    let cfg = HttpConfig {
        bind: "127.0.0.1:0".into(),
        token_file: Some(token_path.clone()),
        port_file: Some(dir.path().join("port")),
        heartbeat_interval: Duration::from_secs(5),
        ..HttpConfig::default()
    };
    let manager = Arc::new(Mutex::new(runtime::RuntimeManager::new(
        std::collections::HashMap::new(),
        None,
    )));
    let runtime = RuntimeManagerAdapter::new(manager, 256, None);
    let handle = crate::http::spawn(
        cfg,
        crate::http::server::metadata("actor".into(), "test"),
        runtime,
        None,
        None,
        test_sync_dispatcher(),
        None,
        Some(backend),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("spawn http server");
    let base = format!("http://{}", handle.local_addr);
    let root = std::fs::read_to_string(&token_path)
        .expect("read root token")
        .trim()
        .to_owned();
    let client = Client::new();

    let session_token = if scopes.is_empty() {
        String::new()
    } else {
        let resp: Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root)
            .json(&serde_json::json!({
                "ttl_seconds": 3600,
                "scopes": scopes,
            }))
            .send()
            .await
            .expect("exchange response")
            .error_for_status()
            .expect("exchange status")
            .json()
            .await
            .expect("exchange body");
        resp["token"].as_str().expect("session token").to_string()
    };

    (
        TestApp {
            _handle: handle,
            client,
            base,
            session_token,
        },
        dir,
    )
}

async fn get_default_workspace(app: &TestApp, token: &str) -> reqwest::Response {
    app.client
        .get(format!("{}/v1/agent/default-workspace", app.base))
        .bearer_auth(token)
        .send()
        .await
        .expect("response")
}

#[tokio::test]
async fn default_workspace_resolves_agent_default_via_workspace_resolver() {
    let on_disk = tempfile::tempdir().unwrap();
    let mock = MockBackend::with_identity("team-test", "agent-actor");
    {
        let mut st = mock.state();
        st.agent_defaults.insert(
            "agent-actor".to_string(),
            AgentDefaults {
                default_agent_type: None,
                default_workspace_id: Some("ws-default".to_string()),
            },
        );
        st.workspaces_by_id.insert(
            "ws-default".to_string(),
            WorkspaceRow {
                id: "ws-default".to_string(),
                team_id: "team-test".to_string(),
                path: Some(on_disk.path().to_string_lossy().to_string()),
                archived: false,
                agent_id: None,
            },
        );
    }
    let backend: Arc<dyn Backend> = Arc::new(mock);
    let (app, _dir) = test_app(backend, &["workspace:read"]).await;
    let resp = get_default_workspace(&app, &app.session_token).await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.expect("json");
    assert_eq!(
        body["path"].as_str().unwrap(),
        on_disk.path().to_string_lossy()
    );
}

#[tokio::test]
async fn default_workspace_falls_back_to_team_first_on_disk_workspace() {
    let on_disk = tempfile::tempdir().unwrap();
    let mock = MockBackend::with_identity("team-test", "agent-actor");
    {
        let mut st = mock.state();
        // No agent default configured (agent_defaults left empty).
        // Decoy row that is NOT on disk — must be skipped.
        st.workspaces_by_id.insert(
            "ws-missing".to_string(),
            WorkspaceRow {
                id: "ws-missing".to_string(),
                team_id: "team-test".to_string(),
                path: Some("/definitely/not/on/this/machine/http-fallback-test".to_string()),
                archived: false,
                agent_id: None,
            },
        );
        st.workspaces_by_id.insert(
            "ws-on-disk".to_string(),
            WorkspaceRow {
                id: "ws-on-disk".to_string(),
                team_id: "team-test".to_string(),
                path: Some(on_disk.path().to_string_lossy().to_string()),
                archived: false,
                agent_id: None,
            },
        );
        // Different team; must never be picked.
        st.workspaces_by_id.insert(
            "ws-other-team".to_string(),
            WorkspaceRow {
                id: "ws-other-team".to_string(),
                team_id: "team-other".to_string(),
                path: Some(on_disk.path().to_string_lossy().to_string()),
                archived: false,
                agent_id: None,
            },
        );
    }
    let backend: Arc<dyn Backend> = Arc::new(mock);
    let (app, _dir) = test_app(backend, &["workspace:read"]).await;
    let resp = get_default_workspace(&app, &app.session_token).await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.expect("json");
    assert_eq!(
        body["path"].as_str().unwrap(),
        on_disk.path().to_string_lossy()
    );
}

#[tokio::test]
async fn default_workspace_returns_null_when_no_candidates() {
    let mock = MockBackend::with_identity("team-test", "agent-actor");
    let backend: Arc<dyn Backend> = Arc::new(mock);
    let (app, _dir) = test_app(backend, &["workspace:read"]).await;
    let resp = get_default_workspace(&app, &app.session_token).await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.expect("json");
    assert!(body["path"].is_null());
}

#[tokio::test]
async fn default_workspace_requires_workspace_read_scope() {
    let mock = MockBackend::with_identity("team-test", "agent-actor");
    let backend: Arc<dyn Backend> = Arc::new(mock);
    // Mint a session token with an unrelated scope only.
    let (app, _dir) = test_app(backend, &["sessions:read"]).await;
    let resp = get_default_workspace(&app, &app.session_token).await;
    assert_eq!(resp.status(), 403);
}
