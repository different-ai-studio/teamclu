//! Shared `provider.team` materialization + secret resolution for spawn and reconcile.
//!
//! Both paths must stay aligned: write the cloud-sourced team provider, then resolve
//! apiKey placeholders. Reconcile uses [`SecretResolveScope::ProviderApiKeysOnly`] so
//! frequent provider reads do not substitute MCP env vars into plaintext on disk.

use std::collections::HashMap;
use std::path::Path;

use crate::mcp_resolve;
use crate::team_provider::{self, ManagedLlmState};

/// How much of `opencode.json` secret resolution should run after `provider.team`
/// is materialized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretResolveScope {
    /// Spawn: substitute every `${KEY}` present in `secrets` (MCP env, provider
    /// apiKey, etc.) and install the runtime overlay.
    FullConfig,
    /// Reconcile: only resolve `provider.*.options.apiKey` — leave MCP placeholders.
    ProviderApiKeysOnly,
}

#[derive(Debug, Clone, Default)]
pub struct TeamProviderSyncResult {
    /// Canonical placeholder content before full runtime resolve — set only for
    /// [`SecretResolveScope::FullConfig`] when placeholders were substituted.
    pub opencode_json_original: Option<String>,
    pub provider_section_changed: bool,
}

/// Materialize `provider.team` from `managed_llm` into amuxd's active-team OpenCode
/// config. Workspace config remains reserved
/// for workspace-owned MCP and project settings.
pub fn sync_global_team_provider(
    managed_llm: &ManagedLlmState,
    secrets: &HashMap<String, String>,
) -> anyhow::Result<bool> {
    let changed = team_provider::ensure_global_team_provider(managed_llm)?;
    let Some(api_key) = secrets.get("tc_api_key") else {
        return Ok(changed);
    };
    let resolved = crate::opencode_config::OpencodeConfigStore::apply_global(|config| {
        let Some(key) = config
            .get_mut("provider")
            .and_then(|providers| providers.get_mut("team"))
            .and_then(|team| team.get_mut("options"))
            .and_then(|options| options.get_mut("apiKey"))
            .and_then(|key| key.as_str().map(str::to_owned))
        else {
            return Ok(false);
        };
        let next = key.replace("${tc_api_key}", api_key);
        if next == key {
            return Ok(false);
        }
        config["provider"]["team"]["options"]["apiKey"] = serde_json::Value::String(next);
        Ok(true)
    })?;
    Ok(changed || resolved)
}

/// Resolve workspace-owned secrets and install the runtime overlay. Team LLM
/// materialization is intentionally absent: it belongs to the active-team config.
pub fn resolve_workspace_runtime_config(
    workspace: &Path,
    secrets: &HashMap<String, String>,
    scope: SecretResolveScope,
) -> anyhow::Result<TeamProviderSyncResult> {
    team_provider::remove_legacy_workspace_team_provider(workspace)?;
    let opencode_json_original = match scope {
        SecretResolveScope::FullConfig => {
            mcp_resolve::resolve_config_secret_refs(workspace, secrets)?
        }
        SecretResolveScope::ProviderApiKeysOnly => {
            mcp_resolve::resolve_provider_api_keys_on_disk(workspace, secrets)?;
            None
        }
    };
    Ok(TeamProviderSyncResult {
        opencode_json_original,
        provider_section_changed: false,
    })
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

    fn read_opencode(path: &Path) -> String {
        fs::read_to_string(path.join("opencode.json")).unwrap()
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
        home.path().join("teams/team-test/state/opencode.json")
    }

    #[test]
    fn provider_only_scope_resolves_team_api_key_leaves_mcp_placeholder() {
        let (_lock, global_dir, _home) = global_config_dir();
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "provider": {
    "team": {
      "options": { "apiKey": "${tc_api_key}" },
      "models": { "model-a": { "name": "Model A" } }
    }
  },
  "mcp": {
    "github": {
      "environment": { "TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}"#,
        )
        .unwrap();

        let secrets = secrets_for_team_provider("actor-123");
        sync_global_team_provider(&ManagedLlmState::Enabled(sample_provider()), &secrets).unwrap();
        resolve_workspace_runtime_config(
            dir.path(),
            &secrets,
            SecretResolveScope::ProviderApiKeysOnly,
        )
        .unwrap();

        let on_disk = read_opencode(dir.path());
        let global = fs::read_to_string(global_config_path(&global_dir)).unwrap();
        assert!(global.contains("sk-tc-actor-123"));
        assert!(!on_disk.contains("provider.team"));
        assert!(
            on_disk.contains("${GITHUB_TOKEN}"),
            "reconcile scope must not resolve MCP placeholders"
        );
        assert!(
            !dir.path().join(".teamclu/opencode.runtime.json").exists(),
            "provider-only resolve must not install spawn overlay"
        );
    }

    #[test]
    fn sync_preserves_resolved_api_key_on_reconcile() {
        let (_lock, dir, _home) = global_config_dir();
        let resolved = "sk-tc-actor-xyz";
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
            &secrets_for_team_provider("actor-xyz"),
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

        sync_global_team_provider(&managed, &secrets).unwrap();
        let reconcile_disk = fs::read_to_string(global_config_path(&dir)).unwrap();

        fs::write(global_config_path(&dir), r#"{}"#).unwrap();
        sync_global_team_provider(&managed, &secrets).unwrap();
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

    #[test]
    fn full_config_scope_materializes_team_provider_and_resolves_secrets() {
        let (_lock, global_dir, _home) = global_config_dir();
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "provider": {
    "team": { "options": { "apiKey": "${tc_api_key}" } }
  },
  "mcp": {
    "github": { "environment": { "TOKEN": "${API_TOKEN}" } }
  }
}"#,
        )
        .unwrap();

        let mut secrets = HashMap::new();
        secrets.insert("tc_api_key".to_string(), "sk-tc-spawn-actor".to_string());
        secrets.insert("API_TOKEN".to_string(), "ghp_spawn".to_string());

        sync_global_team_provider(&ManagedLlmState::Enabled(sample_provider()), &secrets).unwrap();
        resolve_workspace_runtime_config(dir.path(), &secrets, SecretResolveScope::FullConfig)
            .unwrap();

        let on_disk = read_opencode(dir.path());
        let global = fs::read_to_string(global_config_path(&global_dir)).unwrap();
        assert!(global.contains("sk-tc-spawn-actor"));
        assert!(on_disk.contains("ghp_spawn"));
        assert!(!global.contains("${tc_api_key}"));
        assert!(!on_disk.contains("${API_TOKEN}"));
        assert!(dir.path().join(".teamclu/opencode.runtime.json").exists());
        // The model list is pinned client-side (TEAM_MODEL_TIERS), so the
        // cloud's `model-a` must NOT appear -- what the gateway routes each
        // tier to is a server-side concern the client never sees.
        let parsed: serde_json::Value = serde_json::from_str(&global).unwrap();
        let models = parsed["provider"]["team"]["models"].as_object().unwrap();
        assert_eq!(models.len(), 3, "exactly the three tiers");
        for (id, label) in crate::team_provider::TEAM_MODEL_TIERS {
            assert_eq!(models[id]["name"].as_str(), Some(label), "tier {id}");
        }
        assert!(
            !models.contains_key("model-a"),
            "cloud model list is not used"
        );
    }
}
