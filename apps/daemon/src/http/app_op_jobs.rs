//! Long app operations — `deploy` and `undeploy` — run here, in the daemon,
//! not in the CLI that asked (P2.5 S3, CLI design §2.6).
//!
//! The CLI is only a waiter: a model's own bash timeout or a Ctrl-C kills the
//! waiter and leaves the operation running, and `amuxd app op wait <op>`
//! picks the wait up again. Each operation is a record keyed by an `op_…`
//! id, kept in memory while this daemon runs and written to disk so the
//! answer survives a restart — where a record still `running` on disk means
//! the daemon stopped mid-way, and the honest answer is `unknown`.
//!
//! States: `running`, then one of `succeeded`, `failed` (nothing to retry
//! blindly about it: the error says what to do) or `unknown` (it may or may
//! not have happened — exit 8, never retry without looking first).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use teamclu_apps::{ErrorKind, OpError};
use tokio::sync::watch;

/// How long a record stays on disk.
const KEEP_FOR: chrono::Duration = chrono::Duration::days(7);
/// The longest one `op_wait` call holds the request open; the CLI loops.
pub const MAX_WAIT: Duration = Duration::from_secs(30);
/// How long an ended operation stays in memory, for waiters already
/// attached; after that it is read from disk like any other.
const LIVE_GRACE: Duration = Duration::from_secs(10 * 60);

