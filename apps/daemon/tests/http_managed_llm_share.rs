//! Shared `ManagedLlmResolver` between daemon runtime assemble and HTTP
//! provider reads. Two independent resolvers mint different tokens and write
//! different baseURLs, which marks every isolation domain for replacement.

include!("support/crate_modules.rs");

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use config::{HttpConfig, OpenCodeCompatStore, WorkspaceControlStore};
use runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use runtime::managed_llm::ManagedLlmResolver;
use runtime::opencode_http::host_pool::{
    GenerationFactory, HostGeneration, HostLease, HostLifecycle, OpenCodeHostPool,
};
use runtime::opencode_http::process_registry::ServeProcessRegistry;
use runtime::opencode_http::supervisor::{ServeSupervisor, ShutdownOutcome};
use runtime::RuntimeSupervisor;
use tokio::sync::Mutex;

fn ws_id(path: &std::path::Path) -> String {
    URL_SAFE_NO_PAD.encode(path.to_str().unwrap())
}

fn enabled_llm(name: &str) -> backend::ManagedLlmConfig {
    backend::ManagedLlmConfig {
        enabled: true,
        base_url: Some("https://gateway.example/v1".to_string()),
        name: Some(name.to_string()),
        models: vec![backend::ManagedLlmModelInfo {
            id: "model-a".to_string(),
            name: "model-a".to_string(),
        }],
    }
}

fn team_provider_json() -> serde_json::Value {
    let raw = std::fs::read_to_string(
        teamclu_runtime_env::opencode_config::global_opencode_config_path(),
    )
    .unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn team_provider_bytes() -> Vec<u8> {
    std::fs::read(teamclu_runtime_env::opencode_config::global_opencode_config_path()).unwrap()
}

struct CountingFactory {
    starts: AtomicUsize,
}

#[async_trait]
impl GenerationFactory for CountingFactory {
    async fn start(
        &self,
        generation_id: String,
        _domain: IsolationDomainKey,
        revision: ProcessEnvRevision,
        env: HashMap<String, String>,
    ) -> Result<Arc<ServeSupervisor>, String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(ServeSupervisor::new(
            generation_id,
            Arc::new(ServeProcessRegistry::new(
                tempfile::tempdir().unwrap().keep().join("pgids.json"),
            )),
            env,
            revision,
        )))
    }

    fn stop(&self, _generation: &HostGeneration) -> ShutdownOutcome {
        ShutdownOutcome::Stopped
    }
}

struct SharedResolverApp {
    handle: crate::http::HttpHandle,
    client: reqwest::Client,
    base: String,
    session_token: String,
    workspace_id: String,
    resolver: Arc<ManagedLlmResolver>,
    mock: backend::mock::MockBackend,
    pool: Option<Arc<OpenCodeHostPool>>,
    factory: Option<Arc<CountingFactory>>,
    _lease: Option<HostLease>,
    _home: test_brand_env::BrandEnvGuard,
    _amuxd: tempfile::TempDir,
    _http: tempfile::TempDir,
    _workspace: tempfile::TempDir,
}

impl SharedResolverApp {
    async fn boot(with_host_pool: bool) -> Self {
        let amuxd = tempfile::tempdir().expect("amuxd home");
        let home = test_brand_env::BrandEnvGuard::set_amuxd_home(amuxd.path());
        std::fs::write(
            amuxd.path().join("daemon.toml"),
            "active_team = \"team-x\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(amuxd.path().join("teams/team-x/state")).unwrap();

        let workspace = tempfile::tempdir().expect("workspace");
        let workspace_id = ws_id(workspace.path());

        let mock = backend::mock::MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), enabled_llm("Team"));
        let backend: Arc<dyn backend::Backend> = Arc::new(mock.clone());
        let resolver = Arc::new(ManagedLlmResolver::new(backend.clone()));

        let http_dir = tempfile::tempdir().expect("http dir");
        let token_path = http_dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(http_dir.path().join("port")),
            heartbeat_interval: Duration::from_secs(5),
            ..HttpConfig::default()
        };

        let manager = Arc::new(Mutex::new(runtime::RuntimeManager::new(
            HashMap::new(),
            None,
        )));
        let (pool, factory, lease, runtime_supervisor) = if with_host_pool {
            let factory = Arc::new(CountingFactory {
                starts: AtomicUsize::new(0),
            });
            let pool = OpenCodeHostPool::new(factory.clone());
            let env = HashMap::from([("SENTINEL".to_string(), "a".to_string())]);
            let revision = ProcessEnvRevision::from_bindings(&env);
            let lease = pool
                .acquire(
                    IsolationDomainKey::Workspace("ws-a".into()),
                    revision,
                    env,
                    Instant::now() + Duration::from_secs(2),
                )
                .await
                .unwrap();
            let supervisor = RuntimeSupervisor::new_with_host_pool(manager.clone(), pool.clone());
            (Some(pool), Some(factory), Some(lease), Some(supervisor))
        } else {
            (None, None, None, None)
        };

        let runtime = crate::http::runtime_adapter::RuntimeManagerAdapter::new(manager, 256, None);
        let workspace_control: Arc<dyn WorkspaceControlStore> =
            Arc::new(OpenCodeCompatStore::new());
        let handle = crate::http::spawn_with_refresh_watch_registry(
            cfg,
            crate::http::server::metadata("actor".into(), "test"),
            runtime,
            Some(workspace_control),
            runtime_supervisor,
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
            None,
            Some(resolver.clone()),
        )
        .await
        .expect("spawn http server");

        let base = format!("http://{}", handle.local_addr);
        let root = std::fs::read_to_string(&token_path)
            .expect("read root token")
            .trim()
            .to_owned();
        let client = reqwest::Client::new();
        let resp: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root)
            .json(&serde_json::json!({"ttl_seconds": 3600}))
            .send()
            .await
            .expect("exchange response")
            .error_for_status()
            .expect("exchange status")
            .json()
            .await
            .expect("exchange body");
        let session_token = resp["token"].as_str().expect("session token").to_string();

        Self {
            handle,
            client,
            base,
            session_token,
            workspace_id,
            resolver,
            mock,
            pool,
            factory,
            _lease: lease,
            _home: home,
            _amuxd: amuxd,
            _http: http_dir,
            _workspace: workspace,
        }
    }

    async fn get_providers(&self) {
        self.client
            .get(format!(
                "{}/v1/workspaces/{}/providers",
                self.base, self.workspace_id
            ))
            .bearer_auth(&self.session_token)
            .send()
            .await
            .expect("providers response")
            .error_for_status()
            .expect("providers status");
    }
}

