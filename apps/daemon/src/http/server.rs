//! axum HTTP server lifecycle.
//!
//! Exposes [`spawn`] — the single entry point the daemon's main loop calls
//! to bind a listener, install middleware (CORS, tracing, request id), and
//! drive the router until a shutdown signal arrives. Returns an
//! [`HttpHandle`] the caller can drop / `shutdown()` to tear the server
//! down cleanly.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::backend::Backend;
use crate::config::workspace_control::WorkspaceControlStore;
use crate::config::{DaemonConfig, HttpConfig};

use super::cors;
use super::routes;
use super::runtime_adapter::RuntimeAdapter;
use super::state::{DaemonMetadata, HttpState};
use super::tokens::{self, TokenStore};

/// Handle returned by [`spawn`]. Drop or [`HttpHandle::shutdown`] to stop
/// the listener. The handle also exposes the actually-bound port for tests
/// and for clients that need to log it.
pub struct HttpHandle {
    pub local_addr: SocketAddr,
    /// Loopback URL adapters use for `/internal/runtime-context/resolve`.
    pub runtime_context_base_url: Option<String>,
    #[allow(dead_code)]
    pub tokens: TokenStore,
    join: JoinHandle<()>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    runtime_context_join: Option<JoinHandle<()>>,
    runtime_context_shutdown: Option<oneshot::Sender<()>>,
}

impl HttpHandle {
    #[allow(dead_code)]
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.runtime_context_shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.runtime_context_join.take() {
            let _ = join.await;
        }
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = (&mut self.join).await;
    }
}

impl Drop for HttpHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.runtime_context_shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.runtime_context_join.take() {
            join.abort();
        }
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.join.abort();
    }
}

/// Loopback URL adapters use to reach `/internal/runtime-context/resolve`.
/// The public listener may bind `0.0.0.0` or `[::]`; resolver clients must
/// always target an explicit loopback address.
pub(crate) fn loopback_runtime_context_url(requested_bind: SocketAddr, bound: SocketAddr) -> String {
    let port = bound.port();
    match requested_bind.ip() {
        std::net::IpAddr::V4(v4) if v4.is_unspecified() => format!("http://127.0.0.1:{port}"),
        std::net::IpAddr::V6(v6) if v6.is_unspecified() => format!("http://[::1]:{port}"),
        ip if ip.is_loopback() => {
            if ip.is_ipv6() {
                format!("http://[::1]:{port}")
            } else {
                format!("http://127.0.0.1:{port}")
            }
        }
        _ => format!("http://127.0.0.1:{port}"),
    }
}


/// Public bind addresses that are not loopback-reachable need a dedicated
/// loopback listener for `/internal/runtime-context/resolve`.
pub(crate) fn needs_dedicated_runtime_context_listener(requested_bind: SocketAddr) -> bool {
    match requested_bind.ip() {
        std::net::IpAddr::V4(v4) => !(v4.is_unspecified() || v4.is_loopback()),
        std::net::IpAddr::V6(v6) => !(v6.is_unspecified() || v6.is_loopback()),
    }
}

async fn spawn_dedicated_runtime_context_listener(
    state: HttpState,
) -> anyhow::Result<(String, JoinHandle<()>, oneshot::Sender<()>)> {
    use axum::routing::post;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| anyhow::anyhow!("bind runtime-context loopback listener: {e}"))?;
    let addr = listener.local_addr()?;
    let base_url = format!("http://127.0.0.1:{}", addr.port());
    let app = Router::new()
        .route(
            "/internal/runtime-context/resolve",
            post(crate::http::runtime_context::resolve_runtime_context),
        )
        .route(
            "/internal/runtime-context/session-prompt",
            post(crate::http::runtime_context::session_prompt),
        )
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = server.await {
            tracing::error!("runtime-context loopback listener exited with error: {e}");
        }
    });
    Ok((base_url, join, shutdown_tx))
}

