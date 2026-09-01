//! Per-team sync dispatch: runs the OSS engine, serializes runs behind a
//! per-team mutex, and caches the last status for the HTTP status endpoint.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

use crate::sync::oss::state::LocalSyncState;
use crate::sync::scheduler::{SyncScheduler, SystemClock, Trigger};
use crate::sync::secret_store::SecretStore;

/// Decoded MQTT knowledge sync hint (`amux/<team>/sync/knowledge`).
#[derive(Debug, Clone, PartialEq)]
pub struct SyncHintPayload {
    pub v: i64,
    pub change_seq: i64,
    pub origin_node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncHintDecision {
    /// Schedule a Remote trigger with this seq.
    Accept { seq: i64 },
    /// Our own upload echoed back — drop.
    DropEcho,
    /// Already covered by local high-water — drop.
    DropStale,
    /// Unknown wire version — drop (caller warns once).
    DropUnknownVersion,
}

/// Parse the JSON body published by FC. Missing/invalid fields → `None`.
pub fn parse_sync_hint_payload(bytes: &[u8]) -> Option<SyncHintPayload> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let v = value.get("v")?.as_i64()?;
    let change_seq = value.get("changeSeq")?.as_i64()?;
    if change_seq <= 0 {
        return None;
    }
    let origin_node_id = value
        .get("originNodeId")
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(SyncHintPayload {
        v,
        change_seq,
        origin_node_id,
    })
}

/// Echo / high-water / version filters before the per-team scheduler.
pub fn evaluate_sync_hint(
    hint: &SyncHintPayload,
    high_water: i64,
    self_node_id: &str,
) -> SyncHintDecision {
    if hint.v != 1 {
        return SyncHintDecision::DropUnknownVersion;
    }
    if hint
        .origin_node_id
        .as_deref()
        .is_some_and(|id| id == self_node_id)
    {
        return SyncHintDecision::DropEcho;
    }
    if hint.change_seq <= high_water {
        return SyncHintDecision::DropStale;
    }
    SyncHintDecision::Accept {
        seq: hint.change_seq,
    }
}

fn warn_unknown_hint_version_once(v: i64) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        tracing::warn!(v, "dropping knowledge sync hint with unknown version");
    }
}

/// A hint whose topic names a team this daemon is not onboarded to. Never
/// expected; warn once rather than per message so a misconfigured broker cannot
/// flood the log.
fn warn_foreign_hint_team_once() {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        tracing::warn!("dropping knowledge sync hint addressed to another team");
    }
}

/// Per-team coalescing state + wake handle for the background fire driver.
///
/// The 300s timer and manual force sync bypass this path entirely.
struct TeamSchedulerSlot {
    logic: std::sync::Mutex<SyncScheduler>,
    wake: Notify,
    driver_started: AtomicBool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub mode: Option<String>,
    pub last_sync_at: String,
    pub syncing: bool,
    pub last_error: Option<String>,
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
    /// Files the server offered that we failed to pull this tick. Non-zero
    /// means the sync cursor is deliberately being held back so they get
    /// retried, and the UI should not present the tick as fully clean.
    pub failed: u32,
    /// Set when sync was skipped because `team_share.auto_sync` is disabled.
    #[serde(default)]
    pub skipped: bool,
    /// Paths this tick refused to upload for being over the per-file size
    /// limit. Not an error — but the user believes these went up unless told.
    #[serde(default)]
    pub oversize: Vec<String>,
    /// How many new files were held back pending confirmation, if any. The UI
    /// turns this into "you added N files at once — send them?".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_new_files: Option<u32>,
    /// How many deletions were held back pending confirmation, if any. The UI
    /// turns this into "this would delete N files for everyone — go ahead?".
    ///
    /// Worth a sharper prompt than the add-side one: an unexpected pile of
    /// deletions is more often a scan that came back short — an unmounted
    /// drive, a moved directory — than an actual intent to delete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_deletes: Option<u32>,
    /// How far the RUNNING tick has got. `None` whenever nothing is running —
    /// it is live state, not a record of the last tick, so a finished sync can
    /// never be left looking like an in-flight one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<crate::sync::oss::SyncProgress>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SyncOptions {
    /// When `true`, run sync even if `team_share.auto_sync` is `false`.
    pub force: bool,
    /// When `true`, push a batch of new files a previous tick held back.
    ///
    /// This is a person's answer to "you added N files at once — send them?",
    /// so it must never be set by the timer or by any automatic retry: doing so
    /// turns the guard into a one-tick delay.
    pub allow_bulk_add: bool,
    /// When `true`, broadcast a set of deletions a previous tick held back.
    ///
    /// Same rule as `allow_bulk_add`, and it matters more here: the timer or an
    /// automatic retry setting this would turn a guard on **other people's**
    /// files into a one-tick delay.
    pub allow_bulk_delete: bool,
}

