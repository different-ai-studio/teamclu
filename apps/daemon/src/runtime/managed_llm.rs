//! Cloud-sourced managed (shared) LLM resolution, shared by the spawn path and
//! the HTTP provider snapshot.
//!
//! Team `provider.team` rows are materialized through
//! [`teamclu_runtime_env::sync_global_team_provider`]:
//! - **Spawn** — [`teamclu_runtime_env::assemble_runtime_env`] with
//!   [`teamclu_runtime_env::SecretResolveScope::FullConfig`]
//! - **Provider reads** — [`ManagedLlmResolver::reconcile_global`]
//!
//! Before reconcile existed, `provider.team` was written only at spawn time, so an
//! admin's model-list change never reached a member until the next runtime spawn
//! — `GET /v1/workspaces/:id/providers` reads straight off disk, so stale lists
//! survived app restarts.
//!
//! Holding the TTL cache here (rather than on `DaemonServer`) lets both callers
//! share one throttled cloud fetch, so reconciling on a provider read costs at
//! most one request per team per [`MANAGED_LLM_TTL`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use teamclu_runtime_env::{ManagedLlmModel, ManagedLlmProvider, ManagedLlmState};

use crate::backend::Backend;

/// How long a cloud managed-LLM fetch is trusted before a refresh is attempted.
const MANAGED_LLM_TTL: Duration = Duration::from_secs(60);

/// A cached managed-LLM resolution plus when it was fetched. Stored per team_id
/// so a transient cloud failure can fall back to the last-known-good value
/// instead of wiping a working `provider.team`.
#[derive(Clone)]
struct CachedManagedLlm {
    fetched_at: Instant,
    state: ManagedLlmState,
}

pub struct ManagedLlmResolver {
    backend: Arc<dyn Backend>,
    /// Mints the `ai:invoke` session token that `provider.team.options.apiKey`
    /// resolves to. `None` in focused tests and wherever no HTTP layer exists —
    /// the provider is then written with the placeholder left in place, which
    /// is correct: there is no local proxy to authenticate against either.
    /// Interior-mutable because the HTTP layer owns the TokenStore and starts
    /// AFTER this resolver is built. Two stores loaded from the same file are
    /// NOT interchangeable — the root token is on disk, but minted session
    /// tokens live only in the instance that minted them, so a token from a
    /// second store authenticates against nothing.
    tokens: parking_lot::RwLock<Option<super::gateway_token::GatewayTokenSource>>,
    /// `http://127.0.0.1:<port>` for this daemon's own listener, set once the
    /// HTTP layer is up. Runtimes are pointed at `<base>/v1/ai/teams/<id>`
    /// rather than at the cloud gateway — see `runtime_facing_base_url`.
    local_http_base: parking_lot::RwLock<Option<String>>,
    cache: AsyncMutex<HashMap<String, CachedManagedLlm>>,
}

