//! `POST /v1/team/link` / `POST /v1/team/unlink` — materialize or tear down
//! the daemon's team global dir and a workspace `teamclu-team` symlink.
//!
//! The team-share global copy (`~/.amuxd/teams/<team_id>/teamclu-team`) and
//! the per-workspace symlink are otherwise only created by the daemon's startup
//! sweep or when a workspace is registered for a runtime (AddWorkspace). When
//! the app enables team-share the user expects
//! them to exist *immediately*, not after a daemon restart or the first
//! session — and the AddWorkspace path rides MQTT, which may not be connected
//! right after onboarding. This local HTTP endpoint lets the app trigger the
//! link directly over the daemon's loopback API right after enable/join.
//!
//! The daemon is single-team: `team_id` is read from `daemon.toml` (fixed at
//! `amuxd init`). The endpoint does not mutate the workspace registry — it only
//! ensures the global dir + symlink exist; registry registration still happens
//! through the normal runtime path.

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::config::workspace_link::{LinkKind, LinkStatus};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

#[derive(Debug, Deserialize)]
pub struct LinkTeamWorkspaceRequest {
    /// Absolute path of a workspace to link into the team's global dir.
    ///
    /// Optional. The team's own directory does not belong to any workspace, and
    /// materializing it is the half of this call that clients actually need
    /// (the Knowledge column's repair button, for one, reads the team dir by
    /// absolute path and never touches a workspace link). Omit it to create the
    /// team dir alone.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LinkTeamWorkspaceResponse {
    pub team_id: String,
    /// Resulting link state: `symlink` | `junction` | `fallback` |
    /// `legacy_retained` (mirrors `workspace_link::LinkStatus`).
    pub status: &'static str,
    /// `~/.amuxd/teams/<team_id>/teamclu-team`.
    pub global_dir: String,
}

fn status_str(status: &LinkStatus) -> &'static str {
    match status {
        LinkStatus::Linked(LinkKind::Symlink) => "symlink",
        LinkStatus::Linked(LinkKind::Junction) => "junction",
        LinkStatus::Fallback => "fallback",
        LinkStatus::LegacyDirRetained { .. } => "legacy_retained",
    }
}

fn onboarded_team_id() -> Result<String, HttpError> {
    let config = crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
        .map_err(|e| HttpError::internal(format!("load daemon config: {e}")))?;
    config
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .ok_or_else(|| HttpError::validation("daemon is not onboarded to a team"))
}

/// `POST /v1/team/link` — body `{ "path"?: "<workspace path>" }`.
pub async fn link_team_workspace(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<LinkTeamWorkspaceRequest>,
) -> Result<Json<LinkTeamWorkspaceResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let team_id = onboarded_team_id()?;
    let path = body
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());

    let status = match path {
        Some(path) => crate::team_link::ensure_team_link(&team_id, path),
        // No workspace named: materialize the team's own directory and stop
        // there. `ensure_team_link` would do this first anyway; skipping it
        // would leave the caller with a response about a link nobody asked for.
        None => match crate::config::global_team_store::ensure_initialized(&team_id) {
            Ok(_) => LinkStatus::Fallback,
            Err(e) => {
                return Err(HttpError::internal(format!("team dir init failed: {e}")));
            }
        },
    };
    let global_dir = crate::config::global_team_store::global_team_dir(&team_id)
        .to_string_lossy()
        .into_owned();

    Ok(Json(LinkTeamWorkspaceResponse {
        team_id,
        status: status_str(&status),
        global_dir,
    }))
}

#[derive(Debug, Serialize)]
pub struct UnlinkTeamWorkspaceResponse {
    pub team_id: String,
    pub path: String,
}

/// `POST /v1/team/unlink` — body `{ "path": "<workspace path>" }`.
pub async fn unlink_team_workspace(
    principal: Principal,
    Json(body): Json<LinkTeamWorkspaceRequest>,
) -> Result<Json<UnlinkTeamWorkspaceResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    // Unlink, unlike link, genuinely needs one: it removes a *workspace's* link.
    let path = body
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| HttpError::validation("path must not be empty"))?;

    let team_id = onboarded_team_id()?;

    crate::team_link::remove_workspace_team_link(path).map_err(|e| {
        HttpError::internal(format!(
            "failed to remove workspace team link at {}: {e}",
            path
        ))
    })?;
    crate::team_link::prune_scaffold_team_home(&team_id);

    Ok(Json(UnlinkTeamWorkspaceResponse {
        team_id,
        path: path.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Knowledge column's repair button reads the team dir by absolute path
    /// and never touches a workspace link, so it calls this with no path at all.
    /// Requiring one made that button unreachable with no folder open — for the
    /// half of the operation that has nothing to do with a workspace.
    #[test]
    fn link_request_accepts_a_body_without_a_path() {
        let body: LinkTeamWorkspaceRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(body.path, None);

        let with_path: LinkTeamWorkspaceRequest =
            serde_json::from_str(r#"{"path":"/tmp/ws"}"#).unwrap();
        assert_eq!(with_path.path.as_deref(), Some("/tmp/ws"));
    }

    #[test]
    fn status_str_covers_all_link_states() {
        assert_eq!(
            status_str(&LinkStatus::Linked(LinkKind::Symlink)),
            "symlink"
        );
        assert_eq!(
            status_str(&LinkStatus::Linked(LinkKind::Junction)),
            "junction"
        );
        assert_eq!(status_str(&LinkStatus::Fallback), "fallback");
        assert_eq!(
            status_str(&LinkStatus::LegacyDirRetained {
                reason: "non-empty".into(),
            }),
            "legacy_retained"
        );
    }
}
