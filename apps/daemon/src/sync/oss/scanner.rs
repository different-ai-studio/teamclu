//! Workspace file scanner — mtime/size dirty detection + allowed-prefix filter.
//!
//! Responsibilities:
//! - Walk the workspace looking for files under allowed prefixes.
//! - Prune ignored entries ([`IgnoreRules`]) without descending into them —
//!   never walking `node_modules/` is most of why this stays cheap.
//! - Hard-skip the `.conflicts/` directory (not via IgnoreRules — a team
//!   `!.conflicts/` must not re-include it) and relocate any legacy sidecar
//!   still sitting beside a note into that directory (move-on-scan).
//! - Cheap dirty check: if mtime+size match state, assume clean.
//! - If mtime/size differ, recompute sha256(plaintext) and compare against
//!   `local_plain_hash` in state to detect real changes.
//! - Returns the list of relative paths that are dirty (or new).

use super::{
    conflict::{self, CONFLICTS_DIR},
    crypto::sha256_hex,
    ignore_rules::IgnoreRules,
    path_validator::ALLOWED_PREFIXES,
    state::LocalSyncState,
};
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

/// Scan the workspace and return all files under allowed prefixes, marking
/// dirty ones.
///
/// Rules are the caller's to supply, deliberately: a sync tick builds one set
/// and threads it through scan, pull and tombstone, and a convenience form that
/// loaded its own would let those three disagree within a single tick — which
/// is exactly the shape of the delete-everything failure in §4.6 of
/// `docs/architecture/obsidian-compatible-knowledge.md`.
pub fn scan_workspace_with(
    workspace_path: &str,
    state: &LocalSyncState,
    rules: &IgnoreRules,
) -> Vec<ScannedFile> {
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
            // Prune at the directory, so an ignored tree costs one stat instead
            // of a full walk. This is also what makes the rules affordable at
            // all: `node_modules/` is the case they exist for.
            //
            // `.conflicts/` is pruned here as a HARD rule (checked before
            // IgnoreRules) so a team `.amuxignore` `!.conflicts/` cannot put
            // conflict copies back on the sync path.
            .filter_entry(|e| {
                if is_conflicts_dir_entry(root, e) {
                    return false;
                }
                !is_ignored_entry(root, e, rules)
            })
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

            // Defense in depth — should already be pruned by filter_entry.
            if conflict::is_under_conflicts_dir(&rel) {
                continue;
            }

            // Legacy sidecar beside a note: relocate under `.conflicts/` and
            // keep scanning. Sidecars were never uploaded, so this is a local
            // rename with no tombstone side effect.
            if is_conflict_file(&rel) {
                let _ = conflict::migrate_legacy_conflict_sidecar(root, &rel);
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

/// Walk each prefix's `.conflicts/` directory and return the relative paths of
/// all conflict sidecar files currently on disk.
///
/// Relocates any legacy sidecars still sitting beside notes first (move-on-scan),
/// so the conflicts UI sees a consistent layout even before the next full sync
/// tick. Used by `GET /v1/team/conflicts`; `scan_workspace_with` deliberately
/// skips these, so they need a separate pass.
pub fn scan_conflict_files(workspace_path: &str) -> Vec<String> {
    let root = Path::new(workspace_path);
    migrate_legacy_sidecars_under(root);

    let mut results = Vec::new();
    for prefix in ALLOWED_PREFIXES {
        let conflicts_dir = root
            .join(prefix.trim_end_matches('/'))
            .join(CONFLICTS_DIR);
        if !conflicts_dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&conflicts_dir)
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

/// Relocate every legacy sidecar under allowed prefixes into `.conflicts/`.
/// Does not descend into `.conflicts/` itself.
fn migrate_legacy_sidecars_under(root: &Path) {
    for prefix in ALLOWED_PREFIXES {
        let prefix_dir = root.join(prefix.trim_end_matches('/'));
        if !prefix_dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&prefix_dir)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_conflicts_dir_entry(root, e))
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if is_conflict_file(&rel) {
                let _ = conflict::migrate_legacy_conflict_sidecar(root, &rel);
            }
        }
    }
}

/// Entries the rules exclude, as the shallowest paths that explain the
/// exclusion: an ignored directory is reported once, and its contents are not
/// walked at all.
///
/// That shape is deliberate. `node_modules/` holds tens of thousands of files;
/// listing every one of them to tell the UI "these are ignored" would cost more
/// than the sync this exists to prevent. One entry per ignored root is enough —
/// the caller marks anything beneath it by prefix.
///
/// Paths are relative to `content_root`, forward slashes, sorted.
pub fn scan_ignored(content_root: &str, rules: &IgnoreRules) -> Vec<String> {
    let root = Path::new(content_root);
    let mut out = Vec::new();
    for prefix in ALLOWED_PREFIXES {
        let prefix_dir = root.join(prefix.trim_end_matches('/'));
        if prefix_dir.is_dir() {
            collect_ignored(root, &prefix_dir, rules, &mut out);
        }
    }
    out.sort();
    out
}

