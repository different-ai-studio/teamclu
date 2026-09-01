//! HTTP integration tests for workspace provider auth (Phase 1 catalog + Phase 2 OAuth).

include!("support/crate_modules.rs");

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::http::runtime_adapter::RuntimeManagerAdapter;
use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use config::{HttpConfig, OpenCodeCompatStore};
use reqwest::Client;
use runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use runtime::opencode_http::host_pool::{GenerationFactory, HostGeneration, OpenCodeHostPool};
use runtime::opencode_http::supervisor::{ServeSupervisor, ShutdownOutcome};
use serde_json::Value;
use tokio::sync::Mutex;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn ws_id(path: &std::path::Path) -> String {
    URL_SAFE_NO_PAD.encode(path.to_str().unwrap())
}

struct TestApp {
    _handle: crate::http::HttpHandle,
    client: Client,
    base: String,
    session_token: String,
}

async fn test_app_with_workspace_store(
    opencode_settings: Option<Arc<opencode_settings::OpenCodeSettingsService>>,
) -> (TestApp, tempfile::TempDir) {
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
    let workspace_control: Arc<dyn config::WorkspaceControlStore> =
        Arc::new(OpenCodeCompatStore::new());
    let handle = crate::http::spawn(
        cfg,
        crate::http::server::metadata("actor".into(), "test"),
        runtime,
        Some(workspace_control),
        None,
        opencode_settings,
        test_sync_dispatcher(),
        None,
        None,
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
    let resp: Value = client
        .post(format!("{base}/v1/auth/exchange"))
        .bearer_auth(&root)
        .json(&serde_json::json!({
            "ttl_seconds": 3600,
            "scopes": [
                "workspace:read",
                "workspace:write",
                "sessions:read",
                "sessions:write",
                "events:read"
            ]
        }))
        .send()
        .await
        .expect("exchange response")
        .error_for_status()
        .expect("exchange status")
        .json()
        .await
        .expect("exchange body");
    let session_token = resp["token"].as_str().expect("session token").to_string();

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

async fn mount_opencode_settings_mocks(mock: &MockServer, workspace_path: &std::path::Path) {
    let directory = workspace_path.to_str().unwrap();

    Mock::given(method("GET"))
        .and(path("/session"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(mock)
        .await;

    Mock::given(method("GET"))
        .and(path("/provider/auth"))
        .and(query_param("directory", directory))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "openai": [{ "type": "oauth", "label": "Live OAuth" }]
        })))
        .mount(mock)
        .await;

    Mock::given(method("POST"))
        .and(path("/provider/openai/oauth/authorize"))
        .and(query_param("directory", directory))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "url": "https://example.com/oauth",
            "method": "code",
            "instructions": "Open the URL"
        })))
        .mount(mock)
        .await;

    Mock::given(method("POST"))
        .and(path("/provider/openai/oauth/callback"))
        .and(query_param("directory", directory))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "ok": true })))
        .mount(mock)
        .await;
}

#[tokio::test]
async fn get_provider_auth_methods_returns_openai_oauth_catalog() {
    let (app, dir) = test_app_with_workspace_store(None).await;
    let wid = ws_id(dir.path());

    let body: Value = app
        .client
        .get(format!(
            "{}/v1/workspaces/{wid}/provider-auth-methods",
            app.base
        ))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response")
        .error_for_status()
        .expect("status")
        .json()
        .await
        .expect("json");

    let openai = body["openai"].as_array().expect("openai array");
    assert_eq!(openai.len(), 1);
    assert_eq!(openai[0]["type"], "oauth");
    assert_eq!(openai[0]["label"], "Browser login");
}

