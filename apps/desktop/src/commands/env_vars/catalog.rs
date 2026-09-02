//! The Tauri commands the settings UI calls: read, reveal, set and delete
//! an environment variable, for the current workspace or a named one.

use super::blob::read_env_blob;
use super::blob::write_env_blob;
use super::index::case_variant_keys_in_blob;
use super::index::env_keys_match;
use super::index::read_env_index;
use super::index::write_env_index;
use super::index::EnvVarEntry;
use std::path::Path;
use tauri::{AppHandle, State};

pub(crate) fn resolve_workspace_path(
    workspace_path: Option<String>,
    window: &tauri::WebviewWindow,
    registry: &State<'_, crate::commands::window::WindowRegistry>,
) -> Result<String, String> {
    crate::commands::team::resolve_workspace_path(workspace_path, window, registry)
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
    registry: State<'_, crate::commands::window::WindowRegistry>,
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
    registry: State<'_, crate::commands::window::WindowRegistry>,
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
    registry: State<'_, crate::commands::window::WindowRegistry>,
    shared_secrets: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
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
        Some(crate::commands::APP_SHORT_NAME),
    );

    // The on-disk scan above only ever finds legacy `_secrets/` files, which
    // nothing writes any more — without this the team list would read as empty
    // right after a successful save. Failures are logged, not surfaced: personal
    // vars are already loaded and are worth returning on their own.
    match crate::commands::shared_secrets::team_listings_from_cloud(
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
    shared_secrets: &crate::commands::shared_secrets::SharedSecretsState,
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
            crate::commands::shared_secrets::set_secret_for_workspace(
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
    shared_secrets: &crate::commands::shared_secrets::SharedSecretsState,
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
            crate::commands::shared_secrets::delete_secret_for_workspace(
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
    registry: State<'_, crate::commands::window::WindowRegistry>,
    shared_secrets: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
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
    registry: State<'_, crate::commands::window::WindowRegistry>,
    shared_secrets: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
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
