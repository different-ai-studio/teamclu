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
}

impl SyncDispatcher {
    pub fn new(secrets: SecretStore, backend: Option<Arc<dyn crate::backend::Backend>>) -> Self {
        Self {
            secrets,
            backend,
            locks: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn secrets(&self) -> &SecretStore {
        &self.secrets
    }

    pub async fn team_share_gate(&self, team_id: &str) -> crate::team_link::TeamShareGate {
        match &self.backend {
            Some(b) => crate::team_link::team_share_gate(b.as_ref(), team_id).await,
            None => crate::team_link::TeamShareGate::Enabled,
        }
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
        self.status
            .lock()
            .await
            .get(team_id)
            .cloned()
            .unwrap_or_default()
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
        let result = self.run_once(team_id, options).await;
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

    async fn run_once(&self, team_id: &str, options: SyncOptions) -> Result<SyncStatus, String> {
        if !options.force && !crate::config::DaemonConfig::team_share_auto_sync_enabled_from_disk()
        {
            return Ok(SyncStatus {
                skipped: true,
                last_sync_at: now_rfc3339(),
                ..Default::default()
            });
        }
        use crate::sync::oss;
        // The share mode comes from FC; the OSS content secret comes from the
        // per-team secret store.
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "no cloud backend for sync".to_string())?;
        let share = backend
            .team_share_config(team_id)
            .await
            .map_err(|e| e.to_string())?;
        let content_root_dir = crate::config::global_team_store::sync_content_root(team_id);
        match share.mode.as_deref() {
            Some("oss") => {
                let secret = self.secrets.resolve_team_secret(team_id, None)?;
                let jwt = self.oss_jwt().await?;
                let fc = oss::fc_client::FcClient::new(self.fc_endpoint()?, jwt);
                let content_root = content_root_dir.to_string_lossy().to_string();
                let r = oss::tick(&content_root, team_id, &secret, &fc)
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
            _ => Ok(SyncStatus {
                mode: None,
                last_sync_at: now_rfc3339(),
                ..Default::default()
            }),
        }
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;

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

    #[test]
    fn fc_endpoint_errors_without_backend() {
        let d = SyncDispatcher::new(crate::sync::secret_store::SecretStore::new(), None);
        assert!(d.fc_endpoint().is_err());
    }
}
