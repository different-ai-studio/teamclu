//! Single authority for where a team's synced content lives on disk.
//!
//! One global copy per team, keyed by `team_id`, under the daemon home
//! (`~/.amuxd`). Every workspace of that team exposes this directory via a
//! `teamclu-team` symlink (see `workspace_link`).

use std::path::{Component, Path, PathBuf};

use super::DaemonConfig;

/// The link/dir name surfaced inside each workspace. Mirrors the desktop
/// `teamclu-introspect` `TEAM_REPO_DIR` const; kept in sync by value.
pub const TEAM_LINK_NAME: &str = "teamclu-team";

/// Fixed top-level subdirectories the sync engine watches inside the team dir.
/// Mirrors `oss_sync::path_validator::ALLOWED_PREFIXES` (without trailing `/`).
///
/// Only `knowledge` is left. `.mcp` and `_secrets` moved to the Cloud API
/// (`docs/architecture/team-mcp-and-env-cloud.md`) and are mirrored into
/// `<team>/cloud/` — a sibling of this directory, so the sync engine never sees
/// them. `skills` moved to the skills registry. `_meta` and `_feedback` never
/// had a writer here.
pub const SHARED_PREFIXES: &[&str] = &["knowledge"];

/// Reject a shared-dir name that could escape the workspace or hide itself.
pub fn validate_shared_dir_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("shared_dir_name must be 1-64 characters");
    }
    if name == "." || name == ".." || name.starts_with('.') {
        anyhow::bail!("shared_dir_name cannot be hidden, . or ..");
    }
    if name.contains('/') || name.contains('\\') {
        anyhow::bail!("shared_dir_name cannot contain path separators");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        anyhow::bail!("shared_dir_name contains unsupported characters");
    }
    Ok(())
}

/// `<workspace_root>/<shared_dir_name>`, validated to stay inside the workspace.
pub fn shared_dir_path(workspace_root: &Path, shared_dir_name: &str) -> anyhow::Result<PathBuf> {
    validate_shared_dir_name(shared_dir_name)?;
    let path = workspace_root.join(shared_dir_name);
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            anyhow::bail!("shared directory path cannot contain ..");
        }
    }
    if !path.starts_with(workspace_root) {
        anyhow::bail!("shared directory must stay inside workspace");
    }
    Ok(path)
}

/// `~/.amuxd/teams/<team_id>/shared/teamclu-team` — the one synced copy.
pub fn global_team_dir(team_id: &str) -> PathBuf {
    super::layout::team_shared_dir(team_id).join(TEAM_LINK_NAME)
}

/// `~/.amuxd/teams/<team_id>/shared` — the sync engines content root.
///
/// Knowledge syncs directly under here as `shared/knowledge/` (the only
/// `SHARED_PREFIX`). It used to live at `shared/teamclu-team/knowledge`; it was
/// hoisted out so a workspace surfaces it via a dedicated `team-knowledge`
/// link instead of through the `teamclu-team` repo dir.
///
/// There is deliberately no migration from the old location. The sync manifest
/// keys files by the root-agnostic relative path `knowledge/…` and blobs are
/// content-addressed, so a machine that upgrades simply pulls the team's
/// knowledge down into the new root on its next tick.
pub fn sync_content_root(team_id: &str) -> PathBuf {
    super::layout::team_shared_dir(team_id)
}

/// `~/.amuxd/teams/<team_id>/state/cloud` — daemon-owned mirror of the team
/// config that now comes from the Cloud API rather than the sync engine (team
/// MCP, team env). See `runtime::team_cloud_config`.
///
/// It must stay outside `shared/`: the sync scanner treats anything inside the
/// synced tree as local content to push, so a daemon writer in there emits
/// tombstones for every other member each time it changes.
///
/// That used to be enforced by "be a sibling of `teamclu-team/`", which is a
/// rule you can only follow if you know it. Under `state/` it follows from
/// where the directory is.
pub fn global_team_cloud_dir(team_id: &str) -> PathBuf {
    super::layout::team_state_dir(team_id).join("cloud")
}

