//! The tick loop and one job's execution, ported from the desktop
//! (`apps/desktop/src/commands/cron/scheduler.rs`, removed with ADR-0010).
//!
//! Differences from the desktop version:
//! - one scheduler for the whole team, not one per workspace — a job's
//!   workspace is `job.workspace_path`;
//! - the turn goes through [`CronExecutor`] (the daemon's own prompt-await
//!   path) instead of the control socket;
//! - UI refresh is a revision bump the desktop polls, not a Tauri event.

use chrono::{DateTime, Local, Utc};
use chrono_tz::Tz;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use super::delivery::DeliveryManager;
use super::storage::CronStorage;
use super::types::*;
use super::{ModelOverride, PromptAwaitRequest, Revisions, Wiring};

const TICK_INTERVAL_SECS: u64 = 15;
const CRON_RUN_HEARTBEAT_INTERVAL_SECS: u64 = 30;
const STALE_RUN_ERROR: &str =
    "Cron run was interrupted before completion; open the session to inspect the latest state.";

/// Cheap to clone; every clone shares state.
#[derive(Clone)]
pub struct CronScheduler {
    storage: CronStorage,
    wiring: Arc<Wiring>,
    revisions: Arc<Revisions>,
    /// Bumped by each `start`; an older tick loop sees the change and exits.
    generation: Arc<AtomicU64>,
    /// Jobs mid-`execute_job` in this process. Deliberately not derived from
    /// persisted `Running` records, which a crash can orphan.
    running_count: Arc<AtomicUsize>,
    /// Set ahead of a planned restart so no new run starts in the last
    /// seconds. Cooperative: a run already in flight is not aborted.
    restart_imminent: Arc<AtomicBool>,
}

/// Increments on creation, decrements on drop — every exit path of
/// `execute_job`, a panic included, decrements exactly once.
struct RunningGuard(Arc<AtomicUsize>);

