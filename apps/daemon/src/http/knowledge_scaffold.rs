//! Desktop HTTP for one-click knowledge vault scaffold.
//!
//! Same handler as the control-socket `cmd: knowledge, action: scaffold`.
//! The desktop Knowledge column calls this over loopback; agents still use
//! the socket / MCP tool. Both paths are idempotent — existing files are
//! never overwritten.

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{
    global_team_store::sync_content_root, knowledge_scaffold::scaffold_at, layout,
};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;

fn active_team_id() -> Result<String, HttpError> {
    let team_id = layout::active_team();
    if team_id == layout::UNCLAIMED_TEAM {
        return Err(HttpError::validation(
            "daemon is not onboarded to a team; knowledge vault is team-scoped",
        ));
    }
    Ok(team_id)
}

fn vault_root(team_id: &str) -> std::path::PathBuf {
    sync_content_root(team_id).join("knowledge")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldBody {
    /// Display name stamped into `00-home.md`. Defaults to the active team id.
    pub team_name: Option<String>,
}

/// `POST /v1/knowledge/scaffold` — body `{ "teamName"?: "<display name>" }`.
pub async fn scaffold_knowledge(
    principal: Principal,
    Json(body): Json<ScaffoldBody>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = active_team_id()?;
    let name = body
        .team_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(team_id.as_str())
        .to_string();
    let root = vault_root(&team_id);

    let report = tokio::task::spawn_blocking(move || scaffold_at(&root, &team_id, &name))
        .await
        .map_err(|e| HttpError::internal(format!("scaffold task join: {e}")))?
        .map_err(|e| HttpError::internal(format!("scaffold failed: {e}")))?;

    Ok(Json(json!({
        "knowledgeRoot": report.knowledge_root,
        "dirsCreated": report.dirs_created,
        "filesCreated": report.files_created,
        "filesSkipped": report.files_skipped,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::knowledge_scaffold::scaffold_at;

    #[test]
    fn scaffold_at_writes_home_and_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let report = scaffold_at(tmp.path(), "team-x", "示例团队").unwrap();
        assert!(tmp.path().join("00-home.md").is_file());
        assert!(tmp.path().join("knowledge.manifest.yaml").is_file());
        assert!(!report.files_created.is_empty());
    }
}
