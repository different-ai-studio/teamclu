//! The zip-entry path guard, shared by every unpacker.
//!
//! Two crates unpack skill packages — the desktop installer and the daemon's
//! reconcile — and they cannot share the unpacking code itself because they sit
//! on different major versions of the `zip` crate. What they must share is
//! this: the rule for which archive entry names are allowed to become paths.
//! A traversal guard that exists in two copies is a guard that will eventually
//! disagree with itself, and the copy that drifts is the one that writes
//! outside the target directory.
//!
//! Deliberately dependency-free string logic so it can live in the crate both
//! sides already depend on.

/// Normalise an archive entry name, or reject it.
///
/// Returns `None` for anything that must not be written: directory entries,
/// absolute paths, parent-directory traversal, backslashes (which some
/// archivers emit as separators and which would otherwise slip past a `/`-only
/// check on Windows), and colons. A colon is how a Windows name carries a
/// drive (`C:/x/evil.cmd`) — and `target.join("C:/x")` *replaces* the target
/// rather than extending it — or an NTFS alternate data stream. No file name
/// that is valid on every platform a skill ships to contains one.
pub fn sanitize_zip_path(raw: &str) -> Option<String> {
    let normalized = raw.trim_start_matches("./").trim_start_matches('/');
    if normalized.is_empty() || normalized.ends_with('/') {
        return None;
    }
    if normalized.contains("..") || normalized.contains('\\') || normalized.contains(':') {
        return None;
    }
    Some(normalized.to_string())
}

/// Carry an archive entry's executable bit onto the file just written.
///
/// Skills ship scripts, and a script that arrives without `+x` fails the first
/// time the agent runs it. Worse under auto-follow: the user fixes it with
/// `chmod +x`, and because the baseline records the exec bit as part of a
/// file's identity, that fix reads as a local edit — auto-follow stops for that
/// pack permanently, and the conflict UI shows an empty diff because the bytes
/// are identical. The only exit it offers is discarding the fix.
///
/// Only the executable bit is honoured, not the rest of the mode: an archive
/// built on another machine can carry group/other bits nobody here intended,
/// and the package has no business setting them.
pub fn apply_zip_mode(path: &std::path::Path, unix_mode: Option<u32>) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Some(mode) = unix_mode else {
            return Ok(());
        };
        if mode & 0o111 == 0 {
            return Ok(());
        }
        let current = std::fs::metadata(path)?.permissions().mode();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(current | 0o111))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, unix_mode);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn an_executable_entry_stays_executable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("check.sh");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        apply_zip_mode(&path, Some(0o100755)).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert!(mode & 0o111 != 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_plain_entry_is_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("SKILL.md");
        std::fs::write(&path, "body\n").unwrap();
        apply_zip_mode(&path, Some(0o100644)).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0);
        // A zip with no mode information at all must not invent one.
        apply_zip_mode(&path, None).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o111,
            0
        );
    }

    #[test]
    fn ordinary_entries_pass_through() {
        assert_eq!(sanitize_zip_path("SKILL.md").as_deref(), Some("SKILL.md"));
        assert_eq!(
            sanitize_zip_path("scripts/check.sh").as_deref(),
            Some("scripts/check.sh")
        );
    }

    #[test]
    fn leading_markers_are_stripped() {
        assert_eq!(sanitize_zip_path("./SKILL.md").as_deref(), Some("SKILL.md"));
        assert_eq!(sanitize_zip_path("/SKILL.md").as_deref(), Some("SKILL.md"));
    }

    #[test]
    fn traversal_and_directory_entries_are_rejected() {
        assert_eq!(sanitize_zip_path("../../etc/passwd"), None);
        assert_eq!(sanitize_zip_path("a/../../b"), None);
        // Backslash separators would survive a `/`-only traversal check.
        assert_eq!(sanitize_zip_path("a\\..\\b"), None);
        // A drive prefix makes `join` discard the target directory on Windows.
        assert_eq!(sanitize_zip_path("C:/Users/x/evil.cmd"), None);
        assert_eq!(sanitize_zip_path("/C:/Users/x/evil.cmd"), None);
        assert_eq!(sanitize_zip_path("SKILL.md:stream"), None);
        assert_eq!(sanitize_zip_path("scripts/"), None);
        assert_eq!(sanitize_zip_path(""), None);
        assert_eq!(sanitize_zip_path("/"), None);
    }
}
