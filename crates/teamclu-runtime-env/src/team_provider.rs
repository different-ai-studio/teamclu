use std::path::Path;

use tracing::info;

use crate::opencode_config::OpencodeConfigStore;
use crate::storage_namespace::{brand_short_name_from_env, resolve_workspace_config_path};
use crate::DEFAULT_TEAM_REPO_DIR;

/// The three capability tiers the team gateway exposes, pinned client-side.
///
/// These ids are the whole public contract. What changes is which upstream each
/// one resolves to, and that mapping lives in the gateway's catalog — so the
/// backend, the price, and the vendor can all move without shipping a client.
/// Adding a fourth tier does need a release, which is the intended trade: a new
/// tier is a product decision, not a config tweak.
///
/// Sourcing this list from the cloud instead (which is what it used to do) made
/// every member's model menu depend on a network round-trip that could return
/// stale or empty, for a list that has not changed in the product's lifetime.
pub const TEAM_MODEL_TIERS: [(&str, &str); 3] =
    [("default", "标准"), ("pro", "高级"), ("max", "旗舰")];

/// The base URL a RUNTIME should call, which is not the one the daemon calls.
///
/// `provider.base_url` is the cloud `llm_base_url` — the gateway, and the
/// cutover lever the daemon's own proxy forwards to. A runtime must not use it
/// directly: the credential it is handed is a daemon `ai:invoke` token, which
/// the gateway (a GoTrue verifier) rejects. Pointing a runtime there produced
/// exactly that — `invalid_token` on every team-model call.
///
/// The daemon supplies its own loopback proxy URL instead, and that indirection
/// is what survives a long run: the runtime's token is good for a year, while
/// the cloud access token behind it expires hourly and is refreshed per request
/// on the daemon side. Baking a cloud token into a config file cannot do that —
/// a long-lived agent would simply start failing an hour in.
///
/// `None` leaves the cloud URL in place, which is right for callers that have
/// no proxy to offer (tests, and any process without an HTTP listener).
fn runtime_facing_base_url<'a>(provider: &'a ManagedLlmProvider, proxy_base: Option<&'a str>) -> &'a str {
    proxy_base.unwrap_or(&provider.base_url)
}

/// One model exposed by the team's managed LLM gateway.
#[derive(Debug, Clone)]
pub struct ManagedLlmModel {
    pub id: String,
    pub name: String,
}

/// The team's managed (shared) LLM provider, sourced from the cloud API rather
/// than a disk file. Materialized into amuxd's global `opencode.json` as
/// `provider.team`.
#[derive(Debug, Clone)]
pub struct ManagedLlmProvider {
    pub name: String,
    pub base_url: String,
    pub models: Vec<ManagedLlmModel>,
}

/// Tri-state result of resolving the team's managed LLM from the cloud.
#[derive(Debug, Clone, Default)]
pub enum ManagedLlmState {
    #[default]
    Unknown,
    Disabled,
    Enabled(ManagedLlmProvider),
}

fn teamclu_config_path(workspace: &Path) -> std::path::PathBuf {
    resolve_workspace_config_path(workspace, &brand_short_name_from_env())
}

/// Read workspace brand config → `team.sharedDirName`, or fall back to
/// [`DEFAULT_TEAM_REPO_DIR`].
pub fn resolve_shared_dir_name(workspace: &Path) -> String {
    let config_path = teamclu_config_path(workspace);
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(_) => return DEFAULT_TEAM_REPO_DIR.to_string(),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(json) => json,
        Err(_) => return DEFAULT_TEAM_REPO_DIR.to_string(),
    };
    json.get("team")
        .and_then(|team| team.get("sharedDirName"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_TEAM_REPO_DIR.to_string())
}

fn map_store_err(e: crate::opencode_config::OpencodeConfigError) -> anyhow::Error {
    anyhow::anyhow!("{e}")
}

fn map_mutate_err(e: anyhow::Error) -> crate::opencode_config::OpencodeConfigError {
    crate::opencode_config::OpencodeConfigError::Parse(e.to_string())
}

