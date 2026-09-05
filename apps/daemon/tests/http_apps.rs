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
    for rel in ["package.json", "pnpm-lock.yaml", "AGENTS.md"] {
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
