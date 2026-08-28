use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::opencode_config::OpencodeConfigStore;
use crate::personal_secrets::is_internal_personal_blob_key;
use crate::resolved_env::{EnvOverrideKind, EnvScope, ResolvedEnvSnapshot};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EnvKeyActivationStatus {
    pub key: String,
    pub scope: EnvScope,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedConfigPlaceholder {
    /// JSON path, e.g. `mcp.github.environment.GITHUB_TOKEN`.
    pub path: String,
    /// Literal placeholder token, e.g. `${API_KEY}`.
    pub placeholder: String,
    /// Referenced env key name.
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvActivationAnalysis {
    pub expected_env_keys: Vec<String>,
    pub effective_env_keys: Vec<String>,
    pub missing_expected_keys: Vec<String>,
    /// Keys queued on the global OpenCode serve host (names only).
    pub served_env_keys: Vec<String>,
    /// Resolved personal/team keys absent from the serve host queue.
    pub missing_served_env_keys: Vec<String>,
    /// Personal/team keys captured on the newest active runtime handle.
    pub active_handle_env_keys: Vec<String>,
    pub key_statuses: Vec<EnvKeyActivationStatus>,
    pub mcp_unresolved_placeholders: Vec<UnresolvedConfigPlaceholder>,
}

#[derive(Debug, Clone)]
pub struct EnvActivationInput<'a> {
    pub personal_env: &'a HashMap<String, String>,
    pub team_env: &'a HashMap<String, String>,
    pub resolved: &'a ResolvedEnvSnapshot,
    pub unresolved_keys: &'a [String],
    pub override_keys: &'a [String],
    pub host_shadowed_keys: &'a [String],
    pub activation_status: &'a str,
    pub active_runtime_count: usize,
    pub active_snapshot: Option<&'a ResolvedEnvSnapshot>,
    /// Key names queued on the global OpenCode serve host.
    pub served_env_keys: &'a [String],
    pub opencode_serve_running: bool,
}

pub fn analyze_env_activation(input: &EnvActivationInput<'_>) -> EnvActivationAnalysis {
    let expected = collect_expected_keys(input.personal_env, input.team_env, input.unresolved_keys);
    let expected_env_keys: Vec<String> = expected.iter().map(|(key, _)| key.clone()).collect();

    let effective_env_keys: Vec<String> = input
        .resolved
        .provenance
        .iter()
        .filter(|entry| entry.alias_of.is_none())
        .filter(|entry| matches!(entry.scope, EnvScope::Personal | EnvScope::Team))
        .map(|entry| entry.key.clone())
        .collect();

    let key_statuses: Vec<EnvKeyActivationStatus> = expected
        .into_iter()
        .map(|(key, scope)| EnvKeyActivationStatus {
            key: key.clone(),
            scope,
            status: classify_key(&key, scope, input),
        })
        .collect();

    let effective_set: HashSet<String> = effective_env_keys
        .iter()
        .map(|key| key.to_ascii_uppercase())
        .collect();
    let missing_expected_keys: Vec<String> = expected_env_keys
        .iter()
        .filter(|key| {
            !effective_set.contains(&key.to_ascii_uppercase())
                && !input
                    .unresolved_keys
                    .iter()
                    .any(|unresolved| unresolved.eq_ignore_ascii_case(key))
        })
        .cloned()
        .collect();

    let served_env_keys: Vec<String> = input.served_env_keys.to_vec();
    let active_handle_env_keys = input
        .active_snapshot
        .map(extract_handle_env_keys)
        .unwrap_or_default();
    let missing_served_env_keys = compute_missing_served_env_keys(
        &effective_env_keys,
        &served_env_keys,
        input.host_shadowed_keys,
        input.opencode_serve_running,
    );

    EnvActivationAnalysis {
        expected_env_keys,
        effective_env_keys,
        missing_expected_keys,
        served_env_keys,
        missing_served_env_keys,
        active_handle_env_keys,
        key_statuses,
        mcp_unresolved_placeholders: Vec::new(),
    }
}

pub fn extract_handle_env_keys(snapshot: &ResolvedEnvSnapshot) -> Vec<String> {
    let mut keys: Vec<String> = snapshot
        .provenance
        .iter()
        .filter(|entry| entry.alias_of.is_none())
        .filter(|entry| matches!(entry.scope, EnvScope::Personal | EnvScope::Team))
        .map(|entry| entry.key.clone())
        .collect();
    keys.sort_by_key(|left| left.to_ascii_lowercase());
    keys.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    keys
}

fn compute_missing_served_env_keys(
    effective_env_keys: &[String],
    served_env_keys: &[String],
    host_shadowed_keys: &[String],
    opencode_serve_running: bool,
) -> Vec<String> {
    if !opencode_serve_running && served_env_keys.is_empty() {
        return Vec::new();
    }
    effective_env_keys
        .iter()
        .filter(|key| {
            !host_shadowed_keys
                .iter()
                .any(|shadowed| shadowed.eq_ignore_ascii_case(key))
                && !key_in_list(served_env_keys, key)
        })
        .cloned()
        .collect()
}

fn should_probe_serve(input: &EnvActivationInput<'_>) -> bool {
    input.opencode_serve_running || !input.served_env_keys.is_empty()
}

fn key_in_list(keys: &[String], key: &str) -> bool {
    keys.iter().any(|entry| entry.eq_ignore_ascii_case(key))
}

pub fn find_unresolved_config_placeholders(
    workspace: &Path,
    bindings: &HashMap<String, String>,
) -> Vec<UnresolvedConfigPlaceholder> {
    let Some(content) = OpencodeConfigStore::load_raw(workspace).ok().flatten() else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    collect_placeholders_in_value(&json, "", bindings, &mut out);
    out.sort_by(|left, right| left.path.cmp(&right.path));
    out.dedup_by(|left, right| left.path == right.path && left.placeholder == right.placeholder);
    out
}

fn collect_expected_keys(
    personal_env: &HashMap<String, String>,
    team_env: &HashMap<String, String>,
    unresolved_keys: &[String],
) -> Vec<(String, EnvScope)> {
    let mut keys = Vec::new();
    for key in personal_env.keys() {
        if !is_internal_personal_blob_key(key) {
            keys.push((key.clone(), EnvScope::Personal));
        }
    }
    for key in team_env.keys() {
        keys.push((key.clone(), EnvScope::Team));
    }
    for key in unresolved_keys {
        if !keys
            .iter()
            .any(|(existing, _)| existing.eq_ignore_ascii_case(key))
        {
            keys.push((key.clone(), EnvScope::Team));
        }
    }
    keys.sort_by_key(|left| left.0.to_ascii_lowercase());
    keys.dedup_by(|left, right| left.0.eq_ignore_ascii_case(&right.0));
    keys
}

fn classify_key(key: &str, scope: EnvScope, input: &EnvActivationInput<'_>) -> String {
    if input
        .unresolved_keys
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(key))
    {
        return "unresolved".to_string();
    }
    if input
        .host_shadowed_keys
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(key))
    {
        return "host_shadowed".to_string();
    }
    if input.resolved.overrides.iter().any(|entry| {
        entry.kind == EnvOverrideKind::Layer
            && entry.overridden.scope == scope
            && entry.overridden.key.eq_ignore_ascii_case(key)
    }) {
        return "overridden".to_string();
    }
    if scope == EnvScope::Personal
        && input
            .override_keys
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(key))
    {
        return "overridden".to_string();
    }

    let in_resolved = binding_contains_key(&input.resolved.bindings, key);
    if !in_resolved {
        return "missing".to_string();
    }

    if input.active_runtime_count > 0 {
        return "pending_session".to_string();
    }

    if should_probe_serve(input) && !key_in_list(input.served_env_keys, key) {
        return "not_served".to_string();
    }

    if input.activation_status == "blocked" {
        return "pending".to_string();
    }

    if input.activation_status == "active" {
        return "active".to_string();
    }

    "pending".to_string()
}

