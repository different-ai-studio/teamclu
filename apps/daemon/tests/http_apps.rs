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
// `http::cron` serves the daemon-owned scheduler (ADR-0010).
#[path = "../src/cron/mod.rs"]
mod cron;
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
                "createdByActorId": "m-owner", "visibility": "personal",
                "authMode": "platform", "authScope": "all",
                "authRules": [{ "path": "/health", "auth": "public" }],
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
            "/v1/teams/:team/actors",
            get(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(serde_json::json!({ "items": [
                    { "id": "m-owner", "kind": "member", "displayName": "Owner" },
                    { "id": "m-li", "kind": "member", "displayName": "李雷" },
                    { "id": "m-wang", "kind": "member", "displayName": "王芳" },
                    { "id": "g-bot", "kind": "agent", "displayName": "Bot", "agentOwnerMemberId": "m-wang" },
                ] })))
            }),
        )
        .route(
            "/v1/apps/:id/access",
            get(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(serde_json::json!({ "items": [
                    { "memberId": "m-li", "permissionLevel": "read", "displayName": "李雷", "actorType": "member", "inherited": false },
                ] })))
            }),
        )
        .route(
            "/v1/apps/:id/access/:member",
            axum::routing::put(
                |headers: HeaderMap, Path((id, member)): Path<(String, String)>, Json(body): Json<Value>| async move {
                    authed(&headers)?;
                    if id == "a2" {
                        return Ok::<_, StatusCode>((
                            StatusCode::FORBIDDEN,
                            Json(serde_json::json!({ "error": { "code": "inherited_access_not_allowed", "message": "inherited" } })),
                        ));
                    }
                    Ok((
                        StatusCode::OK,
                        Json(serde_json::json!({ "memberId": member, "permissionLevel": body["permissionLevel"] })),
                    ))
                },
            ),
        )
        .route(
            "/v1/apps/:id/storage/objects",
            get(|headers: HeaderMap, axum::extract::RawQuery(q): axum::extract::RawQuery| async move {
                authed(&headers)?;
                assert_eq!(q.as_deref(), Some("limit=100&prefix=uploads%2F&delimiter=%2F"));
                Ok::<_, StatusCode>(Json(serde_json::json!({
                    "folders": ["uploads/2026/"],
                    "items": [{ "path": "uploads/a.png", "size": 3 }],
                    "nextCursor": null, "canWrite": true,
                })))
            }),
        )
        .route(
            "/v1/apps/:id/storage/sign-upload",
            axum::routing::post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                authed(&headers)?;
                assert_eq!(body, serde_json::json!({ "path": "img/logo.png", "contentType": "image/png" }));
                Ok::<_, StatusCode>(Json(serde_json::json!({
                    "path": "img/logo.png", "url": "https://bucket.test/put?sig", "expiresIn": 600,
                })))
            }),
        )
        .route(
            "/v1/apps/:id/storage/purge",
            axum::routing::post(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(serde_json::json!({ "deleted": 7 })))
            }),
        )
        .route(
            "/v1/apps/:id/undeploy",
            axum::routing::post(|headers: HeaderMap, Path(id): Path<String>| async move {
                authed(&headers)?;
                // a2 is slow: the CLI's first reply comes back while it runs.
                if id == "a2" {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
                Ok::<_, StatusCode>(Json(serde_json::json!({
                    "app": row(&id), "operation": { "status": "succeeded" },
                })))
            }),
        )
        .route(
            "/v1/apps/:id/env",
            get(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(serde_json::json!({
                    "canWrite": true,
                    "items": [{ "key": "STRIPE_KEY", "isSecret": true, "value": null }],
                })))
            }),
        )
        .route(
            "/v1/apps/:id/env/:key",
            axum::routing::put(
                |headers: HeaderMap, Path((_, key)): Path<(String, String)>, Json(body): Json<Value>| async move {
                    authed(&headers)?;
                    let secret = body["isSecret"] == true;
                    Ok::<_, StatusCode>(Json(serde_json::json!({
                        "key": key, "isSecret": secret,
                        "value": if secret { Value::Null } else { body["value"].clone() },
                    })))
                },
            ),
        )
        .route(
            "/v1/apps/:id/cron-jobs",
            get(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(serde_json::json!({
                    "items": [{ "id": "11111111-1111-1111-1111-111111111111", "name": "nightly", "enabled": true }],
                })))
            }),
        )
        .route(
            "/v1/apps/:id/cron-jobs/:job/run",
            axum::routing::post(
                |headers: HeaderMap, Path((_, job)): Path<(String, String)>| async move {
                    authed(&headers)?;
                    assert_eq!(job, "11111111-1111-1111-1111-111111111111");
                    Ok::<_, StatusCode>(Json(serde_json::json!({ "status": "succeeded", "responseStatus": 200 })))
                },
            ),
        )
        .route(
            "/v1/apps/:id/custom-domain/verify",
            axum::routing::post(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>((
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({ "error": { "code": "dns_not_visible", "message": "TXT record not found" } })),
                ))
            }),
        )
        .route(
            "/v1/apps/:id/data/tables",
            get(|headers: HeaderMap| async move {
                authed(&headers)?;
                Ok::<_, StatusCode>(Json(serde_json::json!({
                    "items": [{ "name": "orders", "primaryKey": ["tenant", "id"] }],
                })))
            }),
        )
        .route(
            "/v1/apps/:id/data/tables/:table/rows/:key",
            axum::routing::delete(
                |headers: HeaderMap, Path((_, table, key)): Path<(String, String, String)>| async move {
                    authed(&headers)?;
                    assert_eq!(table, "orders");
                    // ["acme",42], unpadded base64url, in the catalog's key order.
                    assert_eq!(key, "WyJhY21lIiw0Ml0");
                    Ok::<_, StatusCode>(StatusCode::NO_CONTENT)
                },
            ),
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

/// The contract envelope's `data`, asserting the call succeeded.
fn data_of(status: u16, body: &Value) -> Value {
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["v"], 1, "{body}");
    assert_eq!(body["ok"], true, "{body}");
    body["data"].clone()
}

