//! `/v1/cron/*` — the daemon-owned scheduler's API (ADR-0010).
//!
//! The desktop settings page proxies its `cron_*` Tauri commands here, agents
//! call `/v1/cron/manage` through `amuxd cron`, and the `teamclu-introspect`
//! sidecar reads `/v1/cron/jobs` (no desktop needed for either), so there is
//! one store and one scheduler however a job is made.
//!
//! | Method | Path                          | Scope             |
//! |--------|-------------------------------|-------------------|
//! | GET    | `/v1/cron/jobs?workspacePath` | `workspace:read`  |
//! | POST   | `/v1/cron/jobs`               | `workspace:write` |
//! | PATCH  | `/v1/cron/jobs/:id`           | `workspace:write` |
//! | DELETE | `/v1/cron/jobs/:id`           | `workspace:write` |
//! | POST   | `/v1/cron/jobs/:id/enabled`   | `workspace:write` |
//! | POST   | `/v1/cron/jobs/:id/run`       | `workspace:write` |
//! | GET    | `/v1/cron/jobs/:id/runs`      | `workspace:read`  |
//! | POST   | `/v1/cron/import`             | `workspace:write` |
//! | POST   | `/v1/cron/manage`             | `workspace:write` |
//! | GET    | `/v1/cron/status`             | `workspace:read`  |
//! | POST   | `/v1/cron/restart-imminent`   | `workspace:write` |
//!
//! `workspacePath` absent means global jobs. `GET /v1/cron/status` carries
//! change counters; the desktop polls it and refreshes its lists when they
//! move, which also covers jobs an agent changed through MCP.

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;
use crate::cron::types::{CreateCronJobRequest, CronJob, CronRunRecord, UpdateCronJobRequest};
use crate::cron::{CronModelSource, CronService, CronStatus};

const READ: &str = "workspace:read";
const WRITE: &str = "workspace:write";

fn cron(state: &HttpState) -> Result<&CronService, HttpError> {
    state
        .cron
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("cron is not available on this daemon"))
}

/// Map the service's string errors: "not found" → 404, the rest → 422.
fn map_err(e: String) -> HttpError {
    if e.contains("not found") {
        HttpError::not_found(e)
    } else if e.contains("not started") {
        HttpError::runtime_unavailable(e)
    } else {
        HttpError::validation(e)
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScopeQuery {
    #[serde(default)]
    pub workspace_path: Option<String>,
}

pub async fn list_jobs(
    principal: Principal,
    State(state): State<HttpState>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<Vec<CronJob>>, HttpError> {
    require_scope(&principal, READ)?;
    Ok(Json(
        cron(&state)?.list_jobs(q.workspace_path.as_deref()).await,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    pub request: CreateCronJobRequest,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

pub async fn create_job(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<CreateBody>,
) -> Result<Json<CronJob>, HttpError> {
    require_scope(&principal, WRITE)?;
    cron(&state)?
        .create_job(body.request, body.workspace_path.as_deref())
        .await
        .map(Json)
        .map_err(map_err)
}

pub async fn update_job(
    principal: Principal,
    State(state): State<HttpState>,
    Path(job_id): Path<String>,
    Json(mut request): Json<UpdateCronJobRequest>,
) -> Result<Json<CronJob>, HttpError> {
    require_scope(&principal, WRITE)?;
    request.id = job_id;
    cron(&state)?
        .update_job(request)
        .await
        .map(Json)
        .map_err(map_err)
}

pub async fn delete_job(
    principal: Principal,
    State(state): State<HttpState>,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, WRITE)?;
    cron(&state)?.remove_job(&job_id).await.map_err(map_err)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct EnabledBody {
    pub enabled: bool,
}

pub async fn set_enabled(
    principal: Principal,
    State(state): State<HttpState>,
    Path(job_id): Path<String>,
    Json(body): Json<EnabledBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, WRITE)?;
    cron(&state)?
        .set_enabled(&job_id, body.enabled)
        .await
        .map_err(map_err)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn run_job(
    principal: Principal,
    State(state): State<HttpState>,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, WRITE)?;
    cron(&state)?.run_job(&job_id).await.map_err(map_err)?;
    Ok(Json(serde_json::json!({ "ok": true, "jobId": job_id })))
}

#[derive(Debug, Deserialize, Default)]
pub struct RunsQuery {
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn get_runs(
    principal: Principal,
    State(state): State<HttpState>,
    Path(job_id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> Result<Json<Vec<CronRunRecord>>, HttpError> {
    require_scope(&principal, READ)?;
    Ok(Json(cron(&state)?.get_runs(&job_id, q.limit).await))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBody {
    pub jobs: Vec<CronJob>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

pub async fn import_jobs(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<ImportBody>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, WRITE)?;
    let added = cron(&state)?
        .import_jobs(body.jobs, body.workspace_path.as_deref())
        .await
        .map_err(map_err)?;
    Ok(Json(serde_json::json!({ "added": added })))
}

/// The agent-facing body `amuxd cron` sends (`action`, `scope`, …). Errors
/// carry the service's message, which the agent reads; a missing job is a
/// 404 and a cron not started yet a 503, like the other cron routes.
pub async fn manage(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, HttpError> {
    require_scope(&principal, WRITE)?;
    cron(&state)?
        .mcp_manage(&body)
        .await
        .map(Json)
        .map_err(map_err)
}

pub async fn status(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Json<CronStatus>, HttpError> {
    require_scope(&principal, READ)?;
    Ok(Json(cron(&state)?.status()))
}

#[derive(Debug, Deserialize)]
pub struct RestartImminentBody {
    pub imminent: bool,
}

pub async fn set_restart_imminent(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<RestartImminentBody>,
) -> Result<Json<CronStatus>, HttpError> {
    require_scope(&principal, WRITE)?;
    let svc = cron(&state)?;
    svc.set_restart_imminent(body.imminent);
    Ok(Json(svc.status()))
}

// ==================== model source ====================

/// [`CronModelSource`] over the same handlers `/v1/agent/default-workspace`
/// and `/v1/workspaces/:id/model-catalog` serve, called in-process.
pub struct HttpCronModels {
    state: HttpState,
}

impl HttpCronModels {
    pub fn new(state: HttpState) -> Self {
        Self { state }
    }

    fn principal() -> Principal {
        Principal {
            token_id: uuid::Uuid::nil(),
            scopes: vec![READ.to_string()],
        }
    }
}

#[async_trait::async_trait]
impl CronModelSource for HttpCronModels {
    async fn default_workspace_path(&self) -> Option<String> {
        let resp =
            super::workspaces::get_default_workspace(Self::principal(), State(self.state.clone()))
                .await
                .ok()?;
        resp.0.path.filter(|p| !p.trim().is_empty())
    }

    async fn model_keys(&self, workspace_path: &str) -> HashSet<String> {
        let Ok(id) = crate::config::workspace_control::encode_workspace_path(std::path::Path::new(
            workspace_path,
        )) else {
            return HashSet::new();
        };
        match super::workspaces::get_model_catalog(
            Self::principal(),
            State(self.state.clone()),
            Path(id),
        )
        .await
        {
            Ok(catalog) => catalog
                .0
                .backends
                .iter()
                .flat_map(|b| b.models.iter())
                .map(|m| m.model_ref.to_lowercase())
                .collect(),
            Err(e) => {
                tracing::debug!(
                    workspace = workspace_path,
                    "cron: model catalog unavailable: {}",
                    e.detail
                );
                HashSet::new()
            }
        }
    }
}
