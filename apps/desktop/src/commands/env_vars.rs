use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, State};

use super::local_secret_store;

const LEGACY_MIGRATION_MARKER_KEY: &str = "_localPersonalSecretsMigrationComplete";

/// Disk-based path for the legacy plaintext env blob written by older versions.
/// Read-only now (kept as a one-time migration source); never written.
fn env_blob_fallback_path() -> std::path::PathBuf {
    super::brand_home_dir().join("env-blob.json")
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

fn read_personal_secret_blob_with_reader<F>(
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

fn read_personal_secret_blob_with_reader_for_startup<F>(
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

/// Context available to system env var default generators.
struct SystemEnvVarContext {
    // Read by default generators; the registry is empty since the team-gateway
    // cutover, so nothing reads it today. Kept as the extension point it documents.
    #[allow(dead_code)]
    actor_id: String,
}

/// How a system env var's default value should be applied on startup.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DefaultPolicy {
    /// Re-derive on every startup; overwrite the stored value if it differs.
    /// Use when the default depends on system state that may change
    /// (e.g. `tc_api_key` is derived from `actor_id`).
    #[allow(dead_code)] // no registry entry uses it since the team-gateway cutover
    RegenerateAlways,
    /// Write the default only when the key is missing from the blob.
    /// Empty user-set values are preserved (treated as "user has decided to leave blank").
    #[allow(dead_code)]
    SetIfAbsent,
}

/// Definition of a system-managed env var.
pub(crate) struct SystemEnvVarDef {
    key: &'static str,
    description: &'static str,
    default_fn: fn(&SystemEnvVarContext) -> Option<String>,
    policy: DefaultPolicy,
    /// When true, the entry is registered with category `system-shared`. The UI uses
    /// this to surface the key as a team-shared candidate (encrypted, synced via
    /// `shared_secrets`) and never seeds a value into the local keychain blob.
    shared_default: bool,
}

/// Registry of all system env vars.
/// To add a new one: append an entry here — nothing else changes.
///
/// Empty since the team-gateway cutover. It held exactly one entry,
/// `tc_api_key`, whose default was `sk-tc-{actor_id[..40]}` — a LiteLLM virtual
/// key the desktop could derive because it was guessable. Its replacement is a
/// daemon session token scoped to `ai:invoke`, which only the daemon can mint,
/// so there is nothing for the desktop to seed.
///
/// Seeding the old value would be worse than useless now: personal env takes
/// precedence over system env when the runtime env is merged, so a leftover
/// `tc_api_key` in the keychain blob would shadow the credential the daemon
/// writes.
pub(crate) const SYSTEM_ENV_VARS: &[SystemEnvVarDef] = &[];

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

fn env_keys_match(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn case_variant_keys_in_blob(
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
fn get_teamclu_json_path(workspace_path: &str) -> String {
    format!(
        "{}/{}/{}",
        workspace_path,
        super::TEAMCLU_DIR,
        super::CONFIG_FILE_NAME
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
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))
}

/// Write the full teamclu.json back (preserving all other fields).
pub(crate) fn write_teamclu_json(
    workspace_path: &str,
    json: &serde_json::Value,
) -> Result<(), String> {
    let teamclu_dir = format!("{}/{}", workspace_path, super::TEAMCLU_DIR);
    let _ = std::fs::create_dir_all(&teamclu_dir);
    let path = get_teamclu_json_path(workspace_path);
    teamclu_gateway::write_json_value_if_changed(&path, json)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
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
    super::APP_SHORT_NAME
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
fn get_env_vars_from_json(json: &serde_json::Value) -> Vec<EnvVarEntry> {
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

fn resolve_workspace_path(
    workspace_path: Option<String>,
    window: &tauri::WebviewWindow,
    registry: &State<'_, super::window::WindowRegistry>,
) -> Result<String, String> {
    super::team::resolve_workspace_path(workspace_path, window, registry)
}

// ─── Tauri Commands ─────────────────────────────────────────────────────

/// Internal: write env var to encrypted blob and update teamclu.json index for a given workspace.
/// Shared between the Tauri command (window-scoped) and `introspect_api` (HTTP path).
pub(crate) async fn env_var_set_for_workspace(
    workspace_path: &str,
    key: String,
    value: String,
    description: Option<String>,
) -> Result<(), String> {
    let key_clone = key.clone();
    let value_clone = value.clone();
    let wp = workspace_path.to_string();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut blob = read_env_blob(&wp)?;
        for variant in case_variant_keys_in_blob(&blob, &key_clone) {
            blob.remove(&variant);
        }
        blob.insert(key_clone, serde_json::Value::String(value_clone));
        write_env_blob(&blob)
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut entries = read_env_index(workspace_path)?;

    entries.retain(|e| !env_keys_match(&e.key, &key));
    entries.push(EnvVarEntry {
        key,
        description,
        category: None,
    });

    write_env_index(workspace_path, &entries)
}

/// What `env_var_get` hands the webview in place of a stored value.
pub(crate) const ENV_VAR_MASKED: &str = "••••••••";

/// Read one value from the local encrypted store, or `Err` when the key is
/// absent. Shared by the masked and the explicit-reveal command.
async fn read_env_value(workspace_path: String, key: &str) -> Result<String, String> {
    let blob = tokio::task::spawn_blocking(move || read_env_blob(&workspace_path))
        .await
        .map_err(|e| e.to_string())??;
    blob.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Key '{}' not found", key))
}

/// Tell the webview whether a value exists for `key`, without the value.
///
/// Returns [`ENV_VAR_MASKED`] when the key is set and `Err` when it is not, so
/// callers that only test presence keep working. The plaintext used to come
/// back from here (SEC-8); the origin that renders agent output is not the one
/// that should hold decrypted credentials by default. Plaintext is a separate,
/// explicit step: [`env_var_reveal`].
#[tauri::command]
pub async fn env_var_get(
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
    key: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    read_env_value(workspace_path, &key).await?;
    Ok(ENV_VAR_MASKED.to_string())
}

/// Plaintext for one key, on an explicit user action (the reveal / copy button
/// in settings). Separate from [`env_var_get`] so a caller that only needs
/// presence never receives the secret, and logged so a reveal leaves a trace.
#[tauri::command]
pub async fn env_var_reveal(
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
    key: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let value = read_env_value(workspace_path, &key).await?;
    log::info!("[EnvVars] value revealed to the webview: {}", key);
    Ok(value)
}

/// Internal: delete env var from blob + teamclu.json index for a given workspace.
/// Shared between the Tauri command (window-scoped) and `introspect_api` (HTTP path).
pub(crate) async fn env_var_delete_for_workspace(
    workspace_path: &str,
    key: String,
) -> Result<(), String> {
    let mut entries = read_env_index(workspace_path)?;

    if let Some(entry) = entries.iter().find(|e| env_keys_match(&e.key, &key)) {
        match entry.category.as_deref() {
            Some("system") | Some("system-shared") => {
                return Err(format!("System variable '{}' cannot be deleted", entry.key));
            }
            _ => {}
        }
    }

    let key_for_blob = key.clone();
    let wp = workspace_path.to_string();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut blob = read_env_blob(&wp)?;
        for variant in case_variant_keys_in_blob(&blob, &key_for_blob) {
            blob.remove(&variant);
        }
        write_env_blob(&blob)
    })
    .await
    .map_err(|e| e.to_string())??;

    entries.retain(|e| !env_keys_match(&e.key, &key));
    write_env_index(workspace_path, &entries)
}

/// Unified env catalog: personal/system defs from the machine index plus team
/// secrets discovered under the same `_secrets/` paths used by the daemon.
#[tauri::command]
pub async fn env_catalog_list(
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
    shared_secrets: State<'_, super::shared_secrets::SharedSecretsState>,
    team_id: Option<String>,
    access_token: Option<String>,
    cloud_api_url: Option<String>,
    workspace_path: Option<String>,
) -> Result<teamclu_runtime_env::env_catalog::EnvCatalog, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    // team_id is required for the `_team_secret.{team_id}` personal-blob secret
    // fallback: when `teamclu.json` carries no inline `team.envSecret` (the
    // common case), passing None here leaves every team var undecryptable.
    let team_id = team_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut catalog = teamclu_runtime_env::env_catalog::load_env_catalog(
        Path::new(&workspace_path),
        team_id,
        Some(super::APP_SHORT_NAME),
    );

    // The on-disk scan above only ever finds legacy `_secrets/` files, which
    // nothing writes any more — without this the team list would read as empty
    // right after a successful save. Failures are logged, not surfaced: personal
    // vars are already loaded and are worth returning on their own.
    match super::shared_secrets::team_listings_from_cloud(
        &shared_secrets,
        &workspace_path,
        team_id,
        access_token.as_deref(),
        cloud_api_url.as_deref(),
    )
    .await
    {
        Ok(cloud) if !cloud.is_empty() => {
            // Cloud wins per key; any legacy file not yet migrated still shows.
            let mut merged: Vec<_> = cloud;
            let cloud_keys: std::collections::HashSet<String> =
                merged.iter().map(|t| t.key_id.clone()).collect();
            merged.extend(
                catalog
                    .team
                    .into_iter()
                    .filter(|t| !cloud_keys.contains(&t.key_id)),
            );
            merged.sort_by(|a, b| a.key_id.cmp(&b.key_id));
            catalog.team = merged;
        }
        Ok(_) => {}
        Err(e) => log::warn!("env_catalog_list: cloud team env unavailable: {e}"),
    }

    Ok(catalog)
}

/// Diagnostics for the team env-var sync chain, surfaced in the settings UI so
/// a member whose team variables aren't syncing can see *where* the chain is
/// broken. Contains no secret material — only presence/path booleans.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvDiagnostics {
    /// A non-empty team id was supplied by the caller.
    pub team_id_present: bool,
    /// The workspace's team directory (usually the `teamclu-team` symlink).
    pub team_link_path: String,
    /// The team dir / link exists on disk.
    pub link_exists: bool,
    /// The team dir entry is a symlink (vs a real directory).
    pub link_is_symlink: bool,
    /// The symlink target path, when the entry is a symlink.
    pub link_target: Option<String>,
    /// The path is accessible following the link (a dangling symlink is false).
    pub target_accessible: bool,
    /// Daemon cloud cache dir exists:
    /// `~/.amuxd/teams/<teamId>/cloud/_secrets`.
    pub secrets_dir_exists: bool,
    /// Count of `*.enc.json` files in the daemon cloud cache (authoritative
    /// after the Cloud API migration).
    pub secret_file_count: usize,
    /// Absolute path of the cloud `_secrets` cache (empty when team id missing).
    pub cloud_secrets_dir: String,
    /// Legacy workspace `teamclu-team/_secrets` still present from the
    /// git/OSS era. Informational only — cloud cache wins at runtime.
    pub legacy_secrets_dir_exists: bool,
    pub legacy_secret_file_count: usize,
    /// A local team secret is resolvable, so shared writes can be encrypted and
    /// existing secrets decrypted.
    pub secret_configured: bool,
}

/// Gather team env-var sync diagnostics for the given workspace/team.
#[tauri::command]
pub async fn team_env_diagnostics(
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
    team_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<TeamEnvDiagnostics, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let team_id_trimmed = team_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let ws = Path::new(&workspace_path);

    let link = teamclu_runtime_env::env_catalog::resolve_team_dir_for_workspace(ws);
    let symlink_meta = std::fs::symlink_metadata(&link).ok();
    let link_is_symlink = symlink_meta
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let link_target = if link_is_symlink {
        std::fs::read_link(&link)
            .ok()
            .map(|p| p.display().to_string())
    } else {
        None
    };
    // `metadata` follows symlinks: a dangling link yields Err → not accessible.
    let target_accessible = std::fs::metadata(&link).is_ok();

    let (cloud_secrets_dir, secrets_dir_exists, secret_file_count) =
        team_cloud_secrets_diag(team_id_trimmed.as_deref());

    let legacy_secrets_dir = link.join(super::shared_secrets::SECRETS_DIR);
    let legacy_secrets_dir_exists = legacy_secrets_dir.exists();
    let legacy_secret_file_count = count_enc_json_files(&legacy_secrets_dir);

    let secret_configured = teamclu_runtime_env::env_catalog::resolve_team_env_secret(
        ws,
        team_id_trimmed.as_deref(),
        Some(super::APP_SHORT_NAME),
    )
    .is_some();

    Ok(TeamEnvDiagnostics {
        team_id_present: team_id_trimmed.is_some(),
        team_link_path: link.display().to_string(),
        link_exists: symlink_meta.is_some(),
        link_is_symlink,
        link_target,
        target_accessible,
        secrets_dir_exists,
        secret_file_count,
        cloud_secrets_dir,
        legacy_secrets_dir_exists,
        legacy_secret_file_count,
        secret_configured,
    })
}

/// `~/.amuxd/teams/<teamId>/state/cloud/_secrets` presence + `*.enc.json` count.
pub(crate) fn team_cloud_secrets_diag(team_id: Option<&str>) -> (String, bool, usize) {
    let Some(team_id) = team_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return (String::new(), false, 0);
    };
    let dir = super::amuxd_team_state_dir(team_id)
        .join("cloud")
        .join(super::shared_secrets::SECRETS_DIR);
    let exists = dir.exists();
    let count = count_enc_json_files(&dir);
    (dir.display().to_string(), exists, count)
}

