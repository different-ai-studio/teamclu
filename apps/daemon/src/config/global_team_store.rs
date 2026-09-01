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
pub const SHARED_PREFIXES: &[&str] = &["documents", "knowledge"];

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
    super::layout::team_shared_dir(team_id).join(SYNC_ROOT_DIR)
}

/// The directory under `shared/` that holds the synced tree.
///
/// Everything the daemon owns for itself — `teamclu-team/`, the
/// `team-knowledge` workspace symlink, `state/` — is a sibling of this rather
/// than a child, so it is outside the synced tree **by construction**. That
/// used to be held in place by comments ("must stay outside `shared/`") and by
/// a guard in `workspace_link.rs` whose own comment calls a symlink landing
/// inside the content root "the exact class of thing this guard exists to keep
/// out". None of those depend on anyone remembering, now.
pub const SYNC_ROOT_DIR: &str = "team-sync";

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
/// Move a pre-`team-sync` layout into place, before anything scans.
///
/// # Why this cannot be skipped
///
/// `state.json` lives in `{meta}/sync/`, **outside** the content root, so it
/// does not move when the root does. Leave the files where they were and the
/// first scan of the new root comes back empty while state still lists every
/// path with `synced_version > 0` — which `locally_deleted_paths` reads as "the
/// user deleted all of these" and the push phase broadcasts as tombstones. The
/// team's knowledge would be deleted off every member's disk.
///
/// Renaming instead keeps the manifest keys (`knowledge/…`, root-relative)
/// unchanged, so this costs no re-download and loses no unpushed edit.
///
/// # Ordering
///
/// Must complete before the first tick. `ensure_initialized` is the only thing
/// that runs before sync for a team, which is why it lives here rather than in
/// the sync module.
///
/// Idempotent: a missing old directory or an existing new one is a no-op, so a
/// crash mid-migration resumes correctly on the next start.
fn migrate_pre_team_sync_layout(team_id: &str) -> std::io::Result<()> {
    let shared = super::layout::team_shared_dir(team_id);
    let sync_root = shared.join(SYNC_ROOT_DIR);

    for prefix in SHARED_PREFIXES {
        let legacy = shared.join(prefix);
        let target = sync_root.join(prefix);
        // Only when the old location has content and the new one is absent.
        // Both present means a half-finished move or a hand-made directory;
        // renaming over it could lose data, so leave it and say so.
        if !legacy.is_dir() {
            continue;
        }
        if target.exists() {
            tracing::warn!(
                team_id,
                prefix,
                "both the legacy and the team-sync copy of this directory exist; \
                 leaving them alone — the legacy one is no longer synced"
            );
            continue;
        }
        std::fs::create_dir_all(&sync_root)?;
        std::fs::rename(&legacy, &target)?;
        tracing::info!(
            team_id,
            prefix,
            "moved into the team-sync content root; manifest paths are unchanged"
        );
    }
    Ok(())
}

/// Log anything at the content root that is not one of the fixed prefixes.
///
/// One `read_dir`, not a walk. The scanner only ever descends into the prefixes
/// (`scanner.rs`, `for prefix in ALLOWED_PREFIXES`), so a stray root entry is
/// otherwise invisible: it never syncs and nothing says why. After the roots
/// were fixed there is no ordinary way to create one — Obsidian opens
/// `knowledge/`, agents reach the tree through per-prefix symlinks, the UI
/// offers no create action at the root — so this exists to explain the case
/// that should not happen, not to police one that does.
fn warn_on_unexpected_root_entries(team_id: &str, sync_root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(sync_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if SHARED_PREFIXES.contains(&name.as_ref()) {
            continue;
        }
        tracing::warn!(
            team_id,
            entry = %name,
            "unexpected entry at the sync root; it is not one of the fixed \
             prefixes and will never be synced"
        );
    }
}

