//! Control-socket handler for agent-managed personal skill packs.

use std::path::Path;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::config::{
    create_pack, get_pack, update_pack, ClaimedTeamContext, CreatePackRequest, ManagedSkillError,
    ManagedSkillErrorCode, UpdatePackRequest,
};
use crate::runtime::refresh::{RefreshChangeKind, RefreshSource};

use super::DaemonServer;

fn sock_error(code: ManagedSkillErrorCode, message: impl Into<String>) -> String {
    json!({
        "ok": false,
        "error": message.into(),
        "errorCode": code.as_str(),
    })
    .to_string()
}

fn sock_ok(result: Value) -> String {
    json!({ "ok": true, "result": result }).to_string()
}

async fn load_team_ownership(server: &DaemonServer) -> ClaimedTeamContext {
    let team_id = server.backend.team_id();
    if team_id.trim().is_empty() {
        return ClaimedTeamContext::NoTeam;
    }
    match server.backend.team_skills(team_id).await {
        Ok(rows) => ClaimedTeamContext::Known(
            rows.into_iter()
                .filter(|row| row.installed)
                .map(|row| row.slug)
                .collect(),
        ),
        Err(error) => {
            tracing::warn!(
                team_id = %team_id,
                error = %error,
                "team skill ownership lookup failed; managed skill mutations will fail closed"
            );
            ClaimedTeamContext::Unavailable
        }
    }
}

async fn record_skills_refresh(server: &DaemonServer, workspace_path: &Path) {
    let Some(refresh) = server.refresh_coordinator.as_ref() else {
        return;
    };
    let Ok(workspace_id) = crate::config::encode_workspace_path(workspace_path) else {
        return;
    };
    if let Err(error) = refresh
        .record_change(
            &workspace_id,
            workspace_path,
            RefreshChangeKind::Skills,
            RefreshSource::UiMutation,
        )
        .await
    {
        tracing::warn!(
            workspace_id = %workspace_id,
            workspace_path = %workspace_path.display(),
            error = %error,
            "failed to record skills refresh after manage_skills"
        );
    }
}

impl DaemonServer {
    pub(crate) async fn handle_skills_manage(
        &self,
        payload: Value,
        reply_tx: oneshot::Sender<String>,
    ) {
        let reply = self.handle_skills_manage_inner(payload).await;
        let _ = reply_tx.send(reply);
    }

    async fn handle_skills_manage_inner(&self, payload: Value) -> String {
        let workspace_path = payload
            .get("workspace_path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(workspace_path) = workspace_path else {
            return sock_error(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                "workspace_path is required",
            );
        };
        let workspace = Path::new(workspace_path);
        if !workspace.is_dir() {
            return sock_error(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                "workspace_path does not exist",
            );
        }

        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("");
        let home = match dirs::home_dir() {
            Some(home) => home,
            None => {
                return sock_error(
                    ManagedSkillErrorCode::SkillWriteFailed,
                    "home directory not found",
                );
            }
        };
        let ownership = load_team_ownership(self).await;

        match action {
            "create" => {
                let req: CreatePackRequest = match serde_json::from_value(payload.clone()) {
                    Ok(req) => req,
                    Err(e) => {
                        return sock_error(
                            ManagedSkillErrorCode::InvalidSkillFrontmatter,
                            format!("invalid create request: {e}"),
                        );
                    }
                };
                match create_pack(workspace, &home, &req, &ownership) {
                    Ok(resp) => {
                        record_skills_refresh(self, workspace).await;
                        sock_ok(serde_json::to_value(resp).unwrap_or(json!({})))
                    }
                    Err(err) => sock_error(err.code, err.message),
                }
            }
            "update" => {
                let req: UpdatePackRequest = match serde_json::from_value(payload.clone()) {
                    Ok(req) => req,
                    Err(e) => {
                        return sock_error(
                            ManagedSkillErrorCode::InvalidSkillFrontmatter,
                            format!("invalid update request: {e}"),
                        );
                    }
                };
                match update_pack(workspace, &home, &req, &ownership) {
                    Ok(resp) => {
                        record_skills_refresh(self, workspace).await;
                        sock_ok(serde_json::to_value(resp).unwrap_or(json!({})))
                    }
                    Err(err) => sock_error(err.code, err.message),
                }
            }
            "get" => {
                let slug = payload
                    .get("slug")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match get_pack(&home, slug) {
                    Ok(resp) => sock_ok(serde_json::to_value(resp).unwrap_or(json!({}))),
                    Err(err) => sock_error(err.code, err.message),
                }
            }
            _ => sock_error(
                ManagedSkillErrorCode::InvalidSkillFilePath,
                "action must be create, update, or get",
            ),
        }
    }
}
