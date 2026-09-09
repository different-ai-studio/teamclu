pub mod amuxd_client;
pub mod delivery;
pub mod scheduler;
pub mod storage;
pub mod types;
pub mod workspace_models;

use delivery::DeliveryManager;
use scheduler::CronScheduler;
use storage::CronStorage;
use types::*;

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, State};

/// Per-workspace cron runtime. Cheap to clone (storage and scheduler are
/// Arc-based internally).
#[derive(Clone)]
pub struct CronInstance {
    pub storage: CronStorage,
    pub scheduler: CronScheduler,
}

impl CronInstance {
    fn new() -> Self {
        let storage = CronStorage::new();
        let scheduler = CronScheduler::new(storage.clone());
        Self { storage, scheduler }
    }
}

/// Cron state — one `CronInstance` per workspace, keyed by workspace_path.
///
/// Multi-window-safe: starting cron for workspace B no longer stops workspace
/// A's scheduler. Each workspace keeps its own jobs, scheduler, and delivery
/// configuration.
pub struct CronState {
    pub instances: tokio::sync::Mutex<HashMap<String, CronInstance>>,
}

impl Default for CronState {
    fn default() -> Self {
        Self {
            instances: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl CronState {
    /// Get or create the `CronInstance` for a workspace. Returns a clone — the
    /// instance is Arc-backed so cloning is cheap and safe to drop the map lock.
    pub async fn instance_for(&self, workspace_path: &str) -> CronInstance {
        let mut instances = self.instances.lock().await;
        instances
            .entry(workspace_path.to_string())
            .or_insert_with(CronInstance::new)
            .clone()
    }

    /// Look up the `CronInstance` for a workspace without creating one.
    /// Commands invoked before `cron_init` for the workspace return `None`,
    /// which surfaces as a clear error to the caller.
    pub async fn try_instance_for(&self, workspace_path: &str) -> Option<CronInstance> {
        let instances = self.instances.lock().await;
        instances.get(workspace_path).cloned()
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum CronScope {
    #[default]
    Global,
    Workspace,
}

pub(crate) fn global_cron_root() -> Result<String, String> {
    let base = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(crate::commands::home_storage_dir_name())
        .join("cron-global");
    std::fs::create_dir_all(&base).map_err(|e| format!("Failed to create global cron dir: {e}"))?;
    Ok(base.to_string_lossy().to_string())
}

/// Storage key + optional execution cwd for workspace-scoped runs.
async fn resolve_cron_paths(
    scope: CronScope,
    workspace_path: Option<String>,
    window: &tauri::Window,
    registry: &State<'_, crate::commands::window::WindowRegistry>,
) -> Result<(String, Option<String>), String> {
    match scope {
        CronScope::Global => Ok((global_cron_root()?, None)),
        CronScope::Workspace => {
            let path = match workspace_path.filter(|p| !p.is_empty()) {
                Some(p) => p,
                None => crate::commands::window::current_workspace_for_window(window, registry)?,
            };
            Ok((path.clone(), Some(path)))
        }
    }
}

/// Look up the cron instance for a scope. Errors if `cron_init` has not run yet.
async fn require_instance(
    scope: CronScope,
    workspace_path: Option<String>,
    window: &tauri::Window,
    registry: &State<'_, crate::commands::window::WindowRegistry>,
    cron_state: &State<'_, CronState>,
) -> Result<CronInstance, String> {
    let (storage_path, _) = resolve_cron_paths(scope, workspace_path, window, registry).await?;
    cron_state
        .try_instance_for(&storage_path)
        .await
        .ok_or_else(|| format!("Cron not initialized (scope={scope:?})"))
}

// ==================== Tauri Commands ====================

/// Initialize the cron system for the calling window's workspace.
///
/// Re-initializing the same workspace stops only that workspace's scheduler
/// (so its job-list and delivery config can be reloaded). Other workspaces
/// are untouched — the previous singleton design would have killed them.
#[tauri::command]
pub async fn cron_init(
    app: AppHandle,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let scope = scope.unwrap_or_default();
    let (storage_path, execution_workspace) =
        resolve_cron_paths(scope, workspace_path, &window, &registry).await?;

    if scope == CronScope::Workspace && !std::path::Path::new(&storage_path).is_dir() {
        return Err(format!("Workspace not found: {}", storage_path));
    }

    let instance = cron_state.instance_for(&storage_path).await;
    instance.scheduler.stop().await;

    instance.storage.init(&storage_path).await;
    instance
        .scheduler
        .set_execution_workspace(execution_workspace)
        .await;
    instance.scheduler.set_app_handle(app);

    let delivery_mgr = DeliveryManager::new(storage_path.clone());
    instance.scheduler.set_delivery(delivery_mgr).await;

    instance.scheduler.reconcile_interrupted_runs().await;

    instance.scheduler.start().await;

    log::info!("[Cron] System initialized (scope={scope:?}, storage={storage_path})");
    Ok(())
}

/// List all cron jobs for the calling window's workspace.
#[tauri::command]
pub async fn cron_list_jobs(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<Vec<CronJob>, String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;
    Ok(instance.storage.list_jobs().await)
}

/// Add a new cron job to the calling window's workspace.
#[tauri::command]
pub async fn cron_add_job(
    request: CreateCronJobRequest,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<CronJob, String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;

    let job = create_job_on_instance(&instance, request).await;
    log::info!("[Cron] Job created: {} ({})", job.name, job.id);
    Ok(job)
}

pub(crate) async fn create_job_on_instance(
    instance: &CronInstance,
    request: CreateCronJobRequest,
) -> CronJob {
    let now = chrono::Utc::now();
    let mut job = CronJob {
        id: uuid::Uuid::new_v4().to_string(),
        name: request.name,
        description: request.description,
        enabled: request.enabled,
        schedule: request.schedule,
        payload: request.payload,
        delivery: request.delivery,
        delete_after_run: request.delete_after_run,
        created_at: now,
        updated_at: now,
        last_run_at: None,
        next_run_at: None,
    };

    job.next_run_at = instance.scheduler.compute_next_run(&job, None);
    instance.storage.add_job(job.clone()).await;
    instance.scheduler.emit_jobs_updated();
    job
}

/// MCP / HTTP entry: mutate the same CronState the settings UI lists.
/// Defaults to global scope so created jobs show up in "Global tasks".
pub(crate) async fn mcp_manage(
    app: &AppHandle,
    cron_state: &CronState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;
    let scope = match body.get("scope").and_then(|v| v.as_str()) {
        Some("workspace") => CronScope::Workspace,
        _ => CronScope::Global,
    };
    let workspace_path = body
        .get("workspace_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let instance = ensure_instance(app, cron_state, scope, workspace_path).await?;

    match action {
        "create" => {
            let request = parse_create_request(body)?;
            let job = create_job_on_instance(&instance, request).await;
            log::info!("[Cron] MCP job created: {} ({})", job.name, job.id);
            let job = serde_json::to_value(job).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "action": "created",
                "job": job,
            }))
        }
        "list" => {
            let jobs = instance.storage.list_jobs().await;
            let jobs = serde_json::to_value(jobs).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "action": "listed", "jobs": jobs }))
        }
        "pause" | "resume" => {
            let job_id = require_mcp_job_id(body)?;
            let enabled = action == "resume";
            instance.storage.toggle_enabled(job_id, enabled).await?;
            if enabled {
                if let Some(job) = instance.storage.get_job(job_id).await {
                    let next = instance.scheduler.compute_next_run(&job, None);
                    instance.storage.update_next_run_at(job_id, next).await;
                }
            }
            instance.scheduler.emit_jobs_updated();
            let action_name = if enabled { "resumed" } else { "paused" };
            Ok(serde_json::json!({
                "action": action_name,
                "job_id": job_id,
            }))
        }
        "delete" => {
            let job_id = require_mcp_job_id(body)?;
            instance.storage.remove_job(job_id).await?;
            instance.scheduler.emit_jobs_updated();
            Ok(serde_json::json!({ "action": "deleted", "job_id": job_id }))
        }
        "run" => {
            let job_id = require_mcp_job_id(body)?;
            let job = instance
                .storage
                .get_job(job_id)
                .await
                .ok_or_else(|| format!("Job not found: {job_id}"))?;
            let scheduler = instance.scheduler.clone();
            tokio::spawn(async move {
                scheduler.execute_job(job).await;
            });
            Ok(serde_json::json!({ "action": "triggered", "job_id": job_id }))
        }
        "get_runs" => {
            let job_id = require_mcp_job_id(body)?;
            let runs = instance.storage.get_runs(job_id, Some(10)).await;
            let runs = serde_json::to_value(runs).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "job_id": job_id, "runs": runs }))
        }
        other => Err(format!("Unknown action: {other}")),
    }
}

