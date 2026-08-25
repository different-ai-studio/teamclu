//! Per-team sync dispatch: runs the OSS engine, serializes runs behind a
//! per-team mutex, and caches the last status for the HTTP status endpoint.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::sync::secret_store::SecretStore;

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
}

impl SyncDispatcher {
    pub fn new(secrets: SecretStore, backend: Option<Arc<dyn crate::backend::Backend>>) -> Self {
        Self {
            secrets,
            backend,
            locks: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(Mutex::new(HashMap::new())),
            progress: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
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

        // The precondition is the team secret, not a cloud flag.
        //
        // This used to ask FC for the team's `share_mode` and do nothing unless
        // it read `"oss"`. Nothing in the product sets that flag any more — no
        // client ships a call to `POST /v1/teams/:id/share-mode` — so every team
        // created since reads as "off" and never synced, silently, with a
        // successful-looking status. The secret is the honest precondition: it
        // is what encrypts and decrypts the content, a team without one cannot
        // sync no matter what any flag says, and one with it always can.
        let Ok(secret) = self.secrets.resolve_team_secret(team_id, None) else {
            // Not an error: a team that never set up sharing has nothing to
            // sync, and a red banner for that is noise, not information.
            return Ok(SyncStatus {
                skipped: true,
                last_sync_at: now_rfc3339(),
                ..Default::default()
            });
        };

        let content_root_dir = crate::config::global_team_store::sync_content_root(team_id);
        let jwt = self.oss_jwt().await?;
        let fc = oss::fc_client::FcClient::new(self.fc_endpoint()?, jwt);
        let content_root = content_root_dir.to_string_lossy().to_string();
        let r = oss::tick_with_progress(&content_root, team_id, &secret, &fc, progress)
            .await
            .map_err(|e| e.to_string())?;
        Ok(SyncStatus {
            mode: Some("oss".into()),
            last_sync_at: now_rfc3339(),
            pulled: r.pulled,
            pushed: r.pushed,
            conflicts: r.conflicts,
            failed: r.failed,
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
        let st = d.sync_team("t", SyncOptions { force: false }).await;
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
        // A team secret is the precondition for syncing at all; without one the
        // tick skips instead of erroring, and this test needs a real error to
        // cache. With the secret in place it gets one from the missing backend.
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
        let err_st = d.sync_team("t", SyncOptions { force: true }).await;
        assert!(err_st.last_error.is_some());

        team.team_share.auto_sync = false;
        crate::config::team_config::save_typed(&crate::config::layout::active_team(), &team)
            .unwrap();

        let st = d.sync_team("t", SyncOptions { force: false }).await;
        assert!(st.skipped);
        assert!(st.last_error.is_some());

        if let Some(v) = orig {
            std::env::set_var("AMUXD_HOME", v);
        } else {
            std::env::remove_var("AMUXD_HOME");
        }
    }

    /// A team that never set up sharing has nothing to sync. That used to be
    /// decided by the cloud `share_mode` flag — which nothing sets any more — so
    /// the honest precondition is the team secret: without it there is nothing
    /// to encrypt or decrypt with, and a red banner would be noise.
    #[tokio::test]
    async fn a_team_without_a_secret_skips_rather_than_erroring() {
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
            .sync_team("no-secret-team", SyncOptions { force: true })
            .await;

        assert!(st.skipped);
        assert!(st.last_error.is_none());

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
}
