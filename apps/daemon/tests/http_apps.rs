//! HTTP integration test for `POST /v1/apps/seed`.
//!
//! Spins the daemon HTTP server with a session token and checks that seeding
//! writes a compiled-in starter template into the checkout and commits it.
//! Seeding is entirely local: there is no template clone and no push, so no
//! git remote is involved.

#[path = "../src/backend/mod.rs"]
mod backend;
#[path = "../src/config/mod.rs"]
mod config;
// Same reason: `http::server` names `crate::device_id` for /v1/info.
#[path = "../src/device_id.rs"]
mod device_id;
// Streaming download helper shared by runtime installers; integration-test
// crate roots only have the modules they declare here.
#[path = "../src/download_progress.rs"]
mod download_progress;
#[path = "../src/error.rs"]
mod error;
#[path = "../src/http/mod.rs"]
mod http;
// Same reason as `process_util` / `device_id`: `http::knowledge_inbox` reaches
// for `crate::knowledge`, and an integration-test crate root only has what it
// declares here.
#[path = "../src/daemon/server/knowledge.rs"]
mod knowledge;
#[path = "../src/mcp_probe.rs"]
mod mcp_probe;
#[path = "../src/mqtt/mod.rs"]
mod mqtt;
#[path = "../src/node_install/mod.rs"]
mod node_install;
#[path = "../src/pi_install/mod.rs"]
mod pi_install;
#[path = "../src/process_util.rs"]
mod process_util;
#[path = "../src/proto.rs"]
mod proto;
#[path = "../src/provider_config.rs"]
mod provider_config;
#[path = "../src/route_probe.rs"]
mod route_probe;
#[path = "../src/runtime/mod.rs"]
mod runtime;
#[path = "../src/sync/mod.rs"]
mod sync;
#[path = "../src/team_link.rs"]
mod team_link;
#[path = "../src/team_shared_env.rs"]
mod team_shared_env;
// Same reason as `device_id` above: the modules declared here carry
// `#[cfg(test)]` blocks that an integration-test crate compiles, and those name
// `crate::test_brand_env` — which resolves against this root, not the bin's.
#[path = "../src/test_brand_env.rs"]
mod test_brand_env;

use std::sync::Arc;
use std::time::Duration;

use backend::Backend;
use config::HttpConfig;
use http::runtime_adapter::RuntimeManagerAdapter;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

struct TestApp {
    _handle: http::server::HttpHandle,
    client: Client,
    base: String,
    session_token: String,
}

async fn test_app() -> (TestApp, tempfile::TempDir) {
    test_app_inner(None).await
}

