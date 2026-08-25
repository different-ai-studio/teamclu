//! Workspace file scanner — mtime/size dirty detection + allowed-prefix filter.
//!
//! Responsibilities:
//! - Walk the workspace looking for files under allowed prefixes.
//! - Skip conflict sidecar files (`*.conflict.*`).
//! - Cheap dirty check: if mtime+size match state, assume clean.
//! - If mtime/size differ, recompute sha256(plaintext) and compare against
//!   `local_plain_hash` in state to detect real changes.
//! - Returns the list of relative paths that are dirty (or new).

use super::{crypto::sha256_hex, path_validator::ALLOWED_PREFIXES, state::LocalSyncState};
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// A file found during the scan.
#[derive(Debug, Clone)]
pub struct ScannedFile {
    /// Relative path from workspace root (forward slashes).
    pub rel_path: String,
    /// Current mtime (unix seconds).
    pub mtime: u64,
    /// Current size in bytes.
    pub size: u64,
    /// sha256 of current plaintext (only computed when needed).
    pub local_plain_hash: String,
    /// True if this file needs to be uploaded.
    pub dirty: bool,
}

/// Scan the workspace and return all files under allowed prefixes,
/// marking dirty ones.
pub fn scan_workspace(workspace_path: &str, state: &LocalSyncState) -> Vec<ScannedFile> {
    let root = Path::new(workspace_path);
    let mut results = Vec::new();

    for prefix in ALLOWED_PREFIXES {
        let prefix_dir = root.join(prefix.trim_end_matches('/'));
        if !prefix_dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&prefix_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path();
            let rel = match abs.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };

            // Skip conflict sidecar files
            if is_conflict_file(&rel) {
                continue;
            }

            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let size = meta.len();

            // Cheap path: mtime + size match state → assume clean.
            if let Some(fs) = state.files.get(&rel) {
                if fs.mtime == mtime && fs.size == size {
                    // File unchanged from last scan — emit as non-dirty.
                    results.push(ScannedFile {
                        rel_path: rel,
                        mtime,
                        size,
                        local_plain_hash: fs.local_plain_hash.clone(),
                        dirty: false,
                    });
                    continue;
                }
            }

            // mtime/size changed — recompute hash.
            let plaintext = match std::fs::read(abs) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let local_plain_hash = sha256_hex(&plaintext);

            let dirty = state
                .files
                .get(&rel)
                .map(|fs| fs.synced_plain_hash != local_plain_hash)
                .unwrap_or(true); // new file → dirty

            results.push(ScannedFile {
                rel_path: rel,
                mtime,
                size,
                local_plain_hash,
                dirty,
            });
        }
    }

    results
}

/// Walk the workspace under allowed prefixes and return the relative paths of
/// all conflict sidecar files (`*.conflict.*`) currently on disk.
///
/// Used by `oss_sync_status` to surface conflicted files in the file tree;
/// `scan_workspace` deliberately skips these, so they need a separate pass.
pub fn scan_conflict_files(workspace_path: &str) -> Vec<String> {
    let root = Path::new(workspace_path);
    let mut results = Vec::new();

    for prefix in ALLOWED_PREFIXES {
        let prefix_dir = root.join(prefix.trim_end_matches('/'));
        if !prefix_dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&prefix_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = match entry.path().strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if is_conflict_file(&rel) {
                results.push(rel);
            }
        }
    }

    results
}

/// Returns true if the relative path is a conflict sidecar.
/// Pattern: `*.conflict.*` (any segment containing `.conflict.`).
pub fn is_conflict_file(rel_path: &str) -> bool {
    // Check the filename component
    let filename = rel_path.rsplit('/').next().unwrap_or(rel_path);
    has_conflict_infix(filename)
}

