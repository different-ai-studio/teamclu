use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

// Re-export for backward compat (other modules use `crate::commands::team::TEAM_REPO_DIR`)
pub use super::TEAM_REPO_DIR;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Team metadata stored in `teamclu-team/_meta/team.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMeta {
    pub team_id: String,
    pub team_name: String,
    /// HMAC-SHA256(team_secret, "teamclu-verify") as hex — for join verification.
    pub secret_verify: String,
    pub created_at: String,
    pub owner_node_id: String,
    /// LiteLLM/FC endpoint URL. When set, joining members register their key
    /// via this endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fc_endpoint: Option<String>,
}

// ─── Workspace Helpers ───────────────────────────────────────────────────────

/// Get the workspace path for the calling window.
pub fn get_workspace_path(
    window: &tauri::WebviewWindow,
    registry: &crate::commands::window::WindowRegistry,
) -> Result<String, String> {
    crate::commands::window::current_workspace_for_window(window, registry)
}

/// `<amuxd home>/teams/<active team>/workspace`, created if missing.
///
/// The daemon's own default worktree — where a gateway session and a global
/// cron job already run when nothing else is picked
/// (`global_team_store::onboarded_default_workspace_dir` is the daemon-side
/// twin of this). `None` while the daemon is unclaimed.
fn daemon_default_workspace_path() -> Option<String> {
    let team = crate::commands::amuxd_active_team()?;
    let dir = crate::commands::amuxd_team_workspace_dir(&team);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[team] create daemon default workspace dir '{}' failed: {e}",
            dir.display()
        );
        return None;
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Resolve a workspace path: the explicit frontend argument, then the calling
/// window's registered workspace, then the daemon's default worktree.
///
/// That last step is what lets config surfaces work before a folder is opened —
/// env vars, MCP servers, skills, the gateway prompt. It is not a guess: the
/// daemon runs there itself when no workspace is picked, so the config edited
/// through these commands is the config those runs read. Erroring instead left
/// whole panels dead on a client with no project open, which is not a state the
/// data justifies: none of it is per-project to begin with.
pub fn resolve_workspace_path(
    workspace_path: Option<String>,
    window: &tauri::WebviewWindow,
    registry: &crate::commands::window::WindowRegistry,
) -> Result<String, String> {
    if let Some(path) = workspace_path.filter(|path| !path.is_empty()) {
        return Ok(path);
    }
    if let Ok(path) = get_workspace_path(window, registry) {
        return Ok(path);
    }
    daemon_default_workspace_path()
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())
}

// ─── Config Helpers ──────────────────────────────────────────────────────────

pub fn read_workspace_config(workspace_path: &str) -> Result<serde_json::Value, String> {
    let config_path = Path::new(workspace_path)
        .join(crate::commands::TEAMCLU_DIR)
        .join(super::CONFIG_FILE_NAME);

    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))
}

pub fn write_workspace_config(
    workspace_path: &str,
    json: &serde_json::Value,
) -> Result<(), String> {
    let teamclu_dir = Path::new(workspace_path).join(crate::commands::TEAMCLU_DIR);
    std::fs::create_dir_all(&teamclu_dir)
        .map_err(|e| format!("Failed to create {}: {}", super::TEAMCLU_DIR, e))?;

    let config_path = teamclu_dir.join(super::CONFIG_FILE_NAME);
    let content = serde_json::to_string_pretty(json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Read `teamclu-team/_meta/team.json` from the given workspace, if present.
#[tauri::command]
pub fn workspace_read_team_meta(workspace_path: String) -> Result<Option<TeamMeta>, String> {
    let meta_path = Path::new(&workspace_path)
        .join(TEAM_REPO_DIR)
        .join("_meta")
        .join("team.json");
    if !meta_path.exists() {
        return Ok(None);
    }
    let content = match std::fs::read_to_string(&meta_path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    match serde_json::from_str::<TeamMeta>(&content) {
        Ok(meta) => Ok(Some(meta)),
        Err(_) => Ok(None),
    }
}

/// Remove `<workspace>/teamclu-team` whether it is a symlink, junction, or real
/// dir. Moved here from `team_share::disconnect` when that module went: this
/// command was its only surviving caller.
fn remove_workspace_team_repo_entry(workspace_path: &str) -> Result<(), String> {
    let link = Path::new(workspace_path).join(TEAM_REPO_DIR);
    match std::fs::symlink_metadata(&link) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to inspect {}: {}", link.display(), e)),
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                std::fs::remove_file(&link)
                    .map_err(|e| format!("Failed to remove symlink {}: {}", link.display(), e))
            }
            #[cfg(windows)]
            {
                std::fs::remove_dir(&link)
                    .map_err(|e| format!("Failed to remove junction {}: {}", link.display(), e))
            }
        }
        Ok(_) => std::fs::remove_dir_all(&link)
            .map_err(|e| format!("Failed to remove directory {}: {}", link.display(), e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_meta_round_trips_camel_case() {
        let meta: TeamMeta = serde_json::from_value(serde_json::json!({
            "teamId": "t-1",
            "teamName": "Demo",
            "secretVerify": "ab12",
            "createdAt": "2026-06-01T00:00:00Z",
            "ownerNodeId": "node-1"
        }))
        .unwrap();

        let value = serde_json::to_value(meta).unwrap();
        assert_eq!(value["teamId"], "t-1");
        assert!(value.get("fcEndpoint").is_none());
    }
}
