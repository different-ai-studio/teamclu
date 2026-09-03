use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

use super::types::{
    normalize_legacy_timeout_status, CronJob, CronJobsData, CronRunRecord, RunStatus,
};

/// Persistent storage for cron jobs and run history
#[derive(Debug)]
pub struct CronStorage {
    /// In-memory jobs data
    data: Arc<RwLock<CronJobsData>>,
    /// Path to the workspace directory
    workspace_path: Arc<RwLock<Option<String>>>,
    /// Serializes disk I/O against in-memory mutations so a concurrent
    /// `reload_jobs_from_disk` can never interleave between a mutation's
    /// in-memory write and its `persist_jobs` (which would clobber the fresh
    /// job back to a stale on-disk copy — the cause of jobs silently
    /// disappearing when a save coincides with a scheduler/UI reload).
    io_lock: Arc<Mutex<()>>,
}

impl Default for CronStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for CronStorage {
    fn clone(&self) -> Self {
        Self {
            data: Arc::clone(&self.data),
            workspace_path: Arc::clone(&self.workspace_path),
            io_lock: Arc::clone(&self.io_lock),
        }
    }
}

impl CronStorage {
    pub fn new() -> Self {
        Self {
            data: Arc::new(RwLock::new(CronJobsData::default())),
            workspace_path: Arc::new(RwLock::new(None)),
            io_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Get the current workspace path
    pub async fn get_workspace_path(&self) -> Option<String> {
        self.workspace_path.read().await.clone()
    }

    /// Get the jobs file path
    fn jobs_path(workspace: &str) -> PathBuf {
        PathBuf::from(workspace)
            .join(crate::commands::TEAMCLU_DIR)
            .join("cron-jobs.json")
    }

    /// Get the runs directory path
    fn runs_dir(workspace: &str) -> PathBuf {
        PathBuf::from(workspace)
            .join(crate::commands::TEAMCLU_DIR)
            .join("cron-runs")
    }

    /// Get the run history file for a specific job
    fn run_file(workspace: &str, job_id: &str) -> PathBuf {
        Self::runs_dir(workspace).join(format!("{}.jsonl", job_id))
    }

    /// Initialize storage with a workspace path and load existing data.
    /// If switching workspaces, replaces old data with new workspace's jobs.
    pub async fn init(&self, workspace_path: &str) {
        // Hold the I/O lock so an in-flight mutation/persist or reload can't race
        // the atomic data + workspace_path swap below.
        let _io = self.io_lock.lock().await;
        log::info!("[Cron] Initializing storage at: {}", workspace_path);

        // Load existing jobs from new workspace, or use empty data if file doesn't exist
        let jobs_path = Self::jobs_path(workspace_path);
        let new_data = if jobs_path.exists() {
            match std::fs::read_to_string(&jobs_path) {
                Ok(content) => match serde_json::from_str::<CronJobsData>(&content) {
                    Ok(loaded) => {
                        log::info!("[Cron] Loaded {} jobs from file", loaded.jobs.len());
                        loaded
                    }
                    Err(e) => {
                        log::error!("[Cron] Failed to parse jobs file: {}", e);
                        CronJobsData::default()
                    }
                },
                Err(e) => {
                    log::error!("[Cron] Failed to read jobs file: {}", e);
                    CronJobsData::default()
                }
            }
        } else {
            log::info!("[Cron] No existing jobs file found, starting with empty jobs");
            CronJobsData::default()
        };

        // Ensure runs directory exists (do I/O before acquiring locks)
        let runs_dir = Self::runs_dir(workspace_path);
        if !runs_dir.exists() {
            let _ = std::fs::create_dir_all(&runs_dir);
        }

        // Replace data atomically — critical for workspace switching to ensure
        // old workspace's jobs don't leak into new workspace
        {
            let mut data = self.data.write().await;
            *data = new_data;
        } // Release data lock immediately

        // Update workspace path
        let mut wp = self.workspace_path.write().await;
        *wp = Some(workspace_path.to_string());
    }

    /// Check if storage is initialized
    pub async fn is_initialized(&self) -> bool {
        self.workspace_path.read().await.is_some()
    }

    /// Get mutable access to the in-memory jobs data
    pub async fn data_mut(&self) -> tokio::sync::RwLockWriteGuard<'_, CronJobsData> {
        self.data.write().await
    }

    /// Persist jobs data to file (public for scheduler direct updates)
    pub async fn persist(&self) {
        let _io = self.io_lock.lock().await;
        self.persist_jobs().await;
    }

    /// Persist jobs data to file.
    ///
    /// Callers must hold `io_lock` for the whole mutate-then-persist sequence so
    /// a concurrent `reload_jobs_from_disk` cannot overwrite in-memory state
    /// with a stale on-disk copy before this write lands.
    async fn persist_jobs(&self) {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let data = self.data.read().await;
            match serde_json::to_string_pretty(&*data) {
                Ok(content) => {
                    if let Err(e) = std::fs::write(Self::jobs_path(ws), content) {
                        log::error!("[Cron] Failed to save jobs: {}", e);
                    }
                }
                Err(e) => {
                    log::error!("[Cron] Failed to serialize jobs: {}", e);
                }
            }
        }
    }

