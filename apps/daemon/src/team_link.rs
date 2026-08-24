//! Materialize team global dir + workspace `teamclu-team` link.
//!
//! Shared by the daemon core and the HTTP `/v1/team/link` handler so HTTP
//! integration tests do not need to pull in `daemon::server`.

use std::path::Path;

use tracing::{debug, info, warn};

use crate::backend::Backend;
use crate::config::global_team_store::{self, TEAM_LINK_NAME};
use crate::config::workspace_link::{self, LinkStatus, TEAM_KNOWLEDGE_LINK_NAME};

/// Result of consulting the cloud share-mode endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamShareGate {
    /// `share_mode` is set (`oss`).
    Enabled,
    /// Team-share is off (`mode` null / missing).
    Disabled,
    /// Cloud lookup failed — do not tear down existing links on a background sweep.
    Unknown,
}

pub async fn team_share_gate(backend: &dyn Backend, team_id: &str) -> TeamShareGate {
    match backend.team_share_config(team_id).await {
        Ok(cfg) => {
            if cfg
                .mode
                .as_deref()
                .filter(|m| !m.trim().is_empty())
                .is_some()
            {
                TeamShareGate::Enabled
            } else {
                TeamShareGate::Disabled
            }
        }
        Err(e) => {
            warn!(
                team_id,
                "team_share_config failed, leaving links unchanged: {e}"
            );
            TeamShareGate::Unknown
        }
    }
}

/// Whether a workspace path is an app checkout
/// (`<amuxd home>/teams/<teamId>/apps/<appId>`).
///
/// App workspaces deliberately get NO `teamclu-team` link. An app's workspace
/// is the user's own project, which they deploy: a link dropped at its root
/// shows up as untracked content, rides along into the app's build artifact,
/// and has nothing to do with the app. Team-shared skills/MCP still resolve —
/// without a link, `resolve_team_dir` falls back to the global team dir, the
/// same path a machine without symlink privileges takes.
///
/// Asks about *any* team's app root, not just the active one. Keying off the
/// active team meant an app belonging to another team failed the check and got
/// a `teamclu-team` directory planted in its source tree.
pub fn is_app_workspace(ws_path: &str) -> bool {
    let teams_root = crate::config::layout::teams_dir();
    if path_is_under(ws_path, &crate::http::apps::apps_data_root()) {
        return true;
    }
    // `teams/<anything>/apps/…` — one level of team id, then the app root.
    std::fs::read_dir(&teams_root)
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| path_is_under(ws_path, &entry.path().join("apps")))
}

/// Whether `ws_path` sits inside `root`. Compares canonicalized paths when both
/// resolve (macOS `/tmp` -> `/private/tmp`, symlinked homes) and falls back to
/// the literal prefix when they do not — the app dir may not exist yet.
fn path_is_under(ws_path: &str, root: &Path) -> bool {
    let path = Path::new(ws_path.trim());
    if path.as_os_str().is_empty() {
        return false;
    }
    match (std::fs::canonicalize(path), std::fs::canonicalize(root)) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => path.starts_with(root),
    }
}

/// Remove one workspace link entry only when it is a symlink/junction.
fn remove_link_entry(link: &Path, ws_path: &str) {
    let Ok(meta) = std::fs::symlink_metadata(link) else {
        return;
    };
    if !meta.file_type().is_symlink() {
        return;
    }
    if let Err(e) = workspace_link::remove_link(link) {
        debug!(workspace = %ws_path, entry = %link.display(), "team link cleanup skipped: {e}");
    }
}

/// Remove `<workspace>/team-knowledge` when it is a symlink/junction.
///
/// Link-only by design: unlike `teamclu-team`, this name never had a legacy
/// real-directory form, so a real directory sitting there is local user content
/// and must survive teardown.
fn remove_workspace_knowledge_symlink(ws_root: &Path, ws_path: &str) {
    remove_link_entry(&ws_root.join(TEAM_KNOWLEDGE_LINK_NAME), ws_path);
}

