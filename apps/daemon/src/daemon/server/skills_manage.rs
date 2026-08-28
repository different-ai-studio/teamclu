//! Control-socket handler for agent-managed personal skill packs.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::config::{
    create_pack, get_pack, update_pack, ClaimedTeamContext, CreatePackRequest, ManageSkillResponse,
    ManagedSkillErrorCode, UpdatePackRequest,
};
use crate::runtime::claude_skills::{
    reconcile_after_managed_mutation, WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED,
};
use crate::runtime::refresh::{RefreshChangeKind, RefreshSource};

use super::DaemonServer;

pub(crate) const WARNING_SKILL_REFRESH_FAILED: &str = "skill_refresh_failed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartialFailure {
    error_code: String,
    message: String,
}

fn sock_error(code: ManagedSkillErrorCode, message: impl Into<String>) -> String {
    json!({
        "ok": false,
        "error": message.into(),
        "errorCode": code.as_str(),
    })
    .to_string()
}

fn sock_managed_ok(result: ManageSkillResponse, partial_failures: &[PartialFailure]) -> String {
    let mut envelope = json!({
        "ok": true,
        "result": result,
    });
    if !partial_failures.is_empty() {
        envelope["partialFailures"] = serde_json::to_value(partial_failures).unwrap_or(json!([]));
    }
    envelope.to_string()
}

pub(crate) fn apply_claude_bridge_after_mutation(
    workspace: &Path,
    slug: &str,
    canonical_pack: &Path,
    warnings: &mut Vec<String>,
) -> Option<PartialFailure> {
    match reconcile_after_managed_mutation(workspace, slug, canonical_pack) {
        Ok(extra) => {
            warnings.extend(extra);
            None
        }
        Err(error) => {
            warnings.push(WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED.into());
            Some(PartialFailure {
                error_code: WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED.into(),
                message: error.to_string(),
            })
        }
    }
}

async fn record_skills_refresh(
    server: &DaemonServer,
    workspace_path: &Path,
) -> Option<PartialFailure> {
    let Some(refresh) = server.refresh_coordinator.as_ref() else {
        return Some(PartialFailure {
            error_code: WARNING_SKILL_REFRESH_FAILED.into(),
            message: "refresh coordinator unavailable".into(),
        });
    };
    let workspace_id = match crate::config::encode_workspace_path(workspace_path) {
        Ok(workspace_id) => workspace_id,
        Err(error) => {
            return Some(PartialFailure {
                error_code: WARNING_SKILL_REFRESH_FAILED.into(),
                message: format!("workspace path encoding failed: {error}"),
            });
        }
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
        return Some(PartialFailure {
            error_code: WARNING_SKILL_REFRESH_FAILED.into(),
            message: error.to_string(),
        });
    }
    None
}

pub(crate) async fn finalize_managed_mutation(
    server: &DaemonServer,
    workspace: &Path,
    mut resp: ManageSkillResponse,
) -> String {
    let canonical = PathBuf::from(&resp.path);
    let mut partial_failures = Vec::new();

    if let Some(failure) =
        apply_claude_bridge_after_mutation(workspace, &resp.slug, &canonical, &mut resp.warnings)
    {
        partial_failures.push(failure);
    }
    if let Some(failure) = record_skills_refresh(server, workspace).await {
        resp.warnings.push(WARNING_SKILL_REFRESH_FAILED.into());
        partial_failures.push(failure);
    }

    sock_managed_ok(resp, &partial_failures)
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
                    Ok(resp) => finalize_managed_mutation(self, workspace, resp).await,
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
                    Ok(resp) => finalize_managed_mutation(self, workspace, resp).await,
                    Err(err) => sock_error(err.code, err.message),
                }
            }
            "get" => {
                let slug = payload
                    .get("slug")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match get_pack(&home, slug) {
                    Ok(resp) => sock_managed_ok(resp, &[]),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{create_pack, CreatePackRequest, ClaimedTeamContext};
    use std::fs;

    fn test_skill_md(slug: &str) -> String {
        format!("---\nname: {slug}\ndescription: Demo.\n---\n")
    }

    #[test]
    fn apply_claude_bridge_surfaces_reconcile_failure_without_dropping_pack() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let ws = tempfile::tempdir().unwrap();
        let req = CreatePackRequest {
            slug: "demo-bridge".into(),
            content: test_skill_md("demo-bridge"),
            files: vec![],
        };
        let resp = create_pack(
            ws.path(),
            home.path(),
            &req,
            &ClaimedTeamContext::NoTeam,
        )
        .unwrap();
        let canonical = PathBuf::from(&resp.path);
        assert!(canonical.join("SKILL.md").is_file());

        fs::create_dir_all(ws.path().join(".claude")).unwrap();
        fs::write(ws.path().join(".claude/skills"), "not-a-directory").unwrap();

        let mut warnings = Vec::new();
        let failure = apply_claude_bridge_after_mutation(
            ws.path(),
            "demo-bridge",
            &canonical,
            &mut warnings,
        );
        assert!(failure.is_some(), "expected bridge failure to surface");
        assert_eq!(
            failure.unwrap().error_code,
            WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED
        );
        assert!(warnings.iter().any(|w| w == WARNING_CLAUDE_BRIDGE_RECONCILE_FAILED));
        assert!(canonical.join("SKILL.md").is_file());
    }
}
