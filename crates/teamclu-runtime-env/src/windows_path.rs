//! Paths handed to Node must not keep Windows' `\\?\` verbatim prefix.
//!
//! `Path::canonicalize` (and Tauri's cached executable path, which
//! canonicalizes) returns `\\?\D:\...` on Windows. Node 22+ resolves that
//! prefix by calling `lstat` on the bare drive letter (`D:`), which fails
//! with `EISDIR: illegal operation on a directory, lstat 'D:'`. The plain
//! form names the same file and is what the module loader can realpath.
//!
//! Device paths that are not a drive (`\\?\Volume{...}`, `\\?\PHYSICALDRIVE0`)
//! stay unchanged: stripping those would point Node at a different object.

use std::path::{Path, PathBuf};

/// `path` with a Windows verbatim prefix removed when the result is still a
/// drive or UNC path. Other inputs, including POSIX paths, are unchanged.
pub fn path_for_node(path: &Path) -> PathBuf {
    PathBuf::from(path_for_node_str(&path.to_string_lossy()))
}

/// String form of [`path_for_node`]. A bare `D:` produced by stripping
/// `\\?\D:` becomes `D:\`, because `lstat('D:')` is the failure this exists
/// to avoid and `D:\` is the drive root that prefix was trying to name.
pub fn path_for_node_str(raw: &str) -> String {
    if let Some(rest) = strip_unc_verbatim(raw) {
        let sep = if raw.contains('/') { "/" } else { "\\" };
        return format!("{sep}{sep}{rest}");
    }
    if let Some(rest) = strip_verbatim_prefix(raw) {
        if is_drive_absolute(rest) {
            return rest.to_string();
        }
        if is_bare_drive(rest) {
            return format!("{rest}\\");
        }
    }
    raw.to_string()
}

fn strip_unc_verbatim(raw: &str) -> Option<&str> {
    const PREFIXES: [&str; 4] = ["\\\\?\\UNC\\", "\\\\?\\unc\\", "//?/UNC/", "//?/unc/"];
    PREFIXES.iter().find_map(|prefix| raw.strip_prefix(prefix))
}

fn strip_verbatim_prefix(raw: &str) -> Option<&str> {
    raw.strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
}

fn is_bare_drive(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_drive_absolute(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_verbatim_drive_and_keeps_the_rest_of_the_path() {
        assert_eq!(
            path_for_node_str(r"\\?\D:\Program Files\TeamClu\kb-maintainer\desktop-runner.js"),
            r"D:\Program Files\TeamClu\kb-maintainer\desktop-runner.js"
        );
        assert_eq!(
            path_for_node_str(r"\\?\D:\team\documents\AI行业应用\群策.pdf"),
            r"D:\team\documents\AI行业应用\群策.pdf"
        );
        assert_eq!(path_for_node_str(r"\\?\D:\"), r"D:\");
        assert_eq!(path_for_node_str(r"\\?\D:"), r"D:\");
        assert_eq!(
            path_for_node_str("//?/D:/team/documents/AI行业应用/"),
            "D:/team/documents/AI行业应用/"
        );
    }

    #[test]
    fn strips_a_verbatim_unc_prefix_without_touching_the_share() {
        assert_eq!(
            path_for_node_str(r"\\?\UNC\server\share\AI行业应用\a.pdf"),
            r"\\server\share\AI行业应用\a.pdf"
        );
        assert_eq!(
            path_for_node_str("//?/UNC/server/share/docs"),
            "//server/share/docs"
        );
    }

    #[test]
    fn leaves_plain_drive_posix_and_device_paths_alone() {
        assert_eq!(
            path_for_node_str(r"D:\team\documents"),
            r"D:\team\documents"
        );
        assert_eq!(path_for_node_str("D:"), "D:");
        assert_eq!(
            path_for_node_str("documents/AI行业应用/"),
            "documents/AI行业应用/"
        );
        assert_eq!(
            path_for_node_str("/tmp/documents/AI行业应用"),
            "/tmp/documents/AI行业应用"
        );
        assert_eq!(
            path_for_node_str(r"\\?\Volume{1234}\folder"),
            r"\\?\Volume{1234}\folder"
        );
        assert_eq!(
            path_for_node_str(r"\\?\PHYSICALDRIVE0"),
            r"\\?\PHYSICALDRIVE0"
        );
    }

    #[test]
    fn path_for_node_round_trips_through_pathbuf() {
        let path = Path::new(r"\\?\D:\team\documents\AI行业应用");
        assert_eq!(
            path_for_node(path),
            PathBuf::from(r"D:\team\documents\AI行业应用")
        );
    }
}