/// Remove `<workspace>/teamclu-team` and `<workspace>/team-knowledge` only when
/// they are symlinks/junctions.
///
/// Used for app workspaces, where a same-named real directory would be the
/// app's own source and must never be deleted.
fn remove_workspace_team_symlink(ws_path: &str) {
    let ws_root = Path::new(ws_path.trim());
    remove_link_entry(&ws_root.join(TEAM_LINK_NAME), ws_path);
    remove_workspace_knowledge_symlink(ws_root, ws_path);
}

/// Remove `<workspace>/teamclu-team` when it is a symlink/junction; remove a
/// real directory if one was materialized locally (legacy). Drops the
/// `team-knowledge` link alongside it.
///
/// Both have to go together. `team-knowledge` points into `shared/knowledge`,
/// which [`prune_scaffold_team_home`] may delete immediately after this call,
/// and nothing would repair the leftover: the workspace-relative repair path
/// (`ensure_team_knowledge_link_from_workspace`) derives its target by reading
/// the `teamclu-team` link this call just removed.
pub fn remove_workspace_team_link(ws_path: &str) -> std::io::Result<()> {
    let ws_root = Path::new(ws_path.trim());
    remove_workspace_knowledge_symlink(ws_root, ws_path);
    let link = ws_root.join(TEAM_LINK_NAME);
    match std::fs::symlink_metadata(&link) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.file_type().is_symlink() => workspace_link::remove_link(&link),
        Ok(_) => std::fs::remove_dir_all(&link),
    }
}

