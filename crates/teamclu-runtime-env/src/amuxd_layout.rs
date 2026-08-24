//! The amuxd home's internal layout — one definition for daemon and desktop.
//!
//! The daemon's `config::layout` and the desktop's `commands::amuxd_*` helpers
//! both delegate here, so a layout change is one edit instead of a mirrored
//! pair held together by a comment. Spec: `docs/architecture/amuxd-home-layout-v2.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Reserved directory name for a daemon that has not been claimed yet.
pub const UNCLAIMED_TEAM: &str = "_unclaimed";

pub fn run_dir(home: &Path) -> PathBuf {
    home.join("run")
}

/// The daemon's control endpoint — where `amuxd.sock`'s line/JSON protocol is
/// served, and the one thing the desktop needs to talk to a running daemon.
///
/// Two shapes, because Windows has no Unix sockets: a socket file under `run/`
/// on unix, and a named pipe on Windows. The daemon serves both (see
/// `spawn_sock_listener`'s two cfg arms); it is only the *name* that differs.
///
/// This lives here, beside every other amuxd path, for the reason #1049 made
/// concrete: the daemon derived the Windows pipe name and the desktop derived
/// `<run>/amuxd.sock`, so the two could never have met even after the desktop
/// learned to speak named pipes.
///
/// `home` is unused on Windows — pipe names live in a machine-global namespace
/// rather than under a directory, which is also why the name has to carry the
/// user (see [`control_pipe_suffix`]).
pub fn control_endpoint(home: &Path) -> PathBuf {
    #[cfg(not(windows))]
    {
        run_dir(home).join("amuxd.sock")
    }
    #[cfg(windows)]
    {
        let _ = home;
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "default".into());
        PathBuf::from(format!(r"\\.\pipe\amuxd-{}", control_pipe_suffix(&user)))
    }
}

/// Sanitize a username into `[A-Za-z0-9_-]` for use inside a Windows pipe name.
/// Non-ASCII / separator characters map to `-` (a multi-byte char produces one
/// `-` per char). Platform-independent so it is unit-testable everywhere.
pub fn control_pipe_suffix(user: &str) -> String {
    user.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

pub fn logs_dir(home: &Path) -> PathBuf {
    home.join("logs")
}

pub fn cache_dir(home: &Path) -> PathBuf {
    home.join("cache")
}

pub fn teams_dir(home: &Path) -> PathBuf {
    home.join("teams")
}

fn team_slug(team_id: &str) -> &str {
    let trimmed = team_id.trim();
    if trimmed.is_empty() {
        UNCLAIMED_TEAM
    } else {
        trimmed
    }
}

pub fn team_dir(home: &Path, team_id: &str) -> PathBuf {
    teams_dir(home).join(team_slug(team_id))
}

pub fn team_state_dir(home: &Path, team_id: &str) -> PathBuf {
    team_dir(home, team_id).join("state")
}

pub fn team_shared_dir(home: &Path, team_id: &str) -> PathBuf {
    team_dir(home, team_id).join("shared")
}

pub fn team_workspace_dir(home: &Path, team_id: &str) -> PathBuf {
    team_dir(home, team_id).join("workspace")
}

/// Just enough of `daemon.toml` to find the active team: path resolution must
/// not fail because an unrelated section stopped parsing.
#[derive(serde::Deserialize)]
struct ActiveTeamProbe {
    /// `active_team` on disk; `team_id` was the interim spelling.
    #[serde(default, alias = "team_id")]
    active_team: Option<String>,
}

/// The team the daemon under `home` is claimed by, or [`UNCLAIMED_TEAM`].
///
/// Mtime-cached: path helpers run on hot paths (every persisted message
/// resolves one), and the pointer changes only at claim time, so a stat
/// replaces a read + parse in the common case.
pub fn active_team(home: &Path) -> String {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, String)>>> = OnceLock::new();

    let path = home.join("daemon.toml");
    let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else {
        return UNCLAIMED_TEAM.to_string();
    };

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_mtime, team)) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&path)
        .filter(|(m, _)| *m == modified)
    {
        let _ = cached_mtime;
        return team.clone();
    }

    let team = std::fs::read_to_string(&path)
        .ok()
        .and_then(|body| toml::from_str::<ActiveTeamProbe>(&body).ok())
        .and_then(|probe| probe.active_team)
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| UNCLAIMED_TEAM.to_string());

    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path, (modified, team.clone()));
    team
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_team_probe_and_cache_follow_the_file() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(active_team(home.path()), UNCLAIMED_TEAM);

        std::fs::write(home.path().join("daemon.toml"), "active_team = \"t1\"\n").unwrap();
        assert_eq!(active_team(home.path()), "t1");
        // Cached read returns the same answer.
        assert_eq!(active_team(home.path()), "t1");

        // Garbage must not take path resolution down with it.
        std::fs::write(home.path().join("daemon.toml"), "active_team = [").unwrap();
        assert_eq!(active_team(home.path()), UNCLAIMED_TEAM);
    }

    #[test]
    fn empty_team_id_is_unclaimed() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            team_dir(home.path(), "  "),
            teams_dir(home.path()).join(UNCLAIMED_TEAM)
        );
    }

    #[test]
    fn control_pipe_suffix_sanitizes_to_safe_charset() {
        assert_eq!(control_pipe_suffix("matt.chow"), "matt-chow");
        // 2 CJK chars + 1 space -> 3 dashes.
        assert_eq!(control_pipe_suffix("\u{7b80}\u{4f53} user"), "---user");
        assert_eq!(control_pipe_suffix("Win_User-1"), "Win_User-1");
    }

    /// The daemon binds this and the desktop connects to it, so "both sides
    /// compute the same string" is the whole contract (#1049).
    #[test]
    fn control_endpoint_matches_the_platform_the_daemon_serves() {
        let home = tempfile::tempdir().unwrap();
        let endpoint = control_endpoint(home.path());
        if cfg!(windows) {
            let name = endpoint.to_string_lossy();
            assert!(
                name.starts_with(r"\\.\pipe\amuxd-"),
                "named pipe, not a path under home: {name}"
            );
        } else {
            assert_eq!(endpoint, run_dir(home.path()).join("amuxd.sock"));
        }
    }
}
