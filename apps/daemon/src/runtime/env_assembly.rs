use std::path::Path;

use teamclu_runtime_env::ManagedLlmState;

use crate::team_shared_env;

use super::SpawnRuntimeEnv;

/// Assemble personal + team + system env, materialize the active-team
/// `provider.team`, and resolve workspace `${KEY}` placeholders before attaching
/// an ACP host.
///
/// `managed_llm` is the team's shared LLM as resolved from the cloud API (base
/// URL + model list). It is written to amuxd's global `opencode.json` inside
/// [`teamclu_runtime_env::assemble_runtime_env`]; the secret (`tc_api_key`) is
/// derived locally from `actor_id`, never sourced from the cloud config.
pub fn assemble_spawn_runtime_env(
    workspace_root: &Path,
    team_id: Option<&str>,
    actor_id: &str,
    display_name: &str,
    cloud_token_file: Option<&str>,
    managed_llm: &ManagedLlmState,
    gateway_token: Option<&str>,
    ai_proxy_base: Option<&str>,
) -> anyhow::Result<SpawnRuntimeEnv> {
    assemble_spawn_runtime_env_for_execution(
        workspace_root,
        workspace_root,
        team_id,
        actor_id,
        display_name,
        cloud_token_file,
        managed_llm,
        gateway_token,
        ai_proxy_base,
    )
}