/// Spawn the HTTP listener. Errors surface as `anyhow::Result` because
/// the daemon's startup path uses that as the lingua franca for early
/// bring-up failures.
///
/// Pass `Some(store)` to enable the `/v1/workspaces/*` control-plane APIs.
/// Pass `None` to disable them (workspace routes return 404). The latter is
/// the default for tests that only exercise session/runtime behaviour.
// Wide by design: this is the single HTTP bring-up seam; a builder would add
// indirection without removing any of the genuinely-distinct dependencies.
#[allow(clippy::too_many_arguments)]
pub async fn spawn(
    http: HttpConfig,
    meta: DaemonMetadata,
    runtime: Arc<dyn RuntimeAdapter>,
    workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
    runtime_supervisor: Option<Arc<crate::runtime::RuntimeSupervisor>>,
    opencode_settings: Option<Arc<crate::opencode_settings::OpenCodeSettingsService>>,
    sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    register_workspace_tx: Option<crate::http::state::RegisterWorkspaceTx>,
    backend: Option<Arc<dyn Backend>>,
    live_tee: Option<tokio::sync::broadcast::Sender<super::live_events::LiveTeeEvent>>,
    // Daemon-level config surface (`/v1/config/*`, `/v1/setup/*`). All three are
    // `None` in focused tests, which makes those routes 503 rather than panic.
    config_path: Option<std::path::PathBuf>,
    channel_reload_tx: Option<tokio::sync::mpsc::Sender<()>>,
    onboarding: Option<Arc<dyn crate::http::setup::OnboardingService>>,
    local_rpc_tx: Option<crate::http::state::LocalRpcTx>,
    local_live_ingest_tx: Option<crate::http::state::LocalLiveIngestTx>,
    team_skills: Option<Arc<crate::runtime::team_skills::TeamSkillReconciler>>,
    runtime_context: Option<Arc<crate::runtime::context_service::RuntimeContextService>>,
    session_prompt: Option<Arc<crate::runtime::session_prompt::SessionPromptService>>,
) -> anyhow::Result<HttpHandle> {
    // Resolve token + port files (defaults live in DaemonConfig::config_dir).
    let token_path = http
        .token_file
        .clone()
        .unwrap_or_else(DaemonConfig::http_token_path);
    let port_path = http
        .port_file
        .clone()
        .unwrap_or_else(DaemonConfig::http_port_path);

    let tokens =
        TokenStore::load_or_init(&token_path).map_err(|e| anyhow::anyhow!("token store: {e}"))?;

    // Parse + bind. Bind first, log second — surfaces address-in-use early.
    let addr: SocketAddr = http
        .bind
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid http.bind {:?}: {e}", http.bind))?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| anyhow::anyhow!("bind {addr}: {e}"))?;
    let local_addr = listener.local_addr()?;
    tokens::write_port_file(&port_path, local_addr.port());

    tracing::info!(
        bind = %local_addr,
        token_path = %token_path.display(),
        port_path = %port_path.display(),
        "http listener ready"
    );

    // CORS layer must be added before the router is materialised so it
    // sees preflight requests.
    let cors_layer = cors::build(&http.allowed_origins)
        .map_err(|e| anyhow::anyhow!("cors build: {}", e.detail))?;

    // Built from the same backend the routes already hold, so `get_providers`
    // can reconcile `provider.team` against the team's current cloud LLM config
    // before reading it back off disk.
    let managed_llm = backend
        .clone()
        .map(|b| Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(b)));
    // Same shape for team MCP / team env: desktop posts after a Cloud API write
    // so the daemon cache converges immediately instead of waiting for the tick.
    let team_cloud = backend
        .clone()
        .map(|b| Arc::new(crate::runtime::team_cloud_config::TeamCloudConfigResolver::new(b)));

    let state = HttpState::new(
        http,
        tokens.clone(),
        meta,
        runtime,
        workspace_control,
        runtime_supervisor,
        opencode_settings,
        sync_dispatcher,
        register_workspace_tx,
    )
    .with_backend(backend)
    .with_config_admin(config_path, channel_reload_tx, onboarding)
    .with_live_tee(live_tee)
    .with_managed_llm(managed_llm)
    .with_team_cloud(team_cloud)
    .with_team_skills(team_skills)
    .with_local_rpc(local_rpc_tx)
    .with_local_live_ingest(local_live_ingest_tx);
    let state = if let Some(service) = runtime_context {
        state.with_runtime_context(service)
    } else {
        state
    };
    let state = state.with_session_prompt(session_prompt);

    let mut runtime_context_join = None;
    let mut runtime_context_shutdown = None;
    let mut runtime_context_base_url = None;
    if let Some(service) = state.runtime_context.as_ref() {
        let base_url = if needs_dedicated_runtime_context_listener(addr) {
            let (url, join, shutdown_tx) =
                spawn_dedicated_runtime_context_listener(state.clone()).await?;
            runtime_context_join = Some(join);
            runtime_context_shutdown = Some(shutdown_tx);
            url
        } else {
            loopback_runtime_context_url(addr, local_addr)
        };
        runtime_context_base_url = Some(base_url.clone());
        service.set_base_url(base_url);
    }

    spawn_reapers(state.clone());
    let mut app: Router = routes::build(state);
    if let Some(layer) = cors_layer {
        app = app.layer(layer);
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = server.await {
            tracing::error!("http listener exited with error: {e}");
        } else {
            tracing::info!("http listener shut down cleanly");
        }
    });

    Ok(HttpHandle {
        local_addr,
        runtime_context_base_url,
        tokens,
        join,
        shutdown_tx: Some(shutdown_tx),
        runtime_context_join,
        runtime_context_shutdown,
    })
}

/// Background reaper: prunes expired session tokens every minute.
/// Idle-session eviction is the runtime adapter's responsibility (the
/// adapter owns the session table); this only handles the auth side.
fn spawn_reapers(state: HttpState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let pruned = state.tokens.sweep_expired();
            if pruned > 0 {
                tracing::debug!(pruned, "expired session tokens swept");
            }
        }
    });
}