/// Drop `~/.amuxd/teams/<team_id>/shared/` when it still holds nothing but the
/// empty scaffold [`global_team_store::ensure_initialized`] creates.
///
/// The emptiness check MUST measure the sync content root — the tree about to
/// be deleted — and not `teamclu-team`. Knowledge lives at `shared/knowledge`
/// now, which leaves `shared/teamclu-team` permanently empty and makes
/// `is_scaffold_only` vacuously true for it; asking it would delete a fully
/// populated `shared/` on any unlink. `state/sync.json` survives that deletion
/// as a sibling, so the next tick would see every `knowledge/*` entry missing
/// and tombstone it for the whole team.
pub fn prune_scaffold_team_home(team_id: &str) {
    let shared = global_team_store::sync_content_root(team_id);
    if !global_team_store::is_scaffold_only(&shared) {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(&shared) {
        debug!(team_id, path = %shared.display(), "prune scaffold team home failed: {e}");
    }
}

/// Background sweep policy: link when enabled; tear down only when share-mode is
/// confirmed off; leave paths alone on transient cloud errors (`Unknown`).
pub fn materialize_or_teardown(gate: TeamShareGate, team_id: &str, ws_path: &str) -> LinkStatus {
    if is_app_workspace(ws_path) {
        // Never link an app checkout, and clear one left by an older build.
        remove_workspace_team_symlink(ws_path);
        return LinkStatus::Fallback;
    }
    match gate {
        TeamShareGate::Enabled => ensure_team_link(team_id, ws_path),
        TeamShareGate::Disabled => {
            if let Err(e) = remove_workspace_team_link(ws_path) {
                debug!(
                    team_id,
                    workspace = %ws_path,
                    "team unlink (workspace entry) skipped: {e}"
                );
            }
            prune_scaffold_team_home(team_id);
            LinkStatus::Fallback
        }
        TeamShareGate::Unknown => LinkStatus::Fallback,
    }
}

/// Idempotently materialize a team's global shared dir and a workspace's
/// `teamclu-team` symlink into it.
pub fn ensure_team_link(team_id: &str, ws_path: &str) -> LinkStatus {
    if team_id.trim().is_empty() || ws_path.trim().is_empty() {
        return LinkStatus::Fallback;
    }
    if is_app_workspace(ws_path) {
        debug!(
            team_id,
            workspace = %ws_path,
            "team link skipped: app workspace (falls back to the global team dir)"
        );
        remove_workspace_team_symlink(ws_path);
        return LinkStatus::Fallback;
    }
    if let Err(e) = crate::config::global_team_store::ensure_initialized(team_id) {
        warn!(team_id, "global team dir init failed: {e}");
        return LinkStatus::Fallback;
    }
    let ws_root = Path::new(ws_path);
    let status = crate::config::workspace_link::ensure_workspace_link(ws_root, team_id);
    let effective = crate::config::global_team_store::resolve_team_dir(ws_root, team_id);
    info!(
        team_id,
        workspace = %ws_path,
        effective = %effective.display(),
        "team link: {status:?}"
    );
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_workspace_team_link_drops_symlink() {
        let ws = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(global.path(), ws.path().join(TEAM_LINK_NAME)).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(global.path(), ws.path().join(TEAM_LINK_NAME)).unwrap();

        remove_workspace_team_link(ws.path().to_str().unwrap()).unwrap();
        assert!(!ws.path().join(TEAM_LINK_NAME).exists());
        assert!(global.path().exists());
    }

    #[test]
    fn materialize_or_teardown_disabled_does_not_create_global_dir() {
        let _lock = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        // SAFETY: serialized by TEST_HOME_LOCK.
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-teardown-test";
        let ws = tempfile::tempdir().unwrap();
        materialize_or_teardown(
            TeamShareGate::Disabled,
            team_id,
            ws.path().to_str().unwrap(),
        );

        assert!(!global_team_store::global_team_dir(team_id).exists());
    }

    #[test]
    fn path_is_under_matches_only_paths_inside_the_root() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("app-1");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(path_is_under(inside.to_str().unwrap(), root.path()));
        // Not created yet (seed hasn't run) — still recognized by prefix.
        assert!(path_is_under(
            root.path().join("app-2").to_str().unwrap(),
            root.path()
        ));
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(!path_is_under(
            elsewhere.path().to_str().unwrap(),
            root.path()
        ));
        assert!(!path_is_under("", root.path()));
        assert!(!path_is_under("   ", root.path()));
    }

    #[test]
    fn app_workspaces_get_no_team_link_and_lose_a_stale_one() {
        let _lock = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        // SAFETY: serialized by TEST_HOME_LOCK.
        unsafe { std::env::set_var("HOME", home.path()) };

        // Asks where apps actually live rather than re-deriving it — the
        // fixture and the predicate must not be able to disagree.
        let app_ws = crate::http::apps::apps_data_root().join("app-1");
        std::fs::create_dir_all(&app_ws).unwrap();
        let app_ws_str = app_ws.to_str().unwrap();
        assert!(is_app_workspace(app_ws_str));

        // A link left by an older build is cleared...
        let global = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(global.path(), app_ws.join(TEAM_LINK_NAME)).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(global.path(), app_ws.join(TEAM_LINK_NAME)).unwrap();

        // ...and no new one is created, even with team-share enabled.
        assert_eq!(ensure_team_link("team-1", app_ws_str), LinkStatus::Fallback);
        assert!(!app_ws.join(TEAM_LINK_NAME).exists());
        assert_eq!(
            materialize_or_teardown(TeamShareGate::Enabled, "team-1", app_ws_str),
            LinkStatus::Fallback
        );
        assert!(!app_ws.join(TEAM_LINK_NAME).exists());
    }

    #[test]
    fn an_app_belonging_to_another_team_is_still_an_app_workspace() {
        let _lock = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        // SAFETY: serialized by TEST_HOME_LOCK.
        unsafe { std::env::set_var("HOME", home.path()) };

        // Apps belong to the team they were created in; this daemon serves one
        // team at a time. Checking only the active team's root left every other
        // team's app looking like an ordinary workspace, so team-share planted
        // a `teamclu-team` directory in the middle of the user's source.
        let other = crate::config::layout::team_apps_dir("team-other").join("app-1");
        std::fs::create_dir_all(&other).unwrap();
        assert!(is_app_workspace(other.to_str().unwrap()));

        // A real workspace under the same team is unaffected.
        let plain = crate::config::layout::team_dir("team-other").join("workspace");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!is_app_workspace(plain.to_str().unwrap()));
    }

    #[test]
    fn app_workspace_cleanup_never_deletes_a_real_directory() {
        let _lock = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        // A same-named real directory inside an app repo is the app's own
        // source; only symlinks may be removed.
        let app_ws = home.path().join(".amuxd").join("apps").join("app-2");
        let real = app_ws.join(TEAM_LINK_NAME);
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"app source").unwrap();

        ensure_team_link("team-1", app_ws.to_str().unwrap());
        assert!(real.join("keep.txt").exists());
    }

    #[test]
    fn prune_scaffold_team_home_removes_empty_global_copy() {
        let _lock = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-prune-test";
        global_team_store::ensure_initialized(team_id).unwrap();
        let shared = global_team_store::sync_content_root(team_id);
        assert!(shared.exists());

        prune_scaffold_team_home(team_id);
        assert!(!shared.exists());
    }

    /// The scaffold check must measure the synced tree, not `teamclu-team`.
    /// `ensure_initialized` leaves that one permanently empty (the shared
    /// prefixes moved a level up), so asking it is vacuously true and every
    /// unlink would delete the team's whole knowledge base — and `sync.json`,
    /// a sibling, survives to tombstone all of it for the rest of the team.
    #[test]
    fn prune_scaffold_team_home_keeps_a_populated_knowledge_dir() {
        let _lock = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-prune-populated";
        global_team_store::ensure_initialized(team_id).unwrap();
        let shared = global_team_store::sync_content_root(team_id);
        let note = shared.join("knowledge").join("keep.md");
        std::fs::write(&note, b"team knowledge").unwrap();
        // The team repo dir is empty, exactly as `ensure_initialized` leaves it.
        assert!(global_team_store::is_scaffold_only(
            &global_team_store::global_team_dir(team_id)
        ));

        prune_scaffold_team_home(team_id);
        assert_eq!(std::fs::read(&note).unwrap(), b"team knowledge");
    }

    /// Teardown must drop `team-knowledge` too. It points into `shared/`, which
    /// `prune_scaffold_team_home` deletes right after, and nothing can repair
    /// the leftover — the workspace-relative repair path reads the
    /// `teamclu-team` link that teardown just removed.
    #[cfg(unix)]
    #[test]
    fn unlink_drops_the_team_knowledge_link_too() {
        let ws = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(target.path(), ws.path().join(TEAM_LINK_NAME)).unwrap();
        std::os::unix::fs::symlink(target.path(), ws.path().join(TEAM_KNOWLEDGE_LINK_NAME))
            .unwrap();

        remove_workspace_team_link(ws.path().to_str().unwrap()).unwrap();
        assert!(std::fs::symlink_metadata(ws.path().join(TEAM_LINK_NAME)).is_err());
        assert!(std::fs::symlink_metadata(ws.path().join(TEAM_KNOWLEDGE_LINK_NAME)).is_err());
        assert!(target.path().exists());
    }

    /// A real `team-knowledge` directory is local user content — this name never
    /// had a legacy real-dir form the way `teamclu-team` did — so teardown must
    /// leave it alone.
    #[test]
    fn unlink_leaves_a_real_team_knowledge_directory_alone() {
        let ws = tempfile::tempdir().unwrap();
        let real = ws.path().join(TEAM_KNOWLEDGE_LINK_NAME);
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("mine.md"), b"local note").unwrap();

        remove_workspace_team_link(ws.path().to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(real.join("mine.md")).unwrap(), b"local note");
    }
}
