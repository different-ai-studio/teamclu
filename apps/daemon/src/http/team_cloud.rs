//! `/v1/team/members*` and `/v1/team/sessions*` — the team's people, agents
//! and conversations, for `amuxd member` and `amuxd session`.
//!
//! Each route is one Cloud API call made as this daemon's account (its agent
//! actor), so the answer is whatever that account may see: RLS decides, not
//! this file. The paths are built here from the route's own parameters; a
//! caller never names a Cloud API path, so this is not an open proxy.
//!
//! A refusal keeps its status (403 stays 403, 404 stays 404) so the CLI can
//! give it the right exit code instead of reading every failure as a 500.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};
use super::state::HttpState;
use crate::backend::{Backend, CloudReply};

fn backend_and_team(
    state: &HttpState,
) -> Result<(&std::sync::Arc<dyn Backend>, String), HttpError> {
    let backend = state
        .backend
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("cloud backend unavailable"))?;
    let team_id = backend.team_id().trim().to_string();
    if team_id.is_empty() {
        return Err(HttpError::validation("daemon is not onboarded to a team"));
    }
    Ok((backend, team_id))
}

/// A Cloud API answer as this route's answer.
fn reply(result: crate::backend::BackendResult<CloudReply>) -> Result<Value, HttpError> {
    let reply = result.map_err(|e| HttpError::runtime_unavailable(e.to_string()))?;
    if (200..300).contains(&reply.status) {
        return Ok(reply.body);
    }
    let message = reply.body["error"]["message"]
        .as_str()
        .or_else(|| reply.body.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Cloud API answered {}", reply.status));
    let code = match reply.status {
        400 => ErrorCode::BadRequest,
        401 => ErrorCode::Unauthorized,
        403 => ErrorCode::Forbidden,
        404 => ErrorCode::NotFound,
        409 => ErrorCode::Conflict,
        422 => ErrorCode::ValidationFailed,
        429 => ErrorCode::RateLimited,
        500..=599 => ErrorCode::RuntimeUnavailable,
        _ => ErrorCode::Internal,
    };
    Err(HttpError::new(code, message))
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// `key=value` pairs, the empty ones left out.
fn query(pairs: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = pairs
        .iter()
        .filter_map(|(k, v)| {
            v.as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| format!("{k}={}", enc(v)))
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

fn non_empty<'a>(value: &'a str, what: &str) -> Result<&'a str, HttpError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(HttpError::validation(format!("{what} must not be empty")));
    }
    Ok(value)
}

// ── Members ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct MembersQuery {
    /// `member` or `agent`.
    #[serde(default)]
    pub kind: Option<String>,
}

/// `GET /v1/team/members?kind=` — the team's people and agents.
pub async fn list_members(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<MembersQuery>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    if let Some(kind) = q.kind.as_deref().filter(|k| !k.is_empty()) {
        if !matches!(kind, "member" | "agent") {
            return Err(HttpError::validation("kind must be member or agent"));
        }
    }
    let (backend, team_id) = backend_and_team(&state)?;
    let path = format!(
        "/v1/teams/{}/actors{}",
        enc(&team_id),
        query(&[("kind", q.kind), ("limit", Some("500".into()))])
    );
    let body = reply(
        backend
            .cloud_request(reqwest::Method::GET, &path, None)
            .await,
    )?;
    Ok(Json(body))
}

/// `GET /v1/team/members/:actor_id` — `me` is this daemon's own agent actor.
pub async fn get_member(
    principal: Principal,
    State(state): State<HttpState>,
    Path(actor_id): Path<String>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (backend, _) = backend_and_team(&state)?;
    let actor_id = match actor_id.trim() {
        "me" => backend.actor_id().to_string(),
        other => other.to_string(),
    };
    let path = format!("/v1/actors/{}", enc(non_empty(&actor_id, "actor id")?));
    let body = reply(
        backend
            .cloud_request(reqwest::Method::GET, &path, None)
            .await,
    )?;
    Ok(Json(body))
}

// ── Sessions ────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct SessionsQuery {
    /// `all` (default), `regular` or `cron`.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub cursor: Option<String>,
}