    /// Reload jobs from disk so changes made by external tools (such as the
    /// teamclu-introspect MCP sidecar) become visible to the UI and scheduler.
    async fn reload_jobs_from_disk(&self) {
        // Serialize against mutations: never replace in-memory state from disk
        // while a mutation has updated memory but not yet finished persisting.
        let _io = self.io_lock.lock().await;
        let workspace = self.workspace_path.read().await.clone();
        let Some(ws) = workspace.as_ref() else {
            return;
        };

        let jobs_path = Self::jobs_path(ws);
        if !jobs_path.exists() {
            return;
        }

        match std::fs::read_to_string(&jobs_path) {
            Ok(content) => match serde_json::from_str::<CronJobsData>(&content) {
                Ok(loaded) => {
                    let mut data = self.data.write().await;
                    *data = loaded;
                }
                Err(e) => {
                    log::error!("[Cron] Failed to parse jobs file during reload: {}", e);
                }
            },
            Err(e) => {
                log::error!("[Cron] Failed to read jobs file during reload: {}", e);
            }
        }
    }

    // ==================== Job CRUD ====================

    /// Get all jobs
    pub async fn list_jobs(&self) -> Vec<CronJob> {
        self.reload_jobs_from_disk().await;
        self.data.read().await.jobs.clone()
    }

    /// Get a single job by ID
    pub async fn get_job(&self, job_id: &str) -> Option<CronJob> {
        self.reload_jobs_from_disk().await;
        self.data
            .read()
            .await
            .jobs
            .iter()
            .find(|j| j.id == job_id)
            .cloned()
    }

    /// Add a new job
    pub async fn add_job(&self, job: CronJob) {
        let _io = self.io_lock.lock().await;
        {
            let mut data = self.data.write().await;
            data.jobs.push(job);
        }
        self.persist_jobs().await;
    }

    /// Update an existing job (replaces the job with matching ID)
    pub async fn update_job(&self, updated: CronJob) -> Result<(), String> {
        let _io = self.io_lock.lock().await;
        {
            let mut data = self.data.write().await;
            if let Some(existing) = data.jobs.iter_mut().find(|j| j.id == updated.id) {
                *existing = updated;
            } else {
                return Err(format!("Job not found: {}", updated.id));
            }
        }
        self.persist_jobs().await;
        Ok(())
    }

    /// Remove a job by ID
    pub async fn remove_job(&self, job_id: &str) -> Result<(), String> {
        let _io = self.io_lock.lock().await;
        {
            let mut data = self.data.write().await;
            let before = data.jobs.len();
            data.jobs.retain(|j| j.id != job_id);
            if data.jobs.len() == before {
                return Err(format!("Job not found: {}", job_id));
            }
        }
        self.persist_jobs().await;

        // Also clean up run history
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let run_file = Self::run_file(ws, job_id);
            if run_file.exists() {
                let _ = std::fs::remove_file(run_file);
            }
        }