impl RunningGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl CronScheduler {
    pub(crate) fn new(
        storage: CronStorage,
        wiring: Arc<Wiring>,
        revisions: Arc<Revisions>,
    ) -> Self {
        Self {
            storage,
            wiring,
            revisions,
            generation: Arc::new(AtomicU64::new(0)),
            running_count: Arc::new(AtomicUsize::new(0)),
            restart_imminent: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running_count.load(Ordering::SeqCst) > 0
    }

    pub fn restart_imminent(&self) -> bool {
        self.restart_imminent.load(Ordering::SeqCst)
    }

    pub fn set_restart_imminent(&self, imminent: bool) {
        self.restart_imminent.store(imminent, Ordering::SeqCst);
    }

    async fn persist_run(&self, record: &CronRunRecord) {
        self.storage.update_last_run(record).await;
        self.revisions.bump_runs();
    }

    fn truncate_response_summary(response: &str) -> String {
        if response.chars().count() > 500 {
            let truncated: String = response.chars().take(497).collect();
            format!("{truncated}...")
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

    /// Mark runs a previous process left `running` as stale (or timeout when
    /// the legacy cut-short marker is present).
    pub async fn reconcile_interrupted_runs(&self) {
        let running = self.storage.get_latest_running_runs().await;
        if running.is_empty() {
            return;
        }
        tracing::info!(
            count = running.len(),
            "cron: reconciling interrupted runs as stale"
        );
        for record in running {
            let reconciled = Self::reconcile_interrupted_run(record, None, Utc::now());
            self.persist_run(&reconciled).await;
        }
    }

    /// Start the tick loop. A second call replaces the first loop.
    pub async fn start(&self) {
        let my_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        tracing::info!(
            generation = my_gen,
            "cron: scheduler started (tick every {TICK_INTERVAL_SECS}s)"
        );
        let scheduler = self.clone();
        tokio::spawn(async move {
            loop {
                if scheduler.generation.load(Ordering::SeqCst) != my_gen {
                    break;
                }
                scheduler.tick().await;
                tokio::time::sleep(std::time::Duration::from_secs(TICK_INTERVAL_SECS)).await;
            }
        });
    }

    /// One tick: fire every enabled job that is due.
    async fn tick(&self) {
        let now = Utc::now();
        for job in self.storage.list_jobs().await {
            if !job.enabled {
                continue;
            }
            let Some(next) = job.next_run_at else {
                if let Some(next) = compute_next_run(&job, None) {
                    self.storage.update_next_run_at(&job.id, Some(next)).await;
                }
                continue;
            };
            if now < next {
                continue;
            }
            if self.restart_imminent() {
                // Leave next_run_at alone so the job fires after the restart.
                continue;
            }
            tracing::info!(job = %job.id, name = %job.name, "cron: job is due");
            // Advance next_run_at before spawning, so the next tick does not
            // fire the same slot again while this run is still going.
            let next_run = compute_next_run(&job, Some(now));
            self.storage
                .update_run_timestamps(&job.id, now, next_run)
                .await;
            self.revisions.bump_jobs();
            let scheduler = self.clone();
            tokio::spawn(async move { scheduler.execute_job(job).await });
        }
    }

    async fn finish(&self, job: &CronJob, record: &CronRunRecord, started_at: DateTime<Utc>) {
        self.persist_run(record).await;
        self.storage.update_last_run_at(&job.id, started_at).await;
        self.revisions.bump_jobs();
    }

    /// Execute one job to completion: session, turn, delivery, bookkeeping.
    pub async fn execute_job(&self, job: CronJob) {
        if self.restart_imminent() {
            tracing::info!(name = %job.name, "cron: job skipped, restart imminent");
            return;
        }
        let Some(executor) = self.wiring.executor() else {
            tracing::warn!(name = %job.name, "cron: job skipped, executor not attached");
            return;
        };
        let _running_guard = RunningGuard::new(Arc::clone(&self.running_count));

        let run_id = uuid::Uuid::new_v4().to_string();
        let started_at = Utc::now();
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
        self.revisions.bump_runs();

        let session_key = format!("cron/{}/{}", job.id, run_id);
        let working_directory = job
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string);

        // Create the cloud session before the (cold-starting) runtime spawn so
        // the UI can open it seconds after "Run now". Best effort: prompt-await
        // creates it later if this fails.
        match executor
            .prepare_session(&session_key, Some(&job.name))
            .await
        {
            Ok(session_id) => {
                record.session_id = Some(session_id);
                self.persist_run(&record).await;
            }
            Err(e) => {
                tracing::warn!(%session_key, "cron: eager session prepare failed ({e}); will stamp after turn");
            }
        }

        let model_override = self
            .resolve_model_override(working_directory.as_deref(), job.payload.model.as_deref())
            .await;

        let agent_type = job
            .payload
            .backend
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        // Unattended: full access unless the job explicitly opts out (see
        // `CronPayload::permission_mode`).
        let permission_mode = job
            .payload
            .permission_mode
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_CRON_PERMISSION_MODE)
            .to_string();

        let wall_timeout_secs = resolve_cron_wall_timeout_seconds(job.payload.timeout_seconds);
        let deadline_secs = wall_timeout_secs + CRON_CLIENT_TIMEOUT_SLACK_SECS;

        let request = PromptAwaitRequest {
            session_key: session_key.clone(),
            message: job.payload.message.clone(),
            job_name: Some(job.name.clone()),
            workspace_root: working_directory.clone(),
            working_directory,
            model_override,
            agent_type,
            permission_mode,
            timeout_secs: wall_timeout_secs,
            idle_timeout_secs: DEFAULT_CRON_IDLE_TIMEOUT_SECS,
        };
        let prompt_future = executor.prompt_await(request);
        tokio::pin!(prompt_future);
        let heartbeat_every = std::time::Duration::from_secs(CRON_RUN_HEARTBEAT_INTERVAL_SECS);
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + heartbeat_every,
            heartbeat_every,
        );

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(deadline_secs), async {
            loop {
                tokio::select! {
                    result = &mut prompt_future => break result,
                    _ = heartbeat.tick() => {
                        record.last_heartbeat_at = Some(Utc::now());
                        self.persist_run(&record).await;
                    }
                }
            }
        })
        .await;

        let turn = match outcome {
            Ok(Ok(turn)) => turn,
            Ok(Err(e)) => {
                record.status = RunStatus::Failed;
                record.finished_at = Some(Utc::now());
                record.error = Some(e);
                self.finish(&job, &record, started_at).await;
                return;
            }
            Err(_) => {
                record.status = RunStatus::Failed;
                record.finished_at = Some(Utc::now());
                record.error = Some(format!("cron turn exceeded {deadline_secs}s"));
                self.finish(&job, &record, started_at).await;
                return;
            }
        };