fn binding_contains_key(bindings: &HashMap<String, String>, key: &str) -> bool {
    bindings.contains_key(key) || bindings.contains_key(&key.to_ascii_uppercase())
}

fn collect_placeholders_in_value(
    value: &serde_json::Value,
    path: &str,
    bindings: &HashMap<String, String>,
    out: &mut Vec<UnresolvedConfigPlaceholder>,
) {
    match value {
        serde_json::Value::String(text) => {
            for (placeholder, key) in extract_placeholders(text) {
                if !binding_contains_key(bindings, &key) {
                    out.push(UnresolvedConfigPlaceholder {
                        path: path.to_string(),
                        placeholder,
                        key,
                    });
                }
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let child_path = if path.is_empty() {
                    index.to_string()
                } else {
                    format!("{path}.{index}")
                };
                collect_placeholders_in_value(item, &child_path, bindings, out);
            }
        }
        serde_json::Value::Object(map) => {
            for (field, item) in map {
                let child_path = if path.is_empty() {
                    field.clone()
                } else {
                    format!("{path}.{field}")
                };
                collect_placeholders_in_value(item, &child_path, bindings, out);
            }
        }
        _ => {}
    }
}

fn extract_placeholders(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            break;
        };
        let key = after[..end].to_string();
        if !key.is_empty() {
            out.push((format!("${{{key}}}"), key));
        }
        rest = &after[end + 1..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolved_env::resolve_runtime_env;
    use crate::SystemEnvContext;
    use std::fs;

    struct TestActivation {
        resolved: ResolvedEnvSnapshot,
    }

    impl TestActivation {
        fn new(
            personal: &HashMap<String, String>,
            team: &HashMap<String, String>,
            _activation_status: &str,
            _active_runtime_count: usize,
        ) -> Self {
            Self {
                resolved: resolve_runtime_env(
                    personal.clone(),
                    team.clone(),
                    SystemEnvContext {
                        actor_id: "actor-1".to_string(),
                        display_name: "Test".to_string(),
                        cloud_token_file: None,
                gateway_token: None,
                    },
                ),
            }
        }

        fn analyze(
            &self,
            personal: &HashMap<String, String>,
            team: &HashMap<String, String>,
            activation_status: &str,
            active_runtime_count: usize,
        ) -> EnvActivationAnalysis {
            analyze_env_activation(&EnvActivationInput {
                personal_env: personal,
                team_env: team,
                resolved: &self.resolved,
                unresolved_keys: &[],
                override_keys: &[],
                host_shadowed_keys: &[],
                activation_status,
                active_runtime_count,
                active_snapshot: None,
                served_env_keys: &[],
                opencode_serve_running: false,
            })
        }
    }

    #[test]
    fn marks_personal_key_active_when_snapshot_is_active() {
        let personal = HashMap::from([("openai_api_key".to_string(), "sk-test".to_string())]);
        let team = HashMap::new();
        let fixture = TestActivation::new(&personal, &team, "active", 0);
        let analysis = fixture.analyze(&personal, &team, "active", 0);
        assert_eq!(analysis.key_statuses.len(), 1);
        assert_eq!(analysis.key_statuses[0].status, "active");
        assert!(analysis.missing_expected_keys.is_empty());
    }

    #[test]
    fn marks_key_not_served_when_missing_from_serve_cache() {
        let personal = HashMap::from([("openai_api_key".to_string(), "sk-test".to_string())]);
        let team = HashMap::new();
        let fixture = TestActivation::new(&personal, &team, "active", 0);
        let analysis = analyze_env_activation(&EnvActivationInput {
            personal_env: &personal,
            team_env: &team,
            resolved: &fixture.resolved,
            unresolved_keys: &[],
            override_keys: &[],
            host_shadowed_keys: &[],
            activation_status: "active",
            active_runtime_count: 0,
            active_snapshot: None,
            served_env_keys: &[],
            opencode_serve_running: true,
        });
        assert_eq!(analysis.key_statuses[0].status, "not_served");
        assert_eq!(
            analysis.missing_served_env_keys,
            vec!["openai_api_key".to_string()]
        );
    }

    #[test]
    fn marks_key_active_when_present_in_serve_cache() {
        let personal = HashMap::from([("openai_api_key".to_string(), "sk-test".to_string())]);
        let team = HashMap::new();
        let fixture = TestActivation::new(&personal, &team, "active", 0);
        let served = vec!["openai_api_key".to_string()];
        let analysis = analyze_env_activation(&EnvActivationInput {
            personal_env: &personal,
            team_env: &team,
            resolved: &fixture.resolved,
            unresolved_keys: &[],
            override_keys: &[],
            host_shadowed_keys: &[],
            activation_status: "active",
            active_runtime_count: 0,
            active_snapshot: None,
            served_env_keys: &served,
            opencode_serve_running: true,
        });
        assert_eq!(analysis.key_statuses[0].status, "active");
        assert!(analysis.missing_served_env_keys.is_empty());
    }

    #[test]
    fn marks_key_pending_session_when_runtime_is_active() {
        let personal = HashMap::from([("openai_api_key".to_string(), "sk-test".to_string())]);
        let team = HashMap::new();
        let fixture = TestActivation::new(&personal, &team, "active", 2);
        let analysis = fixture.analyze(&personal, &team, "active", 2);
        assert_eq!(analysis.key_statuses[0].status, "pending_session");
    }

    #[test]
    fn marks_team_override_on_personal_key() {
        let personal = HashMap::from([("shared_token".to_string(), "personal".to_string())]);
        let team = HashMap::from([("shared_token".to_string(), "team".to_string())]);
        let fixture = TestActivation::new(&personal, &team, "active", 0);
        let analysis = fixture.analyze(&personal, &team, "active", 0);
        assert_eq!(analysis.key_statuses[0].status, "overridden");
    }

    #[test]
    fn finds_unresolved_mcp_placeholder_in_opencode_json() {
        let dir = tempfile::TempDir::new().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "mcp": {
    "github": {
      "environment": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}"#,
        )
        .unwrap();

        let bindings = HashMap::from([("API_KEY".to_string(), "set".to_string())]);
        let found = find_unresolved_config_placeholders(dir.path(), &bindings);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "GITHUB_TOKEN");
        assert!(found[0].path.contains("github"));
    }
}