        Ok(())
    }

    /// Toggle job enabled/disabled
    pub async fn toggle_enabled(&self, job_id: &str, enabled: bool) -> Result<(), String> {
        let _io = self.io_lock.lock().await;
        {
            let mut data = self.data.write().await;
            if let Some(job) = data.jobs.iter_mut().find(|j| j.id == job_id) {
                job.enabled = enabled;
                job.updated_at = chrono::Utc::now();
            } else {
                return Err(format!("Job not found: {}", job_id));
            }
        }
        self.persist_jobs().await;
        Ok(())
    }

    /// Update job timestamps after a run
    pub async fn update_run_timestamps(
        &self,
        job_id: &str,
        last_run: chrono::DateTime<chrono::Utc>,
        next_run: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        let _io = self.io_lock.lock().await;
        {
            let mut data = self.data.write().await;
            if let Some(job) = data.jobs.iter_mut().find(|j| j.id == job_id) {
                job.last_run_at = Some(last_run);
                job.next_run_at = next_run;
                job.updated_at = chrono::Utc::now();
            }
        }
        self.persist_jobs().await;
    }

    /// Set only `next_run_at` (e.g. when filling in a missing schedule or re-enabling a job).
    /// Does not touch `last_run_at`.
    pub async fn update_next_run_at(
        &self,
        job_id: &str,
        next_run: Option<chrono::DateTime<chrono::Utc>>,
    ) {
        let _io = self.io_lock.lock().await;
        {
            let mut data = self.data.write().await;
            if let Some(job) = data.jobs.iter_mut().find(|j| j.id == job_id) {
                job.next_run_at = next_run;
                job.updated_at = chrono::Utc::now();
            }
        }
        self.persist_jobs().await;
    }

    // ==================== Run History ====================

    /// Append a run record for a job
    pub async fn append_run(&self, record: &CronRunRecord) {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let runs_dir = Self::runs_dir(ws);
            if !runs_dir.exists() {
                let _ = std::fs::create_dir_all(&runs_dir);
            }
            let run_file = Self::run_file(ws, &record.job_id);
            match serde_json::to_string(record) {
                Ok(line) => {
                    use std::io::Write;
                    match std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&run_file)
                    {
                        Ok(mut file) => {
                            if let Err(e) = writeln!(file, "{}", line) {
                                log::error!("[Cron] Failed to write run record: {}", e);
                            }
                        }
                        Err(e) => {
                            log::error!("[Cron] Failed to open run file: {}", e);
                        }
                    }
                }
                Err(e) => {
                    log::error!("[Cron] Failed to serialize run record: {}", e);
                }
            }
        }
    }

    /// Update the last run record for a job (used when a run completes)
    pub async fn update_last_run(&self, record: &CronRunRecord) {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let run_file = Self::run_file(ws, &record.job_id);
            if !run_file.exists() {
                // No runs file, just append
                drop(workspace);
                self.append_run(record).await;
                return;
            }

            // Read all lines, update the last one with matching run_id
            match std::fs::read_to_string(&run_file) {
                Ok(content) => {
                    let mut lines: Vec<String> = content
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .map(|l| l.to_string())
                        .collect();

                    let mut found = false;
                    for line in lines.iter_mut().rev() {
                        if let Ok(existing) = serde_json::from_str::<CronRunRecord>(line) {
                            if existing.run_id == record.run_id {
                                if let Ok(updated_line) = serde_json::to_string(record) {
                                    *line = updated_line;
                                    found = true;
                                    break;
                                }
                            }
                        }
                    }

                    if found {
                        let new_content = lines.join("\n") + "\n";
                        if let Err(e) = std::fs::write(&run_file, new_content) {
                            log::error!("[Cron] Failed to update run file: {}", e);
                        }
                    }
                }
                Err(e) => {
                    log::error!("[Cron] Failed to read run file: {}", e);
                }
            }
        }
    }

    /// Get run history for a job (most recent first, with optional limit)
    /// Get run history for a job.
    ///
    /// Performance note: Currently reads and parses the entire file, then truncates
    /// to the requested limit. For jobs with thousands of runs, this could be slow.
    /// Future optimization: read from end of file backwards and stop after `limit` lines.
    pub async fn get_runs(&self, job_id: &str, limit: Option<usize>) -> Vec<CronRunRecord> {
        let workspace = self.workspace_path.read().await;
        if let Some(ws) = workspace.as_ref() {
            let run_file = Self::run_file(ws, job_id);
            if !run_file.exists() {
                return Vec::new();
            }

            match std::fs::read_to_string(&run_file) {
                Ok(content) => {
                    let mut records: Vec<CronRunRecord> = content
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .filter_map(|l| serde_json::from_str(l).ok())
                        .map(|mut record| {
                            normalize_legacy_timeout_status(&mut record);
                            record
                        })
                        .collect();

                    // Most recent first
                    records.reverse();

                    let mut seen_run_ids = std::collections::HashSet::new();
                    records.retain(|record| seen_run_ids.insert(record.run_id.clone()));

                    if let Some(limit) = limit {
                        records.truncate(limit);
                    }

                    records
                }
                Err(e) => {
                    log::error!("[Cron] Failed to read runs for {}: {}", job_id, e);
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        }
    }

    /// Get the latest persisted state for runs that were active when the app stopped.
    pub async fn get_latest_running_runs(&self) -> Vec<CronRunRecord> {
        let workspace = self.workspace_path.read().await;
        let Some(ws) = workspace.as_ref() else {
            return Vec::new();
        };

        let runs_dir = Self::runs_dir(ws);
        if !runs_dir.exists() {
            return Vec::new();
        }

        let mut records_by_run_id = std::collections::HashMap::<String, CronRunRecord>::new();
        if let Ok(entries) = std::fs::read_dir(&runs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for line in content.lines().filter(|l| !l.trim().is_empty()) {
                        if let Ok(mut record) = serde_json::from_str::<CronRunRecord>(line) {
                            normalize_legacy_timeout_status(&mut record);
                            records_by_run_id.insert(record.run_id.clone(), record);
                        }
                    }
                }
            }
        }

        records_by_run_id
            .into_values()
            .filter(|record| record.status == RunStatus::Running)
            .collect()
    }
}