        // Stamp the session first: even a failed turn has one to open.
        record.session_id = Some(turn.session_id.clone());
        self.persist_run(&record).await;

        if let Some(agent_err) = turn.agent_error {
            record.status = RunStatus::Failed;
            record.finished_at = Some(Utc::now());
            record.error = Some(agent_err);
            self.finish(&job, &record, started_at).await;
            return;
        }

        let response_text = turn.text;
        if !response_text.is_empty() {
            record.response_summary = Some(Self::truncate_response_summary(&response_text));
        }

        let mut delivery_failed = false;
        if let Some(delivery) = &job.delivery {
            if delivery.mode == DeliveryMode::Announce && !response_text.is_empty() {
                let mgr = DeliveryManager::new(job.workspace_path.clone(), executor.clone());
                let message = format!("[Cron: {}]\n\n{}", job.name, response_text);
                match mgr
                    .send_notification(&delivery.channel, &delivery.to, &message)
                    .await
                {
                    Ok(()) => {
                        record.delivery_status = Some("delivered".to_string());
                        tracing::info!(name = %job.name, channel = delivery.channel.as_str(), "cron: delivered");
                    }
                    Err(e) => {
                        let err_msg = format!("Delivery failed: {e}");
                        tracing::warn!(name = %job.name, "cron: {err_msg}");
                        record.delivery_status = Some(err_msg.clone());
                        delivery_failed = true;
                        if !delivery.best_effort {
                            record.status = RunStatus::Failed;
                            record.finished_at = Some(Utc::now());
                            record.error = Some(err_msg);
                            self.finish(&job, &record, started_at).await;
                            return;
                        }
                    }
                }
            }
        }

        record.status = if turn.timed_out {
            RunStatus::Timeout
        } else {
            RunStatus::Success
        };
        record.finished_at = Some(Utc::now());
        self.finish(&job, &record, started_at).await;

        // A one-time job is removed only after a fully successful run; a
        // failed delivery keeps it so the result can be seen and retried.
        if job.delete_after_run && job.schedule.kind == ScheduleKind::At && !delivery_failed {
            tracing::info!(name = %job.name, "cron: deleting one-time job after successful run");
            if self.storage.remove_job(&job.id).await.is_ok() {
                self.revisions.bump_jobs();
            }
        }
        tracing::info!(name = %job.name, "cron: job completed");
    }

    /// Honor `payload.model` only while the run's workspace still advertises
    /// it; a stale pin falls back to the workspace default instead of failing.
    async fn resolve_model_override(
        &self,
        working_directory: Option<&str>,
        job_model: Option<&str>,
    ) -> Option<ModelOverride> {
        let pref = job_model.map(str::trim).filter(|s| !s.is_empty())?;
        let models = self.wiring.models();
        let workspace = match (working_directory, models.as_ref()) {
            (Some(path), _) => Some(path.to_string()),
            (None, Some(m)) => m.default_workspace_path().await,
            (None, None) => None,
        };
        let available = match (workspace.as_deref(), models.as_ref()) {
            (Some(path), Some(m)) => m.model_keys(path).await,
            _ => std::collections::HashSet::new(),
        };
        resolve_cron_model_override(&available, workspace.as_deref(), pref)
    }
}

/// See [`CronScheduler::resolve_model_override`]. An empty `available` set
/// means the catalog could not be read: pass the pin through.
pub(crate) fn resolve_cron_model_override(
    available: &std::collections::HashSet<String>,
    workspace_path: Option<&str>,
    pref: &str,
) -> Option<ModelOverride> {
    let (provider, model) = teamclu_gateway::parse_model_preference(pref)?;
    if available.is_empty() {
        return Some(ModelOverride { provider, model });
    }
    let key = format!("{}/{}", provider.to_lowercase(), model.to_lowercase());
    if available.contains(&key) {
        Some(ModelOverride { provider, model })
    } else {
        tracing::info!(
            workspace = ?workspace_path,
            "cron: model '{pref}' is not in the workspace catalog; using the workspace default"
        );
        None
    }
}