/// Assemble environment sources from the registered parent workspace while
/// materializing provider and placeholder-resolved OpenCode config in the
/// directory where the runtime will actually execute.
pub fn assemble_spawn_runtime_env_for_execution(
    workspace_root: &Path,
    execution_directory: &Path,
    team_id: Option<&str>,
    actor_id: &str,
    display_name: &str,
    cloud_token_file: Option<&str>,
    managed_llm: &ManagedLlmState,
    gateway_token: Option<&str>,
    ai_proxy_base: Option<&str>,
) -> anyhow::Result<SpawnRuntimeEnv> {
    // Cold ManagedLlm cache often yields Unknown and omits TEAMCLU_TEAM_PROVIDER;
    // reconstruct Enabled from on-disk provider.team so the spawn fingerprint
    // matches a later successful cloud resolve with the same gateway data.
    let disk_team = teamclu_runtime_env::read_global_team_provider();
    let managed_llm =
        teamclu_runtime_env::stabilize_managed_llm_for_spawn(managed_llm, disk_team.as_ref());
    let team_env = team_shared_env::load_team_env_for_workspace_detailed(workspace_root, team_id);
    let mut bundle = teamclu_runtime_env::assemble_runtime_env(
        execution_directory,
        team_env.values,
        teamclu_runtime_env::SystemEnvContext {
            actor_id: actor_id.to_string(),
            display_name: display_name.to_string(),
            cloud_token_file: cloud_token_file.map(str::to_string),
            // Binds `tc_gateway_token`, which `TEAMCLU_TEAM_PROVIDER` names as
            // its `apiKeyEnv`.
            //
            // This used to be None, on the reasoning that `provider.team` is
            // written to the active-team global config and its apiKey resolved
            // during reconcile — true, and true only for opencode, which reads
            // that file. Every other runtime registers the provider itself from
            // the env payload and looks the credential up by name. With the
            // binding missing, pi registered the team provider and then showed
            // none of its models: a provider with no resolvable credential is
            // "loaded but unavailable" in pi, which is indistinguishable from
            // never having been registered. Verified by A/B — same payload, the
            // only difference being this variable.
            gateway_token: gateway_token.map(str::to_string),
            ai_proxy_base: ai_proxy_base.map(str::to_string),
        },
        &managed_llm,
    )?;
    let personal_store = teamclu_runtime_env::diagnose_personal_env_store();
    let personal_location = (!personal_store.secrets_dir.is_empty()).then(|| {
        std::path::Path::new(&personal_store.secrets_dir)
            .join("personal-secrets.json.enc")
            .display()
            .to_string()
    });
    bundle
        .resolved_env
        .annotate_sources(personal_location.as_deref(), &team_env.source_paths);
    bundle
        .resolved_env
        .unresolved
        .extend(team_env.unresolved_keys.into_iter().map(|key| {
            teamclu_runtime_env::UnresolvedEnv {
                key,
                scope: teamclu_runtime_env::EnvScope::Team,
                reason: teamclu_runtime_env::UnresolvedReason::Unavailable,
            }
        }));
    let mut extra_env = bundle.extra_env;
    // Backend-neutral team-provider handoff. opencode consumes the team gateway
    // via `provider.team` in the active team's opencode.json; other local
    // runtimes (pi, …) cannot read that file and instead register the provider
    // themselves from this payload.
    //
    // The secret is NOT embedded: the payload carries `apiKeyEnv`, naming the
    // binding to read it from — `tc_gateway_token`, bound above. That binding
    // has to exist, or the provider registers and every model on it silently
    // becomes unavailable, which looks exactly like it never registered.
    if let ManagedLlmState::Enabled(provider) = &managed_llm {
        extra_env.insert(
            "TEAMCLU_TEAM_PROVIDER".to_string(),
            teamclu_runtime_env::team_provider_env_payload(provider, ai_proxy_base),
        );
    }

    // #742: point opencode at the daemon-owned device-level config, which is
    // where user-configured providers now live. `OPENCODE_CONFIG` loads it as an
    // *additional* global-scope config after the standard global chain, so these
    // entries win over the user's hand-edited
    // `~/.config/opencode/opencode.json` — a file we deliberately never write.
    //
    // Only set when the file exists: pointing the variable at a missing path
    // buys nothing and risks opencode erroring on a config it cannot read.
    let global_config = teamclu_runtime_env::opencode_config::global_opencode_config_path();
    if global_config.is_file() {
        extra_env.insert(
            "OPENCODE_CONFIG".to_string(),
            global_config.display().to_string(),
        );
    }
    Ok(SpawnRuntimeEnv {
        extra_env,
        resolved_env: Some(bundle.resolved_env),
        env_team_id: team_id.map(str::to_string),
        force_env_override: true,
        opencode_json_original: bundle.opencode_json_original,
        is_gateway: false,
        permission: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_brand_env::BrandEnvGuard;
    use teamclu_runtime_env::team_crypto::{self, SecretEntry};
    use teamclu_runtime_env::{ManagedLlmModel, ManagedLlmProvider};

    /// An isolated amuxd home with an active team.
    ///
    /// Every test that assembles a spawn environment needs this: assembly calls
    /// `ensure_global_team_provider`, which WRITES the team provider into
    /// `<amuxd home>/teams/<active team>/state/opencode.json`. Without the
    /// override that path is the developer's real `~/.amuxd` — running this
    /// suite locally overwrote the machine's actual gateway URL and model list
    /// with these fixtures, then read them back on the next run, which is why
    /// the same test failed differently on a developer box than on CI.
    ///
    /// `BrandEnvGuard` (not a private mutex) because it holds the daemon-wide
    /// `TEST_HOME_LOCK`: `HOME`, `AMUXD_HOME` and the brand name all feed the
    /// same process-global path resolution, so a second lock would serialize
    /// these tests against each other while still racing `team_link` and
    /// friends. Drop order matters — the guard restores the env before the
    /// TempDir it points at is removed.
    fn amuxd_home_with_active_team() -> (tempfile::TempDir, BrandEnvGuard) {
        let home = tempfile::tempdir().unwrap();
        let guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-test\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join("teams/team-test/state")).unwrap();
        (home, guard)
    }

    /// Where the active team's `opencode.json` lives — resolved the same way
    /// the production writer resolves it, so the test cannot drift from the
    /// layout by hand-joining a path.
    fn global_team_config() -> std::path::PathBuf {
        teamclu_runtime_env::opencode_config::global_opencode_config_path()
    }

    /// Covers the production boundary, rather than merely testing the secret
    /// reader: an encrypted team value must be present in the environment that
    /// is handed to the ACP host. Keep the key unique so any developer's local
    /// personal environment cannot mask a regression in this test.
    #[test]
    fn encrypted_team_secret_is_injected_into_spawn_environment() {
        let (_home, _home_guard) = amuxd_home_with_active_team();
        let workspace = tempfile::tempdir().unwrap();
        let team_secret = "6a".repeat(32);
        let config_dir = workspace.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({ "team": { "envSecret": team_secret } }).to_string(),
        )
        .unwrap();

        let secrets_dir = workspace.path().join("teamclu-team").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let entry = SecretEntry {
            key_id: "team_env_integration_test_token".to_string(),
            key: "expected-team-value".to_string(),
            ..Default::default()
        };
        let key = team_crypto::derive_key(&team_secret).unwrap();
        let envelope = team_crypto::encrypt_secret(&entry, &key).unwrap();
        std::fs::write(
            secrets_dir.join("team_env_integration_test_token.enc.json"),
            serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();

        let spawn_env = assemble_spawn_runtime_env(
            workspace.path(),
            None,
            "actor-for-env-test",
            "Env Test Agent",
            None,
            &ManagedLlmState::Unknown,
            None,
        )
        .unwrap();

        assert_eq!(
            spawn_env
                .extra_env
                .get("team_env_integration_test_token")
                .map(String::as_str),
            Some("expected-team-value")
        );
        assert_eq!(
            spawn_env
                .extra_env
                .get("TEAM_ENV_INTEGRATION_TEST_TOKEN")
                .map(String::as_str),
            Some("expected-team-value"),
            "the uppercase alias is what many ACP agents consume"
        );
    }

    #[test]
    fn worktree_uses_parent_team_env_and_materializes_its_own_opencode_config() {
        let (_home, _home_guard) = amuxd_home_with_active_team();
        let workspace = tempfile::tempdir().unwrap();
        let worktree = workspace.path().join(".worktrees/cron-j1-r1");
        std::fs::create_dir_all(&worktree).unwrap();

        let team_secret = "7b".repeat(32);
        let config_dir = workspace.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({ "team": { "envSecret": team_secret } }).to_string(),
        )
        .unwrap();
        let secrets_dir = workspace.path().join("teamclu-team/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let key = team_crypto::derive_key(&team_secret).unwrap();
        let envelope = team_crypto::encrypt_secret(
            &SecretEntry {
                key_id: "cron_worktree_env_sentinel".into(),
                key: "from-parent".into(),
                ..Default::default()
            },
            &key,
        )
        .unwrap();
        std::fs::write(
            secrets_dir.join("cron_worktree_env_sentinel.enc.json"),
            serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
        std::fs::write(
            worktree.join("opencode.json"),
            serde_json::json!({
                "mcp": {
                    "sentinel": {
                        "environment": {
                            "TOKEN": "${CRON_WORKTREE_ENV_SENTINEL}"
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let managed = ManagedLlmState::Enabled(ManagedLlmProvider {
            name: "Team".into(),
            base_url: "https://gateway.example/v1".into(),
            models: vec![ManagedLlmModel {
                id: "cron-model".into(),
                name: "Cron Model".into(),
            }],
        });

        let spawn_env = assemble_spawn_runtime_env_for_execution(
            workspace.path(),
            &worktree,
            None,
            "cron-actor",
            "Cron Agent",
            None,
            &managed,
            None,
        )
        .unwrap();

        assert_eq!(
            spawn_env
                .extra_env
                .get("CRON_WORKTREE_ENV_SENTINEL")
                .map(String::as_str),
            Some("from-parent")
        );
        // The worktree config carries the workspace's own `${KEY}` placeholders,
        // resolved from the PARENT workspace's team env.
        let materialized = std::fs::read_to_string(worktree.join("opencode.json")).unwrap();
        assert!(materialized.contains("from-parent"));
        assert!(
            !workspace.path().join("opencode.json").exists(),
            "placeholder resolution belongs in the execution worktree"
        );
        // The team provider is NOT part of that file any more: since #941 it is
        // scoped to the active team and written once, globally.
        let global = std::fs::read_to_string(global_team_config()).unwrap();
        assert!(
            global.contains("\"team\""),
            "the managed provider belongs in the active team's global opencode.json"
        );
        // The tier list is pinned client-side, so the cloud's model name is not
        // what proves the provider landed -- the provider entry itself is.
        assert!(global.contains("\"default\""), "pinned tiers materialized");
        assert!(
            !global.contains("cron-model"),
            "cloud model list is not used"
        );
        assert!(
            !materialized.contains("cron-model"),
            "and must not be duplicated into the worktree config"
        );
    }

    #[test]
    fn unknown_managed_llm_with_disk_provider_matches_enabled_fingerprint() {
        let (_home, _home_guard) = amuxd_home_with_active_team();
        let workspace = tempfile::tempdir().unwrap();
        // The "disk provider" a cold cache falls back to is the active team's
        // global config (`read_global_team_provider`), not the workspace's.
        std::fs::write(
            global_team_config(),
            serde_json::json!({
                "provider": {
                    "team": {
                        "name": "Team",
                        "options": {
                            "baseURL": "https://gateway.example/v1",
                            "apiKey": "${tc_api_key}"
                        },
                        "models": {
                            "gpt-4": { "name": "GPT-4" }
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let enabled = ManagedLlmState::Enabled(ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "gpt-4".to_string(),
                name: "GPT-4".to_string(),
            }],
        });

        let from_unknown = assemble_spawn_runtime_env(
            workspace.path(),
            None,
            "actor-fp",
            "FP Agent",
            None,
            &ManagedLlmState::Unknown,
            None,
        )
        .unwrap();
        let from_enabled = assemble_spawn_runtime_env(
            workspace.path(),
            None,
            "actor-fp",
            "FP Agent",
            None,
            &enabled,
            None,
        )
        .unwrap();

        assert!(
            from_unknown.extra_env.contains_key("TEAMCLU_TEAM_PROVIDER"),
            "Unknown + global provider.team must still inject TEAMCLU_TEAM_PROVIDER"
        );
        assert_eq!(
            from_unknown.extra_env.get("TEAMCLU_TEAM_PROVIDER"),
            from_enabled.extra_env.get("TEAMCLU_TEAM_PROVIDER")
        );
        assert_eq!(
            teamclu_runtime_env::resolved_env::fingerprint_bindings(&from_unknown.extra_env),
            teamclu_runtime_env::resolved_env::fingerprint_bindings(&from_enabled.extra_env),
            "spawn fingerprints must match across Unknown→Enabled when disk already has provider.team"
        );
    }
}
