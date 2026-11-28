//! Scheduled jobs, owned by the daemon (ADR-0010).
//!
//! Scheduler, storage, execution and delivery all live here; the desktop keeps
//! only the settings UI and reaches this through `/v1/cron/*` (`http/cron.rs`).
//! A daemon with no desktop attached — a gateway box, a server install — now
//! runs its jobs, which was the point: cron exists to run while nobody is
//! there.
//!
//! Storage is team-scoped (`~/.amuxd/teams/<id>/cron/`, see [`storage`]).
//!
//! The scheduler does not talk to the runtime directly. A turn needs the
//! daemon's main loop (it owns `&self.teamclu`, which is not `Send`), so it
//! goes through [`CronExecutor`], which the daemon implements by sending the
//! same `PromptAwait` / `CronPrepareSession` commands the desktop used to send
//! over the control socket. The turn path itself is unchanged.
//!
//! **Unattended runs are full access.** A cron turn has nobody to answer an
//! approval prompt, so a turn that stops to ask just burns its timeout.
//! [`types::DEFAULT_CRON_PERMISSION_MODE`] is applied here, in the daemon, for
//! every job that does not explicitly opt out — not left to a desktop UI that
//! is not there.

pub mod delivery;
pub mod expr;
pub mod scheduler;
pub mod storage;
pub mod types;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use scheduler::CronScheduler;
use storage::CronStorage;
use types::*;

// ==================== Execution seam ====================

/// One cron turn, as the daemon's `prompt-await` handler takes it. Field names
/// are the control-socket wire names, so the daemon side can forward this as
/// the JSON payload it always parsed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptAwaitRequest {
    pub session_key: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_override: Option<ModelOverride>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    pub permission_mode: String,
    pub timeout_secs: u64,
    pub idle_timeout_secs: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelOverride {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct PromptAwaitResponse {
    pub text: String,
    /// Cloud `sessions.id` the reply was persisted under.
    pub session_id: String,
    /// Set when the session exists but the turn itself failed.
    pub agent_error: Option<String>,
    /// The turn hit its wall-clock or idle budget (partial text may remain).
    pub timed_out: bool,
}

/// Chat a reply token maps to, in the shape announce delivery stores.
#[derive(Debug, Clone)]
pub struct ResolvedCronTarget {
    pub channel: String,
    pub to: String,
}

/// What the scheduler needs from the rest of the daemon to run a job.
#[async_trait::async_trait]
pub trait CronExecutor: Send + Sync {
    /// Create the cloud session for a run up front, before the slow runtime
    /// spawn, so a "Run now" can be navigated to within seconds.
    async fn prepare_session(
        &self,
        session_key: &str,
        job_name: Option<&str>,
    ) -> Result<String, String>;
    /// Drive one turn to completion.
    async fn prompt_await(&self, req: PromptAwaitRequest) -> Result<PromptAwaitResponse, String>;
    /// Push one message through a running channel gateway (wecom, seatalk).
    async fn channel_send(&self, channel: &str, target: &str, message: &str) -> Result<(), String>;
    async fn resolve_reply_token(&self, token: &str) -> Result<ResolvedCronTarget, String>;
}

/// Which models a run may pin. Lives on the HTTP side (it reuses the
/// model-catalog handler), so it is wired separately from the executor.
#[async_trait::async_trait]
pub trait CronModelSource: Send + Sync {
    /// The workspace a global job runs in.
    async fn default_workspace_path(&self) -> Option<String>;
    /// Lowercased `provider/model` refs the workspace's catalog advertises.
    /// Empty when the catalog could not be read.
    async fn model_keys(&self, workspace_path: &str) -> HashSet<String>;
}

/// Late-bound collaborators. The cron service is built before the HTTP
/// listener and the control-socket channel exist; each is attached once it
/// does. Until the executor is attached the scheduler does not fire.
#[derive(Default)]
pub(crate) struct Wiring {
    executor: OnceLock<Arc<dyn CronExecutor>>,
    models: OnceLock<Arc<dyn CronModelSource>>,
}

impl Wiring {
    pub(crate) fn executor(&self) -> Option<Arc<dyn CronExecutor>> {
        self.executor.get().cloned()
    }
    pub(crate) fn models(&self) -> Option<Arc<dyn CronModelSource>> {
        self.models.get().cloned()
    }
}

/// Change counters the desktop polls (`GET /v1/cron/status`) to know when to
/// refresh its job list or run history. Bumped on every change, from any
/// source: the UI, an agent through MCP, or the scheduler itself.
#[derive(Default)]
pub struct Revisions {
    jobs: AtomicU64,
    runs: AtomicU64,
}

impl Revisions {
    pub fn bump_jobs(&self) {
        self.jobs.fetch_add(1, Ordering::SeqCst);
    }
    pub fn bump_runs(&self) {
        self.runs.fetch_add(1, Ordering::SeqCst);
    }
    pub fn jobs(&self) -> u64 {
        self.jobs.load(Ordering::SeqCst)
    }
    pub fn runs(&self) -> u64 {
        self.runs.load(Ordering::SeqCst)
    }
}

// ==================== Service ====================

/// The daemon's cron. Cheap to clone.
#[derive(Clone)]
pub struct CronService {
    storage: CronStorage,
    scheduler: CronScheduler,
    wiring: Arc<Wiring>,
    revisions: Arc<Revisions>,
}

/// Snapshot for `GET /v1/cron/status`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronStatus {
    /// A job is mid-execution in this process.
    pub running: bool,
    pub restart_imminent: bool,
    pub jobs_revision: u64,
    pub runs_revision: u64,
}

