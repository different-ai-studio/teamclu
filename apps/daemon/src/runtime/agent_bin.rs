//! `amuxd` on the PATH of the agents this daemon runs.
//!
//! Agents manage apps with `amuxd app …` (P2.5), so their shell has to find
//! `amuxd`. Nothing guaranteed that: the desktop runs its bundled sidecar
//! straight out of the app bundle and never installs it anywhere on PATH. A
//! directory holding only `amuxd` — a link to (or, on Windows, a `.cmd`
//! forwarding to) this very executable — goes first on each agent host's
//! PATH. Only `amuxd`, not the bundle's whole directory, and this daemon's own
//! binary, so the CLI an agent runs always matches the daemon it talks to.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The directory to put first on an agent host's PATH, or `None` when it
/// could not be made (the agent then finds whatever `amuxd` PATH has).
pub fn agent_bin_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = crate::config::layout::run_dir().join("agent-bin");
        match prepare(&dir, &exe) {
            Ok(()) => Some(dir),
            Err(e) => {
                tracing::warn!(dir = %dir.display(), error = %e, "could not put amuxd on agents' PATH");
                None
            }
        }
    })
    .as_deref()
}

/// Make `dir` hold an `amuxd` that runs `exe`, replacing a stale one.
fn prepare(dir: &Path, exe: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        let link = dir.join("amuxd");
        if std::fs::read_link(&link).ok().as_deref() != Some(exe) {
            let tmp = dir.join(format!(".amuxd.{}", std::process::id()));
            let _ = std::fs::remove_file(&tmp);
            std::os::unix::fs::symlink(exe, &tmp)?;
            std::fs::rename(&tmp, &link)?;
        }
    }
    #[cfg(windows)]
    {
        let shim = dir.join("amuxd.cmd");
        let body = format!("@\"{}\" %*\r\n", exe.display());
        if std::fs::read_to_string(&shim).ok().as_deref() != Some(body.as_str()) {
            std::fs::write(&shim, body)?;
        }
    }
    Ok(())
}

/// `path` with [`agent_bin_dir`] in front.
pub fn with_agent_bin(path: std::ffi::OsString) -> std::ffi::OsString {
    let Some(dir) = agent_bin_dir() else {
        return path;
    };
    let rest = std::env::split_paths(&path).filter(|p| p != dir);
    std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(rest)).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_link_points_at_this_executable_and_is_replaced_when_stale() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent-bin");
        let old = dir.path().join("old-amuxd");
        let new = dir.path().join("new-amuxd");
        prepare(&bin, &old).unwrap();
        assert_eq!(std::fs::read_link(bin.join("amuxd")).unwrap(), old);
        prepare(&bin, &new).unwrap();
        assert_eq!(std::fs::read_link(bin.join("amuxd")).unwrap(), new);
        // Idempotent.
        prepare(&bin, &new).unwrap();
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
    }
}
