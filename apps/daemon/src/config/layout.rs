//! The one place `~/.amuxd` paths are constructed.
//!
//! Normative spec: `docs/architecture/amuxd-home-layout-v2.md`. The root holds
//! exactly the entries in [`teamclu_runtime_env::ROOT_ALLOWLIST`], and
//! [`tests::root_holds_only_allowlisted_entries`] is what keeps that true — the
//! old layout had no such rule, so every feature invented its own answer for
//! where to write and the root accumulated ~30 loose files.
//!
//! Adding a path here means answering one question first: *should this change
//! when the team changes?* Yes → [`team_state_dir`]. No, and it is a cache →
//! [`cache_dir`]. No, and it dies with the process → [`run_dir`].

use std::path::PathBuf;

use super::DaemonConfig;

/// `~/.amuxd` (or `~/.amuxd-<brand>`, or `$AMUXD_HOME`).
pub fn root() -> PathBuf {
    DaemonConfig::config_dir()
}

/// Process runtime: pid, lock, control socket, HTTP discovery, child pgids.
///
/// Everything here is safe to delete while the daemon is stopped — it is
/// rebuilt on the next boot and describes *this* process, not any state.
pub fn run_dir() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::run_dir(&root())
}

/// The control endpoint this daemon binds — `run/amuxd.sock` on unix, a named
/// pipe on Windows. Shared with the desktop, which has to connect to it.
///
/// Note the Windows half is NOT under `run/`: a pipe name lives in a
/// machine-global namespace, so the "safe to delete" rule above does not reach
/// it.
pub fn control_endpoint() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::control_endpoint(&root())
}

/// Rotating daemon log.
pub fn logs_dir() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::logs_dir(&root())
}

/// Machine-level caches: keyed by backend or worktree, never by team. Deleting
/// any of it costs one cold probe and nothing else.
pub fn cache_dir() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::cache_dir(&root())
}

/// `~/.amuxd/mcp.json` — device-level MCP servers (see `config::device_mcp`).
///
/// At the root because it is the one MCP layer that is neither per-team nor a
/// cache: it describes *this machine's* tools (this daemon's socket, the local
/// `npx` bridges), survives a team switch, and holds the user's enable toggles.
pub fn device_mcp_file() -> PathBuf {
    root().join("mcp.json")
}

/// One directory per team.
pub fn teams_dir() -> PathBuf {
    teamclu_runtime_env::amuxd_layout::teams_dir(&root())
}

/// Reserved directory name for a daemon that has not been claimed yet.
///
/// Unclaimed is a supported resting state (`DeferredBackend::unclaimed()`), and
/// the embedded `/v1/ui` chat can create sessions in it, so those writes need
/// somewhere to land. Giving them a directory means the code has exactly one
/// path — "the current team's directory" — instead of a `None` branch at every
/// write site. Team ids are UUIDs, so the leading underscore cannot collide.
pub const UNCLAIMED_TEAM: &str = teamclu_runtime_env::amuxd_layout::UNCLAIMED_TEAM;

/// `teams/<id>`, or `teams/_unclaimed` when there is no team yet.
pub fn team_dir(team_id: &str) -> PathBuf {
    team_dir_in(&root(), team_id)
}

/// [`team_dir`] under an explicit home, for callers that already hold one —
/// notably `SecretStore`, whose tests point it at a temp directory. Same layout
/// either way, so a fixture cannot drift from the real thing.
pub fn team_dir_in(home: &std::path::Path, team_id: &str) -> PathBuf {
    teamclu_runtime_env::amuxd_layout::team_dir(home, team_id)
}

/// [`team_state_dir`] under an explicit home.
pub fn team_state_dir_in(home: &std::path::Path, team_id: &str) -> PathBuf {
    team_dir_in(home, team_id).join("state")
}

/// `teams/<id>/shared` — the **only** path the sync engine is allowed to scan.
///
/// Everything the daemon writes for a team is a sibling of this, never inside
/// it. That is what makes "will adding a file here push it to the cloud?"
/// answerable with a flat no: under the old layout the answer depended on which
/// level you added it at, and `cloud/` only escaped the scanner by being a
/// sibling of `teamclu-team/` — an implicit rule with nothing enforcing it.
pub fn team_shared_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("shared")
}

/// `teams/<id>/state` — daemon-private, never synced.
pub fn team_state_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("state")
}

/// `teams/<id>/workspace` — the writable default worktree for spawns that carry
/// no workspace of their own.
pub fn team_workspace_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("workspace")
}

/// `teams/<id>/apps` — one directory per app, and the only place an app's
/// files live.
///
/// A sibling of `state/`, not a child of it: an app checkout is the user's own
/// project, not daemon bookkeeping, and it is what an agent session opens as
/// its working directory. Nor is it under `workspace/`, which is the shared
/// default worktree — an app owns its directory outright.
pub fn team_apps_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("apps")
}

/// `teams/<active>/apps` — the app root for the team this daemon serves.
pub fn active_apps_dir() -> PathBuf {
    team_apps_dir(&active_team())
}