pub fn ensure_initialized(team_id: &str) -> std::io::Result<PathBuf> {
    let dir = global_team_dir(team_id);
    std::fs::create_dir_all(&dir)?;
    // Knowledge syncs under `shared/knowledge` (the sync content root), not
    // under `shared/teamclu-team/knowledge` — see `sync_content_root`.
    let shared = super::layout::team_shared_dir(team_id);
    std::fs::create_dir_all(&shared)?;
    // Before anything creates the new tree, so the rename has a clear target.
    migrate_pre_team_sync_layout(team_id)?;
    let sync_root = sync_content_root(team_id);
    std::fs::create_dir_all(&sync_root)?;
    for prefix in SHARED_PREFIXES {
        std::fs::create_dir_all(sync_root.join(prefix))?;
    }
    warn_on_unexpected_root_entries(team_id, &sync_root);
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

    // ── the team-sync migration ───────────────────────────────────────────
    //
    // The assertion that matters is `migration_leaves_no_tombstone_candidates`.
    // If it regresses, upgrading deletes the team's knowledge off every
    // member's machine — the files stop being where the scan looks while
    // state.json still lists them, and the push phase reads that as intent.

    #[test]
    fn migration_moves_a_legacy_prefix_into_the_sync_root() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());

        let shared = super::super::layout::team_shared_dir("team-mig");
        std::fs::create_dir_all(shared.join("knowledge")).unwrap();
        std::fs::write(shared.join("knowledge/a.md"), b"hello").unwrap();

        ensure_initialized("team-mig").unwrap();

        let root = sync_content_root("team-mig");
        assert_eq!(
            std::fs::read(root.join("knowledge/a.md")).unwrap(),
            b"hello",
            "content must arrive at the new root"
        );
        assert!(
            !shared.join("knowledge").exists(),
            "the legacy directory must be gone, not copied"
        );
        assert!(root.join("documents").is_dir(), "both roots are created");
    }

    #[test]
    fn migration_leaves_no_tombstone_candidates() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());

        let shared = super::super::layout::team_shared_dir("team-tomb");
        std::fs::create_dir_all(shared.join("knowledge/sub")).unwrap();
        for path in ["knowledge/a.md", "knowledge/sub/b.md"] {
            std::fs::write(shared.join(path), b"x").unwrap();
        }

        ensure_initialized("team-tomb").unwrap();

        // The engine decides a file was deleted from "in state, absent from the
        // scan". state.json keys by the root-relative path and lives outside the
        // content root, so every one of these paths must still resolve under the
        // NEW root — otherwise the next push tombstones them for the whole team.
        let root = sync_content_root("team-tomb");
        for path in ["knowledge/a.md", "knowledge/sub/b.md"] {
            assert!(
                root.join(path).is_file(),
                "{path} must still be found where the scan now looks; \
                 if it is not, the next push deletes it for every member"
            );
        }
    }

    #[test]
    fn migration_is_idempotent_and_never_overwrites() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());

        let shared = super::super::layout::team_shared_dir("team-idem");
        std::fs::create_dir_all(shared.join("knowledge")).unwrap();
        std::fs::write(shared.join("knowledge/a.md"), b"legacy").unwrap();

        ensure_initialized("team-idem").unwrap();
        // A second run is a no-op — a crash mid-migration resumes correctly.
        ensure_initialized("team-idem").unwrap();
        let root = sync_content_root("team-idem");
        assert_eq!(
            std::fs::read(root.join("knowledge/a.md")).unwrap(),
            b"legacy"
        );

        // Both present: refuse rather than rename over content that is already
        // in the new location.
        std::fs::create_dir_all(shared.join("knowledge")).unwrap();
        std::fs::write(shared.join("knowledge/other.md"), b"reappeared").unwrap();
        ensure_initialized("team-idem").unwrap();
        assert_eq!(
            std::fs::read(root.join("knowledge/a.md")).unwrap(),
            b"legacy",
            "the migrated copy must not be clobbered"
        );
    }

    #[test]
    fn daemon_owned_dirs_are_siblings_of_the_sync_root_not_children() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());

        // This used to be held in place by comments saying "must stay outside
        // shared/". Moving the content root down makes it structural.
        let root = sync_content_root("team-sib");
        assert!(!global_team_dir("team-sib").starts_with(&root));
        assert!(!global_sync_state_path("team-sib").starts_with(&root));
    }

    #[test]
    fn global_dir_is_keyed_by_team_id() {
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
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
        let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
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
        // The team repo dir used to be INSIDE the synced tree, which is why the
        // list above had to be measured against `sync_content_root` rather than
        // against `shared/`. Moving the content root down to `team-sync/` put it
        // outside too, so it now belongs in the same list rather than as a
        // counter-example.
        assert!(
            !global_team_dir("team-a").starts_with(&synced),
            "the team repo dir is a sibling of the synced tree now, not a child"
        );
        // Guard the premise a different way: `synced` must be a real
        // subdirectory, or every assertion above passes vacuously.
        assert!(synced.starts_with(super::super::layout::team_shared_dir("team-a")));
        assert!(synced.ends_with(SYNC_ROOT_DIR));
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
        // The prefixes live under the sync content root — `shared/team-sync/` —
        // not under the repo dir and not directly under `shared/`.
        let shared = sync_content_root("team-x");
        for prefix in SHARED_PREFIXES {
            assert!(
                shared.join(prefix).is_dir(),
                "{prefix} should exist under the sync root"
            );
        }
    }
}
