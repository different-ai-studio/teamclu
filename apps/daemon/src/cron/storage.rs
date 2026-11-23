//! Team-scoped cron storage: `~/.amuxd/teams/<id>/cron/`.
//!
//! ```text
//! cron/
//!   jobs.json            every job of the team, global and workspace alike
//!   runs/<job_id>.jsonl  run history, one record per line (updated in place)
//! ```
//!
//! The desktop kept one store per workspace plus a brand-specific
//! `cron-global` directory (ADR-0010). Here there is one store, and a job's
//! workspace is a field on the job.
//!
//! The daemon is the only writer, so unlike the desktop store this never
//! reloads from disk behind a caller's back — except when the root itself
//! moves (an unclaimed daemon claims a team), which re-reads the new root.
//!
//! **Jobs made before the daemon had a team.** They land in
//! `teams/_unclaimed/cron/`. Claiming a team usually renames that whole
//! directory into place (`layout::promote_unclaimed`), but when the team
//! already has a directory the rename is skipped and `_unclaimed` is left
//! alone. So on loading a team's root this store also adopts whatever cron
//! `_unclaimed` still holds: jobs merged by id, their run files moved, and the
//! old `jobs.json` renamed `jobs.json.migrated`. Otherwise those jobs would
//! sit in a directory nothing reads, and never run.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::types::{
    normalize_legacy_timeout_status, CronJob, CronJobsData, CronRunRecord, RunStatus,
};

type RootFn = Arc<dyn Fn() -> PathBuf + Send + Sync>;

/// How many run records a job's history file keeps. The history view shows
/// 50 and the MCP tool 10; uncapped, a job that ran every few minutes grew its
/// file without bound — and the file is rewritten on every heartbeat of a run.
const MAX_RUN_RECORDS_PER_JOB: usize = 200;

struct Loaded {
    root: PathBuf,
    data: CronJobsData,
}

/// Persistent storage for cron jobs and run history. Cheap to clone.
#[derive(Clone)]
pub struct CronStorage {
    root: RootFn,
    /// Directory whose leftover jobs are folded into any other root on load
    /// (the unclaimed team's cron dir). `None` in tests that do not need it.
    adopt_from: Option<RootFn>,
    /// Jobs in memory plus the root they were read from. One lock for both,
    /// held across mutate-then-persist, so no write can interleave with
    /// another or with a root switch.
    state: Arc<Mutex<Option<Loaded>>>,
    /// Serializes run-history file rewrites (`update_last_run` reads, edits
    /// and rewrites the whole file).
    runs_lock: Arc<Mutex<()>>,
}

impl std::fmt::Debug for CronStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CronStorage").finish_non_exhaustive()
    }
}

