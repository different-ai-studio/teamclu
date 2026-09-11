//! Creates and repairs the links that surface a team's synced content inside a
//! workspace: `team-knowledge` and `team-documents`, both pointing into the
//! team's single global copy (see [`super::global_team_store`]).
//!
//! There used to be a third, `teamclu-team`, pointing at `shared/teamclu-team`.
//! Everything that lived behind it has moved — knowledge and documents to
//! `shared/team-sync` (the two links above), `.mcp` and `_secrets` to the Cloud
//! API, skills to the registry — so it pointed at an empty scaffold that still
//! sat in every workspace's file tree. It is no longer created, and a stale
//! symlink by that name is removed.
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
    /// The link is in place and resolves.
    Linked(LinkKind),
    /// Could not create a link; readers must use the global dir directly.
    Fallback,
}

/// Surface `team_id`'s synced roots in a workspace: `team-knowledge` and
/// `team-documents`. Idempotent. Never errors — returns the status of the
/// knowledge link, the one every caller has always meant by "linked".
///
/// A stale `teamclu-team` **symlink** from an older build is removed on the
/// way. A real directory by that name is left exactly as it is: it predates the
/// global store, and nothing here can prove its contents were ever synced.
pub fn ensure_workspace_link(workspace_root: &Path, team_id: &str) -> LinkStatus {
    let target = match global_team_store::ensure_initialized(team_id) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(team_id, "global team dir init failed: {e}");
            return LinkStatus::Fallback;
        }
    };
    let legacy_link = workspace_root.join(TEAM_LINK_NAME);

    // Never touch a "workspace" that IS the team's own `shared/` dir. That
    // happens when a bogus workspace at `~/.amuxd/teams/<id>/shared` gets
    // registered (such entries have appeared in workspaces.toml, synced from the
    // cloud): its `teamclu-team` is the global store dir itself, and linking the
    // synced roots from it would plant `shared/team-knowledge` inside the sync
    // content root — which the scanner would then walk. A self-symlink left by
    // an older build is cleaned up.
    if legacy_link == target {
        if is_symlink(&legacy_link) {
            let _ = remove_link(&legacy_link);
        }
        tracing::warn!(
            team_id,
            workspace = %workspace_root.display(),
            "skipping team links: workspace path is the team's own shared dir"
        );
        return LinkStatus::Fallback;
    }

    if is_symlink(&legacy_link) {
        if let Err(e) = remove_link(&legacy_link) {
            tracing::debug!(
                workspace = %workspace_root.display(),
                "stale teamclu-team link not removed: {e}"
            );
        }
    }

    let _ = ensure_team_documents_link(workspace_root, team_id);
    ensure_team_knowledge_link(workspace_root, team_id)
}

/// A symlink or junction — never a real directory.
fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
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

/// Workspace link name surfacing the team's synced knowledge dir
/// (`shared/team-sync/knowledge`). Sibling of [`TEAM_LINK_NAME`]
/// (`teamclu-team`).
pub const TEAM_KNOWLEDGE_LINK_NAME: &str = "team-knowledge";

/// Workspace link name surfacing the team's synced documents dir
/// (`shared/team-sync/documents`).
///
/// A separate link rather than one pointing at the whole synced tree, because
/// the two roots are different things: documents are files with an owner and
/// may be permission-restricted, knowledge is shared consensus. An agent that
/// wants one should not have to walk past the other.
///
/// Permissions on documents need no enforcement here. A device only holds what
/// its owner is allowed to receive, so an agent running on it sees exactly what
/// that person sees — which is the same conclusion the ACL design reaches about
/// agents generally.
pub const TEAM_DOCUMENTS_LINK_NAME: &str = "team-documents";

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

/// Surface the team's synced documents dir in a workspace.
///
/// Mirrors [`ensure_team_knowledge_link`]; kept as its own function so a caller
/// that wants only one of the two roots can say so.
pub fn ensure_team_documents_link(workspace_root: &Path, team_id: &str) -> LinkStatus {
    if let Err(e) = global_team_store::ensure_initialized(team_id) {
        tracing::warn!(team_id, "ensure_initialized for team-documents failed: {e}");
        return LinkStatus::Fallback;
    }
    let target = global_team_store::sync_content_root(team_id).join("documents");
    ensure_link_to(&workspace_root.join(TEAM_DOCUMENTS_LINK_NAME), &target)
}