fn team_slug(team_id: &str) -> &str {
    let trimmed = team_id.trim();
    if trimmed.is_empty() {
        UNCLAIMED_TEAM
    } else {
        trimmed
    }
}
// (slug rule lives in teamclu_runtime_env::amuxd_layout; this local copy only
// serves promote_unclaimed's rename bookkeeping)

/// The team this daemon is currently claimed by, or [`UNCLAIMED_TEAM`].
/// Mtime-cached in `teamclu_runtime_env` — path helpers sit on hot paths.
pub fn active_team() -> String {
    teamclu_runtime_env::amuxd_layout::active_team(&root())
}

/// `teams/<active>/state` — where this daemon's team-scoped files live now.
pub fn active_state_dir() -> PathBuf {
    team_state_dir(&active_team())
}

/// Adopt whatever an unclaimed daemon wrote, at the moment it gets a team.
///
/// A rename, so the sessions and history the daemon accumulated before
/// onboarding survive it, and so there is only ever one directory to look in.
///
/// When the target already exists the daemon is re-claiming a team it already
/// has state for. Merging two stores is not something a path module can decide,
/// so `_unclaimed` is left where it is and reported — inert, and still there to
/// recover by hand.
pub fn promote_unclaimed(team_id: &str) -> std::io::Result<()> {
    let slug = team_slug(team_id);
    if slug == UNCLAIMED_TEAM {
        return Ok(());
    }
    let from = teams_dir().join(UNCLAIMED_TEAM);
    if !from.is_dir() {
        return Ok(());
    }
    let to = teams_dir().join(slug);
    if to.exists() {
        // A target with no `state/` is not "existing state" — it is a shell a
        // v1 install (or a bare `shared/` checkout) left behind. Adopting the
        // unclaimed `state/` into it is what keeps the standard v1-upgrade +
        // re-onboard path from stranding pre-onboarding sessions.
        let to_state = to.join("state");
        let from_state = from.join("state");
        if !to_state.exists() && from_state.is_dir() {
            std::fs::rename(&from_state, &to_state)?;
            let _ = std::fs::remove_dir(&from);
            return Ok(());
        }
        tracing::warn!(
            from = %from.display(),
            to = %to.display(),
            "claimed a team that already has local state; leaving the unclaimed \
             directory in place rather than merging"
        );
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)
}

/// Create the fixed subdirectories so callers can write without each of them
/// re-deriving a `create_dir_all`. Best effort: a failure here surfaces at the
/// actual write, with a path in the message.
pub fn ensure() {
    for dir in [run_dir(), logs_dir(), cache_dir(), teams_dir()] {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(dir = %dir.display(), error = %e, "create amuxd layout dir failed");
        }
    }
}

/// Files the v1 layout left at the root, removed on first boot of a v2 daemon.
///
/// Not a migration — ADR-0006 chose a hard cutover, and nothing here is read
/// any more. They are deleted rather than left alone because two of them are
/// live credentials: `backend.toml` still holds a usable `refresh_token`, and
/// `daemon.toml`'s `[channels]` bot tokens and `agents.cursor.api_key` are
/// plaintext. Keeping dead files would be untidy; keeping these is a risk.
const V1_ROOT_FILES: &[&str] = &[
    "amuxd.cloud-token",
    "amuxd.err.log",
    "amuxd.http.port",
    "amuxd.http.token",
    "amuxd.lock",
    "amuxd.managed.log",
    "amuxd.out.log",
    "amuxd.pid",
    "amuxd.sock",
    "backend.toml",
    "daemon.toml",
    "members.toml",
    "model-catalog.toml",
    "model-mru.toml",
    "opencode.serve.pgid",
    "secret.key",
    "sessions.toml",
    "supabase.toml",
    "workspaces.toml",
];

/// Directories the v1 layout left at the root.
///
/// `teams/` is absent on purpose: v2 keeps it, and the per-team subtree is
/// reshaped in place rather than thrown away.
const V1_ROOT_DIRS: &[&str] = &[
    "apps",
    "attachments",
    "bin",
    "history",
    "mcp-configs",
    "pi-sessions",
    "team-secrets",
    "teamclaw",
    "teamclu",
];

/// v1 subdirectories inside `teams/<id>/` that v2 relocated (`teamclu-team` →
/// `shared/teamclu-team`, `cloud` → `state/cloud`, `sync` → `state/sync.json`).
/// Removed rather than moved — hard cutover, the next sync repopulates — and
/// removing them is what lets `promote_unclaimed` adopt into a team directory
/// a v1 install left behind.
const V1_TEAM_SUBDIRS: &[&str] = &["teamclu-team", "cloud", "sync"];