/// Apply `provider.team` reconciliation in-memory (no write). Returns whether the
/// config object changed.
pub fn mutate_team_provider(
    config: &mut serde_json::Value,
    state: &ManagedLlmState,
    proxy_base: Option<&str>,
) -> anyhow::Result<bool> {
    if matches!(state, ManagedLlmState::Unknown) {
        return Ok(false);
    }

    let obj = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("opencode.json root is not an object"))?;

    if obj.get("$schema").is_none() && obj.is_empty() {
        obj.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
    }

    let has_team_in_opencode = obj
        .get("provider")
        .and_then(|p| p.as_object())
        .map(|p| p.contains_key("team"))
        .unwrap_or(false);

    let mut changed = false;

    match state {
        ManagedLlmState::Enabled(provider) => {
            // Pinned, not read from `provider.models` (see TEAM_MODEL_TIERS).
            let mut models_out = serde_json::Map::new();
            for (id, label) in TEAM_MODEL_TIERS {
                models_out.insert(
                    id.to_string(),
                    serde_json::json!({
                        "name": label,
                        "limit": { "context": 256000, "output": 16000 }
                    }),
                );
            }

            let name = if provider.name.is_empty() {
                "Team"
            } else {
                &provider.name
            };
            // Preserve an already-resolved credential so this reconcile (which
            // runs on every provider read, including after wake) does not
            // clobber it with a placeholder and break a live opencode serve.
            //
            // Two values are NOT worth preserving, and both are rewritten by
            // `sync_global_team_provider` right after this:
            //   - a `sk-tc-*` LiteLLM virtual key left over from before the
            //     gateway cutover, which the new gateway will never accept
            //   - any placeholder
            let api_key = obj
                .get("provider")
                .and_then(|p| p.get("team"))
                .and_then(|t| t.get("options"))
                .and_then(|o| o.get("apiKey"))
                .and_then(|v| v.as_str())
                .filter(|k| !k.contains("${"))
                .filter(|k| !k.starts_with(crate::merge::LEGACY_VIRTUAL_KEY_PREFIX))
                .unwrap_or(crate::merge::GATEWAY_TOKEN_PLACEHOLDER);
            let team_entry = serde_json::json!({
                "npm": "@ai-sdk/openai-compatible",
                "name": name,
                "options": { "baseURL": runtime_facing_base_url(provider, proxy_base), "apiKey": api_key },
                "models": models_out,
            });

            let providers = obj
                .entry("provider")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("provider is not an object"))?;
            if providers.get("team") != Some(&team_entry) {
                providers.insert("team".to_string(), team_entry);
                changed = true;
                info!(
                    base_url = %provider.base_url,
                    "Wrote provider.team to opencode.json (synced from cloud managed LLM)"
                );
            }
        }
        ManagedLlmState::Disabled => {
            if has_team_in_opencode {
                if let Some(providers) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) {
                    providers.remove("team");
                    if providers.is_empty() {
                        obj.remove("provider");
                    }
                    changed = true;
                    info!("Removed stale provider.team from opencode.json (managed LLM disabled)");
                }
            }
        }
        ManagedLlmState::Unknown => {}
    }

    Ok(changed)
}

/// Read `provider.team` from amuxd's active-team OpenCode config, if present.
pub fn read_global_team_provider() -> Option<serde_json::Value> {
    let json = OpencodeConfigStore::load_global().ok()?;
    json.get("provider")
        .and_then(|provider| provider.get("team"))
        .filter(|team| team.is_object())
        .cloned()
}

