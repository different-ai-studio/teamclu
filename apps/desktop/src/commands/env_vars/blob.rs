//! The personal secret blob: the encrypted store the values actually live
//! in, its legacy plaintext predecessor, and the one-way migration marker
//! that keeps a workspace from being migrated twice.

use super::index::get_teamclu_json_path;
use super::index::read_env_index;
use super::index::read_teamclu_json;
use super::index::write_env_index;
use super::index::write_teamclu_json;
use super::index::EnvVarEntry;
use crate::commands::local_secret_store;
use std::path::Path;

const LEGACY_MIGRATION_MARKER_KEY: &str = "_localPersonalSecretsMigrationComplete";

/// Disk-based path for the legacy plaintext env blob written by older versions.
/// Read-only now (kept as a one-time migration source); never written.
fn env_blob_fallback_path() -> std::path::PathBuf {
    crate::commands::brand_home_dir().join("env-blob.json")
}

/// Read the env blob from the disk fallback file.
fn read_env_blob_from_disk() -> Option<serde_json::Map<String, serde_json::Value>> {
    let path = env_blob_fallback_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&content).ok()?;
    match val {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

fn personal_secret_store_paths() -> Result<local_secret_store::SecretStorePaths, String> {
    local_secret_store::SecretStorePaths::for_home_dir()
}

/// Read the legacy plaintext env blob from the disk fallback file, if present.
///
/// The macOS/Windows keychain is no longer read — the disk fallback
/// (`~/.<app>/env-blob.json`, written by older versions) is the only remaining
/// legacy migration source. Pre-migration secrets that lived *only* in the OS
/// keychain are intentionally no longer recovered.
pub(crate) fn read_legacy_disk_blob(
    _workspace_path: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    if let Some(disk_blob) = read_env_blob_from_disk() {
        if !disk_blob.is_empty() {
            println!(
                "[EnvVars] Restored {} entries from legacy disk fallback",
                disk_blob.len()
            );
            return Ok(Some(disk_blob));
        }
    }
    Ok(None)
}

fn read_personal_secret_blob(
    workspace_path: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let paths = personal_secret_store_paths()?;
    read_personal_secret_blob_from_paths(workspace_path, &paths)
}

pub(crate) fn read_personal_secret_blob_from_paths(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    read_personal_secret_blob_with_reader(workspace_path, paths, read_legacy_disk_blob)
}

pub(crate) fn read_personal_secret_blob_with_reader<F>(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
    legacy_reader: F,
) -> Result<serde_json::Map<String, serde_json::Value>, String>
where
    F: Fn(&str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String>,
{
    read_personal_secret_blob_with_reader_for_startup(workspace_path, paths, legacy_reader)
        .map(|(blob, _retry_needed)| blob)
}

pub(crate) fn read_personal_secret_blob_with_reader_for_startup<F>(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
    legacy_reader: F,
) -> Result<(serde_json::Map<String, serde_json::Value>, bool), String>
where
    F: Fn(&str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String>,
{
    if !paths.blob_path.exists() {
        let blob = local_secret_store::read_or_migrate_secret_blob(paths, || {
            legacy_reader(workspace_path)
        })?;
        if workspace_can_persist_legacy_migration_marker(workspace_path) {
            mark_workspace_legacy_migration_complete_best_effort(workspace_path);
        }
        return Ok((blob, false));
    }

    let mut blob = local_secret_store::read_secret_blob(paths)?;
    let mut top_up_succeeded = false;
    let mut retry_needed = false;
    let migration_pending = match workspace_legacy_migration_pending(workspace_path) {
        Ok(pending) => pending,
        Err(err) => {
            eprintln!(
                "[EnvVars] Legacy workspace top-up marker check failed for '{}': {}",
                workspace_path, err
            );
            retry_needed = true;
            false
        }
    };

    if migration_pending {
        match legacy_reader(workspace_path) {
            Ok(Some(legacy_map)) => {
                let mut changed = false;
                for (key, value) in legacy_map {
                    if let serde_json::map::Entry::Vacant(entry) = blob.entry(key) {
                        entry.insert(value);
                        changed = true;
                    }
                }
                if changed {
                    local_secret_store::write_secret_blob(paths, &blob)?;
                }
                top_up_succeeded = true;
            }
            Ok(None) => {
                top_up_succeeded = true;
            }
            Err(err) => {
                eprintln!(
                    "[EnvVars] Legacy workspace top-up skipped for '{}': {}",
                    workspace_path, err
                );
                retry_needed = true;
            }
        }
        if top_up_succeeded {
            mark_workspace_legacy_migration_complete_best_effort(workspace_path);
        }
    }

    Ok((blob, retry_needed))
}

fn write_personal_secret_blob(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let paths = personal_secret_store_paths()?;
    local_secret_store::write_secret_blob(&paths, map)
}

/// Read the entire env var blob from the local encrypted personal secret store.
/// On first read, migrate legacy plaintext disk-blob data if present.
pub(crate) fn read_env_blob(
    workspace_path: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    read_personal_secret_blob(workspace_path)
}

/// Write the entire env var blob to the local encrypted personal secret store.
pub(crate) fn write_env_blob(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    write_personal_secret_blob(map)
}

fn workspace_legacy_migration_pending(workspace_path: &str) -> Result<bool, String> {
    let json = read_teamclu_json(workspace_path)?;
    Ok(!json
        .get(LEGACY_MIGRATION_MARKER_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

fn mark_workspace_legacy_migration_complete(workspace_path: &str) -> Result<(), String> {
    let mut json = read_teamclu_json(workspace_path)?;
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            LEGACY_MIGRATION_MARKER_KEY.to_string(),
            serde_json::Value::Bool(true),
        );
        write_teamclu_json(workspace_path, &json)?;
    }
    Ok(())
}

fn workspace_can_persist_legacy_migration_marker(workspace_path: &str) -> bool {
    let path = get_teamclu_json_path(workspace_path);
    Path::new(&path).exists() && read_teamclu_json(workspace_path).is_ok()
}

fn mark_workspace_legacy_migration_complete_best_effort(workspace_path: &str) {
    if let Err(err) = mark_workspace_legacy_migration_complete(workspace_path) {
        eprintln!(
            "[EnvVars] Failed to persist legacy workspace migration marker for '{}': {}",
            workspace_path, err
        );
    }
}

/// Derive index entries for user keys present in the machine-global personal blob
/// but missing from the index.
///
/// Key-only rows — never a secret value. Internal blob keys (`tc_api_key`,
/// `_team_secret.*`) are skipped.
pub(crate) fn derive_personal_env_index_from_blob(workspace_path: &str) -> Result<usize, String> {
    let blob = read_env_blob(workspace_path)?;
    let mut entries = read_env_index(workspace_path)?;
    let index_lower: std::collections::HashSet<String> =
        entries.iter().map(|e| e.key.to_ascii_lowercase()).collect();

    let mut added = 0usize;
    let mut blob_keys: Vec<String> = blob
        .iter()
        .filter_map(|(key, value)| {
            if !value.is_string() {
                return None;
            }
            if teamclu_runtime_env::is_internal_personal_blob_key(key) {
                return None;
            }
            Some(key.clone())
        })
        .collect();
    blob_keys.sort();

    for key in blob_keys {
        if index_lower.contains(&key.to_ascii_lowercase()) {
            continue;
        }
        entries.push(EnvVarEntry {
            key,
            description: None,
            category: None,
        });
        added += 1;
    }

    if added > 0 {
        write_env_index(workspace_path, &entries)?;
        println!(
            "[EnvVars] Derived {} personal env index entr{} from the blob",
            added,
            if added == 1 { "y" } else { "ies" }
        );
    }

    Ok(added)
}
