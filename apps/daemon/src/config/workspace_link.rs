//! Creates and repairs the `teamclu-team` entry inside a workspace so it
//! points at the team's single global copy (see [`super::global_team_store`]).
//!
//! Unix/macOS use a symlink. Windows tries a directory junction, then falls
//! back to "no link, read the global dir directly" so opening a workspace
//! never fails on symlink-privilege errors.

use std::path::Path;

use super::global_team_store::{self, TEAM_LINK_NAME};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkKind {
    Symlink,
    /// Windows directory junction (created when symlink privileges are absent).
    #[cfg_attr(not(windows), allow(dead_code))]
    Junction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkStatus {
    /// `teamclu-team` is a working link to the global dir.
    Linked(LinkKind),
    /// Could not create a link; readers must use the global dir directly.
    Fallback,
    /// A legacy real dir with un-synced changes was left untouched.
    LegacyDirRetained { reason: String },
}

/// Ensure `<workspace_root>/teamclu-team` points at the global team dir for
/// `team_id`. Idempotent. Never errors — returns the resulting status.
pub fn ensure_workspace_link(workspace_root: &Path, team_id: &str) -> LinkStatus {
    let target = match global_team_store::ensure_initialized(team_id) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(team_id, "global team dir init failed: {e}");
            return LinkStatus::Fallback;
        }
    };
    let link = workspace_root.join(TEAM_LINK_NAME);

    // Never link a "workspace" whose `teamclu-team` path IS the team's own
    // global store dir (`~/.amuxd/teams/<id>/teamclu-team`). That happens when
    // a bogus workspace at `~/.amuxd/teams/<id>` gets registered (such entries
    // have appeared in workspaces.toml, synced from the cloud). With link ==
    // target the code below would treat the global real dir as a "legacy dir",
    // `remove_dir_all` it (destroying the synced content), then symlink it to
    // itself — a self-referential link that makes every `cd` into it fail with
    // ELOOP. Clean up any such self-symlink and refuse to (re)create it.
    //
    // This runs BEFORE `ensure_team_knowledge_link`. Such a "workspace" is the
    // team's `shared/` dir, so linking knowledge from it plants a
    // `shared/team-knowledge` symlink inside the sync content root — the exact
    // class of thing this guard exists to keep out.
    if link == target {
        if std::fs::symlink_metadata(&link)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            let _ = remove_link(&link);
        }
        tracing::warn!(
            team_id,
            workspace = %workspace_root.display(),
            "skipping team link: workspace path is the team's global dir (would self-symlink)"
        );
        return LinkStatus::Fallback;
    }

    // Surface the team knowledge dir in the workspace too. Runs on every link
    // so opening/switching a workspace always re-creates a stale link.
    let _ = ensure_team_knowledge_link(workspace_root, team_id);

    // Already a symlink: repoint if stale or dangling, else done.
    if let Ok(meta) = std::fs::symlink_metadata(&link) {
        if meta.file_type().is_symlink() {
            match std::fs::read_link(&link) {
                Ok(dest) if dest == target && link.is_dir() => {
                    return LinkStatus::Linked(LinkKind::Symlink);
                }
                _ => {
                    let _ = remove_link(&link);
                }
            }
        } else if meta.is_dir() {
            // Legacy real dir → migration (Task 4 fills this in).
            return migrate_legacy_dir(&link, &target);
        }
    }

    create_link(&link, &target)
}

/// Platform link creation with fallback chain.
fn create_link(link: &Path, target: &Path) -> LinkStatus {
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(target, link) {
            Ok(()) => LinkStatus::Linked(LinkKind::Symlink),
            Err(e) => {
                tracing::warn!(
                    "symlink {} -> {} failed: {e}",
                    link.display(),
                    target.display()
                );
                LinkStatus::Fallback
            }
        }
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return LinkStatus::Linked(LinkKind::Symlink);
        }
        if junction_create(link, target).is_ok() {
            return LinkStatus::Linked(LinkKind::Junction);
        }
        tracing::warn!(
            "symlink/junction {} failed; falling back to direct global read",
            link.display()
        );
        LinkStatus::Fallback
    }
}