fn require_mcp_job_id(body: &serde_json::Value) -> Result<&str, String> {
    body.get("job_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Missing field: job_id".to_string())
}

fn parse_create_request(body: &serde_json::Value) -> Result<CreateCronJobRequest, String> {
    let mut obj = body
        .as_object()
        .cloned()
        .ok_or_else(|| "create body must be an object".to_string())?;
    obj.remove("action");
    obj.remove("scope");
    obj.remove("workspace_path");
    obj.remove("job_id");
    serde_json::from_value(serde_json::Value::Object(obj))
        .map_err(|e| format!("invalid create request: {e}"))
}

pub(crate) async fn ensure_instance(
    app: &AppHandle,
    cron_state: &CronState,
    scope: CronScope,
    workspace_path: Option<String>,
) -> Result<CronInstance, String> {
    let (storage_path, execution_workspace) = match scope {
        CronScope::Global => (global_cron_root()?, None),
        CronScope::Workspace => {
            let path = workspace_path
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "workspace scope requires workspace_path".to_string())?;
            if !std::path::Path::new(&path).is_dir() {
                return Err(format!("Workspace not found: {path}"));
            }
            (path.clone(), Some(path))
        }
    };

    let instance = cron_state.instance_for(&storage_path).await;
    if instance.storage.is_initialized().await {
        return Ok(instance);
    }

    instance.storage.init(&storage_path).await;
    instance
        .scheduler
        .set_execution_workspace(execution_workspace)
        .await;
    instance.scheduler.set_app_handle(app.clone());

    let delivery_mgr = DeliveryManager::new(storage_path.clone());
    instance.scheduler.set_delivery(delivery_mgr).await;
    instance.scheduler.reconcile_interrupted_runs().await;
    instance.scheduler.start().await;
    Ok(instance)
}