/// Reconstruct a [`ManagedLlmProvider`] from an on-disk `provider.team` object.
pub fn managed_llm_provider_from_disk_team(team: &serde_json::Value) -> Option<ManagedLlmProvider> {
    let base_url = team
        .get("options")
        .and_then(|options| options.get("baseURL"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())?
        .to_string();
    let name = team
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Team")
        .to_string();
    let models = team
        .get("models")
        .and_then(|v| v.as_object())
        .map(|map| {
            let mut models: Vec<ManagedLlmModel> = map
                .iter()
                .map(|(id, entry)| ManagedLlmModel {
                    id: id.clone(),
                    name: entry
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(id)
                        .to_string(),
                })
                .collect();
            models.sort_by(|left, right| left.id.cmp(&right.id));
            models
        })
        .unwrap_or_default();
    Some(ManagedLlmProvider {
        name,
        base_url,
        models,
    })
}

/// Stabilize managed-LLM state before spawn env fingerprinting.
///
/// Cold cloud fetches / empty TTL caches often yield [`ManagedLlmState::Unknown`],
/// which omits `TEAMCLU_TEAM_PROVIDER` from the spawn env. A later successful
/// fetch then injects the key and flips the OpenCode host fingerprint.
/// When the active-team config already has `provider.team`, reconstruct `Enabled` from it so the
/// first attach matches a subsequent confirmed cloud answer with the same data.
pub fn stabilize_managed_llm_for_spawn(
    state: &ManagedLlmState,
    disk_team_provider: Option<&serde_json::Value>,
) -> ManagedLlmState {
    if !matches!(state, ManagedLlmState::Unknown) {
        return state.clone();
    }
    match disk_team_provider.and_then(managed_llm_provider_from_disk_team) {
        Some(provider) => ManagedLlmState::Enabled(provider),
        None => ManagedLlmState::Unknown,
    }
}

/// JSON payload for the `TEAMCLU_TEAM_PROVIDER` spawn env (no secret embedded).
pub fn team_provider_env_payload(
    provider: &ManagedLlmProvider,
    proxy_base: Option<&str>,
) -> String {
    let models: Vec<serde_json::Value> = provider
        .models
        .iter()
        .filter(|m| !m.id.is_empty())
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "name": if m.name.is_empty() { &m.id } else { &m.name },
            })
        })
        .collect();
    let name = if provider.name.is_empty() {
        "Team"
    } else {
        &provider.name
    };
    serde_json::json!({
        "name": name,
        "baseUrl": runtime_facing_base_url(provider, proxy_base),
        // Names the env binding a runtime that registers the provider
        // itself (pi) should read the credential from. Must track the key
        // bound in resolved_env.rs — a stale name here is a silent 401.
        "apiKeyEnv": "tc_gateway_token",
        "models": models,
    })
    .to_string()
}

/// Reconcile `provider.team` in the active-team OpenCode config against the
/// cloud-sourced managed LLM.
///
/// Returns whether the on-disk config was rewritten. External callers should prefer
/// [`crate::team_provider_sync::sync_global_team_provider`] so materialization and secret resolution
/// stay aligned across spawn and reconcile paths.
pub fn ensure_global_team_provider(
    state: &ManagedLlmState,
    proxy_base: Option<&str>,
) -> anyhow::Result<bool> {
    if matches!(state, ManagedLlmState::Unknown) {
        return Ok(false);
    }
    OpencodeConfigStore::apply_global(|config| {
        mutate_team_provider(config, state, proxy_base).map_err(map_mutate_err)
    })
    .map_err(map_store_err)
}