/// Next run time for a job after `after` (default: now).
pub fn compute_next_run(job: &CronJob, after: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    let after = after.unwrap_or_else(Utc::now);
    match job.schedule.kind {
        ScheduleKind::At => {
            let at = job.schedule.at.as_deref()?;
            let at = DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Utc);
            (at > after).then_some(at)
        }
        ScheduleKind::Every => job
            .schedule
            .every_ms
            .map(|ms| after + chrono::Duration::milliseconds(ms as i64)),
        ScheduleKind::Cron => {
            // The `cron` crate reads fields in the timezone of the DateTime
            // passed to `after()`. Default is the system local wall clock
            // (Unix crontab semantics); `schedule.tz` is an IANA override.
            let expr = job.schedule.expr.as_deref()?;
            // Standard crontab in, the `cron` crate's notation out — see
            // `expr.rs` for why the day-of-week field cannot pass through.
            let schedule = match super::expr::parse(expr) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!("cron: invalid cron expression '{expr}': {e}");
                    return None;
                }
            };
            let tz = job
                .schedule
                .tz
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .and_then(|s| match Tz::from_str(s) {
                    Ok(tz) => Some(tz),
                    Err(_) => {
                        tracing::warn!("cron: unknown IANA timezone '{s}', using system local");
                        None
                    }
                });
            match tz {
                Some(tz) => schedule
                    .after(&after.with_timezone(&tz))
                    .next()
                    .map(|dt| dt.with_timezone(&Utc)),
                None => schedule
                    .after(&after.with_timezone(&Local))
                    .next()
                    .map(|dt| dt.with_timezone(&Utc)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Timelike};

    fn make_scheduler() -> CronScheduler {
        let dir = std::env::temp_dir().join(format!("amuxd-cron-test-{}", uuid::Uuid::new_v4()));
        CronScheduler::new(
            CronStorage::at(dir),
            Arc::new(Wiring::default()),
            Arc::new(Revisions::default()),
        )
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
            workspace_path: None,
        }
    }

    fn sched(kind: ScheduleKind) -> CronSchedule {
        CronSchedule {
            kind,
            at: None,
            every_ms: None,
            expr: None,
            tz: None,
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
    }

    #[test]
    fn interrupted_running_run_without_confirmation_reconciles_to_stale() {
        let now = Utc.with_ymd_and_hms(2024, 6, 1, 12, 3, 0).unwrap();
        let record = make_run_record(RunStatus::Running, None);
        let reconciled = CronScheduler::reconcile_interrupted_run(record, None, now);
        assert_eq!(reconciled.status, RunStatus::Stale);
        assert_eq!(reconciled.session_id.as_deref(), Some("session-1"));
        assert!(reconciled.error.unwrap().contains("interrupted"));
    }

    // ── restart safety ──────────────────────────────────────────────────────

    #[test]
    fn running_guard_tracks_concurrent_executions() {
        let scheduler = make_scheduler();
        assert!(!scheduler.is_running());
        {
            let _guard = RunningGuard::new(Arc::clone(&scheduler.running_count));
            assert!(scheduler.is_running());
        }
        assert!(!scheduler.is_running());
    }

    #[tokio::test]
    async fn restart_imminent_skips_new_job_before_any_run_record_is_created() {
        let scheduler = make_scheduler();
        scheduler.set_restart_imminent(true);
        let mut s = sched(ScheduleKind::Every);
        s.every_ms = Some(1000);
        scheduler.execute_job(make_job(s)).await;
        assert!(!scheduler.is_running());
        assert!(scheduler.storage.get_runs("test-id", None).await.is_empty());
    }

    #[tokio::test]
    async fn without_an_executor_a_job_leaves_no_run_record() {
        let scheduler = make_scheduler();
        let mut s = sched(ScheduleKind::Every);
        s.every_ms = Some(1000);
        scheduler.execute_job(make_job(s)).await;
        assert!(scheduler.storage.get_runs("test-id", None).await.is_empty());
    }

    #[test]
    fn resolve_cron_wall_timeout_defaults_to_sixty_minutes() {
        assert_eq!(
            resolve_cron_wall_timeout_seconds(None),
            DEFAULT_CRON_WALL_TIMEOUT_SECS
        );
        assert_eq!(resolve_cron_wall_timeout_seconds(Some(120)), 120);
        assert_eq!(
            resolve_cron_wall_timeout_seconds(Some(7200)),
            MAX_CRON_WALL_TIMEOUT_SECS
        );
    }

    // ── model override ──────────────────────────────────────────────────────

    #[test]
    fn model_override_rejects_stale_model() {
        let available = std::collections::HashSet::from(["pi/deepseek-v4-flash-free".to_string()]);
        assert!(
            resolve_cron_model_override(&available, Some("/ws"), "scnet/MiniMax-M2.5").is_none()
        );
    }

    #[test]
    fn model_override_accepts_configured_model_case_insensitively() {
        let available = std::collections::HashSet::from(["scnet/minimax-m2.5".to_string()]);
        let out =
            resolve_cron_model_override(&available, Some("/ws"), "scnet/MiniMax-M2.5").unwrap();
        assert_eq!(
            (out.provider.as_str(), out.model.as_str()),
            ("scnet", "MiniMax-M2.5")
        );
    }

    #[test]
    fn model_override_passes_through_when_catalog_unreadable() {
        let out = resolve_cron_model_override(&Default::default(), None, "scnet/m").unwrap();
        assert_eq!(out.model, "m");
    }

    // ── compute_next_run ────────────────────────────────────────────────────

    #[test]
    fn at_future_returns_that_timestamp() {
        let future = Utc::now() + Duration::hours(1);
        let mut s = sched(ScheduleKind::At);
        s.at = Some(future.to_rfc3339());
        let diff = (compute_next_run(&make_job(s), None).unwrap() - future)
            .num_seconds()
            .abs();
        assert!(diff <= 1);
    }

    #[test]
    fn at_past_missing_or_invalid_returns_none() {
        let mut s = sched(ScheduleKind::At);
        s.at = Some((Utc::now() - Duration::hours(1)).to_rfc3339());
        assert!(compute_next_run(&make_job(s), None).is_none());
        assert!(compute_next_run(&make_job(sched(ScheduleKind::At)), None).is_none());
        let mut s = sched(ScheduleKind::At);
        s.at = Some("not-a-date".into());
        assert!(compute_next_run(&make_job(s), None).is_none());
    }

    #[test]
    fn every_adds_interval_to_after() {
        let mut s = sched(ScheduleKind::Every);
        s.every_ms = Some(30_000);
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap();
        assert_eq!(
            compute_next_run(&make_job(s), Some(anchor)).unwrap(),
            anchor + Duration::milliseconds(30_000)
        );
        assert!(compute_next_run(&make_job(sched(ScheduleKind::Every)), None).is_none());
    }

    #[test]
    fn cron_daily_at_9am_returns_next_occurrence() {
        let mut s = sched(ScheduleKind::Cron);
        s.expr = Some("0 9 * * *".into());
        s.tz = Some("UTC".into());
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 8, 0, 0).unwrap();
        let r = compute_next_run(&make_job(s), Some(anchor)).unwrap();
        assert_eq!((r.hour(), r.minute(), r.second()), (9, 0, 0));
        assert!(r > anchor);
    }

    #[test]
    fn cron_weekday_expression_fires_on_correct_days() {
        // Standard crontab: 1=Mon .. 5=Fri (`expr.rs` translates for the
        // `cron` crate, which numbers days from Sunday=1).
        let mut s = sched(ScheduleKind::Cron);
        s.expr = Some("0 10 * * 1-5".into());
        s.tz = Some("UTC".into());
        let anchor = Utc.with_ymd_and_hms(2024, 6, 2, 11, 0, 0).unwrap();
        assert_eq!(
            compute_next_run(&make_job(s), Some(anchor)).unwrap(),
            Utc.with_ymd_and_hms(2024, 6, 3, 10, 0, 0).unwrap()
        );
    }

    #[test]
    fn cron_invalid_or_missing_expression_returns_none() {
        let mut s = sched(ScheduleKind::Cron);
        s.expr = Some("not a cron expr".into());
        assert!(compute_next_run(&make_job(s), None).is_none());
        assert!(compute_next_run(&make_job(sched(ScheduleKind::Cron)), None).is_none());
    }

    #[test]
    fn cron_with_named_timezone_returns_correct_utc_time() {
        let mut s = sched(ScheduleKind::Cron);
        s.expr = Some("0 9 * * *".into());
        s.tz = Some("Asia/Shanghai".into());
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 0, 30, 0).unwrap();
        let r = compute_next_run(&make_job(s), Some(anchor)).unwrap();
        assert_eq!((r.hour(), r.minute()), (1, 0));
    }

    #[test]
    fn cron_unknown_timezone_falls_back_without_panic() {
        let mut s = sched(ScheduleKind::Cron);
        s.expr = Some("0 9 * * *".into());
        s.tz = Some("Not/AReal_Zone".into());
        assert!(compute_next_run(&make_job(s), None).is_some());
    }
}