/// Whether a filename is one the conflict writer produced:
/// `<stem>.conflict.<unix_ts>.<hash>[.<ext>]`.
///
/// The timestamp is what makes it ours. Accepting any name with a `.conflict.`
/// infix swept up ordinary documents — `merge.conflict.md` is a note somebody
/// wrote — and that had two consequences: sync silently refused to upload it
/// (sidecars are never pushed), and the conflicts endpoint listed it as a
/// decision that could never be made, because reversing the name to find "the
/// document it belongs to" fails and the resolve guard then rejects it.
fn has_conflict_infix(name: &str) -> bool {
    let Some((_, suffix)) = name.split_once(".conflict.") else {
        return false;
    };
    let mut parts = suffix.split('.');
    let Some(ts) = parts.next() else {
        return false;
    };
    if ts.is_empty() || !ts.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // A hash segment always follows the timestamp; the extension is optional.
    parts.next().is_some_and(|hash| !hash.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::oss::state::LocalSyncState;

    #[test]
    fn test_conflict_detection() {
        assert!(is_conflict_file(
            "knowledge/foo.conflict.1748332800.abc12345.md"
        ));
        assert!(is_conflict_file(
            "knowledge/bar.conflict.1748332800.def67890"
        ));
        assert!(!is_conflict_file("knowledge/foo.md"));
        // A document somebody named after the word: not ours, must sync
        // normally and must never appear as a decision to make.
        assert!(!is_conflict_file("knowledge/merge.conflict.md"));
        assert!(!is_conflict_file("knowledge/notes.conflict.draft.md"));
        // Shaped like ours but with no hash segment.
        assert!(!is_conflict_file("knowledge/foo.conflict.1748332800"));
        assert!(!is_conflict_file("knowledge/conflict.md")); // "conflict" not after "."
        assert!(!is_conflict_file("knowledge/my.conflict")); // no dot after "conflict"
    }

    #[test]
    fn test_scan_dirty_detection() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let skills_dir = dir.path().join("knowledge");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("hello.md"), b"hello world").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let files = scan_workspace(ws, &state);

        // New file → dirty
        let f = files
            .iter()
            .find(|f| f.rel_path == "knowledge/hello.md")
            .unwrap();
        assert!(f.dirty);
        assert_eq!(f.local_plain_hash, super::sha256_hex(b"hello world"));
    }

    #[test]
    fn test_scan_skips_conflict_files() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let skills_dir = dir.path().join("knowledge");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            skills_dir.join("foo.conflict.1234567890.abc12345.md"),
            b"conflict",
        )
        .unwrap();
        std::fs::write(skills_dir.join("real.md"), b"real").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let files = scan_workspace(ws, &state);

        assert!(files.iter().any(|f| f.rel_path == "knowledge/real.md"));
        assert!(!files.iter().any(|f| f.rel_path.contains(".conflict.")));
    }

    #[test]
    fn test_scan_conflict_files_collects_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let skills_dir = dir.path().join("knowledge");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("real.md"), b"real").unwrap();
        std::fs::write(
            skills_dir.join("foo.conflict.1234567890.abc12345.md"),
            b"conflict",
        )
        .unwrap();

        let conflicts = scan_conflict_files(ws);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains(".conflict."));
        assert!(!conflicts.iter().any(|c| c == "knowledge/real.md"));
    }

    #[test]
    fn test_scan_skips_disallowed_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let other_dir = dir.path().join("other");
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(other_dir.join("file.md"), b"data").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let files = scan_workspace(ws, &state);
        assert!(files.is_empty());
    }

    #[test]
    fn test_scan_clean_if_mtime_size_match() {
        use crate::sync::oss::state::FileState;
        use std::time::UNIX_EPOCH;

        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let skills_dir = dir.path().join("knowledge");
        std::fs::create_dir_all(&skills_dir).unwrap();
        let file_path = skills_dir.join("stable.md");
        let content = b"stable content";
        std::fs::write(&file_path, content).unwrap();

        let meta = std::fs::metadata(&file_path).unwrap();
        let mtime = meta
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let size = meta.len();
        let hash = sha256_hex(content);

        let mut state = LocalSyncState::load(ws, "team-test").unwrap();
        state.files.insert(
            "knowledge/stable.md".to_string(),
            FileState {
                synced_version: 1,
                synced_cipher_hash: "fake_cipher".into(),
                synced_plain_hash: hash.clone(),
                local_plain_hash: hash.clone(),
                mtime,
                size,
                dirty: false,
                deleted_local: false,
            },
        );

        let files = scan_workspace(ws, &state);
        let f = files
            .iter()
            .find(|f| f.rel_path == "knowledge/stable.md")
            .unwrap();
        assert!(!f.dirty, "file should be clean (mtime+size match)");
    }
}