#[cfg(windows)]
fn junction_create(link: &Path, target: &Path) -> std::io::Result<()> {
    use crate::process_util::CommandNoWindow;

    // `mklink /J` creates a junction without admin rights.
    let status = std::process::Command::new("cmd")
        .no_window()
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "mklink /J failed",
        ))
    }
}

/// A legacy real `teamclu-team/` dir was found. If it has no un-synced
/// changes, consolidate it into the global dir and replace it with a symlink.
/// If it is dirty, leave it untouched and report it for the UI to resolve.
fn migrate_legacy_dir(link: &Path, target: &Path) -> LinkStatus {
    if !global_team_store::is_scaffold_only(target) {
        // Global is already populated, so we cannot prove this directory's
        // contents are already synced upstream. Removing it would risk
        // discarding unsynced edits — retain instead and let the UI surface it
        // for the user to resolve.
        return LinkStatus::LegacyDirRetained {
            reason: "populated global; cannot verify legacy dir is synced".into(),
        };
    }

    // First workspace wins: seed the global copy from the legacy content.
    if let Err(e) = copy_dir_contents(link, target) {
        tracing::warn!("seed global from legacy {} failed: {e}", link.display());
        return LinkStatus::LegacyDirRetained {
            reason: format!("seed-global failed: {e}"),
        };
    }

    // Safe to replace: we just seeded this content into an empty global.
    if let Err(e) = std::fs::remove_dir_all(link) {
        tracing::warn!("remove legacy dir {} failed: {e}", link.display());
        return LinkStatus::LegacyDirRetained {
            reason: format!("remove legacy dir failed: {e}"),
        };
    }
    create_link(link, target)
}

/// Recursively copy everything under `from` into `to`.
fn copy_dir_contents(from: &Path, to: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&dst)?;
            copy_dir_contents(&src, &dst)?;
        } else {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Workspace link name surfacing the team's synced knowledge dir
/// (`shared/knowledge`). Sibling of [`TEAM_LINK_NAME`] (`teamclu-team`).
pub const TEAM_KNOWLEDGE_LINK_NAME: &str = "team-knowledge";

/// Remove a workspace link entry regardless of how the platform materialized it.
///
/// On Windows a directory symlink is a directory entry and `remove_file` fails
/// on it. Every call site needs both arms: an inlined `remove_file` leaves the
/// stale link in place, `create_link` then fails with `AlreadyExists`, and the
/// link can never be repointed again.
pub fn remove_link(link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::remove_file(link)
    }
    #[cfg(windows)]
    {
        // Directory symlink / junction first; fall back for a file symlink.
        std::fs::remove_dir(link).or_else(|_| std::fs::remove_file(link))
    }
}

/// Idempotent: repoint a stale or dangling link at `target`, leave a real
/// directory (user content) untouched, else create the link. Shared by the
/// team-id and workspace-relative `team-knowledge` entry points.
fn ensure_link_to(link: &Path, target: &Path) -> LinkStatus {
    if let Ok(meta) = std::fs::symlink_metadata(link) {
        if meta.file_type().is_symlink() {
            match std::fs::read_link(link) {
                Ok(dest) if dest == target && link.is_dir() => {
                    return LinkStatus::Linked(LinkKind::Symlink);
                }
                _ => {
                    let _ = remove_link(link);
                }
            }
        } else if meta.is_dir() {
            return LinkStatus::Fallback;
        } else {
            // A plain file, not a link — `remove_link`'s Windows directory arm
            // would be wrong here.
            let _ = std::fs::remove_file(link);
        }
    }
    create_link(link, target)
}

/// Ensure `<workspace_root>/team-knowledge` points at the team's synced
/// knowledge dir (`shared/knowledge`).
pub fn ensure_team_knowledge_link(workspace_root: &Path, team_id: &str) -> LinkStatus {
    if let Err(e) = global_team_store::ensure_initialized(team_id) {
        tracing::warn!(team_id, "ensure_initialized for team-knowledge failed: {e}");
        return LinkStatus::Fallback;
    }
    let target = global_team_store::sync_content_root(team_id).join("knowledge");
    ensure_link_to(&workspace_root.join(TEAM_KNOWLEDGE_LINK_NAME), &target)
}