/// One-shot: remove the v1 layout. Marked by a file under `teams/`, so a second
/// boot costs one `exists()`.
///
/// Runs under the daemon lock, before anything reads config — see
/// `docs/architecture/amuxd-home-layout-v2.md` §7. A daemon that had already
/// onboarded comes up unclaimed afterwards and the user re-onboards; that is
/// the cutover, and it is visible rather than silent.
pub fn purge_v1_layout() {
    let marker = teams_dir().join(".v1-purged");
    if marker.exists() {
        return;
    }
    let root = root();
    if !root.is_dir() {
        return;
    }

    let mut removed = 0usize;
    for name in V1_ROOT_FILES {
        if std::fs::remove_file(root.join(name)).is_ok() {
            removed += 1;
        }
    }
    for name in V1_ROOT_DIRS {
        if std::fs::remove_dir_all(root.join(name)).is_ok() {
            removed += 1;
        }
    }
    // Timestamped backups the old config writers left behind. Same reasoning as
    // `backend.toml`: `daemon.toml.bak.<ts>` carries the previous team's
    // credentials, and nothing prunes them.
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.contains(".bak.") || name.contains(".bak-") {
                if std::fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }

    // The v1 layout *inside* surviving team directories.
    if let Ok(entries) = std::fs::read_dir(teams_dir()) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            for sub in V1_TEAM_SUBDIRS {
                if std::fs::remove_dir_all(entry.path().join(sub)).is_ok() {
                    removed += 1;
                }
            }
        }
    }

    // The pre-`~/.amuxd` config directory. `migrate_legacy_file` used to copy
    // files back out of it on every entry point; the copier is gone, but the
    // directory still holds a `daemon.toml`/`backend.toml` generation with
    // live credentials — the exact class of file this purge exists to remove.
    if let Some(config_dir) = dirs::config_dir() {
        if std::fs::remove_dir_all(config_dir.join("amux")).is_ok() {
            removed += 1;
        }
    }

    if let Err(e) = std::fs::create_dir_all(marker.parent().unwrap_or(&root))
        .and_then(|_| std::fs::write(&marker, "v1 layout removed\n"))
    {
        tracing::warn!(error = %e, "could not mark the v1 purge; it will retry next boot");
        return;
    }
    if removed > 0 {
        tracing::info!(
            removed,
            "removed the v1 amuxd layout (ADR-0006 hard cutover)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_brand_env::BrandEnvGuard;
    use std::collections::BTreeSet;
    use teamclu_runtime_env::ROOT_ALLOWLIST;

    #[test]
    fn active_team_is_unclaimed_until_daemon_toml_names_one() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());

        assert_eq!(active_team(), UNCLAIMED_TEAM);

        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-a\"\n",
        )
        .unwrap();
        assert_eq!(active_team(), "team-a");

        // A config that no longer parses must not take path resolution down
        // with it — an unclaimed daemon still has to boot and serve setup.
        std::fs::write(home.path().join("daemon.toml"), "active_team = [").unwrap();
        assert_eq!(active_team(), UNCLAIMED_TEAM);
    }

    #[test]
    fn claiming_a_team_adopts_the_unclaimed_directory() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());

        let before = team_state_dir("");
        std::fs::create_dir_all(&before).unwrap();
        std::fs::write(before.join("runtimes.toml"), b"sessions = []").unwrap();

        promote_unclaimed("team-a").unwrap();

        assert!(!teams_dir().join(UNCLAIMED_TEAM).exists());
        assert!(team_state_dir("team-a").join("runtimes.toml").is_file());
    }

    /// Re-claiming a team this daemon already has state for must not clobber it.
    /// Merging two stores is not a decision this module can make, so the
    /// unclaimed directory is left behind to recover by hand.
    #[test]
    fn claiming_a_team_that_already_has_state_leaves_both() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());

        std::fs::create_dir_all(team_state_dir("")).unwrap();
        std::fs::create_dir_all(team_state_dir("team-a")).unwrap();
        std::fs::write(
            team_state_dir("team-a").join("backend.toml"),
            b"kind = \"x\"",
        )
        .unwrap();

        promote_unclaimed("team-a").unwrap();

        assert!(teams_dir().join(UNCLAIMED_TEAM).exists());
        assert!(team_state_dir("team-a").join("backend.toml").is_file());
    }

    #[test]
    fn subdirectories_are_all_allowlisted() {
        let expected: BTreeSet<&str> = ROOT_ALLOWLIST.iter().copied().collect();
        for dir in ["run", "logs", "cache", "teams"] {
            assert!(
                expected.contains(dir),
                "{dir}/ is not in ROOT_ALLOWLIST — update the spec and the constant together"
            );
        }
    }

    /// The acceptance criterion from the spec, executable: after a full
    /// layout + config bootstrap, nothing unlisted exists at the root.
    #[test]
    fn root_holds_only_allowlisted_entries() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());

        ensure();
        DaemonConfig::bootstrap()
            .save(&DaemonConfig::default_path())
            .unwrap();
        crate::device_id::daemon_device_id();

        let allowed: BTreeSet<&str> = ROOT_ALLOWLIST.iter().copied().collect();
        let found: BTreeSet<String> = std::fs::read_dir(root())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();

        let unexpected: Vec<&String> = found
            .iter()
            .filter(|name| !allowed.contains(name.as_str()))
            .collect();
        assert!(
            unexpected.is_empty(),
            "unlisted entries at the amuxd root: {unexpected:?}\n\
             Put it under run/, logs/, cache/ or teams/<id>/state/ — see \
             docs/architecture/amuxd-home-layout-v2.md §1."
        );
    }
}