async fn test_app_inner(backend: Option<Arc<dyn Backend>>) -> (TestApp, tempfile::TempDir) {
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
    let dispatcher =
        sync::dispatch::SyncDispatcher::new(sync::secret_store::SecretStore::new(), None);
    let handle = http::spawn(
        cfg,
        http::server::metadata("actor".into(), "test"),
        runtime,
        None,
        None,
        dispatcher,
        None,
        backend,
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
            "scopes": ["workspace:read", "workspace:write"]
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

/// Files every compiled-in template ships (see `sync::app_templates`).
fn assert_seeded_checkout(workdir: &std::path::Path) {
    for rel in [
        "package.json",
        "pnpm-lock.yaml",
        "AGENTS.md",
        "teamclu.app.json",
    ] {
        assert!(
            workdir.join(rel).is_file(),
            "{rel} missing from seeded checkout"
        );
    }
}

/// Seeding writes a compiled-in template into the checkout.
///
/// It does NOT clone a template repo, does NOT push anywhere, and no longer
/// initialises a local repo — git is gone from the product. Template *content*
/// is covered by the unit tests in `sync::app_templates`; this asserts the HTTP
/// contract.
#[tokio::test]
async fn seed_app_writes_template() {
    let (app, dir) = test_app().await;

    // Fresh, non-existent target: the handler creates it.
    let workdir = dir.path().join("work");

    let resp = app
        .client
        .post(format!("{}/v1/apps/seed", app.base))
        .bearer_auth(&app.session_token)
        .json(&serde_json::json!({
            "appId": "app-test",
            "appName": "Test App",
            "appType": "static_web",
            "workspaceId": "ws-test",
            "workdir": workdir.to_str().unwrap(),
        }))
        .send()
        .await
        .expect("seed response");

    assert_eq!(resp.status(), 200, "expected 200, got {}", resp.status());
    let body: Value = resp.json().await.expect("json body");
    assert_eq!(body["status"], "ready");

    assert_seeded_checkout(&workdir);
}

/// Re-seeding an existing checkout is a documented no-op, so a wrecked app can
/// be repaired.
#[tokio::test]
async fn seed_app_is_idempotent() {
    let (app, dir) = test_app().await;
    let workdir = dir.path().join("work");

    let seed = || {
        app.client
            .post(format!("{}/v1/apps/seed", app.base))
            .bearer_auth(&app.session_token)
            .json(&serde_json::json!({
                "appId": "app-test",
                "appType": "static_web",
                "workdir": workdir.to_str().unwrap(),
            }))
            .send()
    };

    assert_eq!(seed().await.expect("first seed").status(), 200);
    assert_eq!(seed().await.expect("second seed").status(), 200);

    assert_seeded_checkout(&workdir);
}

/// A repo URL means "import this", so the starter template must not be written
/// — not even when the clone never happens because the URL is unusable.
///
/// `ext::` is a git remote-helper that runs a command; the daemon rejects it
/// before `git` is spawned, and the app is left with nothing rather than with a
/// template the user did not ask for.
#[tokio::test]
async fn seed_with_an_unusable_repo_url_writes_nothing() {
    let (app, dir) = test_app().await;
    let workdir = dir.path().join("work");

    let resp = app
        .client
        .post(format!("{}/v1/apps/seed", app.base))
        .bearer_auth(&app.session_token)
        .json(&serde_json::json!({
            "appId": "app-test",
            "appName": "Test App",
            "appType": "static_web",
            "workdir": workdir.to_str().unwrap(),
            "gitRemoteUrl": "ext::sh -c whoami",
        }))
        .send()
        .await
        .expect("seed response");

    assert_eq!(resp.status(), 422, "expected a validation error");
    let body: Value = resp.json().await.expect("json body");
    assert_eq!(body["code"], "validation_failed");
    assert!(
        !workdir.join("AGENTS.md").exists(),
        "an import must never fall back to the template"
    );
}

#[tokio::test]
async fn seed_app_requires_scope() {
    let (app, dir) = test_app().await;
    // Mint a token without workspace:write.
    let token_path = dir.path().join("token");
    let root = std::fs::read_to_string(&token_path)
        .unwrap()
        .trim()
        .to_owned();
    let resp: Value = app
        .client
        .post(format!("{}/v1/auth/exchange", app.base))
        .bearer_auth(&root)
        .json(&serde_json::json!({
            "ttl_seconds": 3600,
            "scopes": ["workspace:read"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let read_only = resp["token"].as_str().unwrap();

    let resp = app
        .client
        .post(format!("{}/v1/apps/seed", app.base))
        .bearer_auth(read_only)
        .json(&serde_json::json!({
            "workdir": dir.path().join("nope").to_str().unwrap(),
            "gitRemoteUrl": "https://example.com/x.git"
        }))
        .send()
        .await
        .expect("response");
    assert_eq!(resp.status(), 403);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["code"], "forbidden");
}

// ─── /v1/app-ops ────────────────────────────────────────────────────────────

/// A Cloud API that knows one live app, `a1` ("Notes"), and one that was
/// never deployed, `a2`. Every route insists on the mock backend's token, so a
/// call that went out on anything else fails loudly.
async fn fake_cloud() -> String {
    use axum::{extract::Path, http::HeaderMap, http::StatusCode, routing::get, Json, Router};

    fn authed(headers: &HeaderMap) -> Result<(), StatusCode> {
        (headers["authorization"] == "Bearer mock-token")
            .then_some(())
            .ok_or(StatusCode::UNAUTHORIZED)
    }
    fn row(id: &str) -> Value {
        match id {
            "a1" => serde_json::json!({
                "id": "a1", "teamId": "team-mock", "name": "Notes", "slug": "notes",
                "fcStatus": "live", "provisionStatus": "ready",
                "publicUrl": "https://notes.apps.test",
            }),
            _ => serde_json::json!({
                "id": id, "teamId": "team-mock", "name": "Draft", "slug": "draft",
                "fcStatus": "not_deployed", "provisionStatus": "ready",
            }),
        }
    }

    let router = Router::new()
        .route(
            "/v1/apps",
            get(|headers: HeaderMap, axum::extract::RawQuery(q): axum::extract::RawQuery| async move {
                authed(&headers)?;
                assert_eq!(q.as_deref(), Some("teamId=team-mock&limit=100"));
                Ok::<_, StatusCode>(Json(serde_json::json!({ "items": [row("a1"), row("a2")] })))
            }),
        )
        .route(
            "/v1/apps/:id",
            get(|headers: HeaderMap, Path(id): Path<String>| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(row(&id)))
            })
            .patch(
                |headers: HeaderMap, Path(id): Path<String>, Json(patch): Json<Value>| async move {
                    authed(&headers)?;
                    let mut updated = row(&id);
                    for (k, v) in patch.as_object().cloned().unwrap_or_default() {
                        updated[k] = v;
                    }
                    Ok::<_, StatusCode>(Json(updated))
                },
            )
            .delete(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(StatusCode::NO_CONTENT)
            }),
        )
        .route(
            "/v1/apps/:id/logs",
            get(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(
                    serde_json::json!({ "items": [{ "message": "listening on :9000" }], "truncated": false }),
                ))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

async fn app_ops(app: &TestApp, body: Value) -> (u16, Value) {
    let resp = app
        .client
        .post(format!("{}/v1/app-ops", app.base))
        .bearer_auth(&app.session_token)
        .json(&body)
        .send()
        .await
        .expect("app-ops response");
    let status = resp.status().as_u16();
    (status, resp.json().await.expect("app-ops body"))
}

/// `amuxd app list` / `logs` run the shared flows on the daemon's own token.
#[tokio::test]
async fn app_ops_runs_the_shared_flows_as_the_daemon_agent() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, listed) = app_ops(&app, serde_json::json!({ "action": "list" })).await;
    assert_eq!(status, 200, "{listed}");
    assert_eq!(listed["team_id"], "team-mock");
    assert_eq!(listed["apps"][0]["url"], "https://notes.apps.test");

    let (status, logs) = app_ops(
        &app,
        serde_json::json!({ "action": "logs", "appName": "notes", "sinceMinutes": 5 }),
    )
    .await;
    assert_eq!(status, 200, "{logs}");
    assert_eq!(logs["app_id"], "a1");
    assert_eq!(logs["since_minutes"], 5);
    assert_eq!(logs["entries"][0]["message"], "listening on :9000");
}

/// A flow that says no answers 422 with its whole sentence as `detail`, and
/// names the next step as a CLI command rather than an MCP tool.
#[tokio::test]
async fn app_ops_refusals_carry_the_cli_next_step() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) =
        app_ops(&app, serde_json::json!({ "action": "logs", "appId": "a2" })).await;
    assert_eq!(status, 422, "{body}");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("never been deployed"), "{detail}");
    assert!(detail.contains("`amuxd app deploy`"), "{detail}");

    let (status, body) = app_ops(&app, serde_json::json!({ "action": "publish" })).await;
    assert_eq!(status, 422, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("unknown action"));
}