/// The contract envelope's `error`, asserting the call failed with `exit`.
fn error_of(status: u16, body: &Value, exit: i64) -> Value {
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["v"], 1, "{body}");
    assert_eq!(body["ok"], false, "{body}");
    assert_eq!(body["error"]["exit"], exit, "{body}");
    body["error"].clone()
}

/// `amuxd app list` / `logs` / `whoami` run the shared flows on the daemon's own token.
#[tokio::test]
async fn app_ops_runs_the_shared_flows_as_the_daemon_agent() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) = app_ops(&app, serde_json::json!({ "action": "list" })).await;
    let listed = data_of(status, &body);
    assert_eq!(listed["team_id"], "team-mock");
    assert_eq!(listed["apps"][0]["url"], "https://notes.apps.test");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "logs", "appName": "notes", "sinceMinutes": 5 }),
    )
    .await;
    let logs = data_of(status, &body);
    assert_eq!(logs["app_id"], "a1");
    assert_eq!(logs["since_minutes"], 5);
    assert_eq!(logs["entries"][0]["message"], "listening on :9000");

    let (status, body) = app_ops(&app, serde_json::json!({ "action": "whoami" })).await;
    let me = data_of(status, &body);
    assert_eq!(me["principal"], "daemon_agent");
    assert_eq!(me["teamId"], "team-mock");
}

/// A flow that says no answers with a stable code, its whole sentence, the
/// exit status it stands for, and the next step as a CLI command.
#[tokio::test]
async fn app_ops_refusals_carry_the_cli_next_step() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) =
        app_ops(&app, serde_json::json!({ "action": "logs", "appId": "a2" })).await;
    let e = error_of(status, &body, 6);
    assert_eq!(e["code"], "app_not_deployed");
    let message = e["message"].as_str().unwrap();
    assert!(message.contains("never been deployed"), "{message}");
    assert!(message.contains("`amuxd app deploy`"), "{message}");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "status", "appName": "nope" }),
    )
    .await;
    assert_eq!(error_of(status, &body, 5)["code"], "app_not_found");

    let (status, body) = app_ops(&app, serde_json::json!({ "action": "publish" })).await;
    let e = error_of(status, &body, 2);
    assert_eq!(e["code"], "unknown_action");
    assert_eq!(e["next"], "amuxd app --help");
}