/// `GET /v1/team/sessions?kind=&limit=&cursor=` — sessions this agent is in.
pub async fn list_sessions(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<SessionsQuery>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (backend, team_id) = backend_and_team(&state)?;
    let path = format!(
        "/v1/sessions{}",
        query(&[
            ("teamId", Some(team_id)),
            ("kind", q.kind),
            ("limit", q.limit.map(|n| n.to_string())),
            ("cursor", q.cursor),
        ])
    );
    let body = reply(
        backend
            .cloud_request(reqwest::Method::GET, &path, None)
            .await,
    )?;
    Ok(Json(body))
}

/// `GET /v1/team/sessions/:id` — the session and who is in it.
pub async fn get_session(
    principal: Principal,
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (backend, team_id) = backend_and_team(&state)?;
    let id = enc(non_empty(&session_id, "session id")?);
    let session = reply(
        backend
            .cloud_request(
                reqwest::Method::GET,
                &format!("/v1/sessions/{id}{}", query(&[("teamId", Some(team_id))])),
                None,
            )
            .await,
    )?;
    let participants = reply(
        backend
            .cloud_request(
                reqwest::Method::GET,
                &format!("/v1/sessions/{id}/roster"),
                None,
            )
            .await,
    )?;
    Ok(Json(
        json!({ "session": session, "participants": participants }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionBody {
    pub title: String,
    /// Who else to seat, besides this agent.
    #[serde(default)]
    pub participant_actor_ids: Vec<String>,
    /// The agent that answers by default. Default: this agent.
    #[serde(default)]
    pub primary_agent_actor_id: Option<String>,
}

/// `POST /v1/team/sessions` — open a session as this agent.
pub async fn create_session(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<CreateSessionBody>,
) -> Result<(StatusCode, Json<Value>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let (backend, team_id) = backend_and_team(&state)?;
    let title = non_empty(&body.title, "title")?;
    let me = backend.actor_id().to_string();
    let mut seats = vec![me.clone()];
    for id in body.participant_actor_ids {
        let id = id.trim().to_string();
        if !id.is_empty() && !seats.contains(&id) {
            seats.push(id);
        }
    }
    let primary = body
        .primary_agent_actor_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(me);
    let payload = json!({
        "teamId": team_id,
        "title": title,
        "mode": "collab",
        "participantActorIds": seats,
        "primaryAgentActorId": primary,
    });
    let created = reply(
        backend
            .cloud_request(reqwest::Method::POST, "/v1/sessions", Some(payload))
            .await,
    )?;
    Ok((StatusCode::CREATED, Json(created)))
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateSessionBody {
    #[serde(default)]
    pub title: Option<String>,
    /// `true` archives, `false` restores.
    #[serde(default)]
    pub archived: Option<bool>,
}

/// `PATCH /v1/team/sessions/:id` — rename, archive or restore.
pub async fn update_session(
    principal: Principal,
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Json(body): Json<UpdateSessionBody>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let (backend, _) = backend_and_team(&state)?;
    let id = enc(non_empty(&session_id, "session id")?);
    let mut patch = serde_json::Map::new();
    if let Some(title) = body.title.as_deref() {
        // A rename by hand locks the title, so the generated one never
        // overwrites it (the same as renaming in the app).
        patch.insert("title".into(), json!(non_empty(title, "title")?));
        patch.insert("titleLocked".into(), json!(true));
    }
    if let Some(archived) = body.archived {
        let at = archived.then(|| chrono::Utc::now().to_rfc3339());
        patch.insert("archivedAt".into(), json!(at));
    }
    if patch.is_empty() {
        return Err(HttpError::validation(
            "nothing to change: pass title or archived",
        ));
    }
    let body = reply(
        backend
            .cloud_request(
                reqwest::Method::PATCH,
                &format!("/v1/sessions/{id}"),
                Some(Value::Object(patch)),
            )
            .await,
    )?;
    Ok(Json(body))
}

#[derive(Debug, Default, Deserialize)]
pub struct MessagesQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub cursor: Option<String>,
}

/// `GET /v1/team/sessions/:id/messages?limit=&cursor=`
pub async fn list_messages(
    principal: Principal,
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let (backend, _) = backend_and_team(&state)?;
    let id = enc(non_empty(&session_id, "session id")?);
    let path = format!(
        "/v1/sessions/{id}/messages{}",
        query(&[
            ("limit", q.limit.map(|n| n.to_string())),
            ("cursor", q.cursor),
        ])
    );
    let body = reply(
        backend
            .cloud_request(reqwest::Method::GET, &path, None)
            .await,
    )?;
    Ok(Json(body))
}

#[derive(Debug, Deserialize)]
pub struct SendMessageBody {
    pub content: String,
}

/// `POST /v1/team/sessions/:id/messages` — post a message as this agent.
pub async fn send_message(
    principal: Principal,
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Json(body): Json<SendMessageBody>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let (backend, team_id) = backend_and_team(&state)?;
    let id = enc(non_empty(&session_id, "session id")?);
    if body.content.trim().is_empty() {
        return Err(HttpError::validation("message must not be empty"));
    }
    let payload = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "teamId": team_id,
        "senderActorId": backend.actor_id(),
        "kind": "text",
        "content": body.content,
    });
    let body = reply(
        backend
            .cloud_request(
                reqwest::Method::POST,
                &format!("/v1/sessions/{id}/messages"),
                Some(payload),
            )
            .await,
    )?;
    Ok(Json(body))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddParticipantBody {
    pub actor_id: String,
}

/// `POST /v1/team/sessions/:id/participants` — seat someone.
pub async fn add_participant(
    principal: Principal,
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Json(body): Json<AddParticipantBody>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let (backend, _) = backend_and_team(&state)?;
    let id = enc(non_empty(&session_id, "session id")?);
    let payload = json!({ "actorId": non_empty(&body.actor_id, "actor id")?, "role": "member" });
    let body = reply(
        backend
            .cloud_request(
                reqwest::Method::POST,
                &format!("/v1/sessions/{id}/participants"),
                Some(payload),
            )
            .await,
    )?;
    Ok(Json(body))
}

/// `DELETE /v1/team/sessions/:id/participants/:actor_id`
pub async fn remove_participant(
    principal: Principal,
    State(state): State<HttpState>,
    Path((session_id, actor_id)): Path<(String, String)>,
) -> Result<Json<Value>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let (backend, _) = backend_and_team(&state)?;
    let path = format!(
        "/v1/sessions/{}/participants/{}",
        enc(non_empty(&session_id, "session id")?),
        enc(non_empty(&actor_id, "actor id")?)
    );
    reply(
        backend
            .cloud_request(reqwest::Method::DELETE, &path, None)
            .await,
    )?;
    Ok(Json(json!({ "removed": actor_id.trim() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_keep_their_status() {
        let status = |code: u16| {
            reply(Ok(CloudReply {
                status: code,
                body: json!({ "error": { "code": "x", "message": "no" } }),
            }))
            .unwrap_err()
            .code
            .http_status()
            .as_u16()
        };
        assert_eq!(status(403), 403);
        assert_eq!(status(404), 404);
        assert_eq!(status(409), 409);
        assert_eq!(status(400), 400);
        assert_eq!(status(500), 503);
        let ok = reply(Ok(CloudReply {
            status: 201,
            body: json!({ "id": "s" }),
        }))
        .unwrap();
        assert_eq!(ok["id"], "s");
    }

    #[test]
    fn the_cloud_message_is_kept() {
        let err = reply(Ok(CloudReply {
            status: 403,
            body: json!({ "error": { "message": "not a member of this team" } }),
        }))
        .unwrap_err();
        assert_eq!(err.detail, "not a member of this team");
    }

    #[test]
    fn empty_query_values_are_left_out() {
        assert_eq!(
            query(&[
                ("teamId", Some("t 1".into())),
                ("cursor", Some(" ".into())),
                ("kind", None)
            ]),
            "?teamId=t%201"
        );
        assert_eq!(query(&[("kind", None)]), "");
    }
}
