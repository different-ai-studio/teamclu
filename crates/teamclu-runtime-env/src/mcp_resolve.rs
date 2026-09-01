use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::opencode_config::OpencodeConfigStore;

fn opencode_config_path(workspace: &Path) -> PathBuf {
    crate::opencode_config::opencode_config_path(workspace)
}

/// Replace `${KEY}` and `$KEY` references in the canonical config, write the
/// resolved copy to `{meta}/opencode.runtime.json`, and install it at
/// `opencode.json` for the active runtime.
///
/// Returns the canonical (placeholder) file content when an overlay was
/// installed — caller must restore it when the runtime stops.
pub fn resolve_config_secret_refs(
    workspace: &Path,
    secrets: &HashMap<String, String>,
) -> anyhow::Result<Option<String>> {
    if secrets.is_empty() {
        return Ok(None);
    }

    let canonical = match OpencodeConfigStore::load_raw(workspace)? {
        Some(content) => content,
        None => return Ok(None),
    };

    let resolved = substitute_secret_placeholders(&canonical, secrets);
    if resolved == canonical {
        return Ok(None);
    }

    for (provider, placeholder) in unresolved_provider_api_key_placeholders(&resolved) {
        tracing::warn!(
            finding = "team_model_gateway_key_unavailable",
            provider = %provider,
            placeholder = %placeholder,
            config = %opencode_config_path(workspace).display(),
            "opencode.json provider apiKey still holds an unresolved placeholder; the model \
             gateway key was not injected — this provider's capabilities will fail closed"
        );
    }

    let overlay_path = crate::opencode_config::runtime_overlay_write_path(workspace);
    OpencodeConfigStore::write_raw(&overlay_path, &resolved)?;

    let config_path = opencode_config_path(workspace);
    let write_lock = crate::atomic_write::opencode_write_lock(&config_path);
    let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
    OpencodeConfigStore::write_raw(&config_path, &resolved)?;

    Ok(Some(canonical))
}

/// Find `provider.<name>.options.apiKey` values that still contain an
/// unresolved `${...}` placeholder. Returns `(provider_name, placeholder)`
/// pairs. The placeholder is a variable *name* (e.g. `${tc_gateway_token}`), never a
/// secret value, so it is safe to log. Returns empty on non-JSON content or
/// when there is no `provider` map.
pub fn unresolved_provider_api_key_placeholders(content: &str) -> Vec<(String, String)> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(content) else {
        return Vec::new();
    };
    let Some(providers) = json.get("provider").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, provider) in providers {
        let Some(api_key) = provider
            .get("options")
            .and_then(|o| o.get("apiKey"))
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if let Some(start) = api_key.find("${") {
            if let Some(end_rel) = api_key[start..].find('}') {
                let placeholder = api_key[start..start + end_rel + 1].to_string();
                out.push((name.clone(), placeholder));
            }
        }
    }
    out
}

/// Resolve only `provider.*.options.apiKey` placeholders on disk.
///
/// MCP and other `${KEY}` references are left untouched — safe for reconcile paths
/// that run on every provider read.
pub fn resolve_provider_api_keys_on_disk(
    workspace: &Path,
    secrets: &HashMap<String, String>,
) -> anyhow::Result<bool> {
    if secrets.is_empty() {
        return Ok(false);
    }

    let canonical = match OpencodeConfigStore::load_raw(workspace)? {
        Some(content) => content,
        None => return Ok(false),
    };

    let resolved = resolve_provider_api_keys(&canonical, secrets);
    if resolved == canonical {
        return Ok(false);
    }

    for (provider, placeholder) in unresolved_provider_api_key_placeholders(&resolved) {
        tracing::warn!(
            finding = "team_model_gateway_key_unavailable",
            provider = %provider,
            placeholder = %placeholder,
            config = %opencode_config_path(workspace).display(),
            "opencode.json provider apiKey still holds an unresolved placeholder; the model \
             gateway key was not injected — this provider's capabilities will fail closed"
        );
    }

    let config_path = opencode_config_path(workspace);
    let write_lock = crate::atomic_write::opencode_write_lock(&config_path);
    let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
    OpencodeConfigStore::write_raw(&config_path, &resolved)?;
    Ok(true)
}