/// Remove the legacy workspace-local copy of TeamClu's reserved `provider.team`.
///
/// The entry used to live in every `<workspace>/opencode.json`. Keeping one
/// around would make a disabled global provider silently fall back to stale
/// workspace models, so every spawn clears it during the global-config
/// migration. Other workspace providers are left untouched.
pub fn remove_legacy_workspace_team_provider(workspace: &Path) -> anyhow::Result<bool> {
    OpencodeConfigStore::apply(workspace, |config| {
        let Some(root) = config.as_object_mut() else {
            return Err(crate::opencode_config::OpencodeConfigError::Parse(
                "opencode.json root is not an object".to_string(),
            ));
        };
        let Some(providers) = root
            .get_mut("provider")
            .and_then(|value| value.as_object_mut())
        else {
            return Ok(false);
        };
        if providers.remove("team").is_none() {
            return Ok(false);
        }
        if providers.is_empty() {
            root.remove("provider");
        }
        Ok(true)
    })
    .map_err(map_store_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_teamclu_json(dir: &Path, shared_dir_name: Option<&str>) {
        let config_path = crate::workspace_config_path(dir, "teamclu");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        let json = match shared_dir_name {
            Some(name) => serde_json::json!({ "team": { "sharedDirName": name } }),
            None => serde_json::json!({ "team": {} }),
        };
        fs::write(&config_path, serde_json::to_string(&json).unwrap()).unwrap();
    }

    fn sample_provider() -> ManagedLlmProvider {
        ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "gpt-4".to_string(),
                name: "GPT-4".to_string(),
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
        home.path()
            .join("teams/team-test/state")
            .join(crate::opencode_config::OPENCODE_JSON)
    }

    #[test]
    fn materializes_exactly_the_three_pinned_tiers_ignoring_the_cloud_list() {
        // The cloud used to drive this list. It no longer does: whatever the
        // backend reports, the client writes default/pro/max. Which upstream a
        // tier resolves to is the gateway's business, and changing it must not
        // require a client release.
        let state = ManagedLlmState::Enabled(ManagedLlmProvider {
            name: "Team".into(),
            base_url: "https://gw.example/v1/teams/t1".into(),
            models: vec![ManagedLlmModel {
                id: "some-cloud-model".into(),
                name: "Cloud Model".into(),
            }],
        });
        let mut config = serde_json::json!({});
        assert!(mutate_team_provider(&mut config, &state).unwrap());

        let models = config["provider"]["team"]["models"].as_object().unwrap();
        assert_eq!(models.len(), 3);
        for (id, label) in TEAM_MODEL_TIERS {
            assert_eq!(models[id]["name"].as_str(), Some(label), "tier {id}");
        }
        assert!(
            !models.contains_key("some-cloud-model"),
            "a model advertised by the cloud must not reach the runtime"
        );
        // The base URL still comes from the cloud -- that is the cutover lever
        // (design §11.1), and pinning it would remove the rollback path.
        assert_eq!(
            config["provider"]["team"]["options"]["baseURL"].as_str(),
            Some("https://gw.example/v1/teams/t1")
        );
    }

    #[test]
    fn ensure_global_team_provider_adds_team_when_enabled() {
        let (_lock, dir, _home) = global_config_dir();
        ensure_global_team_provider(&ManagedLlmState::Enabled(sample_provider())).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(global_config_path(&dir)).unwrap()).unwrap();
        assert!(parsed["provider"]["team"].is_object());
    }

    #[test]
    fn ensure_global_team_provider_preserves_a_live_resolved_token() {
        // Reconcile runs on every provider read. Overwriting a resolved
        // credential with the placeholder would break a live opencode serve
        // mid-session, so a real token has to survive.
        let (_lock, dir, _home) = global_config_dir();
        let resolved = "tok_live_session";
        write_team_provider_with_key(&dir, resolved);
        ensure_global_team_provider(&ManagedLlmState::Enabled(sample_provider())).unwrap();
        assert_eq!(
            read_team_api_key(&dir).as_deref(),
            Some(resolved),
            "a live token must survive reconcile"
        );
    }

    #[test]
    fn ensure_global_team_provider_drops_a_legacy_litellm_key() {
        // The opposite case, and the reason the filter is not just "keep
        // anything already resolved": a `sk-tc-*` LiteLLM virtual key left over
        // from before the gateway cutover names a credential the new gateway
        // will never accept. Preserving it would strand the device on a dead
        // key with no self-healing path -- the symptom is a permanent 401 that
        // no amount of reconciling clears.
        let (_lock, dir, _home) = global_config_dir();
        write_team_provider_with_key(&dir, "sk-tc-actor-123");
        ensure_global_team_provider(&ManagedLlmState::Enabled(sample_provider())).unwrap();
        assert_eq!(
            read_team_api_key(&dir).as_deref(),
            Some(crate::merge::GATEWAY_TOKEN_PLACEHOLDER),
            "a legacy virtual key is replaced by the placeholder, which sync_global_team_provider then fills"
        );
    }

    fn write_team_provider_with_key(dir: &tempfile::TempDir, api_key: &str) {
        fs::write(
            global_config_path(dir),
            serde_json::json!({
                "provider": {
                    "team": {
                        "options": {
                            "baseURL": "https://gateway.example/v1",
                            "apiKey": api_key
                        },
                        "models": { "old-model": { "name": "Old" } }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn read_team_api_key(dir: &tempfile::TempDir) -> Option<String> {
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(global_config_path(dir)).unwrap()).unwrap();
        parsed["provider"]["team"]["options"]["apiKey"]
            .as_str()
            .map(str::to_owned)
    }

    #[test]
    fn ensure_global_team_provider_overwrites_existing_team_when_enabled() {
        let (_lock, dir, _home) = global_config_dir();
        fs::write(
            global_config_path(&dir),
            serde_json::json!({
                "provider": {
                    "team": { "options": { "baseURL": "https://old.example" } }
                }
            })
            .to_string(),
        )
        .unwrap();
        ensure_global_team_provider(&ManagedLlmState::Enabled(sample_provider())).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(global_config_path(&dir)).unwrap()).unwrap();
        assert_eq!(
            parsed["provider"]["team"]["options"]["baseURL"],
            "https://gateway.example/v1"
        );
    }

    #[test]
    fn ensure_global_team_provider_removes_stale_team_when_disabled() {
        let (_lock, dir, _home) = global_config_dir();
        fs::write(
            global_config_path(&dir),
            serde_json::json!({ "provider": { "team": {} } }).to_string(),
        )
        .unwrap();
        ensure_global_team_provider(&ManagedLlmState::Disabled).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(global_config_path(&dir)).unwrap()).unwrap();
        assert!(parsed.get("provider").is_none());
    }

    #[test]
    fn ensure_global_team_provider_unknown_leaves_config_untouched() {
        let (_lock, dir, _home) = global_config_dir();
        fs::write(
            global_config_path(&dir),
            serde_json::json!({ "provider": { "team": { "keep": true } } }).to_string(),
        )
        .unwrap();
        ensure_global_team_provider(&ManagedLlmState::Unknown).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(global_config_path(&dir)).unwrap()).unwrap();
        assert_eq!(parsed["provider"]["team"]["keep"], true);
    }

    #[test]
    fn resolve_shared_dir_name_reads_teamclu_json() {
        let dir = TempDir::new().unwrap();
        write_teamclu_json(dir.path(), Some("custom-team"));
        assert_eq!(resolve_shared_dir_name(dir.path()), "custom-team");
    }

    #[test]
    fn stabilize_leaves_enabled_and_disabled_unchanged() {
        let enabled = ManagedLlmState::Enabled(sample_provider());
        assert!(matches!(
            stabilize_managed_llm_for_spawn(&enabled, None),
            ManagedLlmState::Enabled(_)
        ));
        assert!(matches!(
            stabilize_managed_llm_for_spawn(&ManagedLlmState::Disabled, None),
            ManagedLlmState::Disabled
        ));
    }

    #[test]
    fn stabilize_unknown_without_disk_stays_unknown() {
        assert!(matches!(
            stabilize_managed_llm_for_spawn(&ManagedLlmState::Unknown, None),
            ManagedLlmState::Unknown
        ));
    }

    #[test]
    fn stabilize_unknown_with_disk_team_becomes_enabled() {
        let disk = serde_json::json!({
            "name": "Team",
            "options": { "baseURL": "https://gateway.example/v1", "apiKey": "${tc_gateway_token}" },
            "models": {
                "gpt-4": { "name": "GPT-4" }
            }
        });
        match stabilize_managed_llm_for_spawn(&ManagedLlmState::Unknown, Some(&disk)) {
            ManagedLlmState::Enabled(provider) => {
                assert_eq!(provider.base_url, "https://gateway.example/v1");
                assert_eq!(provider.models.len(), 1);
                assert_eq!(provider.models[0].id, "gpt-4");
            }
            other => panic!("expected Enabled from disk, got {other:?}"),
        }
    }

    #[test]
    fn stabilize_unknown_disk_payload_matches_enabled_env_payload() {
        let provider = sample_provider();
        let disk = serde_json::json!({
            "name": provider.name,
            "options": { "baseURL": provider.base_url, "apiKey": "${tc_gateway_token}" },
            "models": {
                "gpt-4": { "name": "GPT-4" }
            }
        });
        let stabilized = stabilize_managed_llm_for_spawn(&ManagedLlmState::Unknown, Some(&disk));
        let ManagedLlmState::Enabled(from_disk) = stabilized else {
            panic!("expected Enabled");
        };
        assert_eq!(
            team_provider_env_payload(&from_disk),
            team_provider_env_payload(&provider)
        );
    }
}