/// Workspace-relative variant for call sites with no `team_id` (notably
/// `prepare_workspace`, which runs on every workspace open/switch). Finds the
/// team's synced root by following a link the workspace already has.
///
/// Asked in order: `team-knowledge`, `team-documents`, then the legacy
/// `teamclu-team`. The first two point straight into `shared/team-sync/`; the
/// last is only there for a workspace last touched by an older build, and is
/// removed once the synced roots are linked from it.
///
/// Whatever is derived is validated before it is used: it has to sit under this
/// build's teams dir and be the `team-sync` directory. Any of these links can be
/// stale — this runs before any sweep has had the chance — and an unvalidated
/// `read_link` result would point `team-knowledge` at an arbitrary directory
/// that no sync engine owns.
pub fn ensure_team_knowledge_link_from_workspace(workspace_root: &Path) -> LinkStatus {
    let Some(sync_root) = sync_root_from_workspace_links(workspace_root) else {
        return LinkStatus::Fallback;
    };
    if !sync_root.starts_with(super::layout::teams_dir())
        || sync_root.file_name() != Some(std::ffi::OsStr::new(global_team_store::SYNC_ROOT_DIR))
    {
        tracing::warn!(
            workspace = %workspace_root.display(),
            target = %sync_root.display(),
            "team links skipped: existing link points outside the teams sync root"
        );
        return LinkStatus::Fallback;
    }
    // Both roots, so a workspace reached this way is not missing one of them.
    let _ = ensure_link_to(
        &workspace_root.join(TEAM_DOCUMENTS_LINK_NAME),
        &sync_root.join("documents"),
    );
    let status = ensure_link_to(
        &workspace_root.join(TEAM_KNOWLEDGE_LINK_NAME),
        &sync_root.join("knowledge"),
    );
    // Only now, with the synced roots in place: until then the legacy link may
    // have been the only thing to derive them from.
    if matches!(status, LinkStatus::Linked(_)) {
        let legacy = workspace_root.join(TEAM_LINK_NAME);
        if is_symlink(&legacy) {
            let _ = remove_link(&legacy);
        }
    }
    status
}

