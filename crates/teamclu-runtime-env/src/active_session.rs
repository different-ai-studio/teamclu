//! TeamClu cloud session id handoff for MCP tools (e.g. `get_session_deeplink`).
//!
//! The daemon stamps the active session into
//! `{workspace}/{meta}/active-session-id` before each agent turn so
//! workspace-scoped MCP servers can resolve "current session" without an
//! explicit tool argument. Meta dir follows the process brand (see
//! [`crate::workspace_meta_dir_name`]).

use std::path::Path;

use crate::atomic_write;
use crate::storage_namespace::{
    brand_short_name_from_env, resolve_workspace_meta_path, workspace_meta_write_path,
};

/// Deprecated alias — prefer brand helpers. Kept for external call sites that
/// still treat official meta as `.teamclu`.
pub const TEAMCLU_DIR: &str = crate::WORKSPACE_META_DIR;
pub const ACTIVE_SESSION_ID_FILE: &str = "active-session-id";
pub const TEAMCLU_SESSION_ID_ENV: &str = "TEAMCLU_SESSION_ID";

/// Canonical write path for the active-session stamp (brand meta dir).
pub fn active_session_id_write_path(workspace: &Path) -> std::path::PathBuf {
    workspace_meta_write_path(
        workspace,
        &brand_short_name_from_env(),
        ACTIVE_SESSION_ID_FILE,
    )
}

/// Resolve path for reads (canonical, else legacy `.teamclu/`).
pub fn active_session_id_path(workspace: &Path) -> std::path::PathBuf {
    resolve_workspace_meta_path(
        workspace,
        &brand_short_name_from_env(),
        ACTIVE_SESSION_ID_FILE,
    )
}

/// Read the last TeamClu cloud session id stamped for this workspace.
pub fn read_active_session_id(workspace: &Path) -> Option<String> {
    let path = active_session_id_path(workspace);
    let raw = std::fs::read_to_string(path).ok()?;
    let id = raw.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Stamp the TeamClu cloud session id for this workspace (best-effort).
pub fn write_active_session_id(workspace: &Path, session_id: &str) -> std::io::Result<()> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let path = active_session_id_write_path(workspace);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut content = id.to_string();
    content.push('\n');
    atomic_write::atomic_write(&path, &content)
}

/// Clear the active-session stamp, but only if it currently holds
/// `session_id`. This is a compare-and-clear: a concurrent session that has
/// since stamped its own id is left untouched, so stopping one session never
/// clobbers another's "current session" signal for the MCP introspect tool.
///
/// Compares against and clears the **brand write path** (the same path
/// [`write_active_session_id`] writes), so it undoes exactly what a prior
/// stamp put there. A missing file, an empty body, or a mismatch all count as
/// "already cleared" (false) — the stamp no longer points at this session.
///
/// Why this exists: `get_session_deeplink` (no `session_id` arg) reads the
/// stamp to resolve "current session". When a runtime stops, the stamp used to
/// keep the dead session's id, so a later session on the same worktree
/// (especially the shared per-team default worktree) could read a stale id and
/// emit a deeplink to a session that no longer exists.
pub fn clear_active_session_id_if_matches(workspace: &Path, session_id: &str) -> bool {
    let id = session_id.trim();
    if id.is_empty() {
        return false;
    }
    let path = active_session_id_write_path(workspace);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    if raw.trim() != id {
        // Another session already restamped the file — leave it alone.
        return false;
    }
    // Truncate to empty rather than unlink: the introspect tool treats an empty
    // stamp as "no current session" (errors instead of returning a stale id),
    // and keeping the file avoids a create-then-write race on the next stamp.
    atomic_write::atomic_write(&path, "").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_namespace::BRAND_SHORT_NAME_ENV;
    use crate::test_util::home_env_lock;

    #[test]
    fn write_then_read_active_session_id() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), "a1ca8f06-94ee-4fb5-bdfb-194a5606062f").unwrap();
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("a1ca8f06-94ee-4fb5-bdfb-194a5606062f")
        );
        assert!(dir
            .path()
            .join(".teamclu")
            .join(ACTIVE_SESSION_ID_FILE)
            .exists());
    }

    #[test]
    fn read_missing_active_session_id_returns_none() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        assert!(read_active_session_id(dir.path()).is_none());
    }

    #[test]
    fn clear_if_match_removes_the_stamped_id() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        let id = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";
        write_active_session_id(dir.path(), id).unwrap();
        assert!(clear_active_session_id_if_matches(dir.path(), id));
        assert!(read_active_session_id(dir.path()).is_none());
    }

    #[test]
    fn clear_if_match_leaves_a_mismatching_stamp_alone() {
        // A concurrent session restamped the file after this one stopped — the
        // stop must not clobber the live session's "current session" signal.
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        let mine = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";
        let theirs = "b2db9017-05ff-4ac6-c0ec-0a5b67171730";
        write_active_session_id(dir.path(), mine).unwrap();
        write_active_session_id(dir.path(), theirs).unwrap(); // concurrent restamp
        assert!(!clear_active_session_id_if_matches(dir.path(), mine));
        assert_eq!(read_active_session_id(dir.path()).as_deref(), Some(theirs));
    }

    #[test]
    fn clear_if_match_on_missing_or_empty_is_a_noop() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        let id = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";
        assert!(!clear_active_session_id_if_matches(dir.path(), id)); // no file
        // An empty/whitespace stamp also reads as "no current session".
        write_active_session_id(dir.path(), id).unwrap(); // creates the .teamclu dir
        let path = dir.path().join(".teamclu").join(ACTIVE_SESSION_ID_FILE);
        atomic_write::atomic_write(&path, "   \n").unwrap();
        assert!(!clear_active_session_id_if_matches(dir.path(), id)); // empty body, no match
        assert!(read_active_session_id(dir.path()).is_none());
    }

    #[test]
    fn clear_if_match_ignores_empty_session_id() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), "a1ca8f06-94ee-4fb5-bdfb-194a5606062f").unwrap();
        assert!(!clear_active_session_id_if_matches(dir.path(), "  "));
    }

    #[test]
    fn white_label_writes_brand_meta_and_reads_legacy_fallback() {
        let _lock = home_env_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(BRAND_SHORT_NAME_ENV, "copilot361");

        let legacy = dir.path().join(".teamclu").join(ACTIVE_SESSION_ID_FILE);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "legacy-session\n").unwrap();
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("legacy-session")
        );

        write_active_session_id(dir.path(), "brand-session").unwrap();
        let brand_path = dir.path().join(".copilot361").join(ACTIVE_SESSION_ID_FILE);
        assert!(brand_path.exists());
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("brand-session")
        );

        std::env::remove_var(BRAND_SHORT_NAME_ENV);
    }
}
