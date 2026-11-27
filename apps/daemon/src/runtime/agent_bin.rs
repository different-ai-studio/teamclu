//! `amuxd` on the PATH of the agents this daemon runs.
//!
//! Agents manage apps with `amuxd app …` (P2.5), so their shell has to find
//! `amuxd`. Nothing guaranteed that: the desktop runs its bundled sidecar
//! straight out of the app bundle and never installs it anywhere on PATH. A
//! directory holding only `amuxd` — a link to this very executable — goes
//! first on each agent host's PATH. On Windows that is `amuxd.exe` (a hard
//! link, or a copy when the volumes differ), because pi's bash tool runs Git
//! Bash there, and MSYS bash finds `amuxd` only as `amuxd.exe`; an
//! `amuxd.cmd` next to it serves cmd and PowerShell. Only `amuxd`, not the
//! bundle's whole directory, and this daemon's own binary, so the CLI an
//! agent runs always matches the daemon it talks to.

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
            let tmp = dir.join(format!("amuxd.{}.tmp", std::process::id()));
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
        place_exe(&dir.join("amuxd.exe"), exe)?;
    }
    Ok(())
}

/// Make `dest` the same program as `exe`: a hard link, else a copy. Left
/// alone when it already is (same size and modification time), and kept when
/// it cannot be replaced because an agent is running it right now — it is
/// still a working amuxd, just the previous build.
#[cfg_attr(not(windows), allow(dead_code))]
fn place_exe(dest: &Path, exe: &Path) -> std::io::Result<()> {
    let same = |a: &Path, b: &Path| -> bool {
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
            _ => false,
        }
    };
    if same(dest, exe) {
        return Ok(());
    }
    let tmp = dest.with_extension(format!("{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    if std::fs::hard_link(exe, &tmp).is_err() {
        std::fs::copy(exe, &tmp)?;
        // A copy gets a new mtime; give it the source's so `same` holds next time.
        if let Ok(modified) = std::fs::metadata(exe).and_then(|m| m.modified()) {
            let _ = std::fs::File::options()
                .write(true)
                .open(&tmp)
                .and_then(|f| f.set_modified(modified));
        }
    }
    match std::fs::rename(&tmp, dest) {
        Ok(()) => Ok(()),
        Err(e) if dest.exists() => {
            let _ = std::fs::remove_file(&tmp);
            tracing::warn!(dest = %dest.display(), error = %e, "kept the previous agent amuxd (in use)");
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
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

    #[test]
    fn an_exe_is_placed_once_and_replaced_when_the_build_changes() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("amuxd-build");
        std::fs::write(&exe, b"v1").unwrap();
        let dest = dir.path().join("agent-bin-amuxd.exe");
        place_exe(&dest, &exe).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"v1");
        // Unchanged: left alone.
        place_exe(&dest, &exe).unwrap();
        // A new build (here a new file at the same path): replaced.
        std::fs::remove_file(&exe).unwrap();
        std::fs::write(&exe, b"v2-longer").unwrap();
        place_exe(&dest, &exe).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"v2-longer");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            2,
            "no temp left behind"
        );
    }

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