/// No cloud session to act on: a daemon that was never onboarded says so
/// instead of failing on the first request.
#[tokio::test]
async fn app_ops_needs_an_onboarded_daemon() {
    let (app, _dir) = test_app_inner(Some(Arc::new(backend::mock::MockBackend::new()))).await;
    let (status, body) = app_ops(&app, serde_json::json!({ "action": "list" })).await;
    assert_eq!(status, 503, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("amuxd init"));
}

/// `update` reaches the row; `delete` refuses an app inferred from a directory
/// and one not confirmed, and goes through only when both are given.
#[tokio::test]
async fn app_ops_update_and_the_delete_guards() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "update", "appId": "a1", "visibility": "team" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["app"]["visibility"], "team");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "update", "appId": "a1", "authMode": "third" }),
    )
    .await;
    assert_eq!(status, 422, "{body}");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "delete", "workspacePath": "/work/notes", "confirm": true }),
    )
    .await;
    assert_eq!(status, 422, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("explicit"));

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "undeploy", "workspacePath": "/work/notes" }),
    )
    .await;
    assert_eq!(status, 422, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("explicit"));

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "delete", "appId": "a1" }),
    )
    .await;
    assert_eq!(status, 422, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("--yes"));

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "delete", "appId": "a1", "confirm": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["action"], "delete");
}