/// No cloud session to act on: a daemon that was never onboarded says so
/// instead of failing on the first request.
#[tokio::test]
async fn app_ops_needs_an_onboarded_daemon() {
    let (app, _dir) = test_app_inner(Some(Arc::new(backend::mock::MockBackend::new()))).await;
    let (status, body) = app_ops(&app, serde_json::json!({ "action": "list" })).await;
    let e = error_of(status, &body, 7);
    assert_eq!(e["code"], "daemon_not_onboarded");
    assert_eq!(e["next"], "amuxd init");
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
    assert_eq!(data_of(status, &body)["app"]["visibility"], "team");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "update", "appId": "a1", "authMode": "third" }),
    )
    .await;
    assert_eq!(error_of(status, &body, 2)["code"], "invalid_auth_mode");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "delete", "workspacePath": "/work/notes", "confirm": true }),
    )
    .await;
    assert_eq!(error_of(status, &body, 2)["code"], "explicit_app_required");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "undeploy", "workspacePath": "/work/notes" }),
    )
    .await;
    assert_eq!(error_of(status, &body, 2)["code"], "explicit_app_required");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "delete", "appId": "a1" }),
    )
    .await;
    let e = error_of(status, &body, 2);
    assert!(e["message"].as_str().unwrap().contains("--yes"));

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "delete", "appId": "a1", "confirm": true }),
    )
    .await;
    assert_eq!(data_of(status, &body)["action"], "delete");
}

/// The resource groups run on the same envelope: env, cron by name, a domain
/// whose DNS is not visible yet, a row addressed by its primary key.
#[tokio::test]
async fn app_ops_resource_groups() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "env_list", "appId": "a1" }),
    )
    .await;
    let env = data_of(status, &body);
    assert_eq!(env["variables"][0]["key"], "STRIPE_KEY");
    assert_eq!(env["variables"][0]["value"], Value::Null);

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "env_set", "appId": "a1",
            "args": { "key": "STRIPE_KEY", "value": "sk_live", "isSecret": true } }),
    )
    .await;
    let set = data_of(status, &body);
    assert_eq!(
        set["variable"]["value"],
        Value::Null,
        "a secret is never echoed"
    );
    assert!(set["note"].as_str().unwrap().contains("`amuxd app deploy`"));

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "cron_run", "appId": "a1", "args": { "job": "nightly" } }),
    )
    .await;
    assert_eq!(data_of(status, &body)["outcome"]["status"], "succeeded");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "cron_run", "appId": "a1", "args": { "job": "weekly" } }),
    )
    .await;
    assert_eq!(error_of(status, &body, 5)["code"], "no_such_name");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "domain_verify", "appId": "a1" }),
    )
    .await;
    let e = error_of(status, &body, 6);
    assert_eq!(e["code"], "dns_not_visible");
    assert_eq!(e["retryable"], true);

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "data_delete", "appId": "a1",
            "args": { "table": "orders", "key": { "id": 42, "tenant": "acme" } } }),
    )
    .await;
    assert_eq!(data_of(status, &body)["action"], "delete_row");
}

/// Long operations run in the daemon: a quick one answers within the grace
/// second, a slow one answers `running` and `op_wait` sees it end.
#[tokio::test]
async fn app_ops_long_operations_run_in_the_daemon() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "undeploy", "appId": "a1" }),
    )
    .await;
    let quick = data_of(status, &body);
    assert_eq!(quick["state"], "succeeded", "{quick}");
    assert_eq!(quick["result"]["complete"], true);
    assert_eq!(quick["app"]["id"], "a1");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "undeploy", "appId": "a2" }),
    )
    .await;
    let slow = data_of(status, &body);
    assert_eq!(slow["state"], "running");
    let op = slow["op"].as_str().unwrap().to_string();

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "status", "appId": "a2" }),
    )
    .await;
    assert_eq!(data_of(status, &body)["active_ops"][0]["op"], op.as_str());

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "op_wait", "args": { "op": op, "timeoutS": 10 } }),
    )
    .await;
    let ended = data_of(status, &body);
    assert_eq!(ended["state"], "succeeded");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "op_list", "args": { "active": false } }),
    )
    .await;
    assert_eq!(data_of(status, &body)["ops"].as_array().unwrap().len(), 2);

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "op_status", "args": { "op": "op_nope" } }),
    )
    .await;
    assert_eq!(error_of(status, &body, 5)["code"], "no_such_op");
}

