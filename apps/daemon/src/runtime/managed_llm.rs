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
    cache: AsyncMutex<HashMap<String, CachedManagedLlm>>,
}

impl ManagedLlmResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            cache: AsyncMutex::new(HashMap::new()),
        }
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
        let secrets = teamclu_runtime_env::secrets_for_team_provider(self.backend.actor_id());
        if let Err(e) = teamclu_runtime_env::sync_global_team_provider(&state, &secrets) {
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

    /// The bug: an admin swapping the team's models left members on the old list
    /// because `provider.team` was only ever written while assembling a spawn
    /// env. Reconciling has to replace the list on disk, not union into it.
    #[tokio::test]
    async fn reconcile_replaces_the_team_model_list_from_cloud() {
        let (_global, _home) = isolated_global_config();
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        let resolver = ManagedLlmResolver::new(backend);

        resolver.reconcile_global("team-x").await;
        assert_eq!(team_model_ids(), vec!["model-a".to_string()]);

        // Admin swaps the team onto a new set. The TTL cache would otherwise
        // hold the old answer, so drop it the way a 60s expiry would.
        mock.state().managed_llm_configs.insert(
            "team-x".to_string(),
            config_with_models(&["model-b", "model-c"]),
        );
        resolver.cache.lock().await.clear();

        resolver.reconcile_global("team-x").await;
        assert_eq!(
            team_model_ids(),
            vec!["model-b".to_string(), "model-c".to_string()],
            "the dropped model must not survive the reconcile"
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
    #[tokio::test]
    async fn reconcile_preserves_resolved_team_api_key() {
        let (_global, _home) = isolated_global_config();
        let resolved_key = "sk-tc-actor-x";
        std::fs::write(
            teamclu_runtime_env::opencode_config::global_opencode_config_path(),
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": {
                    "team": {
                        "npm": "@ai-sdk/openai-compatible",
                        "name": "Team",
                        "options": {
                            "baseURL": "https://gateway.example/v1",
                            "apiKey": resolved_key
                        },
                        "models": { "model-a": { "name": "model-a" } }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = ManagedLlmResolver::new(backend);

        resolver.reconcile_global("team-x").await;
        assert_eq!(team_api_key(), resolved_key);
    }

    #[tokio::test]
    async fn reconcile_resolves_tc_api_key_placeholder() {
        let (_global, _home) = isolated_global_config();
        std::fs::write(
            teamclu_runtime_env::opencode_config::global_opencode_config_path(),
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": {
                    "team": {
                        "options": { "apiKey": "${tc_api_key}" },
                        "models": { "model-a": { "name": "model-a" } }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = ManagedLlmResolver::new(backend);

        resolver.reconcile_global("team-x").await;
        assert_eq!(team_api_key(), "sk-tc-actor-x");
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