#[tokio::test]
async fn get_provider_auth_methods_merges_live_opencode_when_configured() {
    let mock = MockServer::start().await;
    let settings = Arc::new(opencode_settings::OpenCodeSettingsService::new("opencode"));
    let (app, dir) = test_app_with_workspace_store(Some(settings.clone())).await;
    settings.inject_test_base_url(dir.path(), mock.uri());
    mount_opencode_settings_mocks(&mock, dir.path()).await;

    let wid = ws_id(dir.path());
    let body: Value = app
        .client
        .get(format!(
            "{}/v1/workspaces/{wid}/provider-auth-methods",
            app.base
        ))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response")
        .error_for_status()
        .expect("status")
        .json()
        .await
        .expect("json");

    let openai = body["openai"].as_array().expect("openai array");
    assert!(
        openai.iter().any(|m| m["label"] == "Live OAuth"),
        "expected live auth method: {openai:?}"
    );
}

#[tokio::test]
async fn get_provider_auth_methods_404_for_missing_workspace_dir() {
    let (app, _dir) = test_app_with_workspace_store(None).await;
    let missing = ws_id(std::path::Path::new(
        "/tmp/teamclu-nonexistent-workspace-phase1-test",
    ));

    let resp = app
        .client
        .get(format!(
            "{}/v1/workspaces/{missing}/provider-auth-methods",
            app.base
        ))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response");

    assert_eq!(resp.status(), 404);
    let body: Value = resp.json().await.expect("problem+json");
    assert_eq!(body["code"], "not_found");
}

#[tokio::test]
async fn post_provider_oauth_authorize_proxies_to_opencode() {
    let mock = MockServer::start().await;
    let settings = Arc::new(opencode_settings::OpenCodeSettingsService::new("opencode"));
    let (app, dir) = test_app_with_workspace_store(Some(settings.clone())).await;
    settings.inject_test_base_url(dir.path(), mock.uri());
    mount_opencode_settings_mocks(&mock, dir.path()).await;

    let wid = ws_id(dir.path());
    let body: Value = app
        .client
        .post(format!(
            "{}/v1/workspaces/{wid}/providers/openai/oauth/authorize",
            app.base
        ))
        .bearer_auth(&app.session_token)
        .json(&serde_json::json!({ "method_index": 0 }))
        .send()
        .await
        .expect("response")
        .error_for_status()
        .expect("status")
        .json()
        .await
        .expect("json");

    assert_eq!(body["url"], "https://example.com/oauth");
    assert_eq!(body["method"], "code");
}

#[tokio::test]
async fn post_provider_oauth_authorize_503_without_settings_service() {
    let (app, dir) = test_app_with_workspace_store(None).await;
    let wid = ws_id(dir.path());

    let resp = app
        .client
        .post(format!(
            "{}/v1/workspaces/{wid}/providers/openai/oauth/authorize",
            app.base
        ))
        .bearer_auth(&app.session_token)
        .json(&serde_json::json!({ "method_index": 0 }))
        .send()
        .await
        .expect("response");

    assert_eq!(resp.status(), 503);
    let body: Value = resp.json().await.expect("problem+json");
    assert_eq!(body["code"], "runtime_unavailable");
}

#[tokio::test]
async fn post_materialize_team_mcp_clears_copies_an_older_build_left_behind() {
    // The route no longer materialises: every runtime reads the team's own file
    // now. What it does instead is undo the old behaviour, because a leftover
    // copy in this file outranks the team's and would freeze that server at
    // whatever was copied.
    let (app, dir) = test_app_with_workspace_store(None).await;
    let wid = ws_id(dir.path());

    let mcp_dir = dir.path().join("teamclu-team").join(".mcp");
    std::fs::create_dir_all(&mcp_dir).expect("mcp dir");
    std::fs::write(
        mcp_dir.join("shared.json"),
        r#"{
  "mcpServers": {
    "team-db": {
      "command": "npx",
      "args": ["-y", "team-db-mcp"]
    }
  }
}"#,
    )
    .expect("write team mcp");

    // What the old materialise would have written, plus a server of the user's
    // own that must survive.
    std::fs::write(
        dir.path().join("opencode.json"),
        r#"{"mcp":{
  "team-db":{"type":"local","enabled":true,"command":["npx","-y","team-db-mcp"]},
  "mine":{"type":"local","enabled":true,"command":["npx","mine"]}
}}"#,
    )
    .expect("write opencode.json");

    let body: Value = app
        .client
        .post(format!(
            "{}/v1/workspaces/{wid}/mcp/materialize-team",
            app.base
        ))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response")
        .error_for_status()
        .expect("status")
        .json()
        .await
        .expect("json");

    assert_eq!(body["changed"], true);
    assert_eq!(body["added_count"], 1, "reports what it removed");

    let opencode = std::fs::read_to_string(dir.path().join("opencode.json")).expect("opencode");
    let parsed: Value = serde_json::from_str(&opencode).expect("parse opencode");
    assert!(
        parsed["mcp"]["team-db"].is_null(),
        "the leftover team copy is gone"
    );
    assert!(
        parsed["mcp"]["mine"].is_object(),
        "the user's own server is untouched"
    );
}