impl CronStorage {
    /// Storage rooted at whatever `root` returns at the moment of each call.
    pub fn new(root: impl Fn() -> PathBuf + Send + Sync + 'static) -> Self {
        Self {
            root: Arc::new(root),
            adopt_from: None,
            state: Arc::new(Mutex::new(None)),
            runs_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Storage fixed at one directory (tests, and the import path's checks).
    pub fn at(root: PathBuf) -> Self {
        Self::new(move || root.clone())
    }

    /// The active team's cron directory, adopting jobs left in the unclaimed
    /// team's (see the module docs).
    pub fn for_active_team() -> Self {
        Self::new(|| {
            crate::config::layout::team_dir(&crate::config::layout::active_team()).join("cron")
        })
        .adopting(|| {
            crate::config::layout::team_dir(crate::config::layout::UNCLAIMED_TEAM).join("cron")
        })
    }

    /// Fold jobs found under `from` into whichever other root gets loaded.
    pub fn adopting(mut self, from: impl Fn() -> PathBuf + Send + Sync + 'static) -> Self {
        self.adopt_from = Some(Arc::new(from));
        self
    }

    /// Merge `from`'s jobs into `data` (by id; `data` wins) and move their run
    /// files under `root`. Renames `from`'s jobs file afterwards so this runs
    /// once. Returns how many jobs were added.
    fn adopt_leftovers(from: &Path, root: &Path, data: &mut CronJobsData) -> usize {
        let jobs_file = Self::jobs_path(from);
        if !jobs_file.is_file() {
            return 0;
        }
        let leftover = Self::read_jobs(from);
        let mut added = 0;
        for job in leftover.jobs {
            if data.jobs.iter().any(|j| j.id == job.id) {
                continue;
            }
            let src = Self::run_file(from, &job.id);
            let dst = Self::run_file(root, &job.id);
            if src.is_file() && !dst.exists() {
                let _ = std::fs::create_dir_all(Self::runs_dir(root));
                if let Err(e) = std::fs::rename(&src, &dst) {
                    tracing::warn!(src = %src.display(), "cron: move adopted run file failed: {e}");
                }
            }
            data.jobs.push(job);
            added += 1;
        }
        if added > 0 {
            // Persist before retiring the source, so a failed write cannot
            // lose the jobs: the source stays and the next load retries.
            if !Self::write_jobs(root, data) {
                return 0;
            }
        }
        let retired = jobs_file.with_extension("json.migrated");
        if let Err(e) = std::fs::rename(&jobs_file, &retired) {
            tracing::warn!(path = %jobs_file.display(), "cron: retire adopted jobs file failed: {e}");
        }
        tracing::info!(
            added,
            from = %from.display(),
            to = %root.display(),
            "cron: adopted jobs made before this daemon had a team"
        );
        added
    }

    pub fn root(&self) -> PathBuf {
        (self.root)()
    }

    fn jobs_path(root: &Path) -> PathBuf {
        root.join("jobs.json")
    }

    fn runs_dir(root: &Path) -> PathBuf {
        root.join("runs")
    }

    fn run_file(root: &Path, job_id: &str) -> PathBuf {
        Self::runs_dir(root).join(format!("{job_id}.jsonl"))
    }

    fn read_jobs(root: &Path) -> CronJobsData {
        let path = Self::jobs_path(root);
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<CronJobsData>(&content) {
                Ok(data) => data,
                Err(e) => {
                    // Keep the unreadable file aside rather than overwrite it
                    // with an empty list on the next save.
                    let aside = path.with_extension(format!(
                        "json.corrupt-{}",
                        chrono::Utc::now().format("%Y%m%d%H%M%S")
                    ));
                    tracing::error!(
                        path = %path.display(),
                        aside = %aside.display(),
                        "cron: jobs file unreadable ({e}); moved aside, starting empty"
                    );
                    let _ = std::fs::rename(&path, &aside);
                    CronJobsData::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => CronJobsData::default(),
            Err(e) => {
                tracing::error!(path = %path.display(), "cron: read jobs failed: {e}");
                CronJobsData::default()
            }
        }
    }

    /// Write-then-rename. Returns whether the file was written.
    fn write_jobs(root: &Path, data: &CronJobsData) -> bool {
        if let Err(e) = std::fs::create_dir_all(root) {
            tracing::error!(root = %root.display(), "cron: create dir failed: {e}");
            return false;
        }
        let content = match serde_json::to_string_pretty(data) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("cron: serialize jobs failed: {e}");
                return false;
            }
        };
        // Write-then-rename: a crash mid-write must not leave a truncated
        // jobs.json, which would read back as "no jobs".
        let path = Self::jobs_path(root);
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, content).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::error!(path = %path.display(), "cron: save jobs failed: {e}");
            return false;
        }
        true
    }

    /// Run `f` against the in-memory jobs for the current root, loading them
    /// first if the root is new. Persists afterwards when `f` returns `true`.
    async fn with_jobs<R>(&self, f: impl FnOnce(&mut CronJobsData) -> (R, bool)) -> R {
        let root = self.root();
        let mut guard = self.state.lock().await;
        if guard.as_ref().map(|l| &l.root) != Some(&root) {
            let mut data = Self::read_jobs(&root);
            if let Some(from) = self.adopt_from.as_ref().map(|f| f()) {
                if from != root {
                    Self::adopt_leftovers(&from, &root, &mut data);
                }
            }
            *guard = Some(Loaded {
                root: root.clone(),
                data,
            });
        }
        let loaded = guard.as_mut().expect("loaded above");
        let (out, dirty) = f(&mut loaded.data);
        if dirty {
            Self::write_jobs(&loaded.root, &loaded.data);
        }
        out
    }

