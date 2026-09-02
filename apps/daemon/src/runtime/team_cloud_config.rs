//! Mirrors the team config that now lives in the Cloud API (team MCP, team env)
//! onto a daemon-owned cache directory, so the synchronous readers can keep
//! reading files.
//!
//! Design: docs/architecture/team-mcp-and-env-cloud.md
//!
//! # Why a file cache instead of fetching at the call site
//!
//! [`crate::config::team_mcp::scan_team_mcp`] and
//! [`crate::team_shared_env::load_team_env_for_workspace_detailed`] are both
//! **synchronous**, and both are reached from synchronous call sites — most
//! importantly `assemble_spawn_runtime_env`, on the runtime spawn path. There is
//! no way to inline an `await` into them without either blocking a Tokio worker
//! or restructuring every caller.
//!
//! More fundamentally, agents have to run offline. A cloud round-trip on the
//! spawn path would make "the network is down" mean "your agent starts with no
//! team env", which silently produces literal `${KEY}` strings in MCP configs
//! (`resolve_config_secret_refs` short-circuits on an empty secret map) and a
//! runtime that fails with opaque 401s.
//!
//! So the fetch is a background reconcile and the readers stay on the
//! filesystem. The cache is the contract between them.
//!
//! # The cache never shrinks on failure
//!
//! A fetch error leaves the previous cache **exactly as it was**. A successful
//! fetch returning an empty `mcpServers` map is different: it is authoritative
//! evidence that this actor has no installed team MCP servers and must clear
//! the cache. Otherwise an uninstall would report success while the daemon
//! continued running the stale server.
//!
//! Note the in-memory TTL cache used by [`crate::runtime::managed_llm`] is not
//! sufficient here: it is process-local and empty after every daemon restart.
//! That is survivable for managed LLM because its durable artifact is
//! `opencode.json` on disk; team env has no such artifact — it is decrypted and
//! injected fresh on every spawn.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as SyncMutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use crate::backend::Backend;
use crate::config::global_team_store::global_team_cloud_dir;

/// How long a successful fetch is trusted before another is attempted.
/// Matches `managed_llm`'s TTL — these are the same class of team-scoped config
/// and there is no reason for them to converge at different rates.
const TEAM_CLOUD_TTL: Duration = Duration::from_secs(60);

/// Name of the single team-MCP cache file. One file rather than one per server
/// so a fetch lands atomically: a partial rename sequence must never be able to
/// present half a team's servers as the whole set.
const MCP_CACHE_FILE: &str = "mcp.json";

static TEAM_MCP_WRITE_LOCKS: OnceLock<SyncMutex<HashMap<String, Arc<SyncMutex<()>>>>> =
    OnceLock::new();
static CACHE_TMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct TeamCloudConfigResolver {
    backend: Arc<dyn Backend>,
    last_fetch: AsyncMutex<HashMap<String, Instant>>,
}

/// What a reconcile actually changed on disk, so callers can decide whether to
/// signal a runtime refresh.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeamCloudReconcileOutcome {
    pub mcp_changed: bool,
    pub env_changed: bool,
}

impl TeamCloudReconcileOutcome {
    pub fn changed(self) -> bool {
        self.mcp_changed || self.env_changed
    }
}

/// Log a reconcile outcome (no fan-out). Prefer [`apply_team_cloud_outcome`]
/// whenever a refresh coordinator is available.
pub fn log_team_cloud_outcome(team_id: &str, outcome: TeamCloudReconcileOutcome) {
    if outcome.changed() {
        tracing::info!(
            team_id,
            mcp_changed = outcome.mcp_changed,
            env_changed = outcome.env_changed,
            "team cloud config cache updated"
        );
    }
}

/// Log + fan-out `RefreshChangeKind::{Mcp, EnvVars}` to every local workspace
/// of `team_id`.
///
/// The cloud cache lives under `~/.amuxd/teams/<id>/cloud/`, a sibling of the
/// synced team dir and outside every `refresh_watch` root — so a cache update
/// never produces a filesystem watch event. The signal has to come from here:
/// `record_change` is per-workspace while the resolver is per-team.
pub async fn apply_team_cloud_outcome(
    team_id: &str,
    outcome: TeamCloudReconcileOutcome,
    backend: Option<&Arc<dyn Backend>>,
    refresh: Option<&Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
) {
    log_team_cloud_outcome(team_id, outcome);
    if !outcome.changed() {
        return;
    }
    let Some(refresh) = refresh else {
        return;
    };
    let Some(backend) = backend else {
        return;
    };

    let rows = match backend
        .get_workspaces_by_agent(team_id, backend.actor_id())
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(
                team_id,
                error = %e,
                "team cloud cache changed but workspace list failed; skipping refresh fan-out"
            );
            return;
        }
    };

    for row in rows {
        let Some((path, _)) = crate::config::workspace_path::listable_local_workspace(&row) else {
            continue;
        };
        let workspace_path = PathBuf::from(&path);
        let workspace_id = row.id;
        if outcome.env_changed {
            record_refresh(
                refresh,
                &workspace_id,
                &workspace_path,
                crate::runtime::refresh::RefreshChangeKind::EnvVars,
            )
            .await;
        }
        if outcome.mcp_changed {
            record_refresh(
                refresh,
                &workspace_id,
                &workspace_path,
                crate::runtime::refresh::RefreshChangeKind::Mcp,
            )
            .await;
        }
    }
}