impl CronService {
    pub fn new(storage: CronStorage) -> Self {
        let wiring = Arc::new(Wiring::default());
        let revisions = Arc::new(Revisions::default());
        let scheduler = CronScheduler::new(storage.clone(), wiring.clone(), revisions.clone());
        Self {
            storage,
            scheduler,
            wiring,
            revisions,
        }
    }

    pub fn for_active_team() -> Self {
        Self::new(CronStorage::for_active_team())
    }

    pub fn attach_models(&self, models: Arc<dyn CronModelSource>) {
        let _ = self.wiring.models.set(models);
    }

    /// Attach the executor and start the scheduler. Runs left `running` by a
    /// previous process are reconciled first. Calling it again is a no-op.
    pub async fn start(&self, executor: Arc<dyn CronExecutor>) {
        if self.wiring.executor.set(executor).is_err() {
            return;
        }
        self.scheduler.reconcile_interrupted_runs().await;
        self.scheduler.start().await;
    }

    pub fn status(&self) -> CronStatus {
        CronStatus {
            running: self.scheduler.is_running(),
            restart_imminent: self.scheduler.restart_imminent(),
            jobs_revision: self.revisions.jobs(),
            runs_revision: self.revisions.runs(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.scheduler.is_running()
    }

    pub fn set_restart_imminent(&self, imminent: bool) {
        self.scheduler.set_restart_imminent(imminent);
    }

    // ---------- jobs ----------

    /// Jobs of one scope: `None` → global jobs, `Some(path)` → that
    /// workspace's jobs. Matches the two lists the settings page shows.
    pub async fn list_jobs(&self, workspace_path: Option<&str>) -> Vec<CronJob> {
        let want = normalize_workspace(workspace_path);
        self.storage
            .list_jobs()
            .await
            .into_iter()
            .filter(|j| normalize_workspace(j.workspace_path.as_deref()) == want)
            .collect()
    }

    pub async fn get_job(&self, job_id: &str) -> Option<CronJob> {
        self.storage.get_job(job_id).await
    }

    pub async fn create_job(
        &self,
        request: CreateCronJobRequest,
        workspace_path: Option<&str>,
    ) -> Result<CronJob, String> {
        let workspace_path = validate_workspace(workspace_path)?;
        expr::validate_schedule(&request.schedule)?;
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
            workspace_path,
        };
        job.next_run_at = scheduler::compute_next_run(&job, None);
        self.storage.add_job(job.clone()).await;
        self.revisions.bump_jobs();
        tracing::info!(job = %job.id, name = %job.name, "cron: job created");
        Ok(job)
    }

    pub async fn update_job(&self, request: UpdateCronJobRequest) -> Result<CronJob, String> {
        if let Some(schedule) = request.schedule.as_ref() {
            expr::validate_schedule(schedule)?;
        }
        let job = self
            .storage
            .modify_job(&request.id.clone(), move |job| {
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
                    job.next_run_at = scheduler::compute_next_run(job, None);
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
            })
            .await?;
        self.revisions.bump_jobs();
        Ok(job)
    }

    pub async fn remove_job(&self, job_id: &str) -> Result<(), String> {
        self.storage.remove_job(job_id).await?;
        self.revisions.bump_jobs();
        Ok(())
    }

    pub async fn set_enabled(&self, job_id: &str, enabled: bool) -> Result<(), String> {
        self.storage.toggle_enabled(job_id, enabled).await?;
        if enabled {
            // Re-enabling re-anchors the schedule at now, so a job paused past
            // its slot does not fire the instant it is resumed.
            if let Some(job) = self.storage.get_job(job_id).await {
                let next = scheduler::compute_next_run(&job, None);
                self.storage.update_next_run_at(job_id, next).await;
            }
        }
        self.revisions.bump_jobs();
        Ok(())
    }

    /// Fire a job now, in the background.
    pub async fn run_job(&self, job_id: &str) -> Result<(), String> {
        let job = self
            .storage
            .get_job(job_id)
            .await
            .ok_or_else(|| format!("Job not found: {job_id}"))?;
        if self.wiring.executor().is_none() {
            return Err("cron is not started yet; try again in a moment".into());
        }
        tracing::info!(job = %job.id, name = %job.name, "cron: manual run");
        let scheduler = self.scheduler.clone();
        tokio::spawn(async move { scheduler.execute_job(job).await });
        Ok(())
    }

    pub async fn get_runs(&self, job_id: &str, limit: Option<usize>) -> Vec<CronRunRecord> {
        self.storage
            .get_runs(job_id, Some(limit.unwrap_or(50)))
            .await
    }

    /// One-shot import of jobs the desktop used to store itself. Idempotent
    /// by job id. `workspace_path` stamps every imported job (the desktop
    /// files carried no path: it was the storage key). Run history is not
    /// imported; schedules are re-anchored so a job does not fire for every
    /// slot it missed while the desktop was closed.
    pub async fn import_jobs(
        &self,
        jobs: Vec<CronJob>,
        workspace_path: Option<&str>,
    ) -> Result<usize, String> {
        let workspace_path = normalize_workspace(workspace_path).map(str::to_string);
        let now = chrono::Utc::now();
        let jobs = jobs
            .into_iter()
            .map(|mut job| {
                job.workspace_path = workspace_path.clone();
                if job.next_run_at.is_none_or(|t| t < now) {
                    job.next_run_at = scheduler::compute_next_run(&job, Some(now));
                }
                job
            })
            .collect();
        let added = self.storage.import_jobs(jobs).await;
        if added > 0 {
            self.revisions.bump_jobs();
        }
        tracing::info!(added, workspace = ?workspace_path, "cron: imported desktop jobs");
        Ok(added)
    }

    // ---------- MCP ----------

    /// The agent-facing surface (`amuxd cron`, which calls
    /// `/v1/cron/manage`). Same store as the settings page, so
    /// a job an agent creates shows up there.
    pub async fn mcp_manage(&self, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        let action = body
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or("Missing field: action")?;
        let workspace_path = match body.get("scope").and_then(|v| v.as_str()) {
            Some("workspace") => Some(
                body.get("workspace_path")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or("workspace scope requires workspace_path")?
                    .to_string(),
            ),
            _ => None,
        };

        match action {
            "create" => {
                let mut body = body.clone();
                self.fill_delivery_channel_from_token(&mut body).await?;
                let mut request = parse_create_request(&body)?;
                if let Some(delivery) = request.delivery.as_mut() {
                    self.pin_announce_delivery_target(delivery).await?;
                }
                let job = self.create_job(request, workspace_path.as_deref()).await?;
                Ok(serde_json::json!({
                    "action": "created",
                    "job": serde_json::to_value(job).map_err(|e| e.to_string())?,
                }))
            }
            "list" => {
                let jobs = self.list_jobs(workspace_path.as_deref()).await;
                Ok(serde_json::json!({
                    "action": "listed",
                    "jobs": serde_json::to_value(jobs).map_err(|e| e.to_string())?,
                }))
            }
            "pause" | "resume" => {
                let job_id = require_mcp_job_id(body)?;
                let enabled = action == "resume";
                self.set_enabled(job_id, enabled).await?;
                Ok(serde_json::json!({
                    "action": if enabled { "resumed" } else { "paused" },
                    "job_id": job_id,
                }))
            }
            "delete" => {
                let job_id = require_mcp_job_id(body)?;
                self.remove_job(job_id).await?;
                Ok(serde_json::json!({ "action": "deleted", "job_id": job_id }))
            }
            "run" => {
                let job_id = require_mcp_job_id(body)?;
                self.run_job(job_id).await?;
                Ok(serde_json::json!({ "action": "triggered", "job_id": job_id }))
            }
            "get_runs" => {
                let job_id = require_mcp_job_id(body)?;
                let runs = self.storage.get_runs(job_id, Some(10)).await;
                Ok(serde_json::json!({
                    "job_id": job_id,
                    "runs": serde_json::to_value(runs).map_err(|e| e.to_string())?,
                }))
            }
            other => Err(format!("Unknown action: {other}")),
        }
    }

    /// `amuxd cron create --to <reply token>` with no `--channel`: the token
    /// already says which chat, so take the channel from it. A delivery with
    /// neither a channel nor a token is left for the parser to refuse.
    async fn fill_delivery_channel_from_token(
        &self,
        body: &mut serde_json::Value,
    ) -> Result<(), String> {
        let reply_token = body
            .get("reply_token")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let Some(delivery) = body.get_mut("delivery").and_then(|d| d.as_object_mut()) else {
            return Ok(());
        };
        if delivery.get("mode").and_then(|m| m.as_str()) == Some("none") {
            return Ok(());
        }
        let has_channel = delivery
            .get("channel")
            .and_then(|c| c.as_str())
            .is_some_and(|c| !c.trim().is_empty());
        if has_channel {
            return Ok(());
        }
        let to = delivery
            .get("to")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .or(reply_token);
        let Some(token) = to.filter(|t| looks_like_reply_token(t)) else {
            return Err("delivery needs a channel unless `to` is a reply token".to_string());
        };
        let executor = self
            .wiring
            .executor()
            .ok_or("cron is not started yet; try again in a moment")?;
        let resolved = executor
            .resolve_reply_token(&token)
            .await
            .map_err(|e| format!("could not resolve the reply token: {e}"))?;
        delivery.insert("channel".into(), serde_json::json!(resolved.channel));
        delivery.insert("to".into(), serde_json::json!(token));
        Ok(())
    }

    async fn pin_announce_delivery_target(
        &self,
        delivery: &mut CronDelivery,
    ) -> Result<(), String> {
        if delivery.mode != DeliveryMode::Announce {
            return Ok(());
        }
        let to = delivery.to.trim();
        if to.is_empty() {
            return Err(ANNOUNCE_DELIVERY_TO_REQUIRED.to_string());
        }
        if !looks_like_reply_token(to) {
            return Ok(());
        }
        let executor = self
            .wiring
            .executor()
            .ok_or("cron is not started yet; try again in a moment")?;
        let resolved = executor.resolve_reply_token(to).await.map_err(|e| {
            format!(
                "could not pin delivery.to from reply_token: {e}. \
                 Pass wecom single:<userid> or group:<chatid> instead."
            )
        })?;
        if delivery.channel.as_str() != resolved.channel {
            return Err(format!(
                "reply_token is a {} chat (`{}`), but delivery.channel is {}",
                resolved.channel,
                resolved.to,
                delivery.channel.as_str()
            ));
        }
        delivery.to = resolved.to;
        Ok(())
    }
}

fn normalize_workspace(path: Option<&str>) -> Option<&str> {
    path.map(str::trim).filter(|p| !p.is_empty())
}

fn validate_workspace(path: Option<&str>) -> Result<Option<String>, String> {
    match normalize_workspace(path) {
        None => Ok(None),
        Some(p) if std::path::Path::new(p).is_dir() => Ok(Some(p.to_string())),
        Some(p) => Err(format!("Workspace not found: {p}")),
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
    let reply_token = obj
        .remove("reply_token")
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(schedule) = obj.get("schedule").cloned() {
        obj.insert("schedule".into(), unwrap_stringified_schedule(schedule));
    }
    let mut request: CreateCronJobRequest = serde_json::from_value(serde_json::Value::Object(obj))
        .map_err(|e| format!("invalid create request: {e}"))?;
    fill_announce_delivery_to(&mut request, reply_token.as_deref())?;
    Ok(request)
}

fn fill_announce_delivery_to(
    request: &mut CreateCronJobRequest,
    reply_token: Option<&str>,
) -> Result<(), String> {
    let Some(delivery) = request.delivery.as_mut() else {
        return Ok(());
    };
    if delivery.mode != DeliveryMode::Announce {
        return Ok(());
    }
    delivery.to = delivery.to.trim().to_string();
    if delivery.to.is_empty() {
        if let Some(token) = reply_token {
            delivery.to = token.to_string();
        }
    }
    if delivery.to.is_empty() {
        return Err(ANNOUNCE_DELIVERY_TO_REQUIRED.to_string());
    }
    Ok(())
}

/// 32-char hex — the shape `reply_token::token_for_binding` mints.
fn looks_like_reply_token(s: &str) -> bool {
    let s = s.trim();
    s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Recover when a sidecar stuffed a one-time/interval object into `expr`
/// because the model stringified `{kind:"at",...}` as a cron expression.
fn unwrap_stringified_schedule(schedule: serde_json::Value) -> serde_json::Value {
    let Some(obj) = schedule.as_object() else {
        return schedule;
    };
    if obj.get("kind").and_then(|v| v.as_str()) != Some("cron") {
        return schedule;
    }
    let Some(expr) = obj.get("expr").and_then(|v| v.as_str()) else {
        return schedule;
    };
    let expr = expr.trim();
    if !expr.starts_with('{') {
        return schedule;
    }
    let Ok(inner) = serde_json::from_str::<serde_json::Value>(expr) else {
        return schedule;
    };
    match inner.get("kind").and_then(|v| v.as_str()) {
        Some("at" | "every" | "cron") => inner,
        _ => schedule,
    }
}

#[cfg(test)]
mod tests {
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

    fn service() -> (tempfile::TempDir, CronService) {
        let dir = tempfile::tempdir().unwrap();
        let svc = CronService::new(CronStorage::at(dir.path().join("cron")));
        (dir, svc)
    }

    #[tokio::test]
    async fn global_and_workspace_jobs_list_separately() {
        let (dir, svc) = service();
        let ws = dir.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let ws = ws.to_str().unwrap();

        let global = svc.create_job(sample_request(), None).await.unwrap();
        let scoped = svc.create_job(sample_request(), Some(ws)).await.unwrap();

        let g = svc.list_jobs(None).await;
        let w = svc.list_jobs(Some(ws)).await;
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].id, global.id);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].id, scoped.id);
        assert_eq!(w[0].workspace_path.as_deref(), Some(ws));
    }

    #[tokio::test]
    async fn create_rejects_a_missing_workspace() {
        let (_dir, svc) = service();
        let err = svc
            .create_job(sample_request(), Some("/definitely/not/here"))
            .await
            .unwrap_err();
        assert!(err.contains("Workspace not found"));
    }

    #[tokio::test]
    async fn every_change_bumps_the_jobs_revision() {
        let (_dir, svc) = service();
        let r0 = svc.status().jobs_revision;
        let job = svc.create_job(sample_request(), None).await.unwrap();
        svc.set_enabled(&job.id, false).await.unwrap();
        svc.remove_job(&job.id).await.unwrap();
        assert_eq!(svc.status().jobs_revision, r0 + 3);
    }

    #[tokio::test]
    async fn mcp_create_is_visible_to_the_settings_list() {
        let (_dir, svc) = service();
        let body = serde_json::json!({
            "action": "create",
            "scope": "global",
            "name": "Morning summary",
            "enabled": true,
            "schedule": { "kind": "cron", "expr": "0 9 * * *" },
            "payload": { "message": "hello" }
        });
        let out = svc.mcp_manage(&body).await.unwrap();
        assert_eq!(out["action"], "created");
        let listed = svc.list_jobs(None).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Morning summary");
    }

    #[tokio::test]
    async fn import_stamps_workspace_and_reanchors_past_schedules() {
        let (dir, svc) = service();
        let mut job = storage::tests::make_job("old");
        job.next_run_at = Some(chrono::Utc::now() - chrono::Duration::days(3));
        let ws = dir.path().to_str().unwrap();
        assert_eq!(
            svc.import_jobs(vec![job.clone()], Some(ws)).await.unwrap(),
            1
        );
        assert_eq!(svc.import_jobs(vec![job], Some(ws)).await.unwrap(), 0);
        let listed = svc.list_jobs(Some(ws)).await;
        assert_eq!(listed.len(), 1);
        assert!(listed[0].next_run_at.unwrap() > chrono::Utc::now());
    }

    #[test]
    fn parse_create_request_unwraps_stringified_at_schedule_stuffed_in_cron_expr() {
        let body = serde_json::json!({
            "action": "create",
            "name": "One-shot ping",
            "enabled": true,
            "schedule": {
                "kind": "cron",
                "expr": "{\"kind\": \"at\", \"at\": \"2026-09-09T20:10:30+08:00\"}"
            },
            "payload": { "message": "ping" }
        });
        let request = parse_create_request(&body).unwrap();
        assert_eq!(request.schedule.kind, ScheduleKind::At);
        assert!(request.schedule.expr.is_none());
    }

    #[test]
    fn parse_create_request_rejects_announce_with_empty_to() {
        let body = serde_json::json!({
            "action": "create",
            "name": "日报",
            "enabled": true,
            "schedule": { "kind": "cron", "expr": "0 10 * * *" },
            "payload": { "message": "hello" },
            "delivery": { "mode": "announce", "channel": "wecom", "to": "" }
        });
        let err = parse_create_request(&body).unwrap_err();
        assert!(err.contains("delivery.to is required"), "got: {err}");
    }

    #[test]
    fn parse_create_request_fills_empty_to_from_reply_token() {
        let token = "0".repeat(32);
        let body = serde_json::json!({
            "action": "create",
            "name": "日报",
            "enabled": true,
            "schedule": { "kind": "cron", "expr": "0 10 * * *" },
            "payload": { "message": "hello" },
            "reply_token": token,
            "delivery": { "mode": "announce", "channel": "wecom", "to": "  " }
        });
        let request = parse_create_request(&body).unwrap();
        assert_eq!(request.delivery.unwrap().to, token);
    }

    #[test]
    fn looks_like_reply_token_is_32_hex() {
        assert!(looks_like_reply_token(&"ab".repeat(16)));
        assert!(!looks_like_reply_token("single:HuangWeiGan"));
        assert!(!looks_like_reply_token(""));
    }
}