pub(crate) fn count_enc_json_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".enc.json"))
                .count()
        })
        .unwrap_or(0)
}

/// Diagnostics for the personal env-var store + workspace index alignment.
/// Contains no secret values — only paths, counts, and key-name mismatches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEnvDiagnostics {
    pub storage_dir: String,
    pub secrets_dir: String,
    pub master_key_exists: bool,
    pub blob_exists: bool,
    pub blob_readable: bool,
    pub blob_error: Option<String>,
    pub stored_var_count: usize,
    pub user_stored_var_count: usize,
    pub workspace_index_count: usize,
    /// Keys listed in `teamclu.json` but absent from the encrypted blob.
    pub index_keys_missing_from_blob: Vec<String>,
    /// Keys in the blob but not listed in the workspace index (non-system).
    pub blob_keys_missing_from_index: Vec<String>,
    /// Personal keys that exist in the host OS env and would override opencode serve spawn.
    pub host_shadowed_keys: Vec<String>,
}

fn parse_env_scope(scope: &str) -> Result<&'static str, String> {
    match scope {
        "personal" => Ok("personal"),
        "team" => Ok("team"),
        other => Err(format!(
            "Invalid scope '{other}'. Expected 'personal' or 'team'."
        )),
    }
}

/// Unified write entry point for personal and team env vars.
pub(crate) async fn env_catalog_set_for_workspace(
    app_handle: &AppHandle,
    shared_secrets: &super::shared_secrets::SharedSecretsState,
    workspace_path: &str,
    scope: &str,
    key: String,
    value: String,
    description: Option<String>,
    category: Option<String>,
    node_id: Option<String>,
    team_id: Option<String>,
    access_token: Option<String>,
    cloud_api_url: Option<String>,
) -> Result<(), String> {
    match parse_env_scope(scope)? {
        "personal" => env_var_set_for_workspace(workspace_path, key, value, description).await,
        "team" => {
            let node_id = node_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "nodeId is required for team env vars".to_string())?;
            super::shared_secrets::set_secret_for_workspace(
                app_handle,
                shared_secrets,
                workspace_path,
                key,
                value,
                description.unwrap_or_default(),
                category.unwrap_or_else(|| "custom".to_string()),
                node_id,
                team_id,
                access_token,
                cloud_api_url,
            )
            .await
        }
        _ => unreachable!(),
    }
}