/// Convenience helper: capture the metadata most callers want without
/// pulling DaemonConfig types into every module.
pub fn metadata(actor_id: String, backend_kind: impl Into<String>) -> DaemonMetadata {
    DaemonMetadata {
        version: env!("CARGO_PKG_VERSION"),
        started_at: chrono::Utc::now(),
        actor_id,
        backend_kind: backend_kind.into(),
        device_id: crate::device_id::daemon_device_id(),
        configured_agent_types: Vec::new(),
        agent_types_advertise: Default::default(),
        mqtt_connected: Default::default(),
        mqtt_recovery: None,
        mqtt_snapshot: std::sync::Arc::new(parking_lot::RwLock::new(
            crate::mqtt::MqttSnapshot::default(),
        )),
    }
}

#[allow(dead_code)]
fn _arc_size_check() {
    // Force HttpState clone to be cheap (Arc fields only).
    fn assert_send<T: Send + Sync>(_: &T) {}
    let h = HttpConfig::default();
    assert_send(&Arc::new(h));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HttpConfig;

    /// A fresh, empty sync dispatcher for HTTP harness tests.
    fn test_dispatcher() -> crate::sync::dispatch::SyncDispatcher {
        crate::sync::dispatch::SyncDispatcher::new(
            crate::sync::secret_store::SecretStore::new(),
            None,
        )
    }

    #[tokio::test]
    async fn spawn_and_healthz_responds() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            allowed_origins: vec![],
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let meta = metadata("actor-test".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let url = format!("http://{}/v1/healthz", handle.local_addr);
        let body: serde_json::Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert_eq!(body["status"], "ok");
        handle.shutdown().await;
    }

    /// Helper: spawn a server + mint a session token with all scopes.
    async fn boot() -> (HttpHandle, reqwest::Client, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            heartbeat_interval: std::time::Duration::from_secs(5),
            ..HttpConfig::default()
        };
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            metadata("actor".into(), "test"),
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root = std::fs::read_to_string(&token_path)
            .unwrap()
            .trim()
            .to_owned();
        let client = reqwest::Client::new();
        let resp: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root)
            .json(&serde_json::json!({"ttl_seconds": 3600}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_token = resp["token"].as_str().unwrap().to_string();
        std::mem::forget(dir); // keep tempdir alive for the duration of the test
        (handle, client, base, session_token)
    }

    #[tokio::test]
    async fn rate_limit_returns_429_with_retry_after() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            rate_limit_rps: 1,
            rate_limit_burst: 2,
            heartbeat_interval: std::time::Duration::from_secs(5),
            ..HttpConfig::default()
        };
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            metadata("a".into(), "test"),
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let client = reqwest::Client::new();
        let mut last_status = 0;
        for _ in 0..10 {
            let r = client
                .get(format!("{base}/v1/healthz"))
                .send()
                .await
                .unwrap();
            last_status = r.status().as_u16();
            if last_status == 429 {
                assert!(r.headers().get("retry-after").is_some());
                assert_eq!(
                    r.headers().get("content-type").unwrap(),
                    "application/problem+json"
                );
                handle.shutdown().await;
                return;
            }
        }
        panic!("expected 429 within 10 requests; last status was {last_status}");
    }

    #[tokio::test]
    async fn create_session_and_stream_tokens() {
        let (handle, client, base, session_token) = boot().await;

        let resp: serde_json::Value = client
            .post(format!("{base}/v1/sessions"))
            .bearer_auth(&session_token)
            .json(&serde_json::json!({"agent_type": "stub"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_id = resp["session_id"].as_str().unwrap().to_string();

        // Send a prompt.
        let ack = client
            .post(format!("{base}/v1/sessions/{session_id}/prompt"))
            .bearer_auth(&session_token)
            .header("idempotency-key", "k1")
            .json(&serde_json::json!({"text": "hi"}))
            .send()
            .await
            .unwrap();
        assert_eq!(ack.status().as_u16(), 202);

        // Replay events — should include the token deltas plus
        // turn.finished.
        let mut saw_finished = false;
        for _ in 0..20 {
            let page: serde_json::Value = client
                .get(format!("{base}/v1/sessions/{session_id}/events?since=0"))
                .bearer_auth(&session_token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if page["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "turn_finished")
            {
                saw_finished = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(saw_finished, "stub agent should publish turn_finished");

        // Idempotent prompt re-submit returns the same ack.
        let ack2: serde_json::Value = client
            .post(format!("{base}/v1/sessions/{session_id}/prompt"))
            .bearer_auth(&session_token)
            .header("idempotency-key", "k1")
            .json(&serde_json::json!({"text": "hi"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let prompt_id = ack2["prompt_id"].as_str().unwrap();
        assert!(!prompt_id.is_empty());

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn sse_stream_yields_frames() {
        let (handle, client, base, session_token) = boot().await;
        let resp: serde_json::Value = client
            .post(format!("{base}/v1/sessions"))
            .bearer_auth(&session_token)
            .json(&serde_json::json!({"agent_type":"stub"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_id = resp["session_id"].as_str().unwrap().to_string();

        // Open the SSE stream BEFORE sending the prompt so the live
        // events arrive on the wire, not just through the backlog.
        let mut stream_resp = client
            .get(format!(
                "{base}/v1/sessions/{session_id}/stream?access_token={session_token}"
            ))
            .send()
            .await
            .unwrap();
        // Give the server a beat to wire up the broadcast receiver.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = client
            .post(format!("{base}/v1/sessions/{session_id}/prompt"))
            .bearer_auth(&session_token)
            .json(&serde_json::json!({"text":"yo"}))
            .send()
            .await
            .unwrap();
        assert!(stream_resp
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));

        // Read until we see a turn_finished frame or the connection
        // closes. 2 second budget is enough for the stub's 5ms-per-char
        // emitter to finish "yo" (2 chars) plus session bookkeeping.
        let mut buf = Vec::<u8>::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut saw_finished = false;
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), stream_resp.chunk())
                .await
            {
                Ok(Ok(Some(chunk))) => {
                    buf.extend_from_slice(&chunk);
                    let s = String::from_utf8_lossy(&buf);
                    if s.contains("event: turn.finished") {
                        saw_finished = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(saw_finished, "SSE stream must publish turn_finished");
        drop(stream_resp);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn last_event_id_below_window_returns_410() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            max_event_backlog: 2, // tiny window so we fall off quickly
            heartbeat_interval: std::time::Duration::from_secs(5),
            ..HttpConfig::default()
        };
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(2);
        let handle = spawn(
            cfg,
            metadata("actor".into(), "test"),
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root = std::fs::read_to_string(&token_path)
            .unwrap()
            .trim()
            .to_owned();
        let client = reqwest::Client::new();
        let exchange: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root)
            .json(&serde_json::json!({"ttl_seconds":3600}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_token = exchange["token"].as_str().unwrap().to_string();

        let snap: serde_json::Value = client
            .post(format!("{base}/v1/sessions"))
            .bearer_auth(&session_token)
            .json(&serde_json::json!({
                "agent_type":"stub",
                "initial_prompt":"abcdefghij"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_id = snap["session_id"].as_str().unwrap().to_string();

        // Wait for the stub to publish enough events to push seq 1 out of
        // the 2-slot ring.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let resp = client
            .get(format!("{base}/v1/sessions/{session_id}/stream"))
            .bearer_auth(&session_token)
            .header("last-event-id", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 410);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["code"], "event_gone");

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn auth_exchange_requires_root_and_returns_token() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let meta = metadata("actor-x".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root_token = std::fs::read_to_string(&token_path).unwrap();
        let root_token = root_token.trim();
        let client = reqwest::Client::new();

        // Without auth → 401.
        let resp = client
            .post(format!("{base}/v1/auth/exchange"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/problem+json"
        );

        // With root token → 200 + session token.
        let resp: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(root_token)
            .json(&serde_json::json!({"scopes":["sessions:read"], "ttl_seconds": 600}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_token = resp["token"].as_str().unwrap().to_string();
        assert!(!session_token.is_empty());
        assert_eq!(resp["scopes"][0], "sessions:read");

        // Session token is rejected by the root-protected endpoint.
        let resp = client
            .get(format!("{base}/v1/auth/tokens"))
            .bearer_auth(&session_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401);

        // But the listing succeeds with the root token.
        let listed: serde_json::Value = client
            .get(format!("{base}/v1/auth/tokens"))
            .bearer_auth(root_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed["tokens"].as_array().unwrap().len(), 1);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn info_endpoint_includes_actor() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let meta = metadata("actor-abc".into(), "cloud_api");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let url = format!("http://{}/v1/info", handle.local_addr);
        let body: serde_json::Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert_eq!(body["actor_id"], "actor-abc");
        assert_eq!(body["backend_kind"], "cloud_api");
        assert!(body["uptime_seconds"].as_i64().unwrap() >= 0);
        handle.shutdown().await;
    }

    // `boot()` mints a default-scope token (no `workspace:write`), so a
    // `/v1/team/link` POST with it is rejected by `require_scope` *before* any
    // daemon-config / filesystem work — a hermetic check of the route wiring.
    #[tokio::test]
    async fn team_link_requires_workspace_write_scope() {
        let (handle, client, base, session_token) = boot().await;
        let resp = client
            .post(format!("{base}/v1/team/link"))
            .bearer_auth(&session_token)
            .json(&serde_json::json!({"path": "/tmp/ws"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403);
        handle.shutdown().await;
    }

    // `boot()` mints a default-scope token, which includes `workspace:read`, so
    // `GET /v1/team/sync/status` is authorized. For an unknown team the
    // dispatcher returns the zero-value `SyncStatus` (`syncing: false`) without
    // touching the filesystem or daemon config — a hermetic check of the route +
    // dispatcher wiring through `HttpState`.
    #[tokio::test]
    async fn team_sync_status_returns_default_for_unknown_team() {
        let (handle, client, base, session_token) = boot().await;
        let resp = client
            .get(format!("{base}/v1/team/sync/status?teamId=t"))
            .bearer_auth(&session_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["syncing"], false);
        handle.shutdown().await;
    }

    // `GET /v1/team/conflicts` for an unknown team is hermetic: the OSS sidecar
    // scan runs against `~/.amuxd/teams/zzznonexistent/teamclu-team` (which does
    // not exist — read-only, returns no files) and the in-memory dispatcher
    // status is the zero value (`conflicts == 0`), so no git-backup marker is
    // appended. The result is an empty array without touching real team state.
    #[tokio::test]
    async fn team_conflicts_empty_for_unknown_team() {
        let (handle, client, base, session_token) = boot().await;
        let resp = client
            .get(format!("{base}/v1/team/conflicts?teamId=zzznonexistent"))
            .bearer_auth(&session_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body, serde_json::json!([]));
        handle.shutdown().await;
    }

    // With `workspace:write` granted, an empty `path` is rejected by the
    // handler's own validation — again before the single-team config load, so
    // the test never touches the real `~/.amuxd/daemon.toml`.
    #[tokio::test]
    async fn team_link_takes_a_pathless_body_while_unlink_still_requires_one() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            heartbeat_interval: std::time::Duration::from_secs(5),
            ..HttpConfig::default()
        };
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            metadata("actor".into(), "test"),
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
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
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root = std::fs::read_to_string(&token_path)
            .unwrap()
            .trim()
            .to_owned();
        let client = reqwest::Client::new();
        let exchanged: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root)
            .json(&serde_json::json!({
                "scopes": ["workspace:write"],
                "ttl_seconds": 3600,
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let token = exchanged["token"].as_str().unwrap().to_string();

        // Link no longer rejects a pathless body: the team's own directory is
        // not a workspace's, and materializing it is exactly what a client with
        // no folder open asks for. Whitespace reads as "no workspace named".
        let resp = client
            .post(format!("{base}/v1/team/link"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"path": "   "}))
            .send()
            .await
            .unwrap();
        assert_ne!(
            resp.status().as_u16(),
            422,
            "a missing workspace path is not a validation error any more"
        );

        // Unlink still requires one — it removes a *workspace's* link.
        // `HttpError::validation` → 422 Unprocessable Entity.
        let resp = client
            .post(format!("{base}/v1/team/unlink"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"path": "   "}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 422);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn rpc_route_returns_503_without_bridge() {
        let (handle, client, base, token) = boot().await;
        let resp = client
            .post(format!("{base}/v1/rpc"))
            .bearer_auth(&token)
            .body(vec![1u8, 2, 3])
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 503);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn rpc_route_requires_auth_and_round_trips_protobuf() {
        use prost::Message as _;

        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            heartbeat_interval: std::time::Duration::from_secs(5),
            ..HttpConfig::default()
        };
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);

        // Stub actor loop: echoes a successful RpcResponse carrying the same
        // request_id, exactly like `dispatch_local_rpc` would.
        let (rpc_tx, mut rpc_rx) =
            tokio::sync::mpsc::channel::<crate::http::state::LocalRpcRequest>(4);
        tokio::spawn(async move {
            while let Some(req) = rpc_rx.recv().await {
                let request =
                    crate::proto::teamclu::RpcRequest::decode(req.payload.as_slice()).unwrap();
                let response = crate::proto::teamclu::RpcResponse {
                    request_id: request.request_id,
                    success: true,
                    error: String::new(),
                    requester_client_id: request.requester_client_id,
                    requester_actor_id: request.requester_actor_id,
                    result: None,
                };
                let _ = req.reply_tx.send(Ok(response.encode_to_vec()));
            }
        });

        let handle = spawn(
            cfg,
            metadata("actor".into(), "test"),
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(rpc_tx),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root = std::fs::read_to_string(&token_path)
            .unwrap()
            .trim()
            .to_owned();
        let client = reqwest::Client::new();

        let request = crate::proto::teamclu::RpcRequest {
            request_id: "req-42".into(),
            requester_client_id: "client-1".into(),
            requester_actor_id: "actor-1".into(),
            ..Default::default()
        };
        let body = request.encode_to_vec();

        // No bearer token → 401 before the bridge is ever consulted.
        let resp = client
            .post(format!("{base}/v1/rpc"))
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401);

        // Authenticated (default scopes include sessions:write) → the reply
        // body is the RpcResponse protobuf the actor loop produced.
        let exchanged: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root)
            .json(&serde_json::json!({"ttl_seconds": 3600}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let token = exchanged["token"].as_str().unwrap().to_string();
        let resp = client
            .post(format!("{base}/v1/rpc"))
            .bearer_auth(&token)
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("application/x-protobuf")
        );
        let bytes = resp.bytes().await.unwrap();
        let decoded = crate::proto::teamclu::RpcResponse::decode(bytes.as_ref()).unwrap();
        assert!(decoded.success);
        assert_eq!(decoded.request_id, "req-42");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn team_management_routes_use_the_daemon_backend() {
        let home = tempfile::tempdir().unwrap();
        let team_id = "team-manage-http-route-test";

        let backend = Arc::new(crate::backend::mock::MockBackend::with_identity(
            team_id,
            "agent-manage",
        ));
        {
            let mut state = backend.state();
            state.team_skills.insert(
                team_id.to_string(),
                vec![crate::backend::TeamSkillRow {
                    slug: "managed-skill".to_string(),
                    summary: "Managed through daemon HTTP".to_string(),
                    category: "test".to_string(),
                    when_to_use: String::new(),
                    when_not_to_use: String::new(),
                    requires: None,
                    owner_actor_id: None,
                    latest_version: 2,
                    installed: false,
                    installed_version: None,
                }],
            );
        }
        let backend_dyn: Arc<dyn Backend> = backend.clone();
        let reconciler = Arc::new(crate::runtime::team_skills::TeamSkillReconciler::new(
            backend_dyn.clone(),
        ));

        let token_path = home.path().join("http-token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(home.path().join("http-port")),
            ..HttpConfig::default()
        };
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(32);
        let handle = spawn(
            cfg,
            metadata("agent-manage".into(), "test"),
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
            Some(backend_dyn),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(reconciler),
            None,
            None,
        )
        .await
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root = std::fs::read_to_string(&token_path).unwrap();
        let client = reqwest::Client::new();
        let exchanged: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(root.trim())
            .json(&serde_json::json!({
                "scopes": ["workspace:read", "workspace:write"]
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let token = exchanged["token"].as_str().unwrap();

        let skills: serde_json::Value = client
            .get(format!("{base}/v1/team/skills"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(skills["teamId"], team_id);
        assert_eq!(skills["skills"][0]["slug"], "managed-skill");

        let response = client
            .put(format!("{base}/v1/team/skills/managed-skill/install"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "version": 2 }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            backend.state().team_skill_installs,
            vec![(team_id.to_string(), "managed-skill".to_string(), 2)]
        );

        handle.shutdown().await;
    }

    #[test]
    fn loopback_runtime_context_url_normalizes_bind_addresses() {
        let bound_v4: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        assert_eq!(
            loopback_runtime_context_url("127.0.0.1:0".parse().unwrap(), bound_v4),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            loopback_runtime_context_url("0.0.0.0:0".parse().unwrap(), bound_v4),
            "http://127.0.0.1:8787"
        );
        let bound_v6: SocketAddr = "[::1]:8787".parse().unwrap();
        assert_eq!(
            loopback_runtime_context_url("[::1]:0".parse().unwrap(), bound_v6),
            "http://[::1]:8787"
        );
        assert_eq!(
            loopback_runtime_context_url("[::]:0".parse().unwrap(), bound_v6),
            "http://[::1]:8787"
        );
    }

    #[tokio::test]
    async fn runtime_context_resolve_loopback_only() {
        use crate::proto::amux;
        use crate::runtime::context_registry::ResolveRuntimeContextRequest;
        use crate::runtime::context_service::RuntimeContextService;

        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let service = Arc::new(RuntimeContextService::new());
        service.register_attached_session(
            amux::AgentType::Opencode,
            "gen-test",
            "backend-a",
            "teamclu-a",
            "runtime-a",
        );
        let env = service.env_for_generation(amux::AgentType::Opencode, "gen-test");
        let token = env
            .get("TEAMCLU_RUNTIME_CONTEXT_TOKEN")
            .cloned()
            .expect("token");
        let meta = metadata("actor-test".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(Arc::clone(&service)),
            None,
        )
        .await
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let client = reqwest::Client::new();
        let body = ResolveRuntimeContextRequest {
            backend_session_id: "backend-a".into(),
            host_generation_id: "gen-test".into(),
            backend_kind: "opencode".into(),
        };
        let ok: serde_json::Value = client
            .post(format!("{base}/internal/runtime-context/resolve"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ok["teamcluSessionId"], "teamclu-a");

        let bad_token = client
            .post(format!("{base}/internal/runtime-context/resolve"))
            .bearer_auth("rtctx_invalid")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(bad_token.status().as_u16(), 401);

        assert_eq!(bad_token.status().as_u16(), 401);

        let unknown: reqwest::Response = client
            .post(format!("{base}/internal/runtime-context/resolve"))
            .bearer_auth(&token)
            .json(&ResolveRuntimeContextRequest {
                backend_session_id: "missing-backend".into(),
                host_generation_id: "gen-test".into(),
                backend_kind: "opencode".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(unknown.status().as_u16(), 404);

        let stale_gen: reqwest::Response = client
            .post(format!("{base}/internal/runtime-context/resolve"))
            .bearer_auth(&token)
            .json(&ResolveRuntimeContextRequest {
                backend_session_id: "backend-a".into(),
                host_generation_id: String::new(),
                backend_kind: "opencode".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(stale_gen.status().as_u16(), 409);

        service.clear_generation(amux::AgentType::Opencode, "gen-test");
        let revoked_token: reqwest::Response = client
            .post(format!("{base}/internal/runtime-context/resolve"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(revoked_token.status().as_u16(), 401);

        handle.shutdown().await;
    }

    #[test]
    fn needs_dedicated_runtime_context_listener_for_public_bind() {
        let lan: SocketAddr = "192.168.1.10:8080".parse().unwrap();
        assert!(needs_dedicated_runtime_context_listener(lan));
        let loopback: SocketAddr = "127.0.0.1:8080".parse().unwrap();
        assert!(!needs_dedicated_runtime_context_listener(loopback));
        let any: SocketAddr = "0.0.0.0:8080".parse().unwrap();
        assert!(!needs_dedicated_runtime_context_listener(any));
    }

    #[tokio::test]
    async fn dedicated_runtime_context_listener_resolves_registered_session() {
        use crate::proto::amux;
        use crate::runtime::context_registry::ResolveRuntimeContextRequest;
        use crate::runtime::context_service::RuntimeContextService;

        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let service = Arc::new(RuntimeContextService::new());
        service.register_attached_session(
            amux::AgentType::Opencode,
            "gen-dedicated",
            "backend-z",
            "teamclu-z",
            "runtime-z",
        );
        let env = service.env_for_generation(amux::AgentType::Opencode, "gen-dedicated");
        let token = env
            .get("TEAMCLU_RUNTIME_CONTEXT_TOKEN")
            .cloned()
            .expect("token");
        let meta = metadata("actor-test".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let state = HttpState::new(
            cfg,
            tokens::TokenStore::load_or_init(&dir.path().join("token")).unwrap(),
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
        )
        .with_runtime_context(Arc::clone(&service));

        let (dedicated_base, join, shutdown_tx) =
            spawn_dedicated_runtime_context_listener(state).await.unwrap();
        assert!(dedicated_base.starts_with("http://127.0.0.1:"));

        let client = reqwest::Client::new();
        let ok: serde_json::Value = client
            .post(format!("{dedicated_base}/internal/runtime-context/resolve"))
            .bearer_auth(&token)
            .json(&ResolveRuntimeContextRequest {
                backend_session_id: "backend-z".into(),
                host_generation_id: "gen-dedicated".into(),
                backend_kind: "opencode".into(),
            })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ok["teamcluSessionId"], "teamclu-z");

        let _ = shutdown_tx.send(());
        let _ = join.await;
    }

    fn seed_session_prompt_backend(
        backend: &Arc<crate::backend::mock::MockBackend>,
        session_id: &str,
        actors: &[(&str, &str, &str)],
    ) {
        use crate::backend::{
            ActorDirectoryRow, BackendParticipantRow, BackendSessionAndParticipants,
            BackendSessionRow,
        };
        let now = chrono::Utc::now();
        let mut st = backend.state();
        st.sessions.insert(
            session_id.to_string(),
            BackendSessionAndParticipants {
                session: BackendSessionRow {
                    id: session_id.to_string(),
                    team_id: "team-mock".to_string(),
                    created_by_actor_id: None,
                    primary_agent_id: None,
                    mode: "collab".to_string(),
                    title: "Test chat".to_string(),
                    summary: String::new(),
                    idea_id: None,
                    created_at: now,
                },
                participants: actors
                    .iter()
                    .map(|(id, _, _)| BackendParticipantRow {
                        session_id: session_id.to_string(),
                        actor_id: id.to_string(),
                        role: None,
                        joined_at: now,
                    })
                    .collect(),
            },
        );
        for (id, name, kind) in actors {
            st.actors_by_id.insert(
                id.to_string(),
                ActorDirectoryRow {
                    id: id.to_string(),
                    display_name: Some(name.to_string()),
                    kind: Some(kind.to_string()),
                },
            );
        }
    }

    #[tokio::test]
    async fn runtime_context_session_prompt_returns_roster_and_append_text() {
        use crate::backend::mock::MockBackend;
        use crate::proto::amux;
        use crate::runtime::context_registry::ResolveRuntimeContextRequest;
        use crate::runtime::context_service::RuntimeContextService;
        use crate::runtime::session_prompt::SessionPromptService;
        use crate::runtime::RuntimeManager;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let service = Arc::new(RuntimeContextService::new());
        service.register_attached_session(
            amux::AgentType::Pi,
            "gen-prompt",
            "backend-pi",
            "teamclu-prompt",
            "runtime-prompt",
        );
        let env = service.env_for_generation(amux::AgentType::Pi, "gen-prompt");
        let token = env
            .get("TEAMCLU_RUNTIME_CONTEXT_TOKEN")
            .cloned()
            .expect("token");

        let backend = Arc::new(MockBackend::default());
        seed_session_prompt_backend(
            &backend,
            "teamclu-prompt",
            &[
                ("agent-1", "小助手", "agent"),
                ("human-1", "Alice", "member"),
            ],
        );

        let manager = Arc::new(Mutex::new(RuntimeManager::new(
            std::collections::HashMap::new(),
            None,
        )));
        {
            let mut mgr = manager.lock().await;
            mgr.add_test_runtime("runtime-prompt");
            mgr.get_handle_mut("runtime-prompt")
                .unwrap()
                .owner_actor_id = "agent-1".into();
        }
        let prompt_service = Arc::new(SessionPromptService::new(
            Arc::clone(&manager),
            backend.clone(),
        ));

        let meta = metadata("actor-test".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
            Some(backend),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(Arc::clone(&service)),
            Some(prompt_service),
        )
        .await
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let client = reqwest::Client::new();
        let ok: serde_json::Value = client
            .post(format!("{base}/internal/runtime-context/session-prompt"))
            .bearer_auth(&token)
            .json(&ResolveRuntimeContextRequest {
                backend_session_id: "backend-pi".into(),
                host_generation_id: "gen-prompt".into(),
                backend_kind: "pi".into(),
            })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ok["teamcluSessionId"], "teamclu-prompt");
        assert_eq!(ok["agentDisplayName"], "小助手");
        assert_eq!(ok["rosterResolved"], true);
        assert!(ok["appendSystemPrompt"]
            .as_str()
            .unwrap()
            .contains("Your display name is \"小助手\""));
        let participants = ok["participants"].as_array().unwrap();
        assert_eq!(participants.len(), 2);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn runtime_context_session_prompt_returns_503_when_service_missing() {
        use crate::proto::amux;
        use crate::runtime::context_registry::ResolveRuntimeContextRequest;
        use crate::runtime::context_service::RuntimeContextService;

        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let service = Arc::new(RuntimeContextService::new());
        service.register_attached_session(
            amux::AgentType::Pi,
            "gen-prompt",
            "backend-pi",
            "teamclu-prompt",
            "runtime-prompt",
        );
        let env = service.env_for_generation(amux::AgentType::Pi, "gen-prompt");
        let token = env
            .get("TEAMCLU_RUNTIME_CONTEXT_TOKEN")
            .cloned()
            .expect("token");
        let meta = metadata("actor-test".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let handle = spawn(
            cfg,
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(Arc::clone(&service)),
            None,
        )
        .await
        .unwrap();
        let base = format!("http://{}", handle.local_addr);
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{base}/internal/runtime-context/session-prompt"))
            .bearer_auth(&token)
            .json(&ResolveRuntimeContextRequest {
                backend_session_id: "backend-pi".into(),
                host_generation_id: "gen-prompt".into(),
                backend_kind: "pi".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 503);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn dedicated_runtime_context_listener_serves_session_prompt() {
        use crate::backend::mock::MockBackend;
        use crate::proto::amux;
        use crate::runtime::context_registry::ResolveRuntimeContextRequest;
        use crate::runtime::context_service::RuntimeContextService;
        use crate::runtime::session_prompt::SessionPromptService;
        use crate::runtime::RuntimeManager;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let service = Arc::new(RuntimeContextService::new());
        service.register_attached_session(
            amux::AgentType::Pi,
            "gen-dedicated-prompt",
            "backend-z",
            "teamclu-z",
            "runtime-z",
        );
        let env = service.env_for_generation(amux::AgentType::Pi, "gen-dedicated-prompt");
        let token = env
            .get("TEAMCLU_RUNTIME_CONTEXT_TOKEN")
            .cloned()
            .expect("token");

        let backend = Arc::new(MockBackend::default());
        seed_session_prompt_backend(
            &backend,
            "teamclu-z",
            &[("agent-z", "Bot", "agent")],
        );
        let manager = Arc::new(Mutex::new(RuntimeManager::new(
            std::collections::HashMap::new(),
            None,
        )));
        {
            let mut mgr = manager.lock().await;
            mgr.add_test_runtime("runtime-z");
            mgr.get_handle_mut("runtime-z")
                .unwrap()
                .owner_actor_id = "agent-z".into();
        }
        let prompt_service = Arc::new(SessionPromptService::new(
            Arc::clone(&manager),
            backend,
        ));

        let meta = metadata("actor-test".into(), "test");
        let runtime = crate::http::runtime_adapter::StubRuntimeAdapter::new(256);
        let state = HttpState::new(
            cfg,
            tokens::TokenStore::load_or_init(&dir.path().join("token")).unwrap(),
            meta,
            runtime,
            None,
            None,
            None,
            test_dispatcher(),
            None,
        )
        .with_runtime_context(Arc::clone(&service))
        .with_session_prompt(Some(prompt_service));

        let (dedicated_base, join, shutdown_tx) =
            spawn_dedicated_runtime_context_listener(state).await.unwrap();
        let client = reqwest::Client::new();
        let ok: serde_json::Value = client
            .post(format!("{dedicated_base}/internal/runtime-context/session-prompt"))
            .bearer_auth(&token)
            .json(&ResolveRuntimeContextRequest {
                backend_session_id: "backend-z".into(),
                host_generation_id: "gen-dedicated-prompt".into(),
                backend_kind: "pi".into(),
            })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ok["agentDisplayName"], "Bot");

        let _ = shutdown_tx.send(());
        let _ = join.await;
    }
}