/// Restore the canonical placeholder config after runtime stop. Provider
/// apiKey values stay resolved since opencode re-reads the config at request time.
pub fn restore_config(
    workspace: &Path,
    original: &Option<String>,
    secrets: &HashMap<String, String>,
) -> anyhow::Result<()> {
    if let Some(content) = original {
        let restored = resolve_provider_api_keys(content, secrets);
        let config_path = opencode_config_path(workspace);
        let write_lock = crate::atomic_write::opencode_write_lock(&config_path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        OpencodeConfigStore::write_raw(&config_path, &restored)?;
        let overlay = crate::opencode_config::runtime_overlay_write_path(workspace);
        let _ = std::fs::remove_file(&overlay);
        let legacy = crate::opencode_config::runtime_overlay_path(workspace);
        if legacy != overlay {
            let _ = std::fs::remove_file(legacy);
        }
    }
    Ok(())
}

fn substitute_secret_placeholders(content: &str, secrets: &HashMap<String, String>) -> String {
    let mut resolved = content.to_string();
    for (key, value) in secrets {
        let placeholder = format!("${{{}}}", key);
        if resolved.contains(&placeholder) {
            resolved = resolved.replace(&placeholder, value);
        }
        let placeholder_bare = format!("${key}");
        if resolved.contains(&placeholder_bare) {
            resolved = resolved.replace(&placeholder_bare, value);
        }
    }
    resolved
}

/// Resolve only `provider.*.options.apiKey` values in the JSON content.
///
/// Other `${KEY}` references (e.g. MCP env vars) are left as placeholders
/// so they don't linger as plaintext on disk.
fn resolve_provider_api_keys(content: &str, secrets: &HashMap<String, String>) -> String {
    let mut json: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return content.to_string(),
    };

    let mut changed = false;
    if let Some(providers) = json.get_mut("provider").and_then(|p| p.as_object_mut()) {
        for provider in providers.values_mut() {
            if let Some(api_key) = provider
                .get_mut("options")
                .and_then(|o| o.get_mut("apiKey"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
            {
                if let Some(start) = api_key.find("${") {
                    if let Some(end) = api_key[start..].find('}') {
                        let key_name = &api_key[start + 2..start + end];
                        if let Some(value) = secrets.get(key_name) {
                            let resolved = api_key.replace(&format!("${{{key_name}}}"), value);
                            provider["options"]["apiKey"] = serde_json::Value::String(resolved);
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    if changed {
        serde_json::to_string_pretty(&json).unwrap_or_else(|_| content.to_string())
    } else {
        content.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_opencode_json(dir: &Path, content: &str) {
        fs::write(dir.join("opencode.json"), content).unwrap();
    }

    fn read_opencode_json(dir: &Path) -> String {
        fs::read_to_string(dir.join("opencode.json")).unwrap()
    }

    fn lock_official_brand() -> std::sync::MutexGuard<'static, ()> {
        let lock = crate::test_util::home_env_lock();
        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);
        lock
    }

    #[test]
    fn resolve_replaces_mcp_environment_placeholders() {
        let _lock = lock_official_brand();
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{
  "mcp": {
    "github": {
      "type": "stdio",
      "environment": {
        "GITHUB_TOKEN": "${API_KEY}"
      }
    }
  }
}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "ghp_secret123".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_some());

        let on_disk = read_opencode_json(dir.path());
        assert!(on_disk.contains("ghp_secret123"));
        assert!(!on_disk.contains("${API_KEY}"));
        assert!(dir.path().join(".teamclu/opencode.runtime.json").exists());
    }

    #[test]
    fn white_label_overlay_writes_brand_meta() {
        let _lock = crate::test_util::home_env_lock();
        std::env::set_var(crate::BRAND_SHORT_NAME_ENV, "copilot361");

        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{ "mcp": { "x": { "environment": { "T": "${API_KEY}" } } } }"#,
        );
        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "secret".to_string());
        resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(dir
            .path()
            .join(".copilot361/opencode.runtime.json")
            .exists());
        assert!(!dir.path().join(".teamclu/opencode.runtime.json").exists());

        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);
    }

    #[test]
    fn official_overlay_writes_teamclu_meta() {
        let _lock = lock_official_brand();
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{ "mcp": { "x": { "environment": { "T": "${API_KEY}" } } } }"#,
        );
        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "secret".to_string());
        resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(dir.path().join(".teamclu/opencode.runtime.json").exists());
    }

    #[test]
    fn restore_puts_mcp_placeholders_back_keeps_resolved_provider_api_key() {
        let dir = TempDir::new().unwrap();
        let original_content = r#"{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "${ANTHROPIC_KEY}"
      }
    }
  },
  "mcp": {
    "github": {
      "type": "stdio",
      "environment": {
        "GITHUB_TOKEN": "${API_KEY}"
      }
    }
  }
}"#;
        write_opencode_json(dir.path(), original_content);

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "ghp_secret123".to_string());
        secrets.insert("ANTHROPIC_KEY".to_string(), "sk-ant-resolved".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_some());

        restore_config(dir.path(), &original, &secrets).unwrap();

        let restored = read_opencode_json(dir.path());
        assert!(
            restored.contains("${API_KEY}"),
            "MCP env should use placeholder"
        );
        assert!(
            restored.contains("sk-ant-resolved"),
            "provider apiKey should stay resolved"
        );
        assert!(
            !restored.contains("${ANTHROPIC_KEY}"),
            "provider apiKey should not keep placeholder"
        );
    }

    #[test]
    fn resolve_returns_none_when_no_placeholders() {
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{"mcp": {"github": {"environment": {"TOKEN": "literal"}}}}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "unused".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_none());
    }

    #[test]
    fn resolve_returns_none_when_secrets_empty() {
        let dir = TempDir::new().unwrap();
        write_opencode_json(dir.path(), r#"{"mcp": {"env": "${API_KEY}"}}"#);

        let secrets = HashMap::new();
        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_none());
    }

    #[test]
    fn detects_unresolved_provider_api_key_placeholder() {
        // The #554 failure: tc_gateway_token was never injected, so the provider
        // apiKey keeps its literal `${tc_gateway_token}` placeholder.
        let content = r#"{
  "provider": {
    "team": { "options": { "apiKey": "${tc_gateway_token}" } },
    "anthropic": { "options": { "apiKey": "sk-ant-resolved" } }
  }
}"#;
        let found = unresolved_provider_api_key_placeholders(content);
        assert_eq!(
            found,
            vec![("team".to_string(), "${tc_gateway_token}".to_string())]
        );
    }

    #[test]
    fn no_unresolved_placeholder_when_all_keys_resolved() {
        let content = r#"{
  "provider": {
    "team": { "options": { "apiKey": "tok_actor_123" } }
  }
}"#;
        assert!(unresolved_provider_api_key_placeholders(content).is_empty());
        // Non-JSON and no-provider content must not panic and yield nothing.
        assert!(unresolved_provider_api_key_placeholders("not json").is_empty());
        assert!(unresolved_provider_api_key_placeholders(r#"{"mcp":{}}"#).is_empty());
    }

    #[test]
    fn resolve_returns_none_when_config_missing() {
        let dir = TempDir::new().unwrap();
        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "value".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_none());
    }

    #[test]
    fn resolve_provider_api_keys_on_disk_leaves_mcp_placeholders() {
        let _lock = lock_official_brand();
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{
  "provider": {
    "team": { "options": { "apiKey": "${tc_gateway_token}" } }
  },
  "mcp": {
    "github": { "environment": { "TOKEN": "${GITHUB_TOKEN}" } }
  }
}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("tc_gateway_token".to_string(), "tok_actor_1".to_string());

        let changed = resolve_provider_api_keys_on_disk(dir.path(), &secrets).unwrap();
        assert!(changed);

        let on_disk = read_opencode_json(dir.path());
        assert!(on_disk.contains("tok_actor_1"));
        assert!(on_disk.contains("${GITHUB_TOKEN}"));
        assert!(!dir.path().join(".teamclu/opencode.runtime.json").exists());
    }

    #[test]
    fn resolve_replaces_bare_dollar_key() {
        let _lock = lock_official_brand();
        let dir = TempDir::new().unwrap();
        write_opencode_json(
            dir.path(),
            r#"{"mcp": {"server": {"environment": {"TOKEN": "$API_KEY"}}}}"#,
        );

        let mut secrets = HashMap::new();
        secrets.insert("API_KEY".to_string(), "bare-value".to_string());

        let original = resolve_config_secret_refs(dir.path(), &secrets).unwrap();
        assert!(original.is_some());

        let on_disk = read_opencode_json(dir.path());
        assert!(on_disk.contains("bare-value"));
        assert!(!on_disk.contains("$API_KEY"));
    }
}
