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
    /// Absolute path of the workspace to link into the team's global dir.
    pub path: String,
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

/// `POST /v1/team/link` — body `{ "path": "<workspace path>" }`.
pub async fn link_team_workspace(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<LinkTeamWorkspaceRequest>,
) -> Result<Json<LinkTeamWorkspaceResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let path = body.path.trim();
    if path.is_empty() {
        return Err(HttpError::validation("path must not be empty"));
    }

    let team_id = onboarded_team_id()?;

    let status = crate::team_link::ensure_team_link(&team_id, path);
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

    let path = body.path.trim();
    if path.is_empty() {
        return Err(HttpError::validation("path must not be empty"));
    }

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
