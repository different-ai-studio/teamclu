use chrono::{DateTime, Local, Utc};
use chrono_tz::Tz;
use cron::Schedule as CronScheduleParser;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use super::delivery::DeliveryManager;
use super::storage::CronStorage;
use super::types::*;

const CRON_RUN_HEARTBEAT_INTERVAL_SECS: u64 = 30;
const STALE_RUN_ERROR: &str =
    "Cron run was interrupted before completion; open the session to inspect the latest state.";

/// The cron scheduler that runs as a background task
#[derive(Debug)]
pub struct CronScheduler {
    storage: CronStorage,
    delivery: Arc<RwLock<Option<DeliveryManager>>>,
    /// Generation counter: incremented on each start/stop to uniquely identify
    /// scheduler instances. Prevents old tick loops from continuing after restart.
    generation: Arc<RwLock<u64>>,
    /// Set from `cron_init` so run-record updates can refresh the UI session filter.
    app_handle: Arc<std::sync::Mutex<Option<AppHandle>>>,
    /// Project cwd for workspace-scoped jobs. `None` for global scope — amuxd uses daemon default.
    execution_workspace: Arc<RwLock<Option<String>>>,
}

impl Clone for CronScheduler {
    fn clone(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            delivery: Arc::clone(&self.delivery),
            generation: Arc::clone(&self.generation),
            app_handle: Arc::clone(&self.app_handle),
            execution_workspace: Arc::clone(&self.execution_workspace),
        }
    }
}