struct DisposeMockFactory {
    base_url: String,
}

#[async_trait]
impl GenerationFactory for DisposeMockFactory {
    async fn start(
        &self,
        generation_id: String,
        _domain: IsolationDomainKey,
        revision: ProcessEnvRevision,
        _env: HashMap<String, String>,
    ) -> Result<Arc<ServeSupervisor>, String> {
        Ok(Arc::new(ServeSupervisor::test_with_base_url(
            generation_id,
            revision,
            self.base_url.clone(),
        )))
    }

    fn stop(&self, _generation: &HostGeneration) -> ShutdownOutcome {
        ShutdownOutcome::Stopped
    }
}

async fn test_app_with_refresh() -> (
    TestApp,
    tempfile::TempDir,
    std::sync::Arc<runtime::RuntimeSupervisor>,
) {
    spawn_refresh_app(runtime::RuntimeSupervisor::new(Arc::new(Mutex::new(
        runtime::RuntimeManager::new(std::collections::HashMap::new(), None),
    ))))
    .await
}

async fn test_app_with_refresh_pool(
    base_url: String,
) -> (
    TestApp,
    tempfile::TempDir,
    std::sync::Arc<runtime::RuntimeSupervisor>,
    Arc<OpenCodeHostPool>,
) {
    let pool = OpenCodeHostPool::new(Arc::new(DisposeMockFactory { base_url }));
    let manager = Arc::new(Mutex::new(runtime::RuntimeManager::new(
        std::collections::HashMap::new(),
        None,
    )));
    let supervisor = runtime::RuntimeSupervisor::new_with_host_pool(manager.clone(), pool.clone());
    let (app, dir) = spawn_refresh_app_inner(manager, supervisor.clone()).await;
    (app, dir, supervisor, pool)
}

async fn spawn_refresh_app(
    supervisor: std::sync::Arc<runtime::RuntimeSupervisor>,
) -> (
    TestApp,
    tempfile::TempDir,
    std::sync::Arc<runtime::RuntimeSupervisor>,
) {
    let manager = supervisor.agent_manager().clone();
    let (app, dir) = spawn_refresh_app_inner(manager, supervisor.clone()).await;
    (app, dir, supervisor)
}