    /// Load the current root (adopting unclaimed leftovers) without touching
    /// it. Run reads call this first: adoption moves run files, and the boot
    /// sweep for interrupted runs comes before anything has listed jobs.
    async fn load(&self) {
        self.with_jobs(|_| ((), false)).await;
    }

    // ==================== Job CRUD ====================

    pub async fn list_jobs(&self) -> Vec<CronJob> {
        self.with_jobs(|d| (d.jobs.clone(), false)).await
    }

    pub async fn get_job(&self, job_id: &str) -> Option<CronJob> {
        self.with_jobs(|d| (d.jobs.iter().find(|j| j.id == job_id).cloned(), false))
            .await
    }

    pub async fn add_job(&self, job: CronJob) {
        self.with_jobs(|d| {
            d.jobs.push(job);
            ((), true)
        })
        .await
    }

    /// Insert jobs whose id is not present yet. Returns how many were added.
    /// Idempotent by id, which is what makes the desktop's one-shot import
    /// safe to retry.
    pub async fn import_jobs(&self, jobs: Vec<CronJob>) -> usize {
        self.with_jobs(|d| {
            let mut added = 0;
            for job in jobs {
                if d.jobs.iter().any(|j| j.id == job.id) {
                    continue;
                }
                d.jobs.push(job);
                added += 1;
            }
            (added, added > 0)
        })
        .await
    }

    pub async fn update_job(&self, updated: CronJob) -> Result<(), String> {
        self.with_jobs(|d| match d.jobs.iter_mut().find(|j| j.id == updated.id) {
            Some(existing) => {
                *existing = updated;
                (Ok(()), true)
            }
            None => (Err(format!("Job not found: {}", updated.id)), false),
        })
        .await
    }

    /// Apply `f` to one job in place. Returns the job after the edit.
    pub async fn modify_job(
        &self,
        job_id: &str,
        f: impl FnOnce(&mut CronJob),
    ) -> Result<CronJob, String> {
        self.with_jobs(|d| match d.jobs.iter_mut().find(|j| j.id == job_id) {
            Some(job) => {
                f(job);
                (Ok(job.clone()), true)
            }
            None => (Err(format!("Job not found: {job_id}")), false),
        })
        .await
    }

    pub async fn remove_job(&self, job_id: &str) -> Result<(), String> {
        let root = self.root();
        self.with_jobs(|d| {
            let before = d.jobs.len();
            d.jobs.retain(|j| j.id != job_id);
            if d.jobs.len() == before {
                (Err(format!("Job not found: {job_id}")), false)
            } else {
                (Ok(()), true)
            }
        })
        .await?;
        let _runs = self.runs_lock.lock().await;
        let _ = std::fs::remove_file(Self::run_file(&root, job_id));
        Ok(())
    }

    pub async fn toggle_enabled(&self, job_id: &str, enabled: bool) -> Result<(), String> {
        self.modify_job(job_id, |job| {
            job.enabled = enabled;
            job.updated_at = chrono::Utc::now();
        })
        .await
        .map(|_| ())
    }

    pub async fn update_run_timestamps(
        &self,
        job_id: &str,
        last_run: chrono::DateTime<chrono::Utc>,
        next_run: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        let _ = self
            .modify_job(job_id, |job| {
                job.last_run_at = Some(last_run);
                job.next_run_at = next_run;
                job.updated_at = chrono::Utc::now();
            })
            .await;
    }

    /// Set only `next_run_at`. Does not touch `last_run_at`.
    pub async fn update_next_run_at(
        &self,
        job_id: &str,
        next_run: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        let _ = self
            .modify_job(job_id, |job| {
                job.next_run_at = next_run;
                job.updated_at = chrono::Utc::now();
            })
            .await;
    }