/// Update an existing cron job in the calling window's workspace.
#[tauri::command]
pub async fn cron_update_job(
    request: UpdateCronJobRequest,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<CronJob, String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;

    let mut job = instance
        .storage
        .get_job(&request.id)
        .await
        .ok_or_else(|| format!("Job not found: {}", request.id))?;

    if let Some(name) = request.name {
        job.name = name;
    }
    if let Some(desc) = request.description {
        job.description = Some(desc);
    }
    if let Some(enabled) = request.enabled {
        job.enabled = enabled;
    }
    if let Some(schedule) = request.schedule {
        job.schedule = schedule;
        job.next_run_at = instance.scheduler.compute_next_run(&job, None);
    }
    if let Some(payload) = request.payload {
        job.payload = payload;
    }
    if let Some(delivery) = request.delivery {
        job.delivery = delivery;
    }
    if let Some(delete_after_run) = request.delete_after_run {
        job.delete_after_run = delete_after_run;
    }

    job.updated_at = chrono::Utc::now();

    instance.storage.update_job(job.clone()).await?;
    log::info!("[Cron] Job updated: {} ({})", job.name, job.id);

    Ok(job)
}

/// Remove a cron job from the calling window's workspace.
#[tauri::command]
pub async fn cron_remove_job(
    job_id: String,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;
    instance.storage.remove_job(&job_id).await?;
    log::info!("[Cron] Job removed: {}", job_id);
    Ok(())
}

