//! Desktop HTTP for the session→knowledge review inbox.
//!
//! Same handlers as the control-socket `cmd: knowledge` actions (`propose`,
//! `inbox_*`, `publish`). The review tab talks HTTP; the session agent, once
//! wired, still uses the socket / MCP tool. Neither path writes the vault
//! until `publish`.

use axum::{extract::Path, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::global_team_store::sync_content_root;
use crate::config::layout;
use crate::knowledge::inbox;
use crate::sync::oss::state::LocalSyncState;

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};

fn active_team_id() -> Result<String, HttpError> {
    let team_id = layout::active_team();
    if team_id == layout::UNCLAIMED_TEAM {
        return Err(HttpError::validation(
            "daemon is not onboarded to a team; knowledge inbox is team-scoped",
        ));
    }
    Ok(team_id)
}

fn vault_root(team_id: &str) -> std::path::PathBuf {
    sync_content_root(team_id).join("knowledge")
}

fn map_inbox_error(code: &str, message: &str) -> HttpError {
    match code {
        "not_found" => HttpError::not_found(message.to_string()),
        "already_exists" => HttpError::new(ErrorCode::Conflict, message.to_string()),
        "no_team" | "not_pending" | "invalid_id" | "invalid_path" | "invalid_content"
        | "corrupt" => HttpError::validation(message.to_string()),
        _ => HttpError::internal(message.to_string()),
    }
}

fn inbox_reply(raw: String) -> Result<Json<Value>, HttpError> {
    let v: Value = serde_json::from_str(&raw).map_err(|e| HttpError::internal(e.to_string()))?;
    if v.get("ok") == Some(&Value::Bool(true)) {
        return Ok(Json(v.get("result").cloned().unwrap_or(Value::Null)));
    }
    let code = v
        .get("errorCode")
        .and_then(Value::as_str)
        .unwrap_or("internal");
    let message = v
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("knowledge inbox failed");
    Err(map_inbox_error(code, message))
}

/// `GET /v1/knowledge/inbox`
pub async fn list_inbox(principal: Principal) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let team_id = active_team_id()?;
    inbox_reply(inbox::inbox_list(&inbox::inbox_dir(&team_id)))
}

/// `GET /v1/knowledge/inbox/:id`
pub async fn get_inbox(
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let team_id = active_team_id()?;
    inbox_reply(inbox::inbox_get(
        &inbox::inbox_dir(&team_id),
        &json!({ "id": id }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeBody {
    pub title: Option<String>,
    pub content: Option<String>,
    pub body: Option<String>,
    pub suggested_path: Option<String>,
    pub session_id: Option<String>,
    pub source: Option<String>,
}

/// `POST /v1/knowledge/inbox`
pub async fn propose_inbox(
    principal: Principal,
    Json(body): Json<ProposeBody>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = active_team_id()?;
    let mut payload = serde_json::Map::new();
    if let Some(title) = body.title {
        payload.insert("title".into(), Value::String(title));
    }
    if let Some(content) = body.content.or(body.body) {
        payload.insert("content".into(), Value::String(content));
    }
    if let Some(path) = body.suggested_path {
        payload.insert("suggestedPath".into(), Value::String(path));
    }
    if let Some(session_id) = body.session_id {
        payload.insert("sessionId".into(), Value::String(session_id));
    }
    payload.insert(
        "source".into(),
        Value::String(body.source.unwrap_or_else(|| "session-header".into())),
    );
    inbox_reply(inbox::propose(
        &team_id,
        &inbox::inbox_dir(&team_id),
        &Value::Object(payload),
    ))
}

/// `DELETE /v1/knowledge/inbox/:id`
pub async fn discard_inbox(
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = active_team_id()?;
    inbox_reply(inbox::inbox_discard(
        &inbox::inbox_dir(&team_id),
        &json!({ "id": id }),
    ))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishBody {
    pub title: Option<String>,
    pub content: Option<String>,
    pub body: Option<String>,
    pub path: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

/// `POST /v1/knowledge/inbox/:id/publish`
pub async fn publish_inbox(
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<PublishBody>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let team_id = active_team_id()?;
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), Value::String(id));
    if let Some(title) = body.title {
        payload.insert("title".into(), Value::String(title));
    }
    if let Some(content) = body.content.or(body.body) {
        payload.insert("content".into(), Value::String(content));
    }
    if let Some(path) = body.path {
        payload.insert("path".into(), Value::String(path));
    }
    payload.insert("overwrite".into(), Value::Bool(body.overwrite));
    let blocked = LocalSyncState::peek_forbidden(&team_id);
    inbox_reply(inbox::publish(
        &inbox::inbox_dir(&team_id),
        &vault_root(&team_id),
        &Value::Object(payload),
        &blocked,
    ))
}

#[cfg(test)]
mod tests {
    use super::map_inbox_error;
    use crate::http::errors::ErrorCode;

    #[test]
    fn already_exists_is_a_conflict_not_a_validation_miss() {
        let err = map_inbox_error("already_exists", "exists");
        assert_eq!(err.code, ErrorCode::Conflict);
    }

    #[test]
    fn missing_candidate_is_not_found() {
        let err = map_inbox_error("not_found", "gone");
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