#[cfg(test)]
mod tests {
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

    #[tokio::test]
    async fn get_runs_returns_only_latest_record_for_duplicate_run_id() {
        let tempdir = tempfile::tempdir().unwrap();
        let storage = CronStorage::new();
        storage.init(tempdir.path().to_str().unwrap()).await;

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

    fn make_job(id: &str) -> CronJob {
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

    // Regression: adding jobs while `list_jobs` (scheduler tick / UI poll)
    // concurrently reloads from disk must never drop a just-added job. Before
    // the io_lock, a reload could interleave between add_job's in-memory push
    // and its persist, clobbering the new job back to a stale on-disk copy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_adds_and_reloads_do_not_drop_jobs() {
        let workspace = tempfile::tempdir().unwrap();
        let storage = CronStorage::new();
        storage.init(workspace.path().to_str().unwrap()).await;

        let mut handles = Vec::new();
        for i in 0..50 {
            let s = storage.clone();
            handles.push(tokio::spawn(async move {
                s.add_job(make_job(&format!("job-{i}"))).await;
            }));
            let s = storage.clone();
            handles.push(tokio::spawn(async move {
                let _ = s.list_jobs().await; // triggers reload_jobs_from_disk
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        assert_eq!(storage.list_jobs().await.len(), 50);
    }

    #[tokio::test]
    async fn list_jobs_reflects_external_file_changes() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().to_str().unwrap();
        let storage = CronStorage::new();

        storage.init(workspace_path).await;
        assert!(storage.list_jobs().await.is_empty());

        let now = Utc::now().to_rfc3339();
        let jobs_path = CronStorage::jobs_path(workspace_path);
        std::fs::create_dir_all(jobs_path.parent().unwrap()).unwrap();
        std::fs::write(
            &jobs_path,
            serde_json::to_string_pretty(&json!({
                "jobs": [{
                    "id": "external-job",
                    "name": "External job",
                    "enabled": true,
                    "schedule": { "kind": "cron", "expr": "0 9 * * *" },
                    "payload": { "message": "hello" },
                    "deleteAfterRun": false,
                    "createdAt": now,
                    "updatedAt": now
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let jobs = storage.list_jobs().await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "external-job");
    }
}