async fn record_refresh(
    refresh: &crate::runtime::refresh::RuntimeRefreshCoordinator,
    workspace_id: &str,
    workspace_path: &Path,
    kind: crate::runtime::refresh::RefreshChangeKind,
) {
    if let Err(error) = refresh
        .record_change(
            workspace_id,
            workspace_path,
            kind,
            crate::runtime::refresh::RefreshSource::UiMutation,
        )
        .await
    {
        tracing::warn!(
            workspace_id,
            workspace_path = %workspace_path.display(),
            ?kind,
            error = %error,
            "failed to record refresh change after team cloud reconcile"
        );
    }
}

/// The single team-MCP file every runtime reads (Cursor `{ "mcpServers": … }`).
///
/// OpenCode cannot load this shape; [`sync_opencode_generated`] writes a sibling
/// adapter for `OPENCODE_CONFIG` only. Other runtimes must not read that sibling.
pub fn team_cloud_mcp_file(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join(MCP_CACHE_FILE)
}

const OPENCODE_GENERATED_FILE: &str = "mcp.opencode.generated.json";

pub fn team_cloud_mcp_opencode_generated_file(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join(OPENCODE_GENERATED_FILE)
}

pub fn team_cloud_mcp_dir(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join(".mcp")
}

pub fn team_cloud_secrets_dir(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join("_secrets")
}

/// Write `contents` to `path` atomically, returning whether the bytes changed.
///
/// tmp+rename rather than truncate+write because the readers are not
/// coordinated with this writer: a reader that opens the file mid-write must see
/// either the old contents or the new ones, never a truncated prefix that fails
/// to parse and silently drops a team's whole MCP set.
fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<bool> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == contents {
            return Ok(false);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let sequence = CACHE_TMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "team-cloud-cache".to_string());
    let tmp = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    std::fs::write(&tmp, contents)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(true),
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            Err(error)
        }
    }
}

fn team_mcp_write_lock(team_id: &str) -> Arc<SyncMutex<()>> {
    let locks = TEAM_MCP_WRITE_LOCKS.get_or_init(|| SyncMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        locks
            .entry(team_id.to_string())
            .or_insert_with(|| Arc::new(SyncMutex::new(()))),
    )
}

/// Write the Cursor SSOT and refresh the OpenCode-only generated adapter.
pub fn replace_team_mcp_cache(
    team_id: &str,
    mcp_servers: &serde_json::Value,
) -> std::io::Result<bool> {
    let lock = team_mcp_write_lock(team_id);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let servers = match mcp_servers {
        serde_json::Value::Object(_) => mcp_servers.clone(),
        serde_json::Value::Null => serde_json::json!({}),
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "mcpServers must be an object",
            ));
        }
    };
    let config = serde_json::json!({ "mcpServers": servers });
    let body = serde_json::to_string_pretty(&config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let changed = write_if_changed(&team_cloud_mcp_file(team_id), &body)?;
    sync_opencode_generated_unlocked(team_id)?;
    Ok(changed)
}

/// Always materialize `mcp.opencode.generated.json` so spawn can set
/// `OPENCODE_CONFIG` even before the first install.
pub fn sync_opencode_generated(team_id: &str) -> std::io::Result<bool> {
    let lock = team_mcp_write_lock(team_id);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    sync_opencode_generated_unlocked(team_id)
}