/// The `shared/team-sync` dir a workspace's existing links lead to, if any.
fn sync_root_from_workspace_links(workspace_root: &Path) -> Option<std::path::PathBuf> {
    for name in [TEAM_KNOWLEDGE_LINK_NAME, TEAM_DOCUMENTS_LINK_NAME] {
        if let Ok(dest) = std::fs::read_link(workspace_root.join(name)) {
            if let Some(root) = dest.parent() {
                return Some(root.to_path_buf());
            }
        }
    }
    // `teamclu-team` -> `<teams>/<id>/shared/teamclu-team`. The synced tree is
    // its sibling `team-sync/`, NOT `shared/` itself.
    let legacy = std::fs::read_link(workspace_root.join(TEAM_LINK_NAME)).ok()?;
    Some(legacy.parent()?.join(global_team_store::SYNC_ROOT_DIR))
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
    fn links_the_synced_roots_and_not_teamclu_team() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let status = ensure_workspace_link(ws.path(), "team-1");
        assert_eq!(status, LinkStatus::Linked(LinkKind::Symlink));

        let sync_root = global_team_store::sync_content_root("team-1");
        assert_eq!(
            std::fs::read_link(ws.path().join(TEAM_KNOWLEDGE_LINK_NAME)).unwrap(),
            sync_root.join("knowledge")
        );
        assert_eq!(
            std::fs::read_link(ws.path().join(TEAM_DOCUMENTS_LINK_NAME)).unwrap(),
            sync_root.join("documents")
        );
        // Nothing lives behind it any more, and it sat at the top of every
        // workspace's file tree.
        assert!(std::fs::symlink_metadata(ws.path().join(TEAM_LINK_NAME)).is_err());
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
    fn removes_a_teamclu_team_link_left_by_an_older_build() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let link = ws.path().join(TEAM_LINK_NAME);
        // Both shapes an older build leaves: pointing at the real store, and
        // dangling.
        std::os::unix::fs::symlink(global_team_store::global_team_dir("team-1"), &link).unwrap();
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        assert!(std::fs::symlink_metadata(&link).is_err());

        std::os::unix::fs::symlink("/nonexistent/old", &link).unwrap();
        ensure_workspace_link(ws.path(), "team-1");
        assert!(std::fs::symlink_metadata(&link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_self_symlink_when_workspace_is_the_global_dir() {
        let (_home, _guard) = temp_home();
        // Seed the team's global dir with real content.
        let global = global_team_store::ensure_initialized("team-self").unwrap();
        std::fs::write(
            global_team_store::sync_content_root("team-self").join("knowledge/keep.md"),
            b"keep me",
        )
        .unwrap();

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
            std::fs::read(
                global_team_store::sync_content_root("team-self").join("knowledge/keep.md")
            )
            .unwrap(),
            b"keep me"
        );

        // ...and no `team-knowledge` link either. `ws_root` here IS the team's
        // `shared/` dir, so one would sit inside the sync content root — the
        // guard has to run before knowledge linking, not after.
        assert!(
            std::fs::symlink_metadata(ws_root.join(TEAM_KNOWLEDGE_LINK_NAME)).is_err(),
            "self-symlink guard must also refuse the team-knowledge link"
        );
        assert!(std::fs::symlink_metadata(ws_root.join(TEAM_DOCUMENTS_LINK_NAME)).is_err());
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
        let bogus = elsewhere
            .path()
            .join("some-other-home")
            .join(TEAM_LINK_NAME);
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
        assert_eq!(
            std::fs::read_link(ws.path().join(TEAM_DOCUMENTS_LINK_NAME)).unwrap(),
            global_team_store::sync_content_root("team-fw").join("documents")
        );
        // Used once to find the synced roots, then gone.
        assert!(std::fs::symlink_metadata(ws.path().join(TEAM_LINK_NAME)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn from_workspace_repairs_from_team_knowledge_once_teamclu_team_is_gone() {
        // The state every workspace is in after this change: no `teamclu-team`
        // to derive anything from. The knowledge link has to be enough to put a
        // missing documents link back.
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        global_team_store::ensure_initialized("team-k2").unwrap();
        let sync_root = global_team_store::sync_content_root("team-k2");
        std::os::unix::fs::symlink(sync_root.join("knowledge"), ws.path().join(TEAM_KNOWLEDGE_LINK_NAME))
            .unwrap();

        assert_eq!(
            ensure_team_knowledge_link_from_workspace(ws.path()),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        assert_eq!(
            std::fs::read_link(ws.path().join(TEAM_DOCUMENTS_LINK_NAME)).unwrap(),
            sync_root.join("documents")
        );
    }

    #[cfg(unix)]
    #[test]
    fn from_workspace_refuses_a_knowledge_link_that_is_not_under_team_sync() {
        // Under the teams dir is not enough: a link to `<teams>/<id>/elsewhere/
        // knowledge` would have documents linked to `elsewhere/documents`, which
        // no sync engine owns.
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let odd = crate::config::layout::teams_dir().join("team-x").join("elsewhere").join("knowledge");
        std::fs::create_dir_all(&odd).unwrap();
        std::os::unix::fs::symlink(&odd, ws.path().join(TEAM_KNOWLEDGE_LINK_NAME)).unwrap();

        assert_eq!(
            ensure_team_knowledge_link_from_workspace(ws.path()),
            LinkStatus::Fallback
        );
        assert!(std::fs::symlink_metadata(ws.path().join(TEAM_DOCUMENTS_LINK_NAME)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_real_teamclu_team_directory_is_never_touched() {
        // It predates the global store. It used to be migrated into it and
        // replaced with a link; now that no link is made, there is nothing to
        // replace it with — and nothing here can prove its contents were ever
        // synced, so it stays exactly as the user left it.
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let legacy = ws.path().join(TEAM_LINK_NAME);
        std::fs::create_dir_all(legacy.join("knowledge")).unwrap();
        std::fs::write(legacy.join("knowledge/unsynced.md"), b"do not lose").unwrap();

        assert_eq!(
            ensure_workspace_link(ws.path(), "team-real"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        let meta = std::fs::symlink_metadata(&legacy).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read(legacy.join("knowledge/unsynced.md")).unwrap(),
            b"do not lose"
        );
        // Nor copied into the global store behind the user's back.
        assert!(!global_team_store::global_team_dir("team-real")
            .join("knowledge/unsynced.md")
            .exists());
    }
}
