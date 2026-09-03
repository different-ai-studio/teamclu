//! What the diagnostics panel reports about env storage: which team and
//! personal stores exist, and how many encrypted files each holds.

use super::catalog::resolve_workspace_path;
use serde::Serialize;
use std::path::Path;
use tauri::State;

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
    registry: State<'_, crate::commands::window::WindowRegistry>,
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

    let legacy_secrets_dir = link.join(crate::commands::shared_secrets::SECRETS_DIR);
    let legacy_secrets_dir_exists = legacy_secrets_dir.exists();
    let legacy_secret_file_count = count_enc_json_files(&legacy_secrets_dir);

    let secret_configured = teamclu_runtime_env::env_catalog::resolve_team_env_secret(
        ws,
        team_id_trimmed.as_deref(),
        Some(crate::commands::APP_SHORT_NAME),
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
    let dir = crate::commands::amuxd_team_state_dir(team_id)
        .join("cloud")
        .join(crate::commands::shared_secrets::SECRETS_DIR);
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