    /// Set only `last_run_at` (after a run finishes; `next_run_at` was already
    /// advanced when the run was fired).
    pub async fn update_last_run_at(&self, job_id: &str, last_run: chrono::DateTime<chrono::Utc>) {
        let _ = self
            .modify_job(job_id, |job| {
                job.last_run_at = Some(last_run);
                job.updated_at = chrono::Utc::now();
            })
            .await;
    }

    // ==================== Run History ====================

    fn append_line(root: &Path, record: &CronRunRecord) {
        use std::io::Write;
        let dir = Self::runs_dir(root);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::error!(dir = %dir.display(), "cron: create runs dir failed: {e}");
            return;
        }
        let line = match serde_json::to_string(record) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("cron: serialize run record failed: {e}");
                return;
            }
        };
        let path = Self::run_file(root, &record.job_id);
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(e) = writeln!(file, "{line}") {
                    tracing::error!(path = %path.display(), "cron: write run record failed: {e}");
                }
            }
            Err(e) => tracing::error!(path = %path.display(), "cron: open run file failed: {e}"),
        }
    }

    pub async fn append_run(&self, record: &CronRunRecord) {
        let root = self.root();
        let _runs = self.runs_lock.lock().await;
        Self::append_line(&root, record);
    }

    /// Replace the record with the same `run_id`, or append when absent.
    pub async fn update_last_run(&self, record: &CronRunRecord) {
        let root = self.root();
        let _runs = self.runs_lock.lock().await;
        let path = Self::run_file(&root, &record.job_id);
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                Self::append_line(&root, record);
                return;
            }
        };
        let mut lines: Vec<String> = content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect();
        let mut found = false;
        for line in lines.iter_mut().rev() {
            if let Ok(existing) = serde_json::from_str::<CronRunRecord>(line) {
                if existing.run_id == record.run_id {
                    if let Ok(updated) = serde_json::to_string(record) {
                        *line = updated;
                        found = true;
                    }
                    break;
                }
            }
        }
        if !found {
            drop(lines);
            Self::append_line(&root, record);
            return;
        }
        if lines.len() > MAX_RUN_RECORDS_PER_JOB {
            lines.drain(..lines.len() - MAX_RUN_RECORDS_PER_JOB);
        }
        let tmp = path.with_extension("jsonl.tmp");
        let body = lines.join("\n") + "\n";
        if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::error!(path = %path.display(), "cron: rewrite run file failed: {e}");
        }
    }

    /// Run history for a job, most recent first, one record per run id.
    pub async fn get_runs(&self, job_id: &str, limit: Option<usize>) -> Vec<CronRunRecord> {
        self.load().await;
        let root = self.root();
        let _runs = self.runs_lock.lock().await;
        let Ok(content) = std::fs::read_to_string(Self::run_file(&root, job_id)) else {
            return Vec::new();
        };
        let mut records: Vec<CronRunRecord> = content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .map(|mut r| {
                normalize_legacy_timeout_status(&mut r);
                r
            })
            .collect();
        records.reverse();
        let mut seen = std::collections::HashSet::new();
        records.retain(|r| seen.insert(r.run_id.clone()));
        if let Some(limit) = limit {
            records.truncate(limit);
        }
        records
    }

    /// Latest state of every run still marked `running` on disk — runs a
    /// previous daemon process was executing when it stopped.
    pub async fn get_latest_running_runs(&self) -> Vec<CronRunRecord> {
        self.load().await;
        let root = self.root();
        let _runs = self.runs_lock.lock().await;
        let Ok(entries) = std::fs::read_dir(Self::runs_dir(&root)) else {
            return Vec::new();
        };
        let mut by_run = std::collections::HashMap::<String, CronRunRecord>::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            for line in content.lines().filter(|l| !l.trim().is_empty()) {
                if let Ok(mut record) = serde_json::from_str::<CronRunRecord>(line) {
                    normalize_legacy_timeout_status(&mut record);
                    by_run.insert(record.run_id.clone(), record);
                }
            }
        }
        by_run
            .into_values()
            .filter(|r| r.status == RunStatus::Running)
            .collect()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    fn make_run(run_id: &str, status: RunStatus) -> CronRunRecord {
        let started_at = Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap();
        CronRunRecord {
            run_id: run_id.to_string(),
            job_id: "job-1".to_string(),
            started_at,
            finished_at: None,
            status,
            last_heartbeat_at: Some(started_at),
            session_id: None,
            response_summary: None,
            delivery_status: None,
            error: None,
        }
    }

    pub(crate) fn make_job(id: &str) -> CronJob {
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "enabled": true,
            "schedule": { "kind": "cron", "expr": "0 9 * * *" },
            "payload": { "message": "hello" },
            "deleteAfterRun": false,
            "createdAt": Utc::now().to_rfc3339(),
            "updatedAt": Utc::now().to_rfc3339()
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn get_runs_returns_only_latest_record_for_duplicate_run_id() {
        let dir = tempfile::tempdir().unwrap();
        let storage = CronStorage::at(dir.path().to_path_buf());

        let running = make_run("run-1", RunStatus::Running);
        let mut success = make_run("run-1", RunStatus::Success);
        let finished_at = Utc.with_ymd_and_hms(2024, 6, 1, 12, 3, 0).unwrap();
        success.finished_at = Some(finished_at);

        storage.append_run(&running).await;
        storage.append_run(&success).await;

        let runs = storage.get_runs("job-1", None).await;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Success);
        assert_eq!(runs[0].finished_at, Some(finished_at));
    }

    #[tokio::test]
    async fn update_last_run_rewrites_in_place_and_running_scan_sees_latest() {
        let dir = tempfile::tempdir().unwrap();
        let storage = CronStorage::at(dir.path().to_path_buf());
        storage
            .append_run(&make_run("run-1", RunStatus::Running))
            .await;
        assert_eq!(storage.get_latest_running_runs().await.len(), 1);

        storage
            .update_last_run(&make_run("run-1", RunStatus::Success))
            .await;
        assert!(storage.get_latest_running_runs().await.is_empty());
        let raw = std::fs::read_to_string(dir.path().join("runs/job-1.jsonl")).unwrap();
        assert_eq!(raw.lines().count(), 1, "rewritten, not appended");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_adds_do_not_drop_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let storage = CronStorage::at(dir.path().to_path_buf());
        let mut handles = Vec::new();
        for i in 0..50 {
            let s = storage.clone();
            handles.push(tokio::spawn(async move {
                s.add_job(make_job(&format!("job-{i}"))).await;
            }));
            let s = storage.clone();
            handles.push(tokio::spawn(async move {
                let _ = s.list_jobs().await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(storage.list_jobs().await.len(), 50);
        // And on disk: a fresh store over the same root reads all 50.
        let reread = CronStorage::at(dir.path().to_path_buf());
        assert_eq!(reread.list_jobs().await.len(), 50);
    }

    #[tokio::test]
    async fn loading_a_team_root_adopts_jobs_left_in_unclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let unclaimed = dir.path().join("_unclaimed/cron");
        let team = dir.path().join("team-a/cron");

        // Made while unclaimed, with a run on record.
        let before = CronStorage::at(unclaimed.clone());
        before.add_job(make_job("early")).await;
        let mut early_run = make_run("run-e", RunStatus::Success);
        early_run.job_id = "early".into();
        before.append_run(&early_run).await;

        // The team already had its own store, so the rename was skipped.
        CronStorage::at(team.clone())
            .add_job(make_job("mine"))
            .await;

        let u = unclaimed.clone();
        let storage = CronStorage::at(team.clone()).adopting(move || u.clone());
        let mut ids: Vec<_> = storage
            .list_jobs()
            .await
            .into_iter()
            .map(|j| j.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["early".to_string(), "mine".to_string()]);
        assert_eq!(storage.get_runs("early", None).await.len(), 1);
        assert!(!unclaimed.join("jobs.json").exists());
        assert!(unclaimed.join("jobs.json.migrated").is_file());

        // Persisted: a fresh store over the team root sees both.
        assert_eq!(CronStorage::at(team).list_jobs().await.len(), 2);
    }

    #[tokio::test]
    async fn interrupted_runs_left_in_unclaimed_are_found_on_boot() {
        // A daemon stopped mid-run while unclaimed, then came back claimed.
        // The boot sweep reads runs before anything has listed jobs, so it
        // must adopt first or the run stays `running` forever.
        let dir = tempfile::tempdir().unwrap();
        let unclaimed = dir.path().join("_unclaimed/cron");
        let team = dir.path().join("team-a/cron");

        let before = CronStorage::at(unclaimed.clone());
        before.add_job(make_job("early")).await;
        let mut interrupted = make_run("run-i", RunStatus::Running);
        interrupted.job_id = "early".into();
        before.append_run(&interrupted).await;
        CronStorage::at(team.clone())
            .add_job(make_job("mine"))
            .await;

        let u = unclaimed.clone();
        let storage = CronStorage::at(team).adopting(move || u.clone());
        let running = storage.get_latest_running_runs().await;
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].run_id, "run-i");
    }

    #[tokio::test]
    async fn the_unclaimed_root_does_not_adopt_itself() {
        let dir = tempfile::tempdir().unwrap();
        let unclaimed = dir.path().join("_unclaimed/cron");
        let u = unclaimed.clone();
        let storage = CronStorage::at(unclaimed.clone()).adopting(move || u.clone());
        storage.add_job(make_job("early")).await;
        let fresh = {
            let u = unclaimed.clone();
            CronStorage::at(unclaimed.clone()).adopting(move || u.clone())
        };
        assert_eq!(fresh.list_jobs().await.len(), 1);
        assert!(unclaimed.join("jobs.json").is_file());
    }

    #[tokio::test]
    async fn run_history_is_capped_when_a_run_is_updated() {
        let dir = tempfile::tempdir().unwrap();
        let storage = CronStorage::at(dir.path().to_path_buf());
        let total = MAX_RUN_RECORDS_PER_JOB + 25;
        for i in 0..total {
            storage
                .append_run(&make_run(&format!("run-{i}"), RunStatus::Success))
                .await;
        }
        let last = format!("run-{}", total - 1);
        storage
            .update_last_run(&make_run(&last, RunStatus::Failed))
            .await;

        let runs = storage.get_runs("job-1", None).await;
        assert_eq!(runs.len(), MAX_RUN_RECORDS_PER_JOB);
        assert!(runs
            .iter()
            .any(|r| r.run_id == last && r.status == RunStatus::Failed));
        assert!(!runs.iter().any(|r| r.run_id == "run-0"));
    }

    #[tokio::test]
    async fn import_is_idempotent_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let storage = CronStorage::at(dir.path().to_path_buf());
        storage.add_job(make_job("a")).await;
        let added = storage
            .import_jobs(vec![make_job("a"), make_job("b"), make_job("c")])
            .await;
        assert_eq!(added, 2);
        assert_eq!(storage.import_jobs(vec![make_job("b")]).await, 0);
        assert_eq!(storage.list_jobs().await.len(), 3);
    }

    #[tokio::test]
    async fn root_switch_reloads_from_the_new_root() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let current = Arc::new(std::sync::Mutex::new(a.path().to_path_buf()));
        let c2 = current.clone();
        let storage = CronStorage::new(move || c2.lock().unwrap().clone());
        storage.add_job(make_job("in-a")).await;
        *current.lock().unwrap() = b.path().to_path_buf();
        assert!(storage.list_jobs().await.is_empty());
        *current.lock().unwrap() = a.path().to_path_buf();
        assert_eq!(storage.list_jobs().await[0].id, "in-a");
    }

    #[tokio::test]
    async fn corrupt_jobs_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("jobs.json"), "{not json").unwrap();
        let storage = CronStorage::at(dir.path().to_path_buf());
        assert!(storage.list_jobs().await.is_empty());
        let aside = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
        assert!(aside);
    }
}