/// One level of [`scan_ignored`]: report what is excluded here, recurse only
/// into what is not.
fn collect_ignored(root: &Path, dir: &Path, rules: &IgnoreRules, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if rules.is_ignored(&rel, is_dir) {
            out.push(rel);
            continue;
        }
        // Conflict sidecars are excluded from sync too, but they are not
        // "ignored" in the sense this list means — the UI has a conflict badge
        // for them, and dimming them as well would say two things at once.
        if is_dir {
            collect_ignored(root, &path, rules, out);
        }
    }
}

/// Whether the walker should refuse to descend into (or emit) this entry.
///
/// The prefix root itself always passes: `filter_entry` is called for it too,
/// and rejecting it would make the whole scan return nothing.
fn is_ignored_entry(root: &Path, entry: &walkdir::DirEntry, rules: &IgnoreRules) -> bool {
    let Ok(rel) = entry.path().strip_prefix(root) else {
        return false;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        return false;
    }
    rules.is_ignored(&rel, entry.file_type().is_dir())
}

/// Whether this walk entry is the `.conflicts/` directory (or under it).
///
/// Checked independently of [`IgnoreRules`] so a negation rule cannot re-open
/// the tree. Used by `filter_entry` to prune before descending.
fn is_conflicts_dir_entry(root: &Path, entry: &walkdir::DirEntry) -> bool {
    let Ok(rel) = entry.path().strip_prefix(root) else {
        return false;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    conflict::is_under_conflicts_dir(&rel)
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
        let files = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()));

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
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join(".conflicts/a")).unwrap();
        std::fs::write(
            knowledge.join(".conflicts/a/foo.conflict.1234567890.abc12345.md"),
            b"conflict",
        )
        .unwrap();
        // Legacy sidecar beside the note — relocated then skipped
        std::fs::write(
            knowledge.join("legacy.conflict.1234567890.abc12345.md"),
            b"legacy",
        )
        .unwrap();
        std::fs::write(knowledge.join("real.md"), b"real").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let files = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()));

        assert!(files.iter().any(|f| f.rel_path == "knowledge/real.md"));
        assert!(
            !files
                .iter()
                .any(|f| f.rel_path.contains(".conflict.") || f.rel_path.contains("/.conflicts/")),
            "sidecars must not appear in the sync scan, got {files:?}"
        );
        // Legacy was moved under .conflicts/
        assert!(!knowledge.join("legacy.conflict.1234567890.abc12345.md").exists());
        assert!(knowledge
            .join(".conflicts/legacy.conflict.1234567890.abc12345.md")
            .exists());
    }

    #[test]
    fn test_scan_conflict_files_collects_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join(".conflicts/a")).unwrap();
        std::fs::write(knowledge.join("real.md"), b"real").unwrap();
        std::fs::write(
            knowledge.join(".conflicts/a/foo.conflict.1234567890.abc12345.md"),
            b"conflict",
        )
        .unwrap();
        // Legacy beside the note — scan_conflict_files migrates then lists it
        std::fs::write(
            knowledge.join("bar.conflict.1234567890.def67890.md"),
            b"legacy",
        )
        .unwrap();

        let conflicts = scan_conflict_files(ws);
        assert_eq!(conflicts.len(), 2, "{conflicts:?}");
        assert!(conflicts.contains(&"knowledge/.conflicts/a/foo.conflict.1234567890.abc12345.md".to_string()));
        assert!(conflicts.contains(&"knowledge/.conflicts/bar.conflict.1234567890.def67890.md".to_string()));
        assert!(!conflicts.iter().any(|c| c == "knowledge/real.md"));
        assert!(!knowledge.join("bar.conflict.1234567890.def67890.md").exists());
    }

    /// `.conflicts/` is a hard skip — a team negation rule must not re-include it.
    #[test]
    fn scan_never_yields_conflicts_dir_even_with_negation_rule() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join(".conflicts")).unwrap();
        std::fs::write(
            knowledge.join(".conflicts/foo.conflict.1.aabbccdd.md"),
            b"sidecar",
        )
        .unwrap();
        std::fs::write(knowledge.join("real.md"), b"real").unwrap();
        // Team rule that would un-ignore `.conflicts/` if we went through IgnoreRules.
        std::fs::write(knowledge.join(".amuxignore"), b"!.conflicts/\n").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let found: Vec<String> = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()))
            .into_iter()
            .map(|f| f.rel_path)
            .collect();

        assert!(found.contains(&"knowledge/real.md".to_string()));
        assert!(
            !found.iter().any(|p| p.contains(".conflicts")),
            "!.conflicts/ must not re-include the hard-skipped dir, got {found:?}"
        );
    }

    #[test]
    fn scan_does_not_descend_into_conflicts_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join(".conflicts/deep")).unwrap();
        std::fs::write(knowledge.join(".conflicts/deep/x.md"), b"should not sync").unwrap();
        std::fs::write(knowledge.join("ok.md"), b"ok").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let found: Vec<String> = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()))
            .into_iter()
            .map(|f| f.rel_path)
            .collect();

        assert_eq!(found, vec!["knowledge/ok.md".to_string()]);
    }

    #[test]
    fn test_scan_skips_disallowed_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let other_dir = dir.path().join("other");
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(other_dir.join("file.md"), b"data").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let files = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()));
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

        let files = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()));
        let f = files
            .iter()
            .find(|f| f.rel_path == "knowledge/stable.md")
            .unwrap();
        assert!(!f.dirty, "file should be clean (mtime+size match)");
    }

    /// The whole reason the rules exist: a repo dragged into the knowledge dir
    /// must not put tens of thousands of files on the sync path.
    #[test]
    fn scan_does_not_descend_into_ignored_directories() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join("node_modules/left-pad")).unwrap();
        std::fs::create_dir_all(knowledge.join("notes")).unwrap();
        std::fs::write(knowledge.join("node_modules/left-pad/index.js"), b"x").unwrap();
        std::fs::write(knowledge.join("node_modules/.package-lock.json"), b"{}").unwrap();
        std::fs::write(knowledge.join("notes/a.md"), b"# a").unwrap();
        std::fs::write(knowledge.join("b.md"), b"# b").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let found: Vec<String> = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()))
            .into_iter()
            .map(|f| f.rel_path)
            .collect();

        assert!(found.contains(&"knowledge/notes/a.md".to_string()));
        assert!(found.contains(&"knowledge/b.md".to_string()));
        assert!(
            !found.iter().any(|p| p.contains("node_modules")),
            "node_modules must not be scanned at all, got {found:?}"
        );
    }

    /// Per-machine tool state is ignored for the same reason, minus the volume:
    /// `.obsidian/workspace.json` is rewritten every time a pane moves.
    #[test]
    fn scan_skips_per_machine_tool_state() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join(".obsidian")).unwrap();
        std::fs::write(knowledge.join(".obsidian/workspace.json"), b"{}").unwrap();
        std::fs::write(knowledge.join(".DS_Store"), b"\0").unwrap();
        std::fs::write(knowledge.join("real.md"), b"# real").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let found: Vec<String> = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()))
            .into_iter()
            .map(|f| f.rel_path)
            .collect();

        assert_eq!(found, vec!["knowledge/real.md".to_string()]);
    }

    /// The list the UI dims by. One entry per ignored root — never the tens of
    /// thousands of files inside it.
    #[test]
    fn scan_ignored_reports_the_root_not_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join("node_modules/left-pad")).unwrap();
        std::fs::create_dir_all(knowledge.join("notes")).unwrap();
        std::fs::write(knowledge.join("node_modules/left-pad/index.js"), b"x").unwrap();
        std::fs::write(knowledge.join("notes/a.md"), b"# a").unwrap();
        std::fs::write(knowledge.join(".DS_Store"), b"x").unwrap();

        let ignored = scan_ignored(ws, &IgnoreRules::load(dir.path()));
        assert_eq!(
            ignored,
            vec![
                "knowledge/.DS_Store".to_string(),
                "knowledge/node_modules".to_string(),
            ]
        );
    }

    #[test]
    fn scan_ignored_finds_nested_ignored_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(knowledge.join("proj/target/debug")).unwrap();
        std::fs::write(knowledge.join("proj/README.md"), b"x").unwrap();

        let ignored = scan_ignored(ws, &IgnoreRules::load(dir.path()));
        assert_eq!(ignored, vec!["knowledge/proj/target".to_string()]);
    }

    #[test]
    fn scan_ignored_is_empty_for_a_clean_tree() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(&knowledge).unwrap();
        std::fs::write(knowledge.join("a.md"), b"# a").unwrap();

        assert!(scan_ignored(ws, &IgnoreRules::load(dir.path())).is_empty());
    }

    /// A team's own rule file has to reach every teammate, so it must sync —
    /// and therefore must survive the scan.
    #[test]
    fn scan_keeps_the_team_rule_file_itself() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let knowledge = dir.path().join("knowledge");
        std::fs::create_dir_all(&knowledge).unwrap();
        std::fs::write(knowledge.join(".amuxignore"), b"scratch/\n").unwrap();
        std::fs::create_dir_all(knowledge.join("scratch")).unwrap();
        std::fs::write(knowledge.join("scratch/tmp.md"), b"x").unwrap();

        let state = LocalSyncState::load(ws, "team-test").unwrap();
        let found: Vec<String> = scan_workspace_with(ws, &state, &IgnoreRules::load(dir.path()))
            .into_iter()
            .map(|f| f.rel_path)
            .collect();

        assert!(found.contains(&"knowledge/.amuxignore".to_string()));
        assert!(!found.iter().any(|p| p.contains("scratch")));
    }
}