/// Toggle a cron job's enabled state.
#[tauri::command]
pub async fn cron_toggle_enabled(
    job_id: String,
    enabled: bool,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;
    instance.storage.toggle_enabled(&job_id, enabled).await?;

    if enabled {
        if let Some(job) = instance.storage.get_job(&job_id).await {
            let next = instance.scheduler.compute_next_run(&job, None);
            instance.storage.update_next_run_at(&job_id, next).await;
        }
    }

    log::info!(
        "[Cron] Job {} {}",
        job_id,
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

/// Run a cron job immediately (manual trigger).
#[tauri::command]
pub async fn cron_run_job(
    job_id: String,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;

    let job = instance
        .storage
        .get_job(&job_id)
        .await
        .ok_or_else(|| format!("Job not found: {}", job_id))?;

    log::info!("[Cron] Manual run triggered for: {} ({})", job.name, job.id);

    let scheduler = instance.scheduler.clone();
    tokio::spawn(async move {
        scheduler.execute_job(job).await;
    });

    Ok(())
}

/// Get run history for a cron job.
#[tauri::command]
pub async fn cron_get_runs(
    job_id: String,
    limit: Option<usize>,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<Vec<CronRunRecord>, String> {
    let instance = require_instance(
        scope.unwrap_or_default(),
        workspace_path,
        &window,
        &registry,
        &cron_state,
    )
    .await?;
    let limit = limit.unwrap_or(50);
    Ok(instance.storage.get_runs(&job_id, Some(limit)).await)
}

/// Refresh delivery configs (no-op now — `DeliveryManager` reads config on demand).
#[tauri::command]
pub async fn cron_refresh_delivery() -> Result<(), String> {
    log::info!("[Cron] Delivery config refresh requested (no-op, config is read on demand)");
    Ok(())
}

#[cfg(test)]
mod mcp_create_tests {
    use super::*;

    fn sample_request() -> CreateCronJobRequest {
        CreateCronJobRequest {
            name: "Morning summary".into(),
            description: None,
            enabled: true,
            schedule: CronSchedule {
                kind: ScheduleKind::Cron,
                at: None,
                every_ms: None,
                expr: Some("0 9 * * *".into()),
                tz: None,
            },
            payload: CronPayload {
                message: "hello".into(),
                model: None,
                backend: None,
                timeout_seconds: None,
                permission_mode: None,
            },
            delivery: None,
            delete_after_run: false,
        }
    }

    #[tokio::test]
    async fn mcp_style_create_is_visible_to_list_jobs_on_the_same_instance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let state = CronState::default();
        let instance = state.instance_for(path).await;
        instance.storage.init(path).await;

        let created = create_job_on_instance(&instance, sample_request()).await;
        let listed = state
            .try_instance_for(path)
            .await
            .unwrap()
            .storage
            .list_jobs()
            .await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].name, "Morning summary");
    }

    #[test]
    fn parse_create_request_accepts_mcp_global_body() {
        let body = serde_json::json!({
            "action": "create",
            "scope": "global",
            "name": "Morning summary",
            "enabled": true,
            "schedule": { "kind": "cron", "expr": "0 9 * * *" },
            "payload": { "message": "hello" }
        });
        let request = parse_create_request(&body).unwrap();
        assert_eq!(request.name, "Morning summary");
        assert_eq!(request.payload.message, "hello");
        assert_eq!(request.schedule.expr.as_deref(), Some("0 9 * * *"));
    }
}
