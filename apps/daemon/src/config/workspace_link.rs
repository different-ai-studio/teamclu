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
    if link == target {
        if std::fs::symlink_metadata(&link)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&link);
        }
        tracing::warn!(
            team_id,
            workspace = %workspace_root.display(),
            "skipping team link: workspace path is the team's global dir (would self-symlink)"
        );
        return LinkStatus::Fallback;
    }

    // Already a symlink: repoint if stale or dangling, else done.
    if let Ok(meta) = std::fs::symlink_metadata(&link) {
        if meta.file_type().is_symlink() {
            match std::fs::read_link(&link) {
                Ok(dest) if dest == target && link.is_dir() => {
                    return LinkStatus::Linked(LinkKind::Symlink);
                }
                _ => {
                    let _ = std::fs::remove_file(&link);
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
        std::fs::write(global.join("knowledge/keep.md"), b"keep me").unwrap();

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
            std::fs::read(global.join("knowledge/keep.md")).unwrap(),
            b"keep me"
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
        std::fs::write(global.join("knowledge/existing.md"), b"already here").unwrap();

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