fn sync_opencode_generated_unlocked(team_id: &str) -> std::io::Result<bool> {
    let mut generated = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {},
    });
    let global = teamclu_runtime_env::opencode_config::global_opencode_config_path();
    if let Ok(body) = std::fs::read_to_string(&global) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if json.is_object() {
                generated = json;
            }
        }
    }
    let mcp = generated
        .as_object_mut()
        .expect("generated is object")
        .entry("mcp")
        .or_insert_with(|| serde_json::json!({}));
    let mcp_map = mcp.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "opencode generated mcp must be an object",
        )
    })?;
    // Device servers (`~/.amuxd/mcp.json`) are already in opencode's own shape,
    // so they go in verbatim. They are inserted before the team's so a team
    // server of the same name still wins.
    if let Ok(body) = std::fs::read_to_string(crate::config::device_mcp::device_mcp_file()) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(servers) = json.get("mcp").and_then(|v| v.as_object()) {
                for (name, raw) in servers {
                    mcp_map.insert(name.clone(), raw.clone());
                }
            }
        }
    }
    if let Ok(body) = std::fs::read_to_string(team_cloud_mcp_file(team_id)) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            let servers = json
                .get("mcpServers")
                .and_then(|v| v.as_object())
                .or_else(|| json.get("mcp").and_then(|v| v.as_object()));
            if let Some(servers) = servers {
                for (name, raw) in servers {
                    if let Ok(parsed) = serde_json::from_value::<
                        crate::config::team_mcp::CursorMcpServer,
                    >(raw.clone())
                    {
                        let converted = crate::config::team_mcp::convert_cursor_server(&parsed);
                        if let Ok(val) = serde_json::to_value(converted) {
                            mcp_map.insert(name.clone(), val);
                        }
                    } else if raw.is_object() {
                        mcp_map.insert(name.clone(), raw.clone());
                    }
                }
            }
        }
    }
    let body = serde_json::to_string_pretty(&generated)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_if_changed(&team_cloud_mcp_opencode_generated_file(team_id), &body)
}

