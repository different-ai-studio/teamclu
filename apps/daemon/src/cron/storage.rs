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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::types::{
    normalize_legacy_timeout_status, CronJob, CronJobsData, CronRunRecord, RunStatus,
};

type RootFn = Arc<dyn Fn() -> PathBuf + Send + Sync>;

struct Loaded {
    root: PathBuf,
    data: CronJobsData,
}

/// Persistent storage for cron jobs and run history. Cheap to clone.
#[derive(Clone)]
pub struct CronStorage {
    root: RootFn,
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
            state: Arc::new(Mutex::new(None)),
            runs_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Storage fixed at one directory (tests, and the import path's checks).
    pub fn at(root: PathBuf) -> Self {
        Self::new(move || root.clone())
    }

    /// The active team's cron directory.
    pub fn for_active_team() -> Self {
        Self::new(|| {
            crate::config::layout::team_dir(&crate::config::layout::active_team()).join("cron")
        })
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

    fn write_jobs(root: &Path, data: &CronJobsData) {
        if let Err(e) = std::fs::create_dir_all(root) {
            tracing::error!(root = %root.display(), "cron: create dir failed: {e}");
            return;
        }
        let content = match serde_json::to_string_pretty(data) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("cron: serialize jobs failed: {e}");
                return;
            }
        };
        // Write-then-rename: a crash mid-write must not leave a truncated
        // jobs.json, which would read back as "no jobs".
        let path = Self::jobs_path(root);
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, content).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::error!(path = %path.display(), "cron: save jobs failed: {e}");
        }
    }

    /// Run `f` against the in-memory jobs for the current root, loading them
    /// first if the root is new. Persists afterwards when `f` returns `true`.
    async fn with_jobs<R>(&self, f: impl FnOnce(&mut CronJobsData) -> (R, bool)) -> R {
        let root = self.root();
        let mut guard = self.state.lock().await;
        if guard.as_ref().map(|l| &l.root) != Some(&root) {
            let data = Self::read_jobs(&root);
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
        let tmp = path.with_extension("jsonl.tmp");
        let body = lines.join("\n") + "\n";
        if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::error!(path = %path.display(), "cron: rewrite run file failed: {e}");
        }
    }

    /// Run history for a job, most recent first, one record per run id.
    pub async fn get_runs(&self, job_id: &str, limit: Option<usize>) -> Vec<CronRunRecord> {
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
