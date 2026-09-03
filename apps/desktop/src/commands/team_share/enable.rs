//! `set_team_secret` / `get_team_secret` / `get_share_status` commands.
//!
//! Enabling is not here any more: share mode is a server-side switch that is
//! already on for every team, so `enable_oss` had nothing left to decide and
//! no caller. What remains is the team encryption key (which only the user can
//! supply) and read-only status.
//!
//! The team shared directory is created and linked by the daemon (one global
//! copy per team under `~/.amuxd/teams/<team_id>/teamclu-team`, exposed via a
//! `teamclu-team` symlink in each workspace); these commands no longer create
//! a per-workspace real dir. Team identifiers (team_id / share_mode / git URL)
//! are NOT persisted to `teamclu.json` — the single source of truth is the
//! Cloud API current-team store.

use serde::{Deserialize, Serialize};

use crate::commands::team_secret_store;
use crate::commands::team_sync_proxy;
use tracing::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableShareResult {
    pub team_id: String,
    pub share_mode: String,
    /// Non-fatal warning surfaced when the share-mode POST succeeded but the
    /// subsequent secret-delivery / link to the daemon did not. The team is
    /// enabled server-side; the daemon may not yet have the secrets it needs to
    /// sync (e.g. it was momentarily unreachable). Frontend should surface this
    /// so the user can retry. Named `clone_warning` for frontend compatibility,
    /// but it now reflects daemon delivery/link rather than a local git clone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_warning: Option<String>,
}

/// Deliver team secret material to the daemon and trigger the link, treating
/// any daemon error as a non-fatal warning. The FC share-mode POST has already
/// committed server-side by the time this runs, so a momentarily-unreachable
/// daemon must not fail the whole enable/join — the daemon's sweep will catch
/// up once it can be reached and the user can retry.
///
/// Returns `Some(warning)` describing the first failure, or `None` on success.
async fn deliver_secrets_and_link(
    team_id: &str,
    workspace_path: &str,
    oss_team_secret: Option<&str>,
) -> Option<String> {
    if let Err(e) = team_sync_proxy::daemon_team_secrets(team_id, oss_team_secret).await {
        return Some(format!("daemon secret delivery deferred: {e}"));
    }
    if let Err(e) = team_sync_proxy::daemon_team_link(workspace_path).await {
        return Some(format!("daemon link deferred: {e}"));
    }
    None
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// ─── set_team_secret ────────────────────────────────────────────────────

/// Save the team secret and hand it to the daemon.
///
/// Returns `Some(warning)` when the local save succeeded but the daemon did
/// not take delivery. That stays non-fatal — the local copy is the
/// contractually-required outcome and the daemon's sweep catches up once
/// reachable — but it is returned rather than logged: the daemon's own copy is
/// the system of record for decrypting `_secrets/`, so until delivery lands
/// the team's shared env vars are dead and only the user can retry.
pub async fn set_team_secret_impl(
    team_id: String,
    secret_hex: String,
    workspace_path: String,
) -> Result<Option<String>, String> {
    let normalized = secret_hex.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("team secret must be exactly 64 hex characters".to_string());
    }
    // A rebuilt secret store is worth telling the user about, so it rides the
    // same channel the delivery warning already uses rather than only reaching
    // the log.
    let store_notice = team_secret_store::save_team_secret(&workspace_path, &team_id, &normalized)?;

    let delivery_warning =
        deliver_secrets_and_link(&team_id, &workspace_path, Some(&normalized)).await;
    let warning = match (store_notice, delivery_warning) {
        (Some(a), Some(b)) => Some(format!("{a} {b}")),
        (Some(a), None) => Some(a),
        (None, b) => b,
    };
    if let Some(w) = &warning {
        info!("team_share_set_team_secret: {w}");
    }
    Ok(warning)
}

#[tauri::command]
pub async fn team_share_set_team_secret(
    team_id: String,
    secret_hex: String,
    workspace_path: String,
) -> Result<Option<String>, String> {
    set_team_secret_impl(team_id, secret_hex, workspace_path).await
}

// ─── get_team_secret ─────────────────────────────────────────────────────

/// Read back the locally-stored team secret so the settings UI can show the
/// currently-configured value instead of a blank box on re-entry. Returns
/// `None` when no secret has been saved for this team/workspace yet (rather
/// than an error) so the frontend can distinguish "not configured" from a real
/// read failure.
#[tauri::command]
pub async fn team_share_get_team_secret(
    team_id: String,
    workspace_path: String,
) -> Result<Option<String>, String> {
    match team_secret_store::load_team_secret(&workspace_path, &team_id) {
        Ok(secret) => Ok(Some(secret)),
        Err(team_secret_store::TeamSecretReadError::NotConfigured) => Ok(None),
        // A store that will not open is NOT "no secret configured", and showing
        // it as an empty box is how a configured team ends up looking unconfigured
        // — the user retypes a secret they already had, and only finds out
        // something is wrong when the save fails. Surface it.
        //
        // This branch used to be `Err(_) => Ok(None)`, justified by a comment
        // claiming the only possible error was "not found". That was not true:
        // the read goes through the encrypted personal blob, which fails loudly
        // when its master key no longer matches.
        Err(team_secret_store::TeamSecretReadError::StoreUnreadable(e)) => Err(e),
    }
}

// ─── get_share_status ────────────────────────────────────────────────────

/// `~/.amuxd/teams/<team_id>/shared/teamclu-team` — the daemon's global copy
/// path, shown in the UI so users can see where synced content actually lives.
pub(crate) fn global_team_dir_display(team_id: &str) -> Option<String> {
    Some(
        crate::commands::amuxd_team_shared_dir(team_id)
            .to_string_lossy()
            .into_owned(),
    )
}

#[cfg(test)]
mod link_status_tests {
    use super::*;
    use crate::commands::TEAM_REPO_DIR;

    #[test]
    fn global_path_contains_team_and_amuxd() {
        if let Some(p) = global_team_dir_display("team-xyz") {
            assert!(p.contains("team-xyz"));
            assert!(p.contains(".amuxd"));
            assert!(p.ends_with(TEAM_REPO_DIR));
        }
    }
}