impl TeamCloudConfigResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            last_fetch: AsyncMutex::new(HashMap::new()),
        }
    }

    /// Refresh the cache if the TTL has expired. Safe to call on any hot path —
    /// at most one request per team per [`TEAM_CLOUD_TTL`].
    pub async fn reconcile(&self, team_id: &str) -> TeamCloudReconcileOutcome {
        if let Some(fetched_at) = self.last_fetch.lock().await.get(team_id) {
            if fetched_at.elapsed() < TEAM_CLOUD_TTL {
                return TeamCloudReconcileOutcome::default();
            }
        }
        self.reconcile_now(team_id).await
    }

    /// Refresh regardless of TTL. Used right after a local write, where waiting
    /// out the TTL would show the user their own change not taking effect.
    pub async fn reconcile_now(&self, team_id: &str) -> TeamCloudReconcileOutcome {
        let mcp_changed = self.reconcile_mcp(team_id).await;
        let env_changed = self.reconcile_env(team_id).await;

        // Only mark the team fetched when *both* halves succeeded. A partial
        // success left as "fetched" would sit stale for a full TTL.
        if mcp_changed.is_some() && env_changed.is_some() {
            self.last_fetch
                .lock()
                .await
                .insert(team_id.to_string(), Instant::now());
        }

        TeamCloudReconcileOutcome {
            mcp_changed: mcp_changed.unwrap_or(false),
            env_changed: env_changed.unwrap_or(false),
        }
    }

    /// `None` on fetch/write failure (cache left untouched), `Some(changed)` otherwise.
    async fn reconcile_mcp(&self, team_id: &str) -> Option<bool> {
        let config = match self.backend.team_mcp_config(team_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    team_id,
                    error = %e,
                    "team MCP cloud fetch failed; keeping the existing cache"
                );
                return None;
            }
        };

        // Serialize with the same shape the reader expects (`{"mcpServers": {…}}`).
        // A response missing the key at all is treated as a fetch problem rather
        // than as "the team has no servers" — the latter would be an unforced
        // way to wipe a working cache over a server-side shape change.
        if config.get("mcpServers").is_none() {
            tracing::warn!(
                team_id,
                "team MCP response had no mcpServers key; keeping the existing cache"
            );
            return None;
        }

        let servers = config
            .get("mcpServers")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        match replace_team_mcp_cache(team_id, &servers) {
            Ok(changed) => Some(changed),
            Err(e) => {
                tracing::warn!(team_id, error = %e, "failed to write team MCP cache");
                None
            }
        }
    }

    /// `None` on fetch failure (cache left untouched), `Some(changed)` otherwise.
    async fn reconcile_env(&self, team_id: &str) -> Option<bool> {
        let rows = match self.backend.team_env_secrets(team_id).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(
                    team_id,
                    error = %e,
                    "team env cloud fetch failed; keeping the existing cache"
                );
                return None;
            }
        };

        let dir = team_cloud_secrets_dir(team_id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(team_id, error = %e, "failed to create team env cache dir");
            return None;
        }

        let mut changed = false;
        let mut written = std::collections::HashSet::new();
        for row in &rows {
            // The key id lands in a filename, so anything that could escape the
            // directory is dropped rather than sanitised — a surprising rename is
            // worse than a missing key, and the server enforces the same charset.
            if row.key_id.is_empty()
                || !row
                    .key_id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                tracing::warn!(team_id, key_id = %row.key_id, "skipping team env key with an unexpected id");
                continue;
            }
            let path = dir.join(format!("{}.enc.json", row.key_id));
            let body = match serde_json::to_string_pretty(&row.envelope) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(team_id, key_id = %row.key_id, error = %e, "failed to serialize team env envelope");
                    continue;
                }
            };
            match write_if_changed(&path, &body) {
                Ok(did) => {
                    changed |= did;
                    written.insert(format!("{}.enc.json", row.key_id));
                }
                Err(e) => {
                    tracing::warn!(team_id, key_id = %row.key_id, error = %e, "failed to write team env cache file");
                }
            }
        }

        // Reconcile deletions. Scoped to this directory, which only ever holds
        // files this resolver wrote — that is exactly why the cache is a
        // daemon-owned sibling of the synced team dir and not a subdirectory of
        // it. Only runs on a successful fetch, so an outage never deletes keys.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.ends_with(".enc.json") || written.contains(name) {
                    continue;
                }
                if std::fs::remove_file(entry.path()).is_ok() {
                    changed = true;
                }
            }
        }

        Some(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn write_if_changed_reports_no_change_for_identical_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("team.json");

        assert!(write_if_changed(&path, "{\"a\":1}").unwrap());
        assert!(!write_if_changed(&path, "{\"a\":1}").unwrap());
        assert!(write_if_changed(&path, "{\"a\":2}").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
    }

    #[test]
    fn write_if_changed_leaves_no_tmp_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("team.json");
        write_if_changed(&path, "{}").unwrap();

        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "stray tmp files: {leftovers:?}");
    }

    #[test]
    fn concurrent_mcp_replacements_keep_cursor_and_opencode_files_consistent() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let team_id = "concurrent-mcp-team";

        // The generated file carries the device servers as well as the team's —
        // `sync_opencode_generated_unlocked` inserts `~/.amuxd/mcp.json`
        // verbatim, by design. Seed one so that difference is present on every
        // run. Left to chance it appears only when another test in this binary
        // boots a daemon, whose `ensure_device_mcp` writes through the
        // process-global `AMUXD_HOME` — this tempdir, while this test holds it.
        // That is what failed on CI under load and passed everywhere else.
        let device_file = crate::config::device_mcp::device_mcp_file();
        std::fs::create_dir_all(device_file.parent().unwrap()).unwrap();
        std::fs::write(
            &device_file,
            r#"{"mcp":{"playwright":{"type":"local","command":["npx","playwright"]}}}"#,
        )
        .unwrap();

        for round in 0..16 {
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let mut workers = Vec::new();
            for name in [format!("alpha-{round}"), format!("beta-{round}")] {
                let barrier = Arc::clone(&barrier);
                workers.push(std::thread::spawn(move || {
                    barrier.wait();
                    replace_team_mcp_cache(
                        team_id,
                        &serde_json::json!({
                            (name.clone()): { "command": "echo", "args": [name] }
                        }),
                    )
                    .unwrap();
                }));
            }
            barrier.wait();
            for worker in workers {
                worker.join().unwrap();
            }

            let cursor: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(team_cloud_mcp_file(team_id)).unwrap(),
            )
            .unwrap();
            let generated: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(team_cloud_mcp_opencode_generated_file(team_id)).unwrap(),
            )
            .unwrap();
            let cursor_names: BTreeSet<_> = cursor["mcpServers"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            let generated_names: BTreeSet<_> = generated["mcp"]
                .as_object()
                .unwrap()
                .keys()
                .filter(|name| !crate::config::device_mcp::is_device_scoped(name))
                .cloned()
                .collect();
            assert_eq!(cursor_names, generated_names);
            assert!(
                generated["mcp"].get("playwright").is_some(),
                "device servers must survive a team replacement",
            );
        }
    }

    #[tokio::test]
    async fn reconcile_mcp_clears_a_populated_cache_when_the_cloud_returns_no_servers() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let team_id = "empty-mcp-team";
        replace_team_mcp_cache(
            team_id,
            &serde_json::json!({
                "stale": { "command": "npx", "args": ["stale-mcp"] }
            }),
        )
        .unwrap();

        let resolver =
            TeamCloudConfigResolver::new(Arc::new(crate::backend::mock::MockBackend::new()));

        assert_eq!(resolver.reconcile_mcp(team_id).await, Some(true));
        let cache: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(team_cloud_mcp_file(team_id)).unwrap())
                .unwrap();
        assert_eq!(cache, serde_json::json!({ "mcpServers": {} }));
    }
}