impl CronScheduler {
    pub fn new(storage: CronStorage) -> Self {
        Self {
            storage,
            delivery: Arc::new(RwLock::new(None)),
            generation: Arc::new(RwLock::new(0)),
            app_handle: Arc::new(std::sync::Mutex::new(None)),
            execution_workspace: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_execution_workspace(&self, path: Option<String>) {
        *self.execution_workspace.write().await = path;
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        if let Ok(mut g) = self.app_handle.lock() {
            *g = Some(app);
        }
    }

    fn emit_cron_sessions_updated(&self) {
        let app = self.app_handle.lock().ok().and_then(|g| g.clone());
        if let Some(app) = app {
            let _ = app.emit("cron:cron-sessions-updated", ());
        }
    }

    async fn persist_run_and_notify_ui(&self, record: &CronRunRecord) {
        self.storage.update_last_run(record).await;
        self.emit_cron_sessions_updated();
    }

    fn truncate_response_summary(response: &str) -> String {
        if response.chars().count() > 500 {
            let truncated: String = response.chars().take(497).collect();
            format!("{}...", truncated)
        } else {
            response.to_string()
        }
    }

    pub(crate) fn reconcile_interrupted_run(
        mut record: CronRunRecord,
        assistant_text: Option<String>,
        finished_at: DateTime<Utc>,
    ) -> CronRunRecord {
        if record.has_legacy_timeout_cut_short_text() {
            record.status = RunStatus::Timeout;
            record.finished_at = Some(finished_at);
            return record;
        }

        if let Some(text) = assistant_text {
            record.status = RunStatus::Success;
            record.response_summary = Some(Self::truncate_response_summary(&text));
            record.finished_at = Some(finished_at);
            return record;
        }

        record.status = RunStatus::Stale;
        record.finished_at = Some(finished_at);
        record.error = Some(STALE_RUN_ERROR.to_string());
        record
    }

    /// Reconcile runs left in `running` by a previous app/executor process.
    ///
    /// After the amuxd migration we no longer probe a remote session for a
    /// possible AgentReply text — recovery would need a new amuxd
    /// `get-session-result` cmd, which is deferred per spec §4. So every
    /// interrupted run is marked Stale (or Timeout if the legacy
    /// "response was cut short" marker is present).
    pub async fn reconcile_interrupted_runs(&self) {
        let running = self.storage.get_latest_running_runs().await;
        if running.is_empty() {
            return;
        }

        println!(
            "[Cron] Reconciling {} interrupted run(s) from previous executor (marking Stale)",
            running.len()
        );

        for record in running {
            let reconciled = Self::reconcile_interrupted_run(record, None, Utc::now());
            self.persist_run_and_notify_ui(&reconciled).await;
        }
    }

    /// Set the delivery manager
    pub async fn set_delivery(&self, delivery: DeliveryManager) {
        let mut d = self.delivery.write().await;
        *d = Some(delivery);
    }

    /// Start the scheduler background loop
    /// Start the scheduler loop with a new generation ID.
    /// Each start increments the generation counter, so old loops exit when they
    /// detect their generation is outdated (prevents duplicate schedulers).
    pub async fn start(&self) {
        let mut gen = self.generation.write().await;
        *gen += 1;
        let current_gen = *gen;
        drop(gen);

        println!(
            "[Cron] Scheduler started (gen: {}, tick every 15 seconds)",
            current_gen
        );

        let scheduler = self.clone();
        tokio::spawn(async move {
            loop {
                // Check if this loop's generation is still current
                let active_gen = *scheduler.generation.read().await;
                if active_gen != current_gen {
                    println!(
                        "[Cron] Scheduler gen {} stopped (current: {})",
                        current_gen, active_gen
                    );
                    break;
                }

                // Check if storage is initialized
                if scheduler.storage.is_initialized().await {
                    scheduler.tick().await;
                }

                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
        });
    }

    /// Stop the scheduler by incrementing the generation counter.
    /// The old tick loop will exit on its next iteration when it detects
    /// its generation ID no longer matches.
    pub async fn stop(&self) {
        let mut gen = self.generation.write().await;
        *gen += 1;
        println!("[Cron] Scheduler stop requested (new gen: {})", *gen);
    }

    /// One tick of the scheduler - check all jobs and fire due ones
    async fn tick(&self) {
        let jobs = self.storage.list_jobs().await;
        let now = Utc::now();

        for job in jobs {
            if !job.enabled {
                continue;
            }

            // Check if job is due
            let is_due = match &job.next_run_at {
                Some(next) => now >= *next,
                None => {
                    // Compute next_run_at if missing
                    if let Some(next) = self.compute_next_run(&job, None) {
                        self.storage.update_next_run_at(&job.id, Some(next)).await;
                        false
                    } else {
                        false
                    }
                }
            };

            if is_due {
                println!(
                    "[Cron] Job '{}' ({}) is due, executing...",
                    job.name, job.id
                );

                // IMPORTANT: Update next_run_at IMMEDIATELY before spawning,
                // so subsequent ticks don't re-fire the same job while it's running.
                let next_run = self.compute_next_run(&job, Some(now));
                self.storage
                    .update_run_timestamps(&job.id, now, next_run)
                    .await;

                let scheduler = self.clone();
                let job_clone = job.clone();
                tokio::spawn(async move {
                    scheduler.execute_job(job_clone).await;
                });
            }
        }
    }

    fn working_directory_for_run(execution_workspace: Option<&str>) -> Option<String> {
        execution_workspace
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    }

    /// Execute a single cron job
    pub async fn execute_job(&self, job: CronJob) {
        let run_id = uuid::Uuid::new_v4().to_string();
        let started_at = Utc::now();

        // Capture current generation and workspace to detect if scheduler was
        // restarted during execution (e.g., workspace switched). If so, abort.
        let my_generation = *self.generation.read().await;
        let my_workspace = self.storage.get_workspace_path().await.unwrap_or_default();
        let execution_workspace = self.execution_workspace.read().await.clone();

        // Create initial run record
        let mut record = CronRunRecord {
            run_id: run_id.clone(),
            job_id: job.id.clone(),
            started_at,
            finished_at: None,
            status: RunStatus::Running,
            last_heartbeat_at: Some(started_at),
            session_id: None,
            response_summary: None,
            delivery_status: None,
            error: None,
        };
        self.storage.append_run(&record).await;

        // Helper macro: abort if scheduler was restarted (workspace switched)
        macro_rules! check_generation {
            () => {
                let active_gen = *self.generation.read().await;
                if active_gen != my_generation {
                    println!(
                        "[Cron] Job '{}' aborted: scheduler restarted (gen {} -> {})",
                        job.name, my_generation, active_gen
                    );
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some("Aborted due to workspace change".to_string());
                    self.storage.append_run(&record).await;
                    return;
                }
            };
        }

        // Check before starting work
        check_generation!();

        // ── New cron-to-amuxd execution flow ─────────────────────────────
        // (Replaces the OpenCode HTTP path.)

        let session_key = format!("cron/{}/{}", job.id, run_id);
        let working_directory = Self::working_directory_for_run(execution_workspace.as_deref());
        let workspace_root = execution_workspace.as_deref();

        // Eagerly create the cloud session and stamp its id into the run record
        // now — before the (cold-starting) ACP runtime spawn inside prompt-await
        // — so the desktop UI can navigate to the session within a couple of
        // seconds of "Run Now" instead of waiting out the whole turn. Best
        // effort: if it fails, prompt-await still creates the session later and
        // stamps it then; we just lose the early navigation for this run.
        match crate::commands::cron::amuxd_client::prepare_cron_session(
            &session_key,
            Some(&job.name),
        )
        .await
        {
            Ok(session_id) => {
                record.session_id = Some(session_id);
                self.persist_run_and_notify_ui(&record).await;
            }
            Err(e) => {
                tracing::warn!(
                    session_key = %session_key,
                    "cron: eager session prepare failed ({e}); will stamp after turn"
                );
            }
        }

        // Honor `payload.model` only when that pair still exists in the workspace
        // config for this run (workspace-scoped path, or daemon default for global).
        let model_workspace_path = match working_directory.clone() {
            Some(path) => Some(path),
            None => super::workspace_models::default_daemon_workspace_path().await,
        };
        let available_models = match model_workspace_path.as_deref() {
            Some(path) => super::workspace_models::list_workspace_model_keys(path).await,
            None => std::collections::HashSet::new(),
        };
        let model_param = super::workspace_models::resolve_cron_model_override(
            &available_models,
            model_workspace_path.as_deref(),
            job.payload.model.as_deref(),
        );

        // Pin the backend the job was created for. Empty/absent → omit so the
        // daemon falls back to its default_agent_type ("auto" selection).
        let agent_type = job
            .payload
            .backend
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        // Unattended runs default to full access — see `CronPayload::permission_mode`.
        let permission_mode = job
            .payload
            .permission_mode
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(crate::commands::cron::types::DEFAULT_CRON_PERMISSION_MODE);

        let prompt_future = crate::commands::cron::amuxd_client::prompt_await(
            crate::commands::cron::amuxd_client::PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: &session_key,
                message: &job.payload.message,
                job_name: Some(&job.name),
                working_directory: working_directory.as_deref().map(str::as_ref),
                workspace_root,
                model_override: model_param.as_ref().map(|(p, m)| {
                    crate::commands::cron::amuxd_client::ModelOverride {
                        provider: p,
                        model: m,
                    }
                }),
                agent_type,
                permission_mode,
                timeout_secs: 300,
            },
        );

        // Heartbeat continues while we await the amuxd response.
        tokio::pin!(prompt_future);
        let heartbeat_every = std::time::Duration::from_secs(CRON_RUN_HEARTBEAT_INTERVAL_SECS);
        let mut heartbeat_interval = tokio::time::interval_at(
            tokio::time::Instant::now() + heartbeat_every,
            heartbeat_every,
        );

        let inner_result = loop {
            tokio::select! {
                result = &mut prompt_future => break result,
                _ = heartbeat_interval.tick() => {
                    record.last_heartbeat_at = Some(Utc::now());
                    self.persist_run_and_notify_ui(&record).await;
                }
            }
        };

        // Outer client-side timeout (330s = amuxd cap 300 + 30s slack)
        let response_text =
            match tokio::time::timeout(std::time::Duration::from_secs(330), async { inner_result })
                .await
            {
                Ok(Ok(r)) => {
                    // Always stamp session_id first — even if the turn itself
                    // failed the cloud session was already created, so the UI
                    // "view session" button can navigate to the partial chat.
                    record.session_id = Some(r.session_id.clone());
                    self.persist_run_and_notify_ui(&record).await;

                    if let Some(agent_err) = r.agent_error {
                        // Session created but ACP turn failed (e.g. timeout).
                        // agent_err already carries any "agent error: " prefix from
                        // the daemon's AmuxError::Agent formatter — don't double it.
                        record.status = RunStatus::Failed;
                        record.finished_at = Some(Utc::now());
                        record.error = Some(agent_err);
                        self.persist_run_and_notify_ui(&record).await;
                        self.update_job_after_run(&job, started_at, &my_workspace)
                            .await;
                        return;
                    }
                    r.text
                }
                Ok(Err(e)) => {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some(e);
                    self.persist_run_and_notify_ui(&record).await;
                    self.update_job_after_run(&job, started_at, &my_workspace)
                        .await;
                    return;
                }
                Err(_) => {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(Utc::now());
                    record.error = Some("amuxd response exceeded 330s".into());
                    self.persist_run_and_notify_ui(&record).await;
                    self.update_job_after_run(&job, started_at, &my_workspace)
                        .await;
                    return;
                }
            };

        record.response_summary = Some(Self::truncate_response_summary(&response_text));

        // Check before delivery (workspace may have changed)
        check_generation!();

        // Step 3: Deliver results if configured
        let mut delivery_failed = false;
        if let Some(delivery) = &job.delivery {
            if delivery.mode == DeliveryMode::Announce {
                let delivery_mgr = self.delivery.read().await;
                if let Some(mgr) = delivery_mgr.as_ref() {
                    // Format the delivery message with job context
                    let delivery_message = format!("[Cron: {}]\n\n{}", job.name, response_text);

                    match mgr
                        .send_notification(&delivery.channel, &delivery.to, &delivery_message)
                        .await
                    {
                        Ok(()) => {
                            record.delivery_status = Some("delivered".to_string());
                            println!(
                                "[Cron] Delivered results for job '{}' via {:?}",
                                job.name, delivery.channel
                            );
                        }
                        Err(e) => {
                            let err_msg = format!("Delivery failed: {}", e);
                            println!("[Cron] {}", err_msg);
                            record.delivery_status = Some(err_msg.clone());
                            delivery_failed = true;
                            if !delivery.best_effort {
                                record.status = RunStatus::Failed;
                                record.finished_at = Some(Utc::now());
                                record.error = Some(err_msg);
                                self.persist_run_and_notify_ui(&record).await;
                                self.update_job_after_run(&job, started_at, &my_workspace)
                                    .await;
                                return;
                            }
                        }
                    }
                } else {
                    record.delivery_status =
                        Some("skipped (delivery manager not available)".to_string());
                    delivery_failed = true;
                }
            }
        }

        // Mark as success
        record.status = RunStatus::Success;
        record.finished_at = Some(Utc::now());
        self.persist_run_and_notify_ui(&record).await;

        // Check before updating job state (workspace may have changed)
        check_generation!();

        // Update job timestamps
        self.update_job_after_run(&job, started_at, &my_workspace)
            .await;

        // Handle delete_after_run for one-time jobs
        // Do NOT delete if delivery failed — user should see the result and retry
        if job.delete_after_run && job.schedule.kind == ScheduleKind::At && !delivery_failed {
            println!(
                "[Cron] Deleting one-time job '{}' after fully successful run",
                job.name
            );
            let _ = self.storage.remove_job(&job.id).await;
        } else if delivery_failed && job.delete_after_run {
            println!(
                "[Cron] Keeping one-time job '{}' because delivery failed (can retry)",
                job.name
            );
        }

        println!("[Cron] Job '{}' completed successfully", job.name);
    }

    /// Update job timestamps after a run.
    /// Note: `next_run_at` is already set by `tick()` before spawning the execution,
    /// so here we only update `last_run_at` to reflect the actual execution time.
    async fn update_job_after_run(
        &self,
        job: &CronJob,
        last_run: DateTime<Utc>,
        expected_workspace: &str,
    ) {
        // Verify we're still in the same workspace before updating
        let current_workspace = self.storage.get_workspace_path().await;
        if current_workspace.as_deref() != Some(expected_workspace) {
            println!(
                "[Cron] Skip update_job_after_run for job '{}': workspace changed (expected '{}', now '{:?}')",
                job.name, expected_workspace, current_workspace
            );
            return;
        }

        // Only update last_run_at; don't overwrite next_run_at which was already set by tick()
        {
            let mut data = self.storage.data_mut().await;
            if let Some(j) = data.jobs.iter_mut().find(|j| j.id == job.id) {
                j.last_run_at = Some(last_run);
                j.updated_at = Utc::now();
            }
        }
        self.storage.persist().await;
    }

    /// Compute the next run time for a job
    pub fn compute_next_run(
        &self,
        job: &CronJob,
        after: Option<DateTime<Utc>>,
    ) -> Option<DateTime<Utc>> {
        let after = after.unwrap_or_else(Utc::now);

        match job.schedule.kind {
            ScheduleKind::At => {
                // One-time: parse the ISO 8601 timestamp
                if let Some(at_str) = &job.schedule.at {
                    if let Ok(at) = DateTime::parse_from_rfc3339(at_str) {
                        let at_utc = at.with_timezone(&Utc);
                        if at_utc > after {
                            return Some(at_utc);
                        }
                    }
                }
                None // Already past or invalid
            }
            ScheduleKind::Every => {
                // Interval: add every_ms to the last run (or now if first run)
                job.schedule
                    .every_ms
                    .map(|ms| after + chrono::Duration::milliseconds(ms as i64))
            }
            ScheduleKind::Cron => {
                // Cron expression: find the next occurrence.
                // The `cron` crate interprets fields in the timezone of the `DateTime` passed to
                // `after()` (see `schedule.rs` next_after). Using UTC made `30 18 * * *` mean
                // 18:30 UTC, not local wall time — fix by defaulting to system local time (Unix
                // crontab semantics). Optional `schedule.tz` is an IANA override (e.g. Asia/Shanghai).
                if let Some(expr) = &job.schedule.expr {
                    // The `cron` crate expects 7-field format (sec min hour dayofmonth month dayofweek year)
                    // Convert 5-field to 7-field by adding seconds(0) and year(*)
                    let full_expr = format!("0 {} *", expr);
                    match CronScheduleParser::from_str(&full_expr) {
                        Ok(schedule) => {
                            let tz_opt = job
                                .schedule
                                .tz
                                .as_ref()
                                .map(|s| s.trim())
                                .filter(|s| !s.is_empty())
                                .and_then(|s| match Tz::from_str(s) {
                                    Ok(tz) => Some(tz),
                                    Err(_) => {
                                        eprintln!(
                                            "[Cron] Unknown IANA timezone '{}', using system local",
                                            s
                                        );
                                        None
                                    }
                                });

                            match tz_opt {
                                Some(tz) => {
                                    let after_tz = after.with_timezone(&tz);
                                    schedule
                                        .after(&after_tz)
                                        .next()
                                        .map(|dt| dt.with_timezone(&Utc))
                                }
                                None => {
                                    let after_local = after.with_timezone(&Local);
                                    schedule
                                        .after(&after_local)
                                        .next()
                                        .map(|dt| dt.with_timezone(&Utc))
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[Cron] Invalid cron expression '{}': {}", expr, e);
                            None
                        }
                    }
                } else {
                    None
                }
            }
        }
    }
}

// ==================== Unit Tests ====================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Timelike};

    // ── helpers ──────────────────────────────────────────────────────────────

    fn make_scheduler() -> CronScheduler {
        CronScheduler::new(CronStorage::new())
    }

    fn make_job(schedule: CronSchedule) -> CronJob {
        let now = Utc::now();
        CronJob {
            id: "test-id".to_string(),
            name: "Test Job".to_string(),
            description: None,
            enabled: true,
            schedule,
            payload: CronPayload {
                message: "test".to_string(),
                model: None,
                backend: None,
                timeout_seconds: None,
                permission_mode: None,
            },
            delivery: None,
            delete_after_run: false,
            created_at: now,
            updated_at: now,
            last_run_at: None,
            next_run_at: None,
        }
    }

    fn make_run_record(status: RunStatus, summary: Option<&str>) -> CronRunRecord {
        let now = Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap();
        CronRunRecord {
            run_id: "run-1".to_string(),
            job_id: "job-1".to_string(),
            started_at: now,
            finished_at: None,
            status,
            session_id: Some("session-1".to_string()),
            response_summary: summary.map(str::to_string),
            delivery_status: None,
            error: None,
            last_heartbeat_at: None,
        }
    }

    #[test]
    fn cron_run_uses_the_workspace_directory() {
        let workspace = "/tmp/teamclu-workspace";

        assert_eq!(
            CronScheduler::working_directory_for_run(Some(workspace)).as_deref(),
            Some(workspace)
        );
    }

    #[test]
    fn global_cron_run_leaves_directory_to_daemon_default() {
        assert_eq!(CronScheduler::working_directory_for_run(None), None);
    }

    // ── run reconciliation ──────────────────────────────────────────────────

    #[test]
    fn old_success_with_timeout_cut_short_summary_normalizes_to_timeout() {
        let mut record = make_run_record(
            RunStatus::Success,
            Some("partial output\n\n---\n⚠️ AI response was cut short after 180s timeout."),
        );

        normalize_legacy_timeout_status(&mut record);

        assert_eq!(record.status, RunStatus::Timeout);
    }

    #[test]
    fn interrupted_running_run_with_timeout_cut_short_text_reconciles_to_timeout() {
        let now = Utc.with_ymd_and_hms(2024, 6, 1, 12, 3, 0).unwrap();
        let record = make_run_record(
            RunStatus::Running,
            Some("partial output\n\n---\n⚠️ AI response was cut short after 180s timeout."),
        );

        let reconciled = CronScheduler::reconcile_interrupted_run(record, None, now);

        assert_eq!(reconciled.status, RunStatus::Timeout);
        assert_eq!(reconciled.finished_at, Some(now));
        assert_eq!(reconciled.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn interrupted_running_run_with_assistant_text_reconciles_to_success() {
        let now = Utc.with_ymd_and_hms(2024, 6, 1, 12, 3, 0).unwrap();
        let record = make_run_record(RunStatus::Running, None);

        let reconciled =
            CronScheduler::reconcile_interrupted_run(record, Some("complete result".into()), now);

        assert_eq!(reconciled.status, RunStatus::Success);
        assert_eq!(
            reconciled.response_summary.as_deref(),
            Some("complete result")
        );
        assert_eq!(reconciled.finished_at, Some(now));
    }

    #[test]
    fn interrupted_running_run_without_confirmation_reconciles_to_stale() {
        let now = Utc.with_ymd_and_hms(2024, 6, 1, 12, 3, 0).unwrap();
        let record = make_run_record(RunStatus::Running, None);

        let reconciled = CronScheduler::reconcile_interrupted_run(record, None, now);

        assert_eq!(reconciled.status, RunStatus::Stale);
        assert_eq!(reconciled.finished_at, Some(now));
        assert_eq!(reconciled.session_id.as_deref(), Some("session-1"));
        assert!(reconciled.error.unwrap().contains("interrupted"));
    }

    #[test]
    fn legacy_payload_timeout_seconds_still_deserializes_for_compatibility() {
        let payload: CronPayload = serde_json::from_str(
            r#"{"message":"hello","timeoutSeconds":30,"model":"openai/gpt-4.1"}"#,
        )
        .unwrap();

        assert_eq!(payload.message, "hello");
        assert_eq!(payload.timeout_seconds, Some(30));
    }

    #[test]
    fn reconcile_without_assistant_text_marks_stale() {
        let record = CronRunRecord {
            run_id: "r1".into(),
            job_id: "j1".into(),
            started_at: Utc.with_ymd_and_hms(2026, 5, 17, 0, 0, 0).unwrap(),
            finished_at: None,
            status: RunStatus::Running,
            last_heartbeat_at: Some(Utc.with_ymd_and_hms(2026, 5, 17, 0, 0, 30).unwrap()),
            session_id: Some("sid-1".into()),
            response_summary: None,
            delivery_status: None,
            error: None,
        };
        let now = Utc.with_ymd_and_hms(2026, 5, 17, 0, 5, 0).unwrap();
        let out = CronScheduler::reconcile_interrupted_run(record, None, now);
        assert_eq!(out.status, RunStatus::Stale);
        assert_eq!(out.finished_at, Some(now));
        assert!(
            out.error.is_some(),
            "stale runs should carry an error message"
        );
    }

    // ── compute_next_run: At ─────────────────────────────────────────────────

    #[test]
    fn at_future_returns_that_timestamp() {
        let scheduler = make_scheduler();
        let future = Utc::now() + Duration::hours(1);
        let job = make_job(CronSchedule {
            kind: ScheduleKind::At,
            at: Some(future.to_rfc3339()),
            every_ms: None,
            expr: None,
            tz: None,
        });
        let result = scheduler.compute_next_run(&job, None);
        // Allow up to 1 second of rounding drift from to_rfc3339/parse
        let diff = (result.unwrap() - future).num_seconds().abs();
        assert!(
            diff <= 1,
            "Expected timestamp close to future, got diff={}",
            diff
        );
    }

    #[test]
    fn at_past_returns_none() {
        let scheduler = make_scheduler();
        let past = Utc::now() - Duration::hours(1);
        let job = make_job(CronSchedule {
            kind: ScheduleKind::At,
            at: Some(past.to_rfc3339()),
            every_ms: None,
            expr: None,
            tz: None,
        });
        assert!(scheduler.compute_next_run(&job, None).is_none());
    }

    #[test]
    fn at_missing_field_returns_none() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::At,
            at: None,
            every_ms: None,
            expr: None,
            tz: None,
        });
        assert!(scheduler.compute_next_run(&job, None).is_none());
    }

    #[test]
    fn at_invalid_timestamp_returns_none() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::At,
            at: Some("not-a-date".to_string()),
            every_ms: None,
            expr: None,
            tz: None,
        });
        assert!(scheduler.compute_next_run(&job, None).is_none());
    }

    // ── compute_next_run: Every ──────────────────────────────────────────────

    #[test]
    fn every_adds_interval_to_after() {
        let scheduler = make_scheduler();
        let interval_ms: u64 = 30_000;
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Every,
            at: None,
            every_ms: Some(interval_ms),
            expr: None,
            tz: None,
        });
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap();
        let result = scheduler.compute_next_run(&job, Some(anchor)).unwrap();
        let expected = anchor + Duration::milliseconds(interval_ms as i64);
        assert_eq!(result, expected);
    }

    #[test]
    fn every_missing_interval_returns_none() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Every,
            at: None,
            every_ms: None,
            expr: None,
            tz: None,
        });
        assert!(scheduler.compute_next_run(&job, None).is_none());
    }

    // ── compute_next_run: Cron ───────────────────────────────────────────────

    #[test]
    fn cron_daily_at_9am_returns_next_occurrence() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: Some("0 9 * * *".to_string()),
            tz: Some("UTC".to_string()),
        });
        // Anchor: 2024-06-01 08:00 UTC — next 09:00 should be the same day
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 8, 0, 0).unwrap();
        let result = scheduler.compute_next_run(&job, Some(anchor)).unwrap();
        assert_eq!(result.hour(), 9);
        assert_eq!(result.minute(), 0);
        assert_eq!(result.second(), 0);
        // Must be in the future relative to anchor
        assert!(result > anchor);
    }

    #[test]
    fn cron_every_5_minutes_is_within_5_minutes() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: Some("*/5 * * * *".to_string()),
            tz: Some("UTC".to_string()),
        });
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 12, 1, 0).unwrap();
        let result = scheduler.compute_next_run(&job, Some(anchor)).unwrap();
        let diff_secs = (result - anchor).num_seconds();
        assert!(
            diff_secs > 0 && diff_secs <= 300,
            "Expected ≤5 min gap, got {}s",
            diff_secs
        );
    }

    #[test]
    fn cron_weekday_expression_fires_on_correct_days() {
        let scheduler = make_scheduler();
        // The `cron` crate uses Quartz notation: 1=Sun, 2=Mon, ..., 6=Fri, 7=Sat.
        // "0 10 * * 2-6" — 10:00 on Mon-Fri.
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: Some("0 10 * * 2-6".to_string()),
            tz: Some("UTC".to_string()),
        });
        // Anchor: 2024-06-02 (Sunday) 11:00 UTC
        let anchor = Utc.with_ymd_and_hms(2024, 6, 2, 11, 0, 0).unwrap();
        let result = scheduler.compute_next_run(&job, Some(anchor)).unwrap();
        // Next Mon-Fri fire should be Monday 2024-06-03 10:00 UTC
        let expected = Utc.with_ymd_and_hms(2024, 6, 3, 10, 0, 0).unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn cron_invalid_expression_returns_none() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: Some("not a cron expr".to_string()),
            tz: None,
        });
        assert!(scheduler.compute_next_run(&job, None).is_none());
    }

    #[test]
    fn cron_missing_expr_returns_none() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: None,
            tz: None,
        });
        assert!(scheduler.compute_next_run(&job, None).is_none());
    }

    #[test]
    fn cron_with_named_timezone_returns_correct_utc_time() {
        let scheduler = make_scheduler();
        // "0 9 * * *" in Asia/Shanghai (UTC+8) should next fire at 01:00 UTC
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: Some("0 9 * * *".to_string()),
            tz: Some("Asia/Shanghai".to_string()),
        });
        // Anchor: 2024-06-01 00:30 UTC (08:30 Shanghai — before 09:00)
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 0, 30, 0).unwrap();
        let result = scheduler.compute_next_run(&job, Some(anchor)).unwrap();
        // 09:00 Shanghai = 01:00 UTC
        assert_eq!(result.hour(), 1);
        assert_eq!(result.minute(), 0);
    }

    #[test]
    fn cron_unknown_timezone_falls_back_without_panic() {
        let scheduler = make_scheduler();
        let job = make_job(CronSchedule {
            kind: ScheduleKind::Cron,
            at: None,
            every_ms: None,
            expr: Some("0 9 * * *".to_string()),
            tz: Some("Not/AReal_Zone".to_string()),
        });
        // Should not panic; falls back to system local — just assert it returns Some
        let result = scheduler.compute_next_run(&job, None);
        assert!(
            result.is_some(),
            "Expected a fallback next-run time for unknown timezone"
        );
    }
}
