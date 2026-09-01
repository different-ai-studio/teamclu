//! Client-side mirror of the FC `validateSyncPath` (spec §3.1.1).
//! Plus an extra symlink-escape check for paths that actually exist on disk.

use std::path::Path;

/// Prefixes this client still syncs. Mirrors the daemon's list.
/// The two fixed roots of the synced tree. Must stay identical to the daemon's
/// list in `apps/daemon/src/sync/oss/path_validator.rs` and FC's in
/// `services/fc/src/lib/sync-path.ts` — three copies, and each one going stale
/// fails differently.
pub const ALLOWED_PREFIXES: &[&str] = &["documents/", "knowledge/"];

/// Moved to the Cloud API — see `apps/daemon/src/sync/oss/path_validator.rs`
/// for why these stay acceptable on the wire instead of being rejected.
pub const RETIRED_PREFIXES: &[&str] = &["skills/", ".mcp/", "_secrets/", "_meta/", "_feedback/"];

/// Whether a path belongs to a prefix that has moved to the Cloud API.
pub fn is_retired(path: &str) -> bool {
    RETIRED_PREFIXES.iter().any(|p| path.starts_with(p))
}

#[derive(Debug, thiserror::Error)]
#[error("InvalidPath: {0}")]
pub struct PathValidationError(pub String);

/// Validate a sync path coming from the wire or being uploaded.
/// Returns `Ok(())` or `Err(PathValidationError)`.
pub fn validate(path: &str) -> Result<(), PathValidationError> {
    if path.is_empty() {
        return Err(PathValidationError("path must be non-empty".into()));
    }
    if path.len() > 1024 {
        return Err(PathValidationError("path exceeds 1024 bytes".into()));
    }
    if path.contains('\0') {
        return Err(PathValidationError("path contains NUL byte".into()));
    }
    if path.chars().any(|c| c < '\x20') {
        return Err(PathValidationError(
            "path contains control character".into(),
        ));
    }
    if path.contains('\\') {
        return Err(PathValidationError(
            "path contains backslash; use forward slashes".into(),
        ));
    }
    if path.starts_with('/') {
        return Err(PathValidationError("absolute path not allowed".into()));
    }
    // Windows drive letter
    if path.len() >= 2 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_alphabetic() {
        return Err(PathValidationError("drive letter not allowed".into()));
    }
    // UNC
    if path.starts_with("//") {
        return Err(PathValidationError("UNC path not allowed".into()));
    }

    // Segment-level checks
    for seg in path.split('/') {
        if seg.is_empty() {
            return Err(PathValidationError(
                "path contains empty segment (double slash or trailing slash)".into(),
            ));
        }
        if seg == "." {
            return Err(PathValidationError(r#"path contains "." segment"#.into()));
        }
        if seg == ".." {
            return Err(PathValidationError(
                r#"path contains ".." segment (directory traversal)"#.into(),
            ));
        }
        if seg.len() > 255 {
            return Err(PathValidationError(format!(
                "path segment exceeds 255 bytes: {}…",
                &seg[..20]
            )));
        }
    }

    if !ALLOWED_PREFIXES.iter().any(|p| path.starts_with(p)) && !is_retired(path) {
        return Err(PathValidationError(format!(
            "path must start with one of: {}",
            ALLOWED_PREFIXES.join(", ")
        )));
    }

    Ok(())
}

/// Additional check: given a workspace-rooted absolute path, verify it does
/// not escape the workspace via symlink (symlink-escape check).
pub fn validate_no_symlink_escape(
    workspace_root: &Path,
    abs_path: &Path,
) -> Result<(), PathValidationError> {
    // Canonicalize without following the last component (it may not exist yet).
    // Walk the path components and check each existing prefix.
    let mut current = workspace_root.to_path_buf();
    let rel = abs_path
        .strip_prefix(workspace_root)
        .map_err(|_| PathValidationError("path is not inside workspace".into()))?;

    for component in rel.components() {
        current.push(component);
        if current.exists() {
            let canonical = current
                .canonicalize()
                .map_err(|e| PathValidationError(format!("canonicalize failed: {e}")))?;
            let ws_canonical = workspace_root
                .canonicalize()
                .unwrap_or_else(|_| workspace_root.to_path_buf());
            if !canonical.starts_with(&ws_canonical) {
                return Err(PathValidationError(format!(
                    "path escapes workspace via symlink: {}",
                    abs_path.display()
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(p: &str) {
        assert!(validate(p).is_ok(), "expected OK for {:?}", p);
    }
    fn err(p: &str) {
        assert!(validate(p).is_err(), "expected Err for {:?}", p);
    }

    #[test]
    fn test_valid_paths() {
        ok("knowledge/bar/baz.txt");
        ok("knowledge/top.md");
    }

    /// Retired prefixes must still validate — see the daemon twin for why.
    #[test]
    fn retired_prefixes_still_validate_but_are_flagged() {
        for retired in [
            "skills/a/SKILL.md",
            ".mcp/config.json",
            "_secrets/key.txt",
            "_meta/team.json",
            "_feedback/report.md",
        ] {
            ok(retired);
            assert!(is_retired(retired), "{retired} must be flagged retired");
        }
        assert!(!is_retired("knowledge/bar.md"));
        for retired in RETIRED_PREFIXES {
            assert!(!ALLOWED_PREFIXES.contains(retired));
        }
    }

    #[test]
    fn test_empty() {
        err("");
    }

    #[test]
    fn test_too_long() {
        let long = format!("knowledge/{}", "a".repeat(1020));
        err(&long);
    }

    #[test]
    fn test_nul_byte() {
        err("knowledge/foo\0bar");
    }

    #[test]
    fn test_control_char() {
        err("knowledge/foo\x01bar");
    }

    #[test]
    fn test_backslash() {
        err("skills\\foo");
    }

    #[test]
    fn test_absolute() {
        err("/skills/foo");
    }

    #[test]
    fn test_drive_letter() {
        err("C:skills/foo");
    }

    #[test]
    fn test_dotdot() {
        err("knowledge/../etc/passwd");
    }

    #[test]
    fn test_dot_segment() {
        err("knowledge/./foo");
    }

    #[test]
    fn test_double_slash() {
        err("knowledge//foo");
    }

    #[test]
    fn test_trailing_slash() {
        err("knowledge/foo/");
    }

    #[test]
    fn test_long_segment() {
        let seg = "a".repeat(256);
        err(&format!("knowledge/{}", seg));
    }

    #[test]
    fn test_disallowed_prefix() {
        err("other/foo.md");
        err("etc/passwd");
    }
}
