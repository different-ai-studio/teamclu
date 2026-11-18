// Re-export for backward compat (other modules use `crate::commands::team::TEAM_REPO_DIR`)
pub use super::TEAM_REPO_DIR;

// ─── Workspace Helpers ───────────────────────────────────────────────────────

/// Get the workspace path for the calling window.
pub fn get_workspace_path(
    window: &tauri::Window,
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
        log::error!(
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
    window: &tauri::Window,
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