/// `amuxd app files`: the daemon lists, signs and deletes; purge needs the
/// app named outright and --yes.
#[tokio::test]
async fn app_ops_files() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "files_ls", "appId": "a1", "args": { "prefix": "uploads/" } }),
    )
    .await;
    let ls = data_of(status, &body);
    assert_eq!(ls["files"][0]["path"], "uploads/a.png");
    assert_eq!(ls["folders"][0], "uploads/2026/");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "files_sign_upload", "appId": "a1",
            "args": { "path": "img/logo.png", "contentType": "image/png" } }),
    )
    .await;
    assert_eq!(data_of(status, &body)["url"], "https://bucket.test/put?sig");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "files_purge", "workspacePath": "/nowhere",
            "args": { "confirm": true } }),
    )
    .await;
    assert_eq!(error_of(status, &body, 2)["code"], "explicit_app_required");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "files_purge", "appId": "a1", "args": {} }),
    )
    .await;
    assert_eq!(error_of(status, &body, 2)["code"], "confirmation_required");

    let (status, body) = app_ops(
        &app,
        serde_json::json!({ "action": "files_purge", "appId": "a1", "args": { "confirm": true } }),
    )
    .await;
    assert_eq!(data_of(status, &body)["deleted"], 7);
}

/// `amuxd app access` / `gate`: grants by name, the org grant as visibility,
/// single-rule edits, and the platform's refusal as exit 4.
#[tokio::test]
async fn app_ops_access_and_gate() {
    let backend = backend::mock::MockBackend::new();
    backend.state().cloud_base_url = Some(fake_cloud().await);
    let (app, _dir) = test_app_inner(Some(Arc::new(backend))).await;
    let call = |action: &str, app_id: &str, args: Value| serde_json::json!({ "action": action, "appId": app_id, "args": args });

    let (status, body) = app_ops(&app, call("access_ls", "a1", Value::Null)).await;
    let ls = data_of(status, &body);
    assert_eq!(ls["creator"]["name"], "Owner");
    assert_eq!(ls["grants"][0]["source"], "direct");
    assert_eq!(ls["org"], Value::Null);
    let members: Vec<&str> = ls["candidates"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        members,
        vec!["王芳"],
        "neither the creator nor a grantee is a candidate"
    );
    assert_eq!(ls["candidates"]["agents"][0]["owner"]["name"], "王芳");

    let (status, body) = app_ops(
        &app,
        call(
            "access_grant",
            "a1",
            serde_json::json!({ "who": "王芳", "level": "write" }),
        ),
    )
    .await;
    let grant = data_of(status, &body);
    assert_eq!(grant["grant"]["actor_id"], "m-wang");
    assert_eq!(grant["grant"]["level"], "write");

    let (status, body) = app_ops(
        &app,
        call(
            "access_grant",
            "a2",
            serde_json::json!({ "who": "王芳", "level": "admin" }),
        ),
    )
    .await;
    assert_eq!(
        error_of(status, &body, 4)["code"],
        "inherited_access_not_allowed"
    );

    let (status, body) = app_ops(
        &app,
        call(
            "access_grant",
            "a1",
            serde_json::json!({ "org": true, "level": "read" }),
        ),
    )
    .await;
    assert_eq!(data_of(status, &body)["org"], "read");

    let (status, body) = app_ops(
        &app,
        call(
            "access_grant",
            "a1",
            serde_json::json!({ "org": true, "level": "write" }),
        ),
    )
    .await;
    assert_eq!(error_of(status, &body, 2)["code"], "org_level_unsupported");

    let (status, body) = app_ops(
        &app,
        call(
            "gate_rule_add",
            "a1",
            serde_json::json!({ "path": "/admin", "auth": "required", "audience": "org" }),
        ),
    )
    .await;
    let gate = data_of(status, &body);
    assert_eq!(gate["gate"]["rules"].as_array().unwrap().len(), 2);
    assert_eq!(gate["gate"]["rules"][1]["path"], "/admin");

    let (status, body) = app_ops(
        &app,
        call("gate_rule_rm", "a1", serde_json::json!({ "path": "/nope" })),
    )
    .await;
    let e = error_of(status, &body, 5);
    assert_eq!(e["code"], "no_such_rule");
    assert_eq!(e["next"], "`amuxd app gate show`");

    let (status, body) = app_ops(&app, call("gate_set", "a1", serde_json::json!({}))).await;
    assert_eq!(error_of(status, &body, 2)["code"], "nothing_to_set");
}