/// `~/.amuxd/teams/<team_id>/workspace` — the writable default worktree used for
/// workspace-less runtime spawns (e.g. the embedded `/v1/ui` chat, which creates
/// sessions with only an `agent_type`). It is a sibling of the synced
/// `teamclu-team` dir, so it is always writable regardless of the daemon's cwd
/// (production daemons launched by the desktop app inherit cwd `/`, which is
/// read-only). It lives inside the daemon config dir, so no `teamclu-team`
/// self-link is created here — relative team reads fall back to `global_team_dir`
/// via [`resolve_team_dir`].
pub fn default_workspace_dir(team_id: &str) -> PathBuf {
    super::layout::team_workspace_dir(team_id)
}

/// The onboarded team's default worktree ([`default_workspace_dir`]), created if
/// missing. Returns `None` when the daemon is not onboarded to a team or the
/// directory can't be created — callers then fall back to the process cwd.
///
/// Shared fallback for workspace-less runtime spawns: the embedded `/v1/ui` chat
/// (HTTP `create_session`) and the offline-session auto-restart path both spawn
/// agents without a `workspace_id`. Using cwd there breaks production daemons,
/// which the desktop app launches with cwd `/` (read-only).
pub fn onboarded_default_workspace_dir() -> Option<PathBuf> {
    let team_id = DaemonConfig::load(&DaemonConfig::default_path())
        .ok()?
        .team_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())?;
    let dir = default_workspace_dir(&team_id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(dir = %dir.display(), error = %e, "create default team workspace dir failed");
        return None;
    }
    Some(dir)
}

/// `~/.amuxd/teams/<team_id>/state/sync.json` — OSS sync state, one per team.
///
/// Defines the canonical per-team sync-state location, consumed by the OSS
/// sync engine's `LocalSyncState::load_at` / `save_at`.
pub fn global_sync_state_path(team_id: &str) -> PathBuf {
    super::layout::team_state_dir(team_id).join("sync.json")
}

/// Where to read this workspace's shared team content. If the in-workspace
/// `teamclu-team` entry exists (symlink/junction/real dir), use it so existing
/// relative read paths resolve transparently; otherwise (e.g. the Windows
/// no-link fallback) read the global dir directly.
pub fn resolve_team_dir(workspace_root: &Path, team_id: &str) -> PathBuf {
    let link = workspace_root.join(TEAM_LINK_NAME);
    // `is_dir` follows symlinks; dangling links return false so we fall back to
    // the global copy instead of treating a broken workspace link as canonical.
    if link.is_dir() {
        link
    } else {
        global_team_dir(team_id)
    }
}

/// Create the team dir and the fixed shared-prefix subdirectories if missing.
/// Returns the team dir path.
pub fn ensure_initialized(team_id: &str) -> std::io::Result<PathBuf> {
    let dir = global_team_dir(team_id);
    std::fs::create_dir_all(&dir)?;
    // Knowledge syncs under `shared/knowledge` (the sync content root), not
    // under `shared/teamclu-team/knowledge` — see `sync_content_root`.
    let shared = super::layout::team_shared_dir(team_id);
    std::fs::create_dir_all(&shared)?;
    for prefix in SHARED_PREFIXES {
        std::fs::create_dir_all(shared.join(prefix))?;
    }
    Ok(dir)
}

/// True when `dir` is missing, totally empty, or only holds empty scaffold dirs
/// from [`ensure_initialized`] (no user content).
///
/// Callers use this to decide whether a directory is safe to delete, so point it
/// at the tree that actually holds the content — [`sync_content_root`], not
/// [`global_team_dir`]. `ensure_initialized` leaves the latter permanently empty
/// now that the shared prefixes live one level up, which makes this vacuously
/// true for it.
pub fn is_scaffold_only(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries.into_iter().all(|e| {
            e.ok()
                .map(|e| {
                    let p = e.path();
                    p.is_dir()
                        && std::fs::read_dir(&p)
                            .map(|mut r| r.next().is_none())
                            .unwrap_or(false)
                })
                .unwrap_or(false)
        }),
        Err(_) => true,
    }
}

