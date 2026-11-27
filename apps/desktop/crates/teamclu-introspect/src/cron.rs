//! The jobs `get_my_capabilities` reports, read straight from amuxd, which owns
//! cron (ADR-0010). Managing jobs moved to the `amuxd cron` CLI.

use serde_json::Value;

/// Jobs the agent can see: the global list plus, when `workspace` is set, that
/// workspace's (cwd mapped back to the workspace root, as the settings page
/// lists it). For `get_my_capabilities`.
pub async fn list_visible_jobs(workspace: &str) -> Result<Vec<Value>, String> {
    let mut jobs = list_scope(None).await?;
    if !workspace.trim().is_empty() {
        jobs.extend(list_scope(Some(&resolve_workspace_root(workspace))).await?);
    }
    Ok(jobs)
}

async fn list_scope(workspace_path: Option<&str>) -> Result<Vec<Value>, String> {
    let path = match workspace_path {
        Some(ws) => format!(
            "/v1/cron/jobs?workspacePath={}",
            crate::daemon_http::urlencode(ws)
        ),
        None => "/v1/cron/jobs".to_string(),
    };
    let resp =
        crate::daemon_http::request(reqwest::Method::GET, &path, &["workspace:read"], None).await?;
    Ok(resp.as_array().cloned().unwrap_or_default())
}

/// Map a runtime cwd (often `{repo}/.worktrees/<id>`) back to the workspace root
/// the desktop cron UI actually lists.
fn resolve_workspace_root(path: &str) -> String {
    let path = std::path::Path::new(path);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut parts: Vec<_> = abs.iter().map(|s| s.to_os_string()).collect();
    if let Some(idx) = parts.iter().position(|c| c == ".worktrees") {
        parts.truncate(idx);
        return std::path::PathBuf::from_iter(parts)
            .to_string_lossy()
            .into_owned();
    }
    abs.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_workspace_root_strips_git_worktree() {
        let input = std::path::PathBuf::from("/repo")
            .join(".worktrees")
            .join("cron-j1-r1");
        let got = std::path::PathBuf::from(resolve_workspace_root(&input.to_string_lossy()));
        assert_eq!(got, std::path::PathBuf::from("/repo"));
    }
}
