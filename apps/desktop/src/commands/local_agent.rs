//! Whether this machine runs a local Agent at all (#1678).
//!
//! amuxd still ships inside the desktop bundle, but it is only started once the
//! user (or the "no default agent anywhere" rule) has enabled the local Agent.
//! A user who only ever talks to remote agents never starts amuxd and never
//! installs Node.js or pi.
//!
//! The switch lives in `<brand home>/local-agent.json`, one per brand, and is
//! the single thing [`super::amuxd_supervisor::AmuxdSupervisor`] consults
//! before spawning the managed daemon. One-shot sidecars (`amuxd init`,
//! `doctor`, `install-pi`, `clear`) are not gated: they exit on their own and
//! leave no resident process.
//!
//! Migration: a file that does not exist yet is decided by `daemon.toml`. A
//! daemon with an `active_team` was bound before this switch existed, so the
//! machine counts as enabled and the decision is written down — an existing
//! user upgrades without seeing setup again.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const STATE_FILE: &str = "local-agent.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct LocalAgentState {
    enabled: bool,
}

fn state_path() -> PathBuf {
    super::brand_home_dir().join(STATE_FILE)
}

fn read_state(path: &Path) -> Option<LocalAgentState> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_state(path: &Path, enabled: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string(&LocalAgentState { enabled }).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash mid-write cannot leave a half file, which
    // would read as "never decided" and re-run the migration.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

/// The recorded decision, or — when none is recorded — the migration verdict
/// from `bound_before`, persisted only when it says "enabled".
///
/// A "not enabled" verdict is not written: a machine that has never decided
/// stays undecided, so a daemon bound later (by an older build sharing this
/// home, say) is still picked up.
fn resolve_enabled(path: &Path, bound_before: impl FnOnce() -> bool) -> bool {
    if let Some(state) = read_state(path) {
        return state.enabled;
    }
    let enabled = bound_before();
    if enabled {
        if let Err(e) = write_state(path, true) {
            log::warn!("[local-agent] could not record the migrated enabled state: {e}");
        }
    }
    enabled
}

/// Is the local Agent enabled on this machine, for this brand?
pub fn is_enabled() -> bool {
    resolve_enabled(&state_path(), || super::amuxd_active_team().is_some())
}

/// Record the switch. Disabling never deletes the file: an absent file means
/// "undecided" and would let the migration turn it straight back on.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    write_state(&state_path(), enabled)
}

#[tauri::command]
pub async fn local_agent_enabled() -> Result<bool, String> {
    Ok(is_enabled())
}

/// Turn the local Agent on. Only records the switch; the onboarding flow starts
/// the daemon itself, under its own progress steps.
#[tauri::command]
pub async fn local_agent_enable() -> Result<(), String> {
    set_enabled(true)
}

/// Turn the local Agent off: record it, then stop the managed daemon (and the
/// pi hosts it owns). The binary stays in the bundle.
#[tauri::command]
pub async fn local_agent_disable<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    super::amuxd_supervisor::AmuxdSupervisor::disable_and_stop(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_undecided_machine_with_a_bound_daemon_migrates_to_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(STATE_FILE);
        assert!(resolve_enabled(&path, || true));
        // Written down, so the decision no longer depends on daemon.toml.
        assert_eq!(read_state(&path), Some(LocalAgentState { enabled: true }));
        assert!(resolve_enabled(&path, || false));
    }

    #[test]
    fn an_undecided_machine_without_a_binding_stays_off_and_undecided() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(STATE_FILE);
        assert!(!resolve_enabled(&path, || false));
        assert_eq!(read_state(&path), None);
    }

    #[test]
    fn disabling_beats_a_daemon_that_is_still_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(STATE_FILE);
        write_state(&path, false).unwrap();
        // daemon.toml keeps its active_team after a disable; that must not
        // switch the local Agent back on.
        assert!(!resolve_enabled(&path, || true));
    }

    #[test]
    fn a_corrupt_file_reads_as_undecided() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(STATE_FILE);
        std::fs::write(&path, "{not json").unwrap();
        assert!(!resolve_enabled(&path, || false));
    }
}
