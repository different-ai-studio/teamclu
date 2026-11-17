//! All-or-nothing writes for the daemon's own state files.
//!
//! `daemon.toml`, `runtimes.toml` and their neighbours were saved with a plain
//! `std::fs::write`, which truncates first and writes second. A daemon killed
//! between the two — or a second writer racing the first, and `daemon.toml`
//! has several — leaves a short or empty file. For `daemon.toml` that is not a
//! lost edit but a daemon that will not start: the file exists, so it is
//! parsed rather than bootstrapped, and the parse fails.

use std::path::Path;

/// Replace `path` with `content` through a sibling temp file and a rename.
///
/// A reader sees the old file or the new one, never part of either. The mode
/// of an existing file is carried over, since a rename would otherwise swap a
/// file the user had tightened for one created under the default umask.
pub fn write(path: &Path, content: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    let existing_mode = std::fs::metadata(path).ok().map(|m| m.permissions());

    // The rename is what makes this atomic; the helper also picks a temp name
    // no concurrent writer shares.
    #[cfg(unix)]
    if let Some(permissions) = existing_mode {
        return write_with(path, content, |tmp| {
            std::fs::set_permissions(tmp, permissions.clone())
        });
    }
    write_with(path, content, |_| Ok(()))
}

fn write_with(
    path: &Path,
    content: &str,
    prepare: impl Fn(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "state".to_string());
    let tmp = path.with_file_name(format!("{name}.{}.{seq}.tmp", std::process::id()));
    let result = std::fs::write(&tmp, content)
        .and_then(|()| prepare(&tmp))
        .and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_file_and_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        write(&path, "a = 1\n").unwrap();
        write(&path, "a = 2\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a = 2\n");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_mode_of_the_file_it_replaces() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(&path, "a = 1\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        write(&path, "a = 2\n").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// A failed write must not take the previous contents with it.
    #[test]
    fn a_failed_write_leaves_the_original_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(&path, "a = 1\n").unwrap();
        let failed = write_with(&path, "a = 2\n", |_| {
            Err(std::io::Error::other("disk went away"))
        });
        assert!(failed.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a = 1\n");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