/// Unified delete entry point for personal and team env vars.
pub(crate) async fn env_catalog_delete_for_workspace(
    app_handle: &AppHandle,
    shared_secrets: &super::shared_secrets::SharedSecretsState,
    workspace_path: &str,
    scope: &str,
    key: String,
    node_id: Option<String>,
    role: Option<String>,
    team_id: Option<String>,
    access_token: Option<String>,
    cloud_api_url: Option<String>,
) -> Result<(), String> {
    match parse_env_scope(scope)? {
        "personal" => env_var_delete_for_workspace(workspace_path, key).await,
        "team" => {
            let node_id = node_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "nodeId is required for team env vars".to_string())?;
            super::shared_secrets::delete_secret_for_workspace(
                app_handle,
                shared_secrets,
                workspace_path,
                key,
                node_id,
                role.unwrap_or_default(),
                team_id,
                access_token,
                cloud_api_url,
            )
            .await
        }
        _ => unreachable!(),
    }
}

/// Create or update a personal or team environment variable.
#[tauri::command]
pub async fn env_catalog_set(
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
    shared_secrets: State<'_, super::shared_secrets::SharedSecretsState>,
    scope: String,
    key: String,
    value: String,
    description: Option<String>,
    category: Option<String>,
    node_id: Option<String>,
    team_id: Option<String>,
    access_token: Option<String>,
    cloud_api_url: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    env_catalog_set_for_workspace(
        &app_handle,
        &shared_secrets,
        &workspace_path,
        &scope,
        key,
        value,
        description,
        category,
        node_id,
        team_id,
        access_token,
        cloud_api_url,
    )
    .await
}