impl ManagedLlmResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            tokens: parking_lot::RwLock::new(None),
            local_http_base: parking_lot::RwLock::new(None),
            cache: AsyncMutex::new(HashMap::new()),
        }
    }

    /// Attach the token source so reconciles can resolve
    /// `provider.team.options.apiKey`. Chained after `new()` because most call
    /// sites (tests, the channel manager) have no HTTP layer to mint from.
    pub fn with_tokens(self, tokens: Option<super::gateway_token::GatewayTokenSource>) -> Self {
        *self.tokens.write() = tokens;
        self
    }

    /// Attach the token source after construction, for the resolver the daemon
    /// builds before its HTTP layer exists.
    pub fn set_tokens(&self, tokens: super::gateway_token::GatewayTokenSource) {
        *self.tokens.write() = Some(tokens);
    }

    /// Record this daemon's own HTTP origin, once its listener has an address.
    pub fn set_local_http_base(&self, base: String) {
        *self.local_http_base.write() = Some(base);
    }

    /// The AI proxy URL a runtime should call for `team_id`, or None when this
    /// daemon has no listener to offer (tests, headless paths).
    pub fn ai_proxy_base(&self, team_id: &str) -> Option<String> {
        self.local_http_base
            .read()
            .as_ref()
            .map(|base| format!("{}/v1/ai/teams/{}", base.trim_end_matches('/'), team_id))
    }

    /// The `ai:invoke` token `provider.team`'s apiKey resolves to.
    ///
    /// Needed on the SPAWN path, not just during reconcile: opencode reads the
    /// resolved key out of `provider.team` in the global config, but every other
    /// runtime is handed `TEAMCLU_TEAM_PROVIDER`, whose `apiKeyEnv` names an env
    /// binding it expects to find. Without the binding pi registers the provider
    /// and then hides every model on it, because a provider with no resolvable
    /// credential is "loaded but unavailable" — which looks exactly like the
    /// provider never having been registered at all.
    pub fn gateway_token(&self) -> Option<String> {
        self.tokens.read().as_ref().map(|t| t.get_or_mint())
    }

    /// Resolve the team's managed (shared) LLM directly from the cloud API, with
    /// a short-TTL in-memory cache. Replaces the old disk-mirrored
    /// `_meta/provider.json` read, which raced the first-install git clone and
    /// only converged after a daemon restart.
    ///
    /// On a transient fetch failure, falls back to the last-known cached value
    /// (or `Unknown` if none) so a working `provider.team` is never wiped by a
    /// blip. The gateway key itself needs no provisioning call: it is derived
    /// locally as `sk-tc-{actor_id[..40]}`.
    pub async fn resolve(&self, team_id: &str) -> ManagedLlmState {
        if let Some(cached) = self.cache.lock().await.get(team_id) {
            if cached.fetched_at.elapsed() < MANAGED_LLM_TTL {
                return cached.state.clone();
            }
        }

        match self.backend.managed_llm_config(team_id).await {
            Ok(cfg) => {
                let state = match (cfg.enabled, cfg.base_url) {
                    (true, Some(base_url)) => ManagedLlmState::Enabled(ManagedLlmProvider {
                        name: cfg.name.unwrap_or_default(),
                        base_url,
                        models: cfg
                            .models
                            .into_iter()
                            .map(|m| ManagedLlmModel {
                                id: m.id,
                                name: m.name,
                            })
                            .collect(),
                    }),
                    // Enabled but no base URL is unusable — treat as disabled.
                    _ => ManagedLlmState::Disabled,
                };
                self.cache.lock().await.insert(
                    team_id.to_string(),
                    CachedManagedLlm {
                        fetched_at: Instant::now(),
                        state: state.clone(),
                    },
                );
                state
            }
            Err(e) => {
                // Preserve last-known-good rather than wiping a working provider.
                let fallback = self
                    .cache
                    .lock()
                    .await
                    .get(team_id)
                    .map(|c| c.state.clone())
                    .unwrap_or(ManagedLlmState::Unknown);
                tracing::warn!(
                    team_id,
                    error = %e,
                    "managed LLM cloud fetch failed; using last-known managed LLM state"
                );
                fallback
            }
        }
    }

    /// Re-materialize the active team's `provider.team`.
    ///
    /// Safe to call on every provider read: the cloud fetch is TTL-throttled and
    /// [`sync_global_team_provider`] only writes when the entry actually differs,
    /// so a steady state performs no writes and does not churn the refresh watcher.
    /// A `Unknown` resolution (no fresh cloud answer) leaves the file untouched.
    pub async fn reconcile_global(&self, team_id: &str) {
        let state = self.resolve(team_id).await;
        // One token per process, reused: `sync_global_team_provider` writes
        // whatever it is given, so minting per reconcile would rewrite the file
        // (and leak a token into the store) on every provider read.
        let token = self
            .tokens
            .read()
            .as_ref()
            .map(|t| t.get_or_mint())
            .unwrap_or_default();
        let secrets = teamclu_runtime_env::secrets_for_team_provider(&token);
        let proxy_base = self.ai_proxy_base(team_id);
        if let Err(e) =
            teamclu_runtime_env::sync_global_team_provider(&state, &secrets, proxy_base.as_deref())
        {
            tracing::warn!(
                team_id,
                error = %e,
                "global team provider sync failed during managed LLM reconcile"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use crate::backend::{ManagedLlmConfig, ManagedLlmModelInfo};
    use crate::test_brand_env::BrandEnvGuard;

    fn config_with_models(models: &[&str]) -> ManagedLlmConfig {
        ManagedLlmConfig {
            enabled: true,
            base_url: Some("https://gateway.example/v1".to_string()),
            name: Some("Team".to_string()),
            models: models
                .iter()
                .map(|id| ManagedLlmModelInfo {
                    id: (*id).to_string(),
                    name: (*id).to_string(),
                })
                .collect(),
        }
    }

    /// An isolated amuxd home for the tests that write the global team config.
    ///
    /// `BrandEnvGuard` deliberately, rather than a mutex local to this module:
    /// it carries the daemon-wide `TEST_HOME_LOCK`, and `HOME`, `AMUXD_HOME`
    /// and the brand name all feed the SAME process-global path resolution. A
    /// second lock only serialized this module against itself while leaving it
    /// free to race `runtime::env_assembly` — which is exactly what turned main
    /// red after #948: both suites drive `<amuxd home>/teams/<active>/state/
    /// opencode.json`, so whoever set AMUXD_HOME last won.
    fn isolated_global_config() -> (tempfile::TempDir, BrandEnvGuard) {
        let dir = tempfile::TempDir::new().unwrap();
        let home = BrandEnvGuard::set_amuxd_home(dir.path());
        std::fs::write(
            dir.path().join("daemon.toml"),
            "active_team = \"team-test\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("teams/team-test/state")).unwrap();
        (dir, home)
    }

    fn team_model_ids() -> Vec<String> {
        let raw = std::fs::read_to_string(
            teamclu_runtime_env::opencode_config::global_opencode_config_path(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut ids: Vec<String> = json["provider"]["team"]["models"]
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    /// The model list is pinned client-side (`TEAM_MODEL_TIERS`), so a cloud
    /// change to it is deliberately ignored: which upstream a tier resolves to
    /// is the gateway's business, and a member's menu should not depend on a
    /// round-trip returning the right thing.
    ///
    /// What reconcile still exists for is `base_url` — that is the per-team
    /// cutover lever (design §11.1), so a change to it MUST land on disk.
    #[tokio::test]
    async fn reconcile_pins_the_tier_list_but_still_follows_the_cloud_base_url() {
        let (_global, _home) = isolated_global_config();
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        let resolver = ManagedLlmResolver::new(backend);

        resolver.reconcile_global("team-x").await;
        assert_eq!(
            team_model_ids(),
            vec!["default".to_string(), "max".to_string(), "pro".to_string()],
            "the cloud's model list must not reach the runtime"
        );

        // Admin swaps the team onto a different set. The TTL cache would
        // otherwise hold the old answer, so drop it the way a 60s expiry would.
        mock.state().managed_llm_configs.insert(
            "team-x".to_string(),
            config_with_models(&["model-b", "model-c"]),
        );
        resolver.cache.lock().await.clear();

        resolver.reconcile_global("team-x").await;
        assert_eq!(
            team_model_ids(),
            vec!["default".to_string(), "max".to_string(), "pro".to_string()],
            "still the three pinned tiers, unchanged by the cloud"
        );
    }

    /// A resolution inside the TTL must not hit the cloud again — provider reads
    /// are frequent, and reconciling on each one must stay cheap.
    #[tokio::test]
    async fn resolve_is_ttl_cached() {
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        let resolver = ManagedLlmResolver::new(backend);

        resolver.resolve("team-x").await;
        // Swap the cloud answer; the cached one must still win.
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-b"]));

        match resolver.resolve("team-x").await {
            ManagedLlmState::Enabled(provider) => {
                assert_eq!(provider.models[0].id, "model-a");
            }
            other => panic!("expected Enabled, got {other:?}"),
        }
    }

    fn team_api_key() -> String {
        let raw = std::fs::read_to_string(
            teamclu_runtime_env::opencode_config::global_opencode_config_path(),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        json["provider"]["team"]["options"]["apiKey"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Provider reads after spawn must not revert a resolved LiteLLM key to the
    /// `${tc_api_key}` placeholder (wake / refresh regression).

    /// Helper: a resolver wired to a real token store, the way the HTTP layer
    /// builds it.
    fn resolver_with_tokens(backend: Arc<dyn Backend>) -> (ManagedLlmResolver, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::http::tokens::TokenStore::load_or_init(&dir.path().join("t")).unwrap();
        std::mem::forget(dir);
        let source = crate::runtime::gateway_token::GatewayTokenSource::new(store);
        let token = source.get_or_mint();
        (
            ManagedLlmResolver::new(backend).with_tokens(Some(source)),
            token,
        )
    }

    fn write_team_provider(api_key: &str) {
        std::fs::write(
            teamclu_runtime_env::opencode_config::global_opencode_config_path(),
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": {
                    "team": {
                        "npm": "@ai-sdk/openai-compatible",
                        "name": "Team",
                        "options": {
                            "baseURL": "https://gateway.example/v1",
                            "apiKey": api_key
                        },
                        "models": { "model-a": { "name": "model-a" } }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn mock_resolver() -> Arc<dyn Backend> {
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        Arc::new(mock)
    }

    #[tokio::test]
    async fn reconcile_resolves_the_gateway_token_placeholder() {
        let (_global, _home) = isolated_global_config();
        write_team_provider(teamclu_runtime_env::GATEWAY_TOKEN_PLACEHOLDER);

        let (resolver, token) = resolver_with_tokens(mock_resolver());
        resolver.reconcile_global("team-x").await;
        assert_eq!(team_api_key(), token);
    }

    /// Session tokens live in daemon memory, so the value left on disk by a
    /// previous process names a token nothing will accept. Reconcile writes the
    /// current one outright rather than only substituting the placeholder --
    /// otherwise a restart strands the device on a dead credential, and the
    /// symptom is a permanent 401 that no amount of reconciling clears.
    #[tokio::test]
    async fn reconcile_replaces_a_token_from_a_previous_process() {
        let (_global, _home) = isolated_global_config();
        write_team_provider("tok_from_a_dead_process");

        let (resolver, token) = resolver_with_tokens(mock_resolver());
        resolver.reconcile_global("team-x").await;
        assert_eq!(team_api_key(), token);
    }

    /// The migration case: a LiteLLM virtual key from before the gateway
    /// cutover. Nothing else would ever clear it.
    #[tokio::test]
    async fn reconcile_clears_a_legacy_litellm_virtual_key() {
        let (_global, _home) = isolated_global_config();
        write_team_provider("sk-tc-actor-x");

        let (resolver, token) = resolver_with_tokens(mock_resolver());
        resolver.reconcile_global("team-x").await;
        assert_eq!(team_api_key(), token);
        assert!(!team_api_key().starts_with("sk-tc-"));
    }

    /// No token source (no HTTP layer) must leave the placeholder alone rather
    /// than writing an empty credential, which would look resolved and fail.
    #[tokio::test]
    async fn reconcile_without_a_token_source_leaves_the_placeholder() {
        let (_global, _home) = isolated_global_config();
        write_team_provider(teamclu_runtime_env::GATEWAY_TOKEN_PLACEHOLDER);

        ManagedLlmResolver::new(mock_resolver())
            .reconcile_global("team-x")
            .await;
        assert_eq!(
            team_api_key(),
            teamclu_runtime_env::GATEWAY_TOKEN_PLACEHOLDER
        );
    }

    /// A cloud blip must not strip a working `provider.team`.
    #[tokio::test]
    async fn unknown_state_leaves_disk_untouched() {
        let (_global, _home) = isolated_global_config();
        std::fs::write(
            teamclu_runtime_env::opencode_config::global_opencode_config_path(),
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": { "team": { "models": { "model-a": { "name": "Model A" } } } }
            }))
            .unwrap(),
        )
        .unwrap();

        // MockBackend with no seeded config resolves to Disabled, not Unknown,
        // so drive the untouched global path through the sync helper directly.
        teamclu_runtime_env::sync_global_team_provider(&ManagedLlmState::Unknown, &HashMap::new())
            .unwrap();

        assert_eq!(team_model_ids(), vec!["model-a".to_string()]);
    }
}