/// Workspace-relative variant for call sites with no `team_id` (notably
/// `prepare_workspace`, which runs on every workspace open/switch). Derives the
/// team's `shared/knowledge` by following the workspace's `teamclu-team` link.
///
/// The derived path is validated to sit under this build's teams dir before it
/// is used. `teamclu-team` can be stale — `ensure_workspace_link` has a test
/// devoted to repointing one, and this runs before any sweep has had the
/// chance — and an unvalidated `read_link` result would point `team-knowledge`
/// at an arbitrary directory that no sync engine owns.
pub fn ensure_team_knowledge_link_from_workspace(workspace_root: &Path) -> LinkStatus {
    let Ok(team_repo) = std::fs::read_link(workspace_root.join(TEAM_LINK_NAME)) else {
        return LinkStatus::Fallback;
    };
    // `teamclu-team` -> `<teams>/<id>/shared/teamclu-team`; knowledge is its sibling.
    let Some(shared) = team_repo.parent() else {
        return LinkStatus::Fallback;
    };
    if !shared.starts_with(super::layout::teams_dir()) {
        tracing::warn!(
            workspace = %workspace_root.display(),
            target = %team_repo.display(),
            "team-knowledge link skipped: teamclu-team points outside the teams dir"
        );
        return LinkStatus::Fallback;
    }
    ensure_link_to(
        &workspace_root.join(TEAM_KNOWLEDGE_LINK_NAME),
        &shared.join("knowledge"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sets an isolated `HOME` and holds the shared HOME lock for the test's
    /// duration so path assertions don't race other HOME-mutating tests.
    fn temp_home() -> (tempfile::TempDir, std::sync::MutexGuard<'static, ()>) {
        let guard = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        (tmp, guard)
    }

    #[cfg(unix)]
    #[test]
    fn creates_symlink_to_global_dir() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let status = ensure_workspace_link(ws.path(), "team-1");
        assert_eq!(status, LinkStatus::Linked(LinkKind::Symlink));
        let link = ws.path().join("teamclu-team");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            global_team_store::global_team_dir("team-1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn is_idempotent() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        // Second call: still linked, no error.
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
    }

    #[cfg(unix)]
    #[test]
    fn repoints_stale_symlink() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let link = ws.path().join("teamclu-team");
        std::os::unix::fs::symlink("/nonexistent/old", &link).unwrap();
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            global_team_store::global_team_dir("team-1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_self_symlink_when_workspace_is_the_global_dir() {
        let (_home, _guard) = temp_home();
        // Seed the team's global dir with real content.
        let global = global_team_store::ensure_initialized("team-self").unwrap();
        std::fs::write(global_team_store::sync_content_root("team-self").join("knowledge/keep.md"), b"keep me").unwrap();

        // A bogus "workspace" whose path is the team store dir itself makes
        // link == target. We must NOT migrate/delete the global dir or create a
        // self-symlink.
        let ws_root = global.parent().unwrap().to_path_buf();
        let status = ensure_workspace_link(&ws_root, "team-self");
        assert_eq!(status, LinkStatus::Fallback);

        // Global dir stays a real dir (not a self-symlink) and keeps its content.
        let meta = std::fs::symlink_metadata(&global).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read(global_team_store::sync_content_root("team-self").join("knowledge/keep.md")).unwrap(),
            b"keep me"
        );

        // ...and no `team-knowledge` link either. `ws_root` here IS the team's
        // `shared/` dir, so one would sit inside the sync content root — the
        // guard has to run before knowledge linking, not after.
        assert!(
            std::fs::symlink_metadata(ws_root.join(TEAM_KNOWLEDGE_LINK_NAME)).is_err(),
            "self-symlink guard must also refuse the team-knowledge link"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_workspace_link_also_links_team_knowledge() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-k"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        let link = ws.path().join(TEAM_KNOWLEDGE_LINK_NAME);
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            global_team_store::sync_content_root("team-k").join("knowledge")
        );
        assert!(link.is_dir(), "link should resolve to the scaffold dir");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_team_knowledge_link_repoints_a_stale_link_and_spares_a_real_dir() {
        let (_home, _guard) = temp_home();

        // Stale/dangling link → repointed.
        let ws = tempfile::tempdir().unwrap();
        let link = ws.path().join(TEAM_KNOWLEDGE_LINK_NAME);
        std::os::unix::fs::symlink("/nonexistent/old-knowledge", &link).unwrap();
        assert_eq!(
            ensure_team_knowledge_link(ws.path(), "team-stale"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            global_team_store::sync_content_root("team-stale").join("knowledge")
        );

        // A real directory is user content: never replaced, never deleted.
        let ws2 = tempfile::tempdir().unwrap();
        let real = ws2.path().join(TEAM_KNOWLEDGE_LINK_NAME);
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("mine.md"), b"local").unwrap();
        assert_eq!(
            ensure_team_knowledge_link(ws2.path(), "team-stale"),
            LinkStatus::Fallback
        );
        assert_eq!(std::fs::read(real.join("mine.md")).unwrap(), b"local");
    }

    /// `teamclu-team` can be stale (there is a whole test for repointing one),
    /// and this path runs before any sweep gets the chance. An unvalidated
    /// `read_link` result would point `team-knowledge` at an arbitrary
    /// directory that no sync engine owns.
    #[cfg(unix)]
    #[test]
    fn from_workspace_refuses_a_target_outside_the_teams_dir() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let bogus = elsewhere.path().join("some-other-home").join(TEAM_LINK_NAME);
        std::fs::create_dir_all(&bogus).unwrap();
        std::os::unix::fs::symlink(&bogus, ws.path().join(TEAM_LINK_NAME)).unwrap();

        assert_eq!(
            ensure_team_knowledge_link_from_workspace(ws.path()),
            LinkStatus::Fallback
        );
        assert!(std::fs::symlink_metadata(ws.path().join(TEAM_KNOWLEDGE_LINK_NAME)).is_err());
        // Nothing was created at the bogus location either.
        assert!(!bogus.parent().unwrap().join("knowledge").exists());
    }

    #[cfg(unix)]
    #[test]
    fn from_workspace_links_knowledge_via_the_team_link() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        // Only `teamclu-team` exists — the state `prepare_workspace` finds.
        let target = global_team_store::ensure_initialized("team-fw").unwrap();
        std::os::unix::fs::symlink(&target, ws.path().join(TEAM_LINK_NAME)).unwrap();

        assert_eq!(
            ensure_team_knowledge_link_from_workspace(ws.path()),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        assert_eq!(
            std::fs::read_link(ws.path().join(TEAM_KNOWLEDGE_LINK_NAME)).unwrap(),
            global_team_store::sync_content_root("team-fw").join("knowledge")
        );
    }

    #[cfg(unix)]
    #[test]
    fn migrates_clean_legacy_dir_into_empty_global() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let legacy = ws.path().join("teamclu-team");
        std::fs::create_dir_all(legacy.join("knowledge")).unwrap();
        std::fs::write(legacy.join("knowledge/a.md"), b"hello").unwrap();

        let status = ensure_workspace_link(ws.path(), "team-mig");
        assert_eq!(status, LinkStatus::Linked(LinkKind::Symlink));
        // Content moved into the global dir.
        let global = global_team_store::global_team_dir("team-mig");
        assert_eq!(
            std::fs::read(global.join("knowledge/a.md")).unwrap(),
            b"hello"
        );
        // Workspace entry is now a symlink, not a real dir.
        assert!(std::fs::symlink_metadata(&legacy)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn retains_legacy_dir_when_global_already_populated() {
        let (_home, _guard) = temp_home();
        // Pre-populate the global dir for this team with real content.
        let global = global_team_store::ensure_initialized("team-pop").unwrap();
        std::fs::write(global.join("README.md"), b"already here").unwrap(); // populated team repo -> retain legacy

        // A legacy dir with its own (possibly unsynced) content.
        let ws = tempfile::tempdir().unwrap();
        let legacy = ws.path().join("teamclu-team");
        std::fs::create_dir_all(legacy.join("knowledge")).unwrap();
        std::fs::write(legacy.join("knowledge/unsynced.md"), b"do not lose").unwrap();

        let status = ensure_workspace_link(ws.path(), "team-pop");
        match status {
            LinkStatus::LegacyDirRetained { .. } => {}
            other => panic!("expected LegacyDirRetained, got {other:?}"),
        }
        // Legacy content preserved, not deleted.
        assert_eq!(
            std::fs::read(legacy.join("knowledge/unsynced.md")).unwrap(),
            b"do not lose"
        );
        assert!(!std::fs::symlink_metadata(&legacy)
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
