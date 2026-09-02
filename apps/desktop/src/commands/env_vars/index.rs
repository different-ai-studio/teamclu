//! The workspace-visible index: `teamclu.json`'s env section and the
//! per-workspace entry list the settings UI renders. Values never live
//! here — only keys, scopes and metadata; see `blob` for the secrets.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// A single environment variable entry (key + description, no value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>, // "system" | None
}

// ─── Internal helpers ───────────────────────────────────────────────────

pub(crate) fn env_keys_match(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

pub(crate) fn case_variant_keys_in_blob(
    blob: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    blob.keys()
        .filter(|k| env_keys_match(k, key))
        .filter(|k| !teamclu_runtime_env::is_internal_personal_blob_key(k))
        .cloned()
        .collect()
}

/// Get the teamclu.json path inside the workspace.
pub(crate) fn get_teamclu_json_path(workspace_path: &str) -> String {
    format!(
        "{}/{}/{}",
        workspace_path,
        crate::commands::TEAMCLU_DIR,
        crate::commands::CONFIG_FILE_NAME
    )
}

/// Read the envVars index from teamclu.json (preserving all other fields).
pub(crate) fn read_teamclu_json(workspace_path: &str) -> Result<serde_json::Value, String> {
    let path = get_teamclu_json_path(workspace_path);
    if !Path::new(&path).exists() {
        return Ok(serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        }));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "Failed to read {}: {}",
            crate::commands::CONFIG_FILE_NAME,
            e
        )
    })?;
    serde_json::from_str(&content).map_err(|e| {
        format!(
            "Failed to parse {}: {}",
            crate::commands::CONFIG_FILE_NAME,
            e
        )
    })
}

/// Write the full teamclu.json back (preserving all other fields).
pub(crate) fn write_teamclu_json(
    workspace_path: &str,
    json: &serde_json::Value,
) -> Result<(), String> {
    let teamclu_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLU_DIR);
    let _ = std::fs::create_dir_all(&teamclu_dir);
    let path = get_teamclu_json_path(workspace_path);
    teamclu_gateway::write_json_value_if_changed(&path, json).map_err(|e| {
        format!(
            "Failed to write {}: {}",
            crate::commands::CONFIG_FILE_NAME,
            e
        )
    })
}

// ── Personal env index ──────────────────────────────────────────────────────
//
// The index (key + description + category) is machine-global, next to the
// encrypted blob it describes: `~/.{brand}/secrets/env-index.json`. It used to be
// an `envVars` array inside every workspace's meta config, which made one
// machine-global fact per-workspace — the same key described differently in two
// checkouts, and a fresh workspace listing none of the keys it can resolve.
//
// Reads fold in a legacy workspace copy; the first write drops it, so a workspace
// migrates the moment the user touches env vars there.

fn brand() -> &'static str {
    crate::commands::APP_SHORT_NAME
}

fn to_index_entries(entries: Vec<EnvVarEntry>) -> Vec<teamclu_runtime_env::PersonalEnvIndexEntry> {
    entries
        .into_iter()
        .map(|e| teamclu_runtime_env::PersonalEnvIndexEntry {
            key: e.key,
            description: e.description,
            category: e.category,
        })
        .collect()
}

fn from_index_entries(
    entries: Vec<teamclu_runtime_env::PersonalEnvIndexEntry>,
) -> Vec<EnvVarEntry> {
    entries
        .into_iter()
        .map(|e| EnvVarEntry {
            key: e.key,
            description: e.description,
            category: e.category,
        })
        .collect()
}

/// The index this workspace should see: machine-level, with a legacy workspace
/// copy behind it.
pub(crate) fn read_env_index(workspace_path: &str) -> Result<Vec<EnvVarEntry>, String> {
    let machine = teamclu_runtime_env::read_personal_env_index_for_brand(brand());
    let legacy = to_index_entries(get_env_vars_from_json(&read_teamclu_json(workspace_path)?));
    Ok(from_index_entries(
        teamclu_runtime_env::merge_personal_env_index(machine, legacy),
    ))
}

/// Persist the index at machine level and retire this workspace's copy.
pub(crate) fn write_env_index(workspace_path: &str, entries: &[EnvVarEntry]) -> Result<(), String> {
    teamclu_runtime_env::write_personal_env_index_for_brand(
        brand(),
        &to_index_entries(entries.to_vec()),
    )
    .map_err(|e| format!("Failed to write personal env index: {e}"))?;

    // Best-effort: the index is written, so a leftover workspace copy is only a
    // stale duplicate. Failing the whole operation over it would be worse.
    if let Ok(mut json) = read_teamclu_json(workspace_path) {
        if json.get("envVars").is_some() {
            set_env_vars_in_json(&mut json, &[]);
            if let Err(err) = write_teamclu_json(workspace_path, &json) {
                eprintln!("[EnvVars] could not retire workspace envVars index: {err}");
            }
        }
    }
    Ok(())
}

/// Read the envVars array from the JSON value.
pub(crate) fn get_env_vars_from_json(json: &serde_json::Value) -> Vec<EnvVarEntry> {
    json.get("envVars")
        .and_then(|v| serde_json::from_value::<Vec<EnvVarEntry>>(v.clone()).ok())
        .unwrap_or_default()
}

/// Write the envVars array back into the JSON value.
fn set_env_vars_in_json(json: &mut serde_json::Value, entries: &[EnvVarEntry]) {
    if let Some(obj) = json.as_object_mut() {
        if entries.is_empty() {
            obj.remove("envVars");
        } else {
            obj.insert(
                "envVars".to_string(),
                serde_json::to_value(entries).unwrap_or(serde_json::json!([])),
            );
        }
    }
}