/// Delete a personal or team environment variable.
#[tauri::command]
pub async fn env_catalog_delete(
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, super::window::WindowRegistry>,
    shared_secrets: State<'_, super::shared_secrets::SharedSecretsState>,
    scope: String,
    key: String,
    node_id: Option<String>,
    role: Option<String>,
    team_id: Option<String>,
    access_token: Option<String>,
    cloud_api_url: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    env_catalog_delete_for_workspace(
        &app_handle,
        &shared_secrets,
        &workspace_path,
        &scope,
        key,
        node_id,
        role,
        team_id,
        access_token,
        cloud_api_url,
    )
    .await
}

/// Ensure all system env vars exist in the local encrypted store and in the teamclu.json index.
/// If a key is missing from the blob, its default value is generated and written.
/// If a key already has a value (user customized), it is left unchanged.
/// This must be called on a blocking thread (disk I/O).
pub(crate) fn ensure_system_env_vars(workspace_path: &str, actor_id: &str) -> Result<(), String> {
    let ctx = SystemEnvVarContext {
        actor_id: actor_id.to_string(),
    };
    let mut blob = read_env_blob(workspace_path)?;
    let mut entries = read_env_index(workspace_path)?;
    let mut blob_changed = false;
    let mut index_changed = false;

    for def in SYSTEM_ENV_VARS {
        // `system-shared` defs never touch the local keychain blob — their values
        // live in `shared_secrets` (team KMS) and are injected into opencode at startup.
        // We only register them in the teamclu.json index so the key shows up in
        // the env-var UI on every member's machine.
        if !def.shared_default {
            let key_present_in_blob = blob.contains_key(def.key);
            let existing_value = blob.get(def.key).and_then(|v| v.as_str()).unwrap_or("");

            match def.policy {
                DefaultPolicy::RegenerateAlways => {
                    // Re-derive on every startup; overwrite if the result differs.
                    // Used when the default depends on mutable system state (e.g. actor_id).
                    if let Some(new_value) = (def.default_fn)(&ctx) {
                        if existing_value != new_value {
                            if !existing_value.is_empty() {
                                println!(
                                    "[EnvVars] Updating system var {} (value changed)",
                                    def.key
                                );
                            } else {
                                println!(
                                    "[EnvVars] Generated default value for system var: {}",
                                    def.key
                                );
                            }
                            blob.insert(def.key.to_string(), serde_json::Value::String(new_value));
                            blob_changed = true;
                        }
                    }
                }
                DefaultPolicy::SetIfAbsent => {
                    // Only seed the default when the key has never been written.
                    // An existing empty string is treated as "user left it blank intentionally".
                    if !key_present_in_blob {
                        if let Some(default) = (def.default_fn)(&ctx) {
                            println!("[EnvVars] Seeding system var {} with default", def.key);
                            blob.insert(def.key.to_string(), serde_json::Value::String(default));
                            blob_changed = true;
                        }
                    }
                }
            }
        }

        // Decide whether to register in the index (synced via teamclu.json):
        //   - shared_default:                always register (key shows in UI; value lives in shared_secrets).
        //   - SetIfAbsent (local):           always register so the key shows even before a value is set.
        //   - RegenerateAlways (local):      only when the blob holds a non-empty value
        //                                    (skip when the generator yielded nothing, e.g. actor_id not ready).
        let should_index = if def.shared_default {
            true
        } else {
            match def.policy {
                DefaultPolicy::RegenerateAlways => blob
                    .get(def.key)
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| !v.is_empty()),
                DefaultPolicy::SetIfAbsent => true,
            }
        };
        if !should_index {
            continue;
        }

        let target_category = if def.shared_default {
            "system-shared"
        } else {
            "system"
        };
        if let Some(existing) = entries.iter_mut().find(|e| e.key == def.key) {
            if existing.category.as_deref() != Some(target_category) {
                existing.category = Some(target_category.to_string());
                index_changed = true;
            }
        } else {
            entries.push(EnvVarEntry {
                key: def.key.to_string(),
                description: Some(def.description.to_string()),
                category: Some(target_category.to_string()),
            });
            index_changed = true;
        }
    }

    if blob_changed {
        write_env_blob(&blob)?;
    }
    if index_changed {
        write_env_index(workspace_path, &entries)?;
    }

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::local_secret_store::SecretStorePaths;
    // One lock for every test in the crate that touches HOME — see test_home.
    use crate::test_home::HomeGuard;
    use tempfile::tempdir;

    #[test]
    fn read_env_blob_migrates_legacy_disk_snapshot_into_local_encrypted_store() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let legacy_blob_dir = home_dir
            .path()
            .join(format!(".{}", teamclu_runtime_env::OFFICIAL_STORAGE_DIR));
        std::fs::create_dir_all(&legacy_blob_dir).unwrap();

        let mut legacy_blob = serde_json::Map::new();
        legacy_blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("legacy-secret".into()),
        );
        std::fs::write(
            legacy_blob_dir.join("env-blob.json"),
            serde_json::to_vec(&legacy_blob).unwrap(),
        )
        .unwrap();

        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        let loaded = read_env_blob(&workspace_path).unwrap();
        assert_eq!(loaded, legacy_blob);

        let paths = SecretStorePaths::for_home_dir().unwrap();
        assert!(
            paths.blob_path.exists(),
            "expected encrypted blob to be created"
        );
        let meta = crate::commands::local_secret_store::read_meta(&paths).unwrap();
        assert!(meta.migrated_from_keychain);

        std::fs::remove_file(legacy_blob_dir.join("env-blob.json")).unwrap();

        let mut updated_blob = loaded.clone();
        updated_blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        write_env_blob(&updated_blob).unwrap();

        let reloaded = read_env_blob(&workspace_path).unwrap();
        assert_eq!(
            reloaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
    }

    #[test]
    fn read_personal_secret_blob_merges_legacy_once_per_workspace() {
        let home_dir = tempdir().unwrap();
        let workspace_a = tempdir().unwrap();
        let workspace_b = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_a_path = workspace_a.path().to_string_lossy().to_string();
        let workspace_b_path = workspace_b.path().to_string_lossy().to_string();

        let first = read_personal_secret_blob_with_reader(&workspace_a_path, &paths, |wp| {
            let mut map = serde_json::Map::new();
            if wp == workspace_a_path {
                map.insert(
                    "WORKSPACE_A_KEY".into(),
                    serde_json::Value::String("a-secret".into()),
                );
            }
            Ok(Some(map))
        })
        .unwrap();
        assert_eq!(
            first.get("WORKSPACE_A_KEY").and_then(|v| v.as_str()),
            Some("a-secret")
        );

        let second = read_personal_secret_blob_with_reader(&workspace_b_path, &paths, |wp| {
            let mut map = serde_json::Map::new();
            if wp == workspace_b_path {
                map.insert(
                    "WORKSPACE_B_KEY".into(),
                    serde_json::Value::String("b-secret".into()),
                );
            }
            Ok(Some(map))
        })
        .unwrap();
        assert_eq!(
            second.get("WORKSPACE_A_KEY").and_then(|v| v.as_str()),
            Some("a-secret")
        );
        assert_eq!(
            second.get("WORKSPACE_B_KEY").and_then(|v| v.as_str()),
            Some("b-secret")
        );

        let third = read_personal_secret_blob_with_reader(&workspace_b_path, &paths, |_wp| {
            Err("legacy reader should not run after workspace migration".to_string())
        })
        .unwrap();
        assert_eq!(third, second);
    }

    #[test]
    fn existing_blob_survives_legacy_reader_error_without_marking_complete() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let mut blob = serde_json::Map::new();
        blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let (first, retry_needed) =
            read_personal_secret_blob_with_reader_for_startup(&workspace_path, &paths, |_wp| {
                Err("simulated legacy reader failure".to_string())
            })
            .unwrap();
        assert_eq!(
            first.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
        assert!(retry_needed);

        let second = read_personal_secret_blob_with_reader(&workspace_path, &paths, |_wp| {
            Err("legacy reader failure remains non-fatal on later reads".to_string())
        })
        .unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn existing_blob_reads_even_if_teamclu_json_is_invalid() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
        std::fs::create_dir_all(&teamclu_dir).unwrap();
        std::fs::write(teamclu_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let mut blob = serde_json::Map::new();
        blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let loaded = read_personal_secret_blob_with_reader(&workspace_path, &paths, |_wp| {
            Err("legacy reader should not be required when local blob already exists".into())
        })
        .unwrap();

        assert_eq!(
            loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
    }

    #[test]
    fn first_migration_succeeds_even_if_teamclu_json_is_invalid() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
        std::fs::create_dir_all(&teamclu_dir).unwrap();
        std::fs::write(teamclu_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        let loaded = read_env_blob(&workspace_path).unwrap();
        assert!(loaded.is_empty());

        let paths = SecretStorePaths::for_home_dir().unwrap();
        assert!(
            paths.blob_path.exists(),
            "expected encrypted blob to be created"
        );
    }

    #[test]
    fn startup_retry_is_requested_when_teamclu_json_is_invalid() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
        std::fs::create_dir_all(&teamclu_dir).unwrap();
        std::fs::write(teamclu_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let mut blob = serde_json::Map::new();
        blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let (loaded, retry_needed) =
            read_personal_secret_blob_with_reader_for_startup(&workspace_path, &paths, |_wp| {
                Ok(None)
            })
            .unwrap();

        assert_eq!(
            loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
        assert!(retry_needed);
    }

    #[test]
    fn env_var_delete_removes_all_case_variants_from_blob_and_index() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
        std::fs::create_dir_all(&teamclu_dir).unwrap();
        std::fs::write(
            teamclu_dir.join(super::super::CONFIG_FILE_NAME),
            serde_json::json!({
                "envVars": [
                    { "key": "jira_token", "description": "lower" },
                    { "key": "JIRA_TOKEN", "description": "upper" }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let mut blob = serde_json::Map::new();
        blob.insert(
            "jira_token".into(),
            serde_json::Value::String("secret-lower".into()),
        );
        blob.insert(
            "JIRA_TOKEN".into(),
            serde_json::Value::String("secret-upper".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(env_var_delete_for_workspace(
                &workspace_path,
                "JIRA_TOKEN".into(),
            ))
            .unwrap();

        let remaining_blob = read_env_blob(&workspace_path).unwrap();
        assert!(!remaining_blob.contains_key("jira_token"));
        assert!(!remaining_blob.contains_key("JIRA_TOKEN"));

        let json = read_teamclu_json(&workspace_path).unwrap();
        let entries = get_env_vars_from_json(&json);
        assert!(entries.is_empty());
    }

    #[test]
    fn derive_personal_env_index_from_blob_adds_missing_user_keys() {
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
        std::fs::create_dir_all(&teamclu_dir).unwrap();
        std::fs::write(
            teamclu_dir.join(super::super::CONFIG_FILE_NAME),
            r#"{"envVars":[{"key":"tc_api_key","category":"system"}]}"#,
        )
        .unwrap();

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let mut blob = serde_json::Map::new();
        blob.insert(
            "tc_api_key".into(),
            serde_json::Value::String("sk-tc-x".into()),
        );
        blob.insert(
            "_team_secret.abc".into(),
            serde_json::Value::String("team".into()),
        );
        blob.insert(
            "ANTHROPIC_AUTH_TOKEN".into(),
            serde_json::Value::String("secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        let added = derive_personal_env_index_from_blob(&workspace_path).unwrap();
        assert_eq!(added, 1);

        let entries = read_env_index(&workspace_path).unwrap();
        let keys: Vec<_> = entries.iter().map(|e| e.key.as_str()).collect();
        // The legacy workspace row is folded in, the blob key is added.
        assert!(keys.contains(&"tc_api_key"));
        assert!(keys.contains(&"ANTHROPIC_AUTH_TOKEN"));
        assert!(!keys.iter().any(|k| k.starts_with("_team_secret.")));

        // The index now lives next to the blob, machine-wide…
        let machine =
            teamclu_runtime_env::read_personal_env_index_for_brand(super::super::APP_SHORT_NAME);
        assert!(machine.iter().any(|e| e.key == "ANTHROPIC_AUTH_TOKEN"));
        // …and the workspace copy is retired rather than kept in sync twice.
        let json = read_teamclu_json(&workspace_path).unwrap();
        assert!(
            json.get("envVars").is_none(),
            "workspace copy should be gone: {json}"
        );

        // Idempotent — second call adds nothing.
        assert_eq!(
            derive_personal_env_index_from_blob(&workspace_path).unwrap(),
            0
        );
    }
}