/// Serializes tests that mutate the process-global `HOME` env var (which
/// `config_dir()` reads). Shared across config submodule tests so HOME-based
/// path assertions don't race. Test-only.
#[cfg(test)]
pub(crate) static TEST_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_shared_dir_names() {
        for value in ["", ".", "..", ".hidden", "../bad", "bad/name"] {
            assert!(validate_shared_dir_name(value).is_err(), "{value}");
        }
    }

    #[test]
    fn resolves_shared_dir_under_workspace() {
        let path = shared_dir_path(Path::new("/tmp/workspace"), "teamclu").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/workspace/teamclu"));
    }

    #[test]
    fn global_dir_is_keyed_by_team_id() {
        let a = global_team_dir("team-a");
        let b = global_team_dir("team-b");
        assert_ne!(a, b);
        assert!(a.ends_with("teams/team-a/shared/teamclu-team"));
        assert!(global_sync_state_path("team-a").ends_with("teams/team-a/state/sync.json"));
    }

    /// The load-bearing separation: everything the daemon writes for a team is
    /// outside the tree the sync engine scans.
    ///
    /// Measured against [`sync_content_root`], never against `global_team_dir`.
    /// The scanned root used to be `shared/teamclu-team`, so asserting on that
    /// path was the same thing; once knowledge was hoisted to `shared/` the two
    /// diverged and `global_team_dir` became a *child* of the synced tree — a
    /// daemon-private path added under `shared/` would have passed the old
    /// assertion and then been pushed to every teammate.
    #[test]
    fn daemon_private_paths_stay_out_of_the_synced_tree() {
        let synced = sync_content_root("team-a");
        for private in [
            global_team_cloud_dir("team-a"),
            global_sync_state_path("team-a"),
            default_workspace_dir("team-a"),
        ] {
            assert!(
                !private.starts_with(&synced),
                "{} is inside the synced tree {}",
                private.display(),
                synced.display()
            );
        }
        // Guard the premise: the team repo dir really is inside the synced tree
        // now, so this test would be vacuous if it kept measuring against it.
        assert!(global_team_dir("team-a").starts_with(&synced));
    }

    #[test]
    fn resolve_team_dir_prefers_link_else_global() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let ws = tempfile::tempdir().unwrap();

        // No in-workspace entry → resolves to the global dir.
        assert_eq!(
            resolve_team_dir(ws.path(), "team-r"),
            global_team_dir("team-r")
        );

        // In-workspace entry present → resolves to it (transparent reads).
        #[cfg(unix)]
        {
            let link = ws.path().join(TEAM_LINK_NAME);
            std::os::unix::fs::symlink(tmp.path(), &link).unwrap();
            assert_eq!(resolve_team_dir(ws.path(), "team-r"), link);
        }

        // Dangling symlink → fall back to the global copy.
        #[cfg(unix)]
        {
            let global = ensure_initialized("team-dangle").unwrap();
            let link = ws.path().join(TEAM_LINK_NAME);
            if link.exists() {
                std::fs::remove_file(&link).unwrap();
            }
            std::os::unix::fs::symlink("/nonexistent/teamclu-team", &link).unwrap();
            assert_eq!(resolve_team_dir(ws.path(), "team-dangle"), global);
        }
    }

    #[test]
    fn ensure_initialized_creates_all_prefixes() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Redirect HOME so config_dir() points at a temp dir.
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let dir = ensure_initialized("team-x").unwrap();
        assert!(dir.is_dir()); // shared/teamclu-team (team repo)
        // knowledge syncs under shared/knowledge (sync content root), not the repo dir
        let shared = sync_content_root("team-x");
        for prefix in SHARED_PREFIXES {
            assert!(shared.join(prefix).is_dir(), "{prefix} should exist under shared/");
        }
    }
}