#[derive(Clone)]
pub struct SyncDispatcher {
    secrets: SecretStore,
    /// Cloud backend used to self-supply the FC bearer for OSS sync. `None` in
    /// tests / harnesses that never run a real OSS tick.
    backend: Option<Arc<dyn crate::backend::Backend>>,
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    status: Arc<Mutex<HashMap<String, SyncStatus>>>,
    /// Progress of in-flight ticks. A std mutex, not the tokio one the rest of
    /// this struct uses: the engine reports from inside its transfer loops, in
    /// sync code, and this lock is only ever held for one map write.
    progress: Arc<std::sync::Mutex<HashMap<String, crate::sync::oss::SyncProgress>>>,
    /// One coalescing scheduler per team. Fed by fs-watch / MQTT hint (Tasks 3
    /// & 8); fires call [`Self::sync_team`] with `force: false`.
    team_schedulers: Arc<Mutex<HashMap<String, Arc<TeamSchedulerSlot>>>>,
}

impl SyncDispatcher {
    pub fn new(secrets: SecretStore, backend: Option<Arc<dyn crate::backend::Backend>>) -> Self {
        Self {
            secrets,
            backend,
            locks: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(Mutex::new(HashMap::new())),
            progress: Arc::new(std::sync::Mutex::new(HashMap::new())),
            team_schedulers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Feed a Local / Remote trigger into the per-team coalescing scheduler.
    ///
    /// Does not run sync inline: the team driver wakes at the scheduled fire
    /// time and calls [`Self::sync_team`]. The 300s timer and `POST /v1/team/sync`
    /// (force) must not call this.
    pub async fn trigger_sync(&self, team_id: &str, trigger: Trigger) {
        let team_id = team_id.trim();
        if team_id.is_empty() {
            return;
        }
        let slot = self.scheduler_slot(team_id).await;
        {
            let mut logic = slot.logic.lock().unwrap_or_else(|e| e.into_inner());
            logic.trigger(&SystemClock, trigger);
        }
        self.ensure_scheduler_driver(team_id, slot.clone());
        slot.wake.notify_one();
    }

    /// Apply MQTT sync-hint filters, then [`Self::trigger_sync`] with
    /// [`Trigger::Remote`] when the hint is actionable.
    ///
    /// Manual checklist (do not automate): A→B ≤10s; ≤10 hints for 2000 files;
    /// no re-tick on own echo once nodeId set; EMQX down → 300s timer still
    /// works / no rebuild loop beyond backoff; pre-migration token → one warn,
    /// worker not rebuilt; payload has no paths; rate / coalesce / pull
    /// self-write checks from the plan.
    ///
    /// `own_team_id` is the team this daemon is onboarded to. The hint's team
    /// comes from a topic segment, and a topic segment is not a capability: a
    /// misrouted or hostile publish carrying `..` would otherwise resolve
    /// `sync_content_root("..")` to the amuxd home itself, and every distinct
    /// value would permanently allocate a scheduler slot plus a driver task that
    /// never exits. A correct broker cannot deliver one — the subscribe filter
    /// pins the team — so this is defence in depth, and cheap.
    pub async fn handle_sync_hint(
        &self,
        own_team_id: &str,
        team_id: &str,
        resource: &str,
        payload: &[u8],
    ) {
        if team_id.trim().is_empty() || team_id != own_team_id.trim() {
            warn_foreign_hint_team_once();
            return;
        }
        // `subscriber::parse_frame` already drops every other resource; this is
        // the public entry point's own contract, not a duplicate of that filter.
        if resource != "knowledge" {
            return;
        }
        let Some(hint) = parse_sync_hint_payload(payload) else {
            return;
        };
        let high_water = LocalSyncState::load_at(team_id)
            .map(|s| s.last_server_seq)
            .unwrap_or(0);
        let self_id = crate::device_id::daemon_device_id();
        match evaluate_sync_hint(&hint, high_water, &self_id) {
            SyncHintDecision::Accept { seq } => {
                self.trigger_sync(team_id, Trigger::Remote { seq }).await;
            }
            SyncHintDecision::DropEcho | SyncHintDecision::DropStale => {}
            SyncHintDecision::DropUnknownVersion => {
                warn_unknown_hint_version_once(hint.v);
            }
        }
    }

    async fn scheduler_slot(&self, team_id: &str) -> Arc<TeamSchedulerSlot> {
        let mut map = self.team_schedulers.lock().await;
        map.entry(team_id.to_string())
            .or_insert_with(|| {
                Arc::new(TeamSchedulerSlot {
                    logic: std::sync::Mutex::new(SyncScheduler::new()),
                    wake: Notify::new(),
                    driver_started: AtomicBool::new(false),
                })
            })
            .clone()
    }

    fn ensure_scheduler_driver(&self, team_id: &str, slot: Arc<TeamSchedulerSlot>) {
        if slot.driver_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let dispatcher = self.clone();
        let team_id = team_id.to_string();
        tokio::spawn(async move {
            loop {
                let wait = {
                    let logic = slot.logic.lock().unwrap_or_else(|e| e.into_inner());
                    match logic.next_fire_at() {
                        Some(at) => Some(at.saturating_duration_since(Instant::now())),
                        None => None,
                    }
                };
                match wait {
                    None => {
                        slot.wake.notified().await;
                        continue;
                    }
                    Some(Duration::ZERO) => {}
                    Some(d) => {
                        tokio::select! {
                            _ = slot.wake.notified() => continue,
                            _ = tokio::time::sleep(d) => {}
                        }
                    }
                }

                let should_run = {
                    let mut logic = slot.logic.lock().unwrap_or_else(|e| e.into_inner());
                    logic.try_begin_tick(&SystemClock)
                };
                if !should_run {
                    continue;
                }

                let st = dispatcher
                    .sync_team(
                        &team_id,
                        SyncOptions {
                            force: false,
                            allow_bulk_add: false,
                            allow_bulk_delete: false,
                        },
                    )
                    .await;
                if let Some(err) = &st.last_error {
                    tracing::warn!(team_id, "scheduler sync error: {err}");
                }

                {
                    let mut logic = slot.logic.lock().unwrap_or_else(|e| e.into_inner());
                    logic.end_tick(&SystemClock);
                }
                // Re-check immediately: mid-tick triggers may already be due on floor.
                slot.wake.notify_one();
            }
        });
    }

    pub fn secrets(&self) -> &SecretStore {
        &self.secrets
    }

    /// FC base URL for OSS sync: the cloud URL from the authenticated backend.
    /// Returns an error if no backend is configured or it exposes no URL.
    pub fn fc_endpoint(&self) -> Result<String, String> {
        self.backend
            .as_ref()
            .and_then(|b| b.cloud_base_url())
            .filter(|u| !u.trim().is_empty())
            .ok_or_else(|| "FC endpoint not configured: no cloud backend URL available".to_string())
    }

    /// FC bearer for OSS sync: the daemon's own auto-refreshing cloud token.
    pub async fn oss_jwt(&self) -> Result<String, String> {
        match &self.backend {
            Some(b) => b
                .auth_token()
                .await
                .map_err(|e| format!("daemon auth_token: {e}")),
            None => Err("no cloud backend available for OSS jwt".to_string()),
        }
    }

    pub async fn status(&self, team_id: &str) -> SyncStatus {
        let mut status: SyncStatus = self
            .status
            .lock()
            .await
            .get(team_id)
            .cloned()
            .unwrap_or_default();
        status.progress = self
            .progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(team_id)
            .copied();
        status
    }

    async fn team_lock(&self, team_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock().await;
        map.entry(team_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Sync one team for one workspace path. Serialized per team_id.
    /// Sync one team's shared tree.
    ///
    /// Takes no workspace: the synced content root is
    /// `~/.amuxd[-<brand>]/teams/<id>/shared`, which belongs to the team, not to
    /// any workspace. The parameter used to be here and was already unused —
    /// keeping it made every caller invent a workspace it did not need, and made
    /// "no folder open" look like "cannot sync".
    pub async fn sync_team(&self, team_id: &str, options: SyncOptions) -> SyncStatus {
        let lock = self.team_lock(team_id).await;
        let _guard = lock.lock().await;
        {
            let mut s = self.status.lock().await;
            s.entry(team_id.to_string()).or_default().syncing = true;
        }
        let sink = {
            let map = self.progress.clone();
            let key = team_id.to_string();
            crate::sync::oss::ProgressSink::new(move |p| {
                map.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key.clone(), p);
            })
        };
        let result = self.run_once(team_id, options, &sink).await;
        // Drop the live progress before publishing the result: a reader that
        // catches the gap must see "not syncing" with no bar, never a finished
        // sync still showing 7/10.
        self.progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(team_id);
        let mut s = self.status.lock().await;
        let entry = s.entry(team_id.to_string()).or_default();
        match result {
            Ok(st) if st.skipped => {
                // auto_sync off: do not replace cached mode/errors/counts with defaults.
                entry.syncing = false;
                entry.skipped = true;
            }
            Ok(mut st) => {
                st.syncing = false;
                st.skipped = false;
                *entry = st;
            }
            Err(e) => {
                entry.syncing = false;
                entry.skipped = false;
                entry.last_error = Some(e);
            }
        }
        entry.clone()
    }

    async fn run_once(
        &self,
        team_id: &str,
        options: SyncOptions,
        progress: &crate::sync::oss::ProgressSink,
    ) -> Result<SyncStatus, String> {
        if !options.force && !crate::config::DaemonConfig::team_share_auto_sync_enabled_from_disk()
        {
            return Ok(SyncStatus {
                skipped: true,
                last_sync_at: now_rfc3339(),
                ..Default::default()
            });
        }
        use crate::sync::oss;

        // No precondition left to check here.
        //
        // `share_mode` went first (nothing in the product ever set it), and the
        // team secret follows it now that knowledge content is uploaded as
        // plaintext: a team without a secret syncs fine, and one with a secret
        // additionally gets to read the blobs written before that change. The
        // secret is therefore fetched, not required.
        let secret = self.secrets.resolve_team_secret(team_id, None).ok();

        let content_root_dir = crate::config::global_team_store::sync_content_root(team_id);
        let jwt = self.oss_jwt().await?;
        let fc = oss::fc_client::FcClient::new(self.fc_endpoint()?, jwt);
        let content_root = content_root_dir.to_string_lossy().to_string();
        let r = oss::tick_with_progress(
            &content_root,
            team_id,
            secret.as_deref(),
            &fc,
            progress,
            oss::engine::TickOptions {
                allow_bulk_add: options.allow_bulk_add,
                allow_bulk_delete: options.allow_bulk_delete,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(SyncStatus {
            mode: Some("oss".into()),
            last_sync_at: now_rfc3339(),
            pulled: r.pulled,
            pushed: r.pushed,
            conflicts: r.conflicts,
            failed: r.failed,
            oversize: r.oversize,
            blocked_new_files: r.blocked_new_files,
            blocked_deletes: r.blocked_deletes,
            ..Default::default()
        })
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use crate::sync::oss::{SyncPhase, SyncProgress};

    /// The desktop reads this JSON verbatim and renders a bar from it, so the
    /// field names and the phase spelling are a contract, not an implementation
    /// detail.
    #[test]
    fn progress_serializes_as_the_client_reads_it() {
        let status = SyncStatus {
            syncing: true,
            progress: Some(SyncProgress {
                phase: SyncPhase::Pulling,
                done: 3,
                total: 12,
            }),
            ..Default::default()
        };
        let v = serde_json::to_value(&status).unwrap();
        assert_eq!(v["progress"]["phase"], "pulling");
        assert_eq!(v["progress"]["done"], 3);
        assert_eq!(v["progress"]["total"], 12);
    }

    /// An idle daemon must not carry a stale bar: the field is absent, which is
    /// what the client treats as "nothing running".
    #[test]
    fn an_idle_status_carries_no_progress_at_all() {
        let v = serde_json::to_value(SyncStatus::default()).unwrap();
        assert!(v.get("progress").is_none(), "{v}");
    }

    /// A dispatcher over a throwaway secret store, plus the mock backend.
    fn dispatcher_with_mock(tmp: &tempfile::TempDir) -> (SyncDispatcher, Arc<MockBackend>) {
        let backend = Arc::new(MockBackend::new());
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        let d = SyncDispatcher::new(store, Some(backend.clone()));
        (d, backend)
    }

    #[tokio::test]
    async fn auto_sync_disabled_skips_without_backend() {
        // AMUXD_HOME is process-wide. Without this lock the set/restore races
        // every other test that reads it, and the loser sees somebody else's
        // temp dir — which is how this test started failing intermittently on
        // CI while passing alone. Same lock the HOME-mutating tests in
        // team_link.rs take, for the same reason.
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        // auto_sync lives in the (unclaimed) team's team.toml now, so the env
        // must point at the temp home *before* the toggle is written.
        let orig = std::env::var("AMUXD_HOME").ok();
        std::env::set_var("AMUXD_HOME", tmp.path());
        let mut team = crate::config::team_config::TeamFileConfig::default();
        team.team_share.auto_sync = false;
        crate::config::team_config::save_typed(&crate::config::layout::active_team(), &team)
            .unwrap();

        let (d, _backend) = dispatcher_with_mock(&tmp);
        let st = d
            .sync_team(
                "t",
                SyncOptions {
                    force: false,
                    ..Default::default()
                },
            )
            .await;
        assert!(st.skipped);
        assert!(st.last_error.is_none());

        if let Some(v) = orig {
            std::env::set_var("AMUXD_HOME", v);
        } else {
            std::env::remove_var("AMUXD_HOME");
        }
    }

    #[tokio::test]
    async fn auto_sync_disabled_skip_preserves_cached_status() {
        // Same process-wide AMUXD_HOME as the sibling test above — they raced
        // each other directly.
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let orig = std::env::var("AMUXD_HOME").ok();
        std::env::set_var("AMUXD_HOME", tmp.path());
        // The toggle lives in team.toml now (see the sibling test above).
        let mut team = crate::config::team_config::TeamFileConfig::default();
        team.team_share.auto_sync = true;
        crate::config::team_config::save_typed(&crate::config::layout::active_team(), &team)
            .unwrap();

        let store = SecretStore::with_base(tmp.path().to_path_buf());
        // Secret is optional (plaintext knowledge); this test still plants one
        // so the tick proceeds far enough to hit the missing-backend error that
        // we then assert stays cached when auto_sync flips off.
        store
            .save(
                "t",
                &crate::sync::secret_store::TeamSecrets {
                    oss_team_secret: Some(
                        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20".into(),
                    ),
                    ..Default::default()
                },
            )
            .unwrap();
        let d = SyncDispatcher::new(store, None);
        let err_st = d
            .sync_team(
                "t",
                SyncOptions {
                    force: true,
                    ..Default::default()
                },
            )
            .await;
        assert!(err_st.last_error.is_some());

        team.team_share.auto_sync = false;
        crate::config::team_config::save_typed(&crate::config::layout::active_team(), &team)
            .unwrap();

        let st = d
            .sync_team(
                "t",
                SyncOptions {
                    force: false,
                    ..Default::default()
                },
            )
            .await;
        assert!(st.skipped);
        assert!(st.last_error.is_some());

        if let Some(v) = orig {
            std::env::set_var("AMUXD_HOME", v);
        } else {
            std::env::remove_var("AMUXD_HOME");
        }
    }

    /// Knowledge uploads are plaintext now, so a missing team secret must not
    /// skip the tick. Skipping here used to leave a device permanently idle
    /// with no banner — the same trap `share_mode` had when nothing set it.
    #[tokio::test]
    async fn a_team_without_a_secret_still_syncs() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let orig = std::env::var("AMUXD_HOME").ok();
        std::env::set_var("AMUXD_HOME", tmp.path());
        let mut team = crate::config::team_config::TeamFileConfig::default();
        team.team_share.auto_sync = true;
        crate::config::team_config::save_typed(&crate::config::layout::active_team(), &team)
            .unwrap();

        let (d, _backend) = dispatcher_with_mock(&tmp);
        let st = d
            .sync_team(
                "no-secret-team",
                SyncOptions {
                    force: true,
                    ..Default::default()
                },
            )
            .await;

        // Knowledge content is plaintext now, so a missing team secret is no
        // longer a reason to do nothing — it only means blobs written before
        // that change cannot be decoded. Skipping here is what made a device
        // with no secret look permanently, silently idle.
        assert!(!st.skipped, "a missing secret must not stop a sync");
        // The mock exposes no cloud URL, so the tick gets as far as asking for
        // one and stops there. That it got that far is the point.
        assert!(
            st.last_error
                .as_deref()
                .unwrap_or_default()
                .contains("FC endpoint"),
            "unexpected error: {:?}",
            st.last_error
        );

        if let Some(v) = orig {
            std::env::set_var("AMUXD_HOME", v);
        } else {
            std::env::remove_var("AMUXD_HOME");
        }
    }

    #[test]
    fn fc_endpoint_errors_without_backend() {
        let d = SyncDispatcher::new(crate::sync::secret_store::SecretStore::new(), None);
        assert!(d.fc_endpoint().is_err());
    }

    /// Tasks 3/8 will call this; until then the smoke test pins the wiring:
    /// one slot per team, driver armed, pure scheduler holding a next fire.
    #[tokio::test]
    async fn trigger_sync_arms_per_team_scheduler() {
        let d = SyncDispatcher::new(crate::sync::secret_store::SecretStore::new(), None);
        d.trigger_sync("team-a", Trigger::Local).await;
        d.trigger_sync("team-a", Trigger::Remote { seq: 9 }).await;

        let map = d.team_schedulers.lock().await;
        assert_eq!(map.len(), 1);
        let slot = map.get("team-a").expect("slot");
        assert!(slot.driver_started.load(Ordering::SeqCst));
        let logic = slot.logic.lock().unwrap_or_else(|e| e.into_inner());
        assert!(logic.next_fire_at().is_some());
        assert_eq!(logic.pending_remote_seq(), Some(9));
        assert!(!logic.in_tick());
    }

    #[test]
    fn sync_hint_drops_own_echo() {
        let hint = SyncHintPayload {
            v: 1,
            change_seq: 99,
            origin_node_id: Some("node-self".into()),
        };
        assert_eq!(
            evaluate_sync_hint(&hint, 0, "node-self"),
            SyncHintDecision::DropEcho
        );
    }

    #[test]
    fn sync_hint_drops_stale_or_equal_seq() {
        let hint = SyncHintPayload {
            v: 1,
            change_seq: 10,
            origin_node_id: Some("peer".into()),
        };
        assert_eq!(
            evaluate_sync_hint(&hint, 10, "self"),
            SyncHintDecision::DropStale
        );
        assert_eq!(
            evaluate_sync_hint(&hint, 11, "self"),
            SyncHintDecision::DropStale
        );
    }

    #[test]
    fn sync_hint_drops_unknown_version() {
        let hint = SyncHintPayload {
            v: 2,
            change_seq: 99,
            origin_node_id: None,
        };
        assert_eq!(
            evaluate_sync_hint(&hint, 0, "self"),
            SyncHintDecision::DropUnknownVersion
        );
    }

    #[test]
    fn sync_hint_accepts_newer_peer_change() {
        let hint = SyncHintPayload {
            v: 1,
            change_seq: 42,
            origin_node_id: Some("peer".into()),
        };
        assert_eq!(
            evaluate_sync_hint(&hint, 10, "self"),
            SyncHintDecision::Accept { seq: 42 }
        );
    }

    #[test]
    fn parse_sync_hint_payload_reads_fc_shape() {
        let raw = br#"{"v":1,"changeSeq":7,"originNodeId":"mac-1","at":"2026-08-26T07:12:00Z"}"#;
        let hint = parse_sync_hint_payload(raw).expect("parse");
        assert_eq!(hint.v, 1);
        assert_eq!(hint.change_seq, 7);
        assert_eq!(hint.origin_node_id.as_deref(), Some("mac-1"));
    }

    #[test]
    fn parse_sync_hint_payload_rejects_non_positive_seq() {
        assert!(parse_sync_hint_payload(br#"{"v":1,"changeSeq":0}"#).is_none());
        assert!(parse_sync_hint_payload(br#"{"v":1}"#).is_none());
    }

    #[tokio::test]
    async fn handle_sync_hint_triggers_remote_when_accepted() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let orig = std::env::var("AMUXD_HOME").ok();
        std::env::set_var("AMUXD_HOME", tmp.path());

        let d = SyncDispatcher::new(crate::sync::secret_store::SecretStore::new(), None);
        let payload = br#"{"v":1,"changeSeq":55,"originNodeId":"other-node"}"#;
        d.handle_sync_hint("team-hint", "team-hint", "knowledge", payload)
            .await;

        let map = d.team_schedulers.lock().await;
        let slot = map.get("team-hint").expect("scheduler armed");
        let logic = slot.logic.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(logic.pending_remote_seq(), Some(55));

        if let Some(v) = orig {
            std::env::set_var("AMUXD_HOME", v);
        } else {
            std::env::remove_var("AMUXD_HOME");
        }
    }

    /// A hint whose topic names another team (or a traversal segment) must not
    /// allocate a scheduler slot — each one would also spawn a driver task that
    /// never exits, and `..` resolves the content root to the amuxd home.
    #[tokio::test]
    async fn handle_sync_hint_rejects_foreign_team() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let orig = std::env::var("AMUXD_HOME").ok();
        std::env::set_var("AMUXD_HOME", tmp.path());

        let d = SyncDispatcher::new(crate::sync::secret_store::SecretStore::new(), None);
        let payload = br#"{"v":1,"changeSeq":55,"originNodeId":"other-node"}"#;
        for foreign in ["..", "someone-elses-team", ""] {
            d.handle_sync_hint("my-team", foreign, "knowledge", payload)
                .await;
        }

        assert!(
            d.team_schedulers.lock().await.is_empty(),
            "a hint for another team must not arm a scheduler"
        );

        if let Some(v) = orig {
            std::env::set_var("AMUXD_HOME", v);
        } else {
            std::env::remove_var("AMUXD_HOME");
        }
    }
}