/// Whether `op` is an id this module made (`op_` + 12 hex): anything else —
/// a path, another team's folder — is not looked up at all.
fn valid_op_id(op: &str) -> bool {
    op.strip_prefix("op_")
        .is_some_and(|hex| hex.len() == 12 && hex.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct OpRecord {
    pub op: String,
    pub action: String,
    pub team_id: String,
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub state: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The flow's `data` on success.
    pub result: Option<Value>,
    /// The contract's `error` object on failure or unknown outcome.
    pub error: Option<Value>,
}

impl OpRecord {
    pub fn is_terminal(&self) -> bool {
        self.state != "running"
    }

    /// The snapshot `op status` / `op list` answer with.
    pub fn snapshot(&self) -> Value {
        let end = self.finished_at.unwrap_or_else(chrono::Utc::now);
        json!({
            "op": self.op,
            "action": self.action,
            "state": self.state,
            "app": { "id": self.app_id, "name": self.app_name },
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_s": (end - self.started_at).num_seconds().max(0),
            "result": self.result,
            "error": self.error,
        })
    }
}

/// The interruption a record still `running` on disk stands for.
fn interrupted(mut rec: OpRecord) -> OpRecord {
    rec.state = "unknown".into();
    rec.finished_at.get_or_insert_with(chrono::Utc::now);
    rec.error = Some(
        OpError::unknown(
            "daemon_restarted",
            format!(
                "amuxd stopped while this {} was running, so whether it finished is unknown — check the app before trying again",
                rec.action
            ),
        )
        .with_next("amuxd app status")
        .to_json(),
    );
    rec
}

/// The live operations of this daemon process.
static LIVE: LazyLock<Mutex<HashMap<String, watch::Sender<OpRecord>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Where one team's records are kept.
#[derive(Debug, Clone)]
pub struct OpStore {
    dir: PathBuf,
}

impl OpStore {
    pub fn new(root: &Path, team_id: &str) -> Self {
        Self {
            dir: root.join("app-ops").join(team_id),
        }
    }

    fn path(&self, op: &str) -> PathBuf {
        self.dir.join(format!("{op}.json"))
    }

    fn persist(&self, rec: &OpRecord) {
        // Best effort: the record in memory is the answer while this daemon
        // runs; the file only matters after a restart.
        if std::fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        if let Ok(text) = serde_json::to_vec(rec) {
            let tmp = self.dir.join(format!(".{}.tmp", rec.op));
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, self.path(&rec.op));
            }
        }
    }

    fn read(&self, op: &str) -> Option<OpRecord> {
        let text = std::fs::read(self.path(op)).ok()?;
        serde_json::from_slice(&text).ok()
    }

    /// Start `run` as operation `action` on the app, returning its record.
    pub fn start<F>(
        &self,
        action: &str,
        team_id: &str,
        app_id: Option<String>,
        app_name: Option<String>,
        run: F,
    ) -> OpRecord
    where
        F: std::future::Future<Output = Result<Value, OpError>> + Send + 'static,
    {
        let rec = OpRecord {
            op: format!("op_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            action: action.to_string(),
            team_id: team_id.to_string(),
            app_id,
            app_name,
            state: "running".into(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            result: None,
            error: None,
        };
        self.persist(&rec);
        let (tx, _) = watch::channel(rec.clone());
        LIVE.lock().unwrap().insert(rec.op.clone(), tx.clone());

        let store = self.clone();
        let op = rec.op.clone();
        tokio::spawn(async move {
            // A panic in the flow must still end the record, as unknown.
            let outcome = tokio::spawn(run).await;
            let mut done = tx.borrow().clone();
            done.finished_at = Some(chrono::Utc::now());
            match outcome {
                Ok(Ok(data)) => {
                    done.state = "succeeded".into();
                    done.result = Some(data);
                }
                Ok(Err(e)) => {
                    done.state = if e.kind == ErrorKind::Unknown {
                        "unknown"
                    } else {
                        "failed"
                    }
                    .into();
                    done.error = Some(e.to_json());
                }
                Err(join) => {
                    done.state = "unknown".into();
                    done.error = Some(
                        OpError::unknown(
                            "op_crashed",
                            format!("the {} stopped unexpectedly ({join}); whether it finished is unknown", done.action),
                        )
                        .with_next("amuxd app status")
                        .to_json(),
                    );
                }
            }
            store.persist(&done);
            tracing::info!(op = %op, state = %done.state, "app operation finished");
            tx.send_replace(done);
            // Ended: memory only needs it while a waiter could still be
            // attached; the disk record answers after that.
            tokio::time::sleep(LIVE_GRACE).await;
            LIVE.lock().unwrap().remove(&op);
        });
        rec
    }

    /// The record now: live, or from disk (where `running` means the
    /// daemon stopped mid-way).
    pub fn get(&self, op: &str) -> Option<OpRecord> {
        if !valid_op_id(op) {
            return None;
        }
        let team = self.team_of_dir();
        if let Some(tx) = LIVE.lock().unwrap().get(op) {
            let rec = tx.borrow().clone();
            return (rec.team_id == team).then_some(rec);
        }
        self.read(op).filter(|rec| rec.team_id == team).map(|rec| {
            if rec.is_terminal() {
                rec
            } else {
                interrupted(rec)
            }
        })
    }

    fn team_of_dir(&self) -> String {
        self.dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// Wait up to `timeout` for the operation to end; the record either way.
    pub async fn wait(&self, op: &str, timeout: Duration) -> Option<OpRecord> {
        if !valid_op_id(op) {
            return None;
        }
        let rx = LIVE.lock().unwrap().get(op).map(|tx| tx.subscribe());
        let Some(mut rx) = rx else {
            return self.get(op);
        };
        let _ = tokio::time::timeout(timeout, rx.wait_for(|r| r.is_terminal())).await;
        self.get(op)
    }

    /// Newest first, at most `limit`; records older than [`KEEP_FOR`] are
    /// removed on the way.
    pub fn list(&self, active_only: bool, limit: usize) -> Vec<OpRecord> {
        let mut out: HashMap<String, OpRecord> = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            let cutoff = chrono::Utc::now() - KEEP_FOR;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(op) = name.strip_suffix(".json") else {
                    continue;
                };
                match self.get(op) {
                    Some(rec) if rec.started_at < cutoff && rec.is_terminal() => {
                        let _ = std::fs::remove_file(entry.path());
                    }
                    Some(rec) => {
                        out.insert(rec.op.clone(), rec);
                    }
                    None => {}
                }
            }
        }
        let team = self.team_of_dir();
        let cutoff = chrono::Utc::now() - KEEP_FOR;
        for tx in LIVE.lock().unwrap().values() {
            let rec = tx.borrow().clone();
            if rec.team_id == team && (rec.started_at >= cutoff || !rec.is_terminal()) {
                out.insert(rec.op.clone(), rec);
            }
        }
        let mut list: Vec<OpRecord> = out
            .into_values()
            .filter(|r| !active_only || !r.is_terminal())
            .collect();
        list.sort_by_key(|r| std::cmp::Reverse(r.started_at));
        list.truncate(limit);
        list
    }

    /// The operations still running on one app.
    pub fn active_on(&self, app_id: &str) -> Vec<Value> {
        self.list(true, 20)
            .into_iter()
            .filter(|r| r.app_id.as_deref() == Some(app_id))
            .map(|r| r.snapshot())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `LIVE` is process-wide and `list()` folds it in by team id alone, while
    // cargo runs these tests on parallel threads in one process. Tests that
    // start operations therefore each use their own team and app ids; sharing
    // `t1`/`a1` let one test's briefly-running deploy show up in another's
    // `active_on("a1")` (seen in CI as `left: 2, right: 1`).

    async fn finished(store: &OpStore, op: &str) -> OpRecord {
        store.wait(op, Duration::from_secs(5)).await.unwrap()
    }

    #[tokio::test]
    async fn an_operation_ends_in_the_state_its_outcome_says() {
        let dir = tempfile::tempdir().unwrap();
        let store = OpStore::new(dir.path(), "t-outcomes");

        let ok = store.start(
            "deploy",
            "t-outcomes",
            Some("a-outcomes".into()),
            None,
            async { Ok(json!({ "deployed": true })) },
        );
        assert_eq!(ok.state, "running");
        let ok = finished(&store, &ok.op).await;
        assert_eq!(ok.state, "succeeded");
        assert_eq!(ok.result.unwrap()["deployed"], true);

        let failed = store.start("deploy", "t-outcomes", None, None, async {
            Err(OpError::conflict(
                "deploy_locked",
                "another deploy is running",
            ))
        });
        let failed = finished(&store, &failed.op).await;
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.error.unwrap()["exit"], 6);

        let unknown = store.start("deploy", "t-outcomes", None, None, async {
            Err(OpError::unknown("deploy_outcome_unknown", "no answer"))
        });
        assert_eq!(finished(&store, &unknown.op).await.state, "unknown");

        let crashed = store.start("undeploy", "t-outcomes", None, None, async {
            panic!("boom");
        });
        let crashed = finished(&store, &crashed.op).await;
        assert_eq!(crashed.state, "unknown");
        assert_eq!(crashed.error.unwrap()["code"], "op_crashed");
    }

    #[tokio::test]
    async fn a_wait_that_runs_out_returns_the_running_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = OpStore::new(dir.path(), "t-wait-runs-out");
        let rec = store.start(
            "deploy",
            "t-wait-runs-out",
            Some("a-wait".into()),
            None,
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(json!({}))
            },
        );
        let snap = store
            .wait(&rec.op, Duration::from_millis(50))
            .await
            .unwrap();
        assert_eq!(snap.state, "running");
        assert_eq!(store.active_on("a-wait").len(), 1);
        assert_eq!(store.list(true, 10).len(), 1);
    }

    #[test]
    fn a_record_left_running_by_a_previous_daemon_reads_as_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let store = OpStore::new(dir.path(), "t1");
        let rec = OpRecord {
            op: "op_0123456789ab".into(),
            action: "deploy".into(),
            team_id: "t1".into(),
            app_id: Some("a1".into()),
            app_name: None,
            state: "running".into(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            result: None,
            error: None,
        };
        store.persist(&rec);
        let got = store.get("op_0123456789ab").unwrap();
        assert_eq!(got.state, "unknown");
        assert_eq!(got.error.unwrap()["exit"], 8);
        assert!(OpStore::new(dir.path(), "t2")
            .get("op_0123456789ab")
            .is_none());
        // Not an id this module made: never turned into a path.
        assert!(store.get("../t1/op_0123456789ab").is_none());
        assert!(!valid_op_id("op_0123456789ab/../x"));
    }
}