#[tokio::test]
async fn http_spawn_initializes_the_shared_resolver() {
    let app = SharedResolverApp::boot(false).await;

    let token = app
        .resolver
        .gateway_token()
        .expect("shared resolver must mint after HTTP bind");
    assert!(
        app.handle.tokens.lookup(&token).is_some(),
        "runtime token must authenticate against the HTTP TokenStore"
    );

    let proxy = app
        .resolver
        .ai_proxy_base("team-x")
        .expect("shared resolver must know the local proxy");
    assert_eq!(
        proxy,
        format!(
            "http://127.0.0.1:{}/v1/ai/teams/team-x",
            app.handle.local_addr.port()
        )
    );

    app.handle.shutdown().await;
}

#[tokio::test]
async fn repeated_provider_get_keeps_opencode_json_byte_identical() {
    let app = SharedResolverApp::boot(false).await;
    app.resolver.reconcile_global("team-x").await;
    let before = team_provider_bytes();

    app.get_providers().await;
    app.resolver.reconcile_global("team-x").await;
    app.get_providers().await;

    assert_eq!(
        team_provider_bytes(),
        before,
        "GET /providers must not rewrite provider.team when cloud config is unchanged"
    );

    let json = team_provider_json();
    let token = app.resolver.gateway_token().unwrap();
    assert_eq!(
        json["provider"]["team"]["options"]["apiKey"].as_str(),
        Some(token.as_str())
    );
    assert_eq!(
        json["provider"]["team"]["options"]["baseURL"].as_str(),
        Some(
            format!(
                "http://127.0.0.1:{}/v1/ai/teams/team-x",
                app.handle.local_addr.port()
            )
            .as_str()
        )
    );

    app.handle.shutdown().await;
}

#[tokio::test]
async fn repeated_provider_get_does_not_replace_a_ready_host() {
    let app = SharedResolverApp::boot(true).await;
    let pool = app.pool.as_ref().unwrap();
    let factory = app.factory.as_ref().unwrap();
    let lease = app._lease.as_ref().unwrap();
    let generation_id = lease.generation.generation_id.clone();
    let revision = lease.generation.process_env_revision.clone();
    assert_eq!(factory.starts.load(Ordering::SeqCst), 1);

    app.resolver.reconcile_global("team-x").await;
    app.get_providers().await;
    app.get_providers().await;

    let reused = pool
        .acquire(
            IsolationDomainKey::Workspace("ws-a".into()),
            revision.clone(),
            HashMap::from([("SENTINEL".into(), "a".into())]),
            Instant::now() + Duration::from_secs(2),
        )
        .await
        .unwrap();

    assert_eq!(reused.generation.generation_id, generation_id);
    assert_eq!(lease.generation.lifecycle(), HostLifecycle::Ready);
    assert_eq!(factory.starts.load(Ordering::SeqCst), 1);

    app.handle.shutdown().await;
}

#[tokio::test]
async fn real_managed_llm_name_change_refreshes_once() {
    let app = SharedResolverApp::boot(true).await;
    let pool = app.pool.as_ref().unwrap();
    let factory = app.factory.as_ref().unwrap();
    let lease = app._lease.as_ref().unwrap();
    let original_id = lease.generation.generation_id.clone();
    let revision = lease.generation.process_env_revision.clone();

    app.resolver.reconcile_global("team-x").await;
    let before = team_provider_bytes();

    app.mock
        .state()
        .managed_llm_configs
        .insert("team-x".to_string(), enabled_llm("Team Renamed"));
    app.resolver.clear_cache().await;
    app.get_providers().await;

    assert_ne!(
        team_provider_bytes(),
        before,
        "a real cloud provider-name change must rewrite provider.team"
    );
    assert_eq!(
        team_provider_json()["provider"]["team"]["name"].as_str(),
        Some("Team Renamed")
    );

    let replacement = pool
        .acquire(
            IsolationDomainKey::Workspace("ws-a".into()),
            revision.clone(),
            HashMap::from([("SENTINEL".into(), "a".into())]),
            Instant::now() + Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_ne!(replacement.generation.generation_id, original_id);
    assert_eq!(factory.starts.load(Ordering::SeqCst), 2);
    assert_eq!(lease.generation.lifecycle(), HostLifecycle::Draining);

    let after_change = team_provider_bytes();
    app.get_providers().await;
    assert_eq!(team_provider_bytes(), after_change);

    let stable = pool
        .acquire(
            IsolationDomainKey::Workspace("ws-a".into()),
            revision,
            HashMap::from([("SENTINEL".into(), "a".into())]),
            Instant::now() + Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(
        stable.generation.generation_id,
        replacement.generation.generation_id
    );
    assert_eq!(factory.starts.load(Ordering::SeqCst), 2);

    app.handle.shutdown().await;
}