async fn spawn_refresh_app_inner(
    manager: Arc<Mutex<runtime::RuntimeManager>>,
    supervisor: std::sync::Arc<runtime::RuntimeSupervisor>,
) -> (TestApp, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let token_path = dir.path().join("token");
    let cfg = HttpConfig {
        bind: "127.0.0.1:0".into(),
        token_file: Some(token_path.clone()),
        port_file: Some(dir.path().join("port")),
        heartbeat_interval: Duration::from_secs(5),
        ..HttpConfig::default()
    };
    let runtime = RuntimeManagerAdapter::new(manager, 256, None);
    runtime.set_runtime_supervisor(supervisor.clone());
    let workspace_control: Arc<dyn config::WorkspaceControlStore> =
        Arc::new(OpenCodeCompatStore::new());
    let handle = crate::http::spawn(
        cfg,
        crate::http::server::metadata("actor".into(), "test"),
        runtime,
        Some(workspace_control),
        Some(supervisor),
        None,
        test_sync_dispatcher(),
        None,
        None,
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
    let resp: Value = client
        .post(format!("{base}/v1/auth/exchange"))
        .bearer_auth(&root)
        .json(&serde_json::json!({
            "ttl_seconds": 3600,
            "scopes": [
                "workspace:read",
                "workspace:write",
                "sessions:read",
                "sessions:write",
                "events:read"
            ]
        }))
        .send()
        .await
        .expect("exchange response")
        .error_for_status()
        .expect("exchange status")
        .json()
        .await
        .expect("exchange body");
    let session_token = resp["token"].as_str().expect("session token").to_string();
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

async fn seed_workspace_host(
    pool: &Arc<OpenCodeHostPool>,
    workspace_id: &str,
) -> runtime::opencode_http::host_pool::HostLease {
    let env = HashMap::from([("SENTINEL".to_string(), "v1".to_string())]);
    let revision = ProcessEnvRevision::from_bindings(&env);
    pool.acquire(
        IsolationDomainKey::Workspace(workspace_id.to_string()),
        revision,
        env,
        Instant::now() + Duration::from_secs(1),
    )
    .await
    .expect("seed host")
}

#[tokio::test]
async fn skills_refresh_applies_and_clears_when_workspace_is_idle() {
    let server = MockServer::start().await;
    let ws = tempfile::tempdir().expect("workspace");
    let directory = ws.path().to_string_lossy().into_owned();
    Mock::given(method("POST"))
        .and(path("/instance/dispose"))
        .and(query_param("directory", directory.clone()))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let (app, _dir, supervisor, pool) = test_app_with_refresh_pool(server.uri()).await;
    let wid = ws_id(ws.path());
    let _lease = seed_workspace_host(&pool, &wid).await;
    let body: Value = app
        .client
        .post(format!("{}/v1/workspaces/{wid}/skills/refresh", app.base))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response")
        .error_for_status()
        .expect("status")
        .json()
        .await
        .expect("json");
    assert_eq!(body["ok"], true);
    assert_eq!(body["status"], "applied");
    assert_eq!(body["outcome"], "reload_required");

    let dto = supervisor
        .refresh_coordinator()
        .runtime_refresh_dto(&wid)
        .await;
    assert_eq!(dto.status, "clean");
    assert!(
        dto.change_kinds.is_empty(),
        "applied refresh must clear pending skills, got {:?}",
        dto.change_kinds
    );
}

#[tokio::test]
async fn skills_refresh_pending_when_workspace_has_active_turn() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/instance/dispose"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;

    let (app, _dir, supervisor, pool) = test_app_with_refresh_pool(server.uri()).await;
    let ws = tempfile::tempdir().expect("workspace");
    let wid = ws_id(ws.path());
    let _lease = seed_workspace_host(&pool, &wid).await;
    {
        let mut manager = supervisor.agent_manager().lock().await;
        manager.add_test_workspace_runtime(
            "rt-busy",
            &ws.path().to_string_lossy(),
            &wid,
            proto::amux::AgentStatus::Active,
        );
    }
    let body: Value = app
        .client
        .post(format!("{}/v1/workspaces/{wid}/skills/refresh", app.base))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response")
        .error_for_status()
        .expect("status")
        .json()
        .await
        .expect("json");
    assert_eq!(body["ok"], true);
    assert_eq!(body["status"], "pending_active_turn");
    assert!(body.get("outcome").is_none() || body["outcome"].is_null());

    let dto = supervisor
        .refresh_coordinator()
        .runtime_refresh_dto(&wid)
        .await;
    assert_eq!(dto.status, "pending");
    assert!(dto.auto_apply_blocked_by_active_runtime);
    assert!(
        dto.change_kinds.iter().any(|k| k == "skills"),
        "expected Skills still pending, got {:?}",
        dto.change_kinds
    );
}

#[tokio::test]
async fn skills_refresh_missing_workspace_is_not_found() {
    let (app, _dir, _supervisor) = test_app_with_refresh().await;
    let missing = std::env::temp_dir().join(format!(
        "teamclu-missing-workspace-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let wid = ws_id(&missing);
    let resp = app
        .client
        .post(format!("{}/v1/workspaces/{wid}/skills/refresh", app.base))
        .bearer_auth(&app.session_token)
        .send()
        .await
        .expect("response");
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
}
