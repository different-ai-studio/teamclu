//! Shared `provider.team` materialization + secret resolution for spawn and reconcile.
//!
//! Both paths must stay aligned: write the cloud-sourced team provider into the
//! active team's `providers.json`. Workspace secrets are never resolved onto
//! disk: pi reads env bindings.

use std::collections::HashMap;

use crate::team_provider::{self, ManagedLlmState};

/// Materialize `provider.team` from `managed_llm` into the active team's
/// `providers.json`.
pub fn sync_global_team_provider(
    managed_llm: &ManagedLlmState,
    secrets: &HashMap<String, String>,
    // The daemon's own loopback AI proxy for this team, which is what a runtime
    // must call — see `runtime_facing_base_url`. None leaves the cloud URL.
    proxy_base: Option<&str>,
) -> anyhow::Result<bool> {
    let changed = team_provider::ensure_global_team_provider(managed_llm, proxy_base)?;
    let Some(gateway_token) = secrets.get("tc_gateway_token") else {
        return Ok(changed);
    };
    let resolved = crate::config_store::ConfigStore::apply_providers(|config| {
        let Some(key) = config
            .get_mut("provider")
            .and_then(|providers| providers.get_mut("team"))
            .and_then(|team| team.get_mut("options"))
            .and_then(|options| options.get_mut("apiKey"))
            .and_then(|key| key.as_str().map(str::to_owned))
        else {
            return Ok(false);
        };
        // Write the current token outright rather than only substituting the
        // placeholder. Session tokens live in daemon memory, so the value on
        // disk is dead after a restart -- a placeholder-only substitution would
        // leave that stale value in place forever. The caller mints once per
        // process and reuses it, so this is a no-op in the steady state.
        //
        // It also clears a `sk-tc-*` LiteLLM key left over from before the
        // cutover, which nothing else would.
        if key == *gateway_token {
            return Ok(false);
        }
        config["provider"]["team"]["options"]["apiKey"] =
            serde_json::Value::String(gateway_token.clone());
        Ok(true)
    })?;
    Ok(changed || resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge::secrets_for_team_provider;
    use crate::team_provider::{ManagedLlmModel, ManagedLlmProvider};
    use std::fs;
    use tempfile::TempDir;

    fn sample_provider() -> ManagedLlmProvider {
        ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "model-a".to_string(),
                name: "Model A".to_string(),
            }],
        }
    }

    fn global_config_dir() -> (
        std::sync::MutexGuard<'static, ()>,
        TempDir,
        crate::test_util::AmuxdHomeGuard,
    ) {
        let lock = crate::test_util::home_env_lock();
        let dir = TempDir::new().unwrap();
        let home = crate::test_util::AmuxdHomeGuard::set(dir.path());
        fs::write(
            dir.path().join("daemon.toml"),
            "active_team = \"team-test\"\n",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("teams/team-test/state")).unwrap();
        (lock, dir, home)
    }

    fn global_config_path(home: &TempDir) -> std::path::PathBuf {
        home.path().join("teams/team-test/state/providers.json")
    }

    #[test]
    fn sync_preserves_resolved_api_key_on_reconcile() {
        let (_lock, dir, _home) = global_config_dir();
        let resolved = "tok_actor_xyz";
        fs::write(
            global_config_path(&dir),
            serde_json::json!({
                "provider": {
                    "team": {
                        "options": {
                            "baseURL": "https://gateway.example/v1",
                            "apiKey": resolved
                        },
                        "models": { "old": { "name": "Old" } }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        sync_global_team_provider(
            &ManagedLlmState::Enabled(sample_provider()),
            &secrets_for_team_provider("tok_actor_xyz"),
            None,
        )
        .unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(global_config_path(&dir)).unwrap()).unwrap();
        assert_eq!(
            parsed["provider"]["team"]["options"]["apiKey"].as_str(),
            Some(resolved)
        );
    }

    #[test]
    fn spawn_and_reconcile_scopes_agree_on_team_provider_api_key() {
        let (_lock, dir, _home) = global_config_dir();

        let secrets = secrets_for_team_provider("shared-actor");
        let managed = ManagedLlmState::Enabled(sample_provider());

        sync_global_team_provider(&managed, &secrets, None).unwrap();
        let reconcile_disk = fs::read_to_string(global_config_path(&dir)).unwrap();

        fs::write(global_config_path(&dir), r#"{}"#).unwrap();
        sync_global_team_provider(&managed, &secrets, None).unwrap();
        let spawn_disk = fs::read_to_string(global_config_path(&dir)).unwrap();

        let reconcile_json: serde_json::Value = serde_json::from_str(&reconcile_disk).unwrap();
        let spawn_json: serde_json::Value = serde_json::from_str(&spawn_disk).unwrap();
        assert_eq!(
            reconcile_json["provider"]["team"]["options"]["apiKey"],
            spawn_json["provider"]["team"]["options"]["apiKey"]
        );
        assert_eq!(
            reconcile_json["provider"]["team"]["models"],
            spawn_json["provider"]["team"]["models"]
        );
    }
}
