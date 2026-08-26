//! Conflict sidecar file management (spec §4.4 / ADR-0008 §5.2 A).
//!
//! Layout:
//! ```text
//! knowledge/a/foo.md
//! knowledge/.conflicts/a/foo.conflict.<unix_ts>.<short_hash[0..8]>[.<ext>]
//! ```
//!
//! The filename format is unchanged; only the directory is. Obsidian ignores
//! dot-directories by default, so parking copies under `.conflicts/` keeps the
//! vault tree and graph clean. Scanner skips the whole directory (hard rule,
//! not via IgnoreRules) so a team `.amuxignore` `!.conflicts/` cannot re-include
//! them; they are never uploaded.
//!
//! [`original_from_conflict`] and [`conflict_timestamp`] are the read side:
//! `GET /v1/team/conflicts` turns a sidecar back into "which document conflicted,
//! and when", which is what the resolution UI decides against. Legacy sidecars
//! that still sit beside a note (pre-migration) reverse the same way — the
//! scanner relocates them on sight.

use super::path_validator::ALLOWED_PREFIXES;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Directory name under each sync prefix that holds conflict copies.
pub const CONFLICTS_DIR: &str = ".conflicts";

/// Write a conflict sidecar file containing `data` for the original `abs_path`.
/// Returns the path of the conflict file written (under `.conflicts/`).
pub async fn write_conflict_sidecar(
    abs_path: &Path,
    data: &[u8],
    cipher_hash: &str,
) -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let conflict_path = conflict_filename(abs_path, ts, cipher_hash);

    if let Some(parent) = conflict_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("conflict: mkdir {}: {e}", parent.display()))?;
    }

    tokio::fs::write(&conflict_path, data)
        .await
        .map_err(|e| format!("conflict: write {}: {e}", conflict_path.display()))?;

    Ok(conflict_path)
}

/// Construct the conflict path for a given original path, timestamp and cipher_hash.
///
/// The sidecar lands under `<prefix>/.conflicts/<mirrored relative dirs>/`, not
/// beside the original. Public so scanner tests can exercise the mapping.
pub fn conflict_filename(original: &Path, unix_ts: u64, cipher_hash: &str) -> PathBuf {
    let filename = original
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Split into stem and extension
    // e.g. "foo.md" → stem="foo", ext=Some("md")
    //      "foo"    → stem="foo", ext=None
    //      "foo.tar.gz" → stem="foo.tar", ext=Some("gz")
    let (stem, ext) = if let Some(dot_pos) = filename.rfind('.') {
        let (s, e) = filename.split_at(dot_pos);
        (s.to_string(), Some(e[1..].to_string())) // e[1..] skips the dot
    } else {
        (filename, None)
    };

    let short_hash = &cipher_hash[..cipher_hash.len().min(8)];

    let conflict_name = match &ext {
        Some(e) if !e.is_empty() => {
            format!("{}.conflict.{}.{}.{}", stem, unix_ts, short_hash, e)
        }
        _ => {
            format!("{}.conflict.{}.{}", stem, unix_ts, short_hash)
        }
    };

    conflict_parent_dir(original).join(conflict_name)
}

/// Directory that should hold the sidecar for `original` — the original's
/// parent with `.conflicts` inserted after the sync-prefix segment.
///
/// `…/knowledge/a/foo.md` → `…/knowledge/.conflicts/a`
/// `…/knowledge/foo.md`   → `…/knowledge/.conflicts`
fn conflict_parent_dir(original: &Path) -> PathBuf {
    let parent = original.parent().unwrap_or_else(|| Path::new("."));
    insert_conflicts_component(parent)
}

/// Insert `.conflicts` after the first sync-prefix path component.
fn insert_conflicts_component(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut inserted = false;
    for comp in path.components() {
        out.push(comp);
        if inserted {
            continue;
        }
        if let Component::Normal(name) = comp {
            if is_sync_prefix_name(name) {
                out.push(CONFLICTS_DIR);
                inserted = true;
            }
        }
    }
    if inserted {
        out
    } else {
        // Not under a known prefix — keep beside the file rather than invent a
        // root-level `.conflicts/` that nothing else knows about.
        path.to_path_buf()
    }
}

fn is_sync_prefix_name(name: &std::ffi::OsStr) -> bool {
    ALLOWED_PREFIXES
        .iter()
        .any(|p| name == p.trim_end_matches('/'))
}

/// Whether a relative sync path sits under `<prefix>/.conflicts/` (the dir
/// itself or anything beneath it). Hard-skip target for scanner + pull.
pub fn is_under_conflicts_dir(rel_path: &str) -> bool {
    for prefix in ALLOWED_PREFIXES {
        let p = prefix.trim_end_matches('/');
        let marker = format!("{p}/{CONFLICTS_DIR}");
        if rel_path == marker || rel_path.starts_with(&format!("{marker}/")) {
            return true;
        }
    }
    false
}

/// Result of trying to move a legacy sidecar into `.conflicts/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrateOutcome {
    /// Sidecar is under `.conflicts/` (was already, or move/cleanup succeeded).
    UnderConflicts(String),
    /// Move could not finish; the legacy file is still on disk at this path and
    /// must stay visible in the conflicts list.
    StillLegacy(String),
    /// Not a sidecar, or the path is gone — nothing to list.
    NotApplicable,
}

/// Relocate a legacy sidecar (`knowledge/a/foo.conflict…` beside the note) into
/// the mirrored `.conflicts/` path. No-op when already there or not a sidecar.
///
/// Sidecars were never uploaded, so this is a local rename with no tombstone.
/// Callers that list conflicts must treat [`MigrateOutcome::StillLegacy`] as a
/// path to emit — swallowing the failure and only walking `.conflicts/` would
/// hide the decision from the UI.
pub fn migrate_legacy_conflict_sidecar(root: &Path, rel: &str) -> MigrateOutcome {
    if !crate::sync::oss::scanner::is_conflict_file(rel) {
        return MigrateOutcome::NotApplicable;
    }
    if is_under_conflicts_dir(rel) {
        return MigrateOutcome::UnderConflicts(rel.to_string());
    }

    let Some(new_rel) = legacy_rel_to_conflicts_rel(rel) else {
        // Shaped like a sidecar but not under a sync prefix we know how to
        // mirror — keep listing it where it is.
        return MigrateOutcome::StillLegacy(rel.to_string());
    };
    let src = root.join(rel);
    let dst = root.join(&new_rel);
    if !src.is_file() {
        return MigrateOutcome::NotApplicable;
    }
    if let Some(parent) = dst.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return MigrateOutcome::StillLegacy(rel.to_string());
        }
    }
    if dst.exists() {
        // Destination already holds a copy — drop the legacy leftover. If the
        // delete fails, do not claim the move succeeded: the conflicts list
        // must still see the legacy path (and will also see `dst` when it
        // walks `.conflicts/`).
        if std::fs::remove_file(&src).is_err() {
            return MigrateOutcome::StillLegacy(rel.to_string());
        }
        return MigrateOutcome::UnderConflicts(new_rel);
    }
    match std::fs::rename(&src, &dst) {
        Ok(()) => MigrateOutcome::UnderConflicts(new_rel),
        Err(_) => MigrateOutcome::StillLegacy(rel.to_string()),
    }
}

/// `knowledge/a/foo.conflict.ts.hash.md` → `knowledge/.conflicts/a/foo.conflict.ts.hash.md`
fn legacy_rel_to_conflicts_rel(rel: &str) -> Option<String> {
    let (dir, filename) = match rel.rsplit_once('/') {
        Some((d, f)) => (d, f),
        None => return None,
    };
    let mut parts: Vec<&str> = dir.split('/').collect();
    let mut i = 0;
    let mut inserted = false;
    while i < parts.len() {
        if !inserted && ALLOWED_PREFIXES.iter().any(|p| parts[i] == p.trim_end_matches('/')) {
            parts.insert(i + 1, CONFLICTS_DIR);
            inserted = true;
            break;
        }
        i += 1;
    }
    if !inserted {
        return None;
    }
    Some(format!("{}/{filename}", parts.join("/")))
}

/// Reconstruct the original file's relative path from a conflict sidecar's
/// relative path. Inverse of [`conflict_filename`].
///
/// `knowledge/.conflicts/a/<stem>.conflict.<ts>.<hash>[.<ext>]` → `knowledge/a/<stem>[.<ext>]`
///
/// Also accepts the pre-migration layout (sidecar beside the note) so resolve
/// and move-on-scan keep working until the rename lands.
///
/// Returns `None` if `rel_path` is not a conflict sidecar.
pub fn original_from_conflict(rel_path: &str) -> Option<String> {
    let (dir, filename) = match rel_path.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, rel_path),
    };

    // Split on the marker; everything before it is the original stem.
    let (stem, suffix) = filename.split_once(".conflict.")?;

    // suffix is "<ts>.<hash>" (no ext) or "<ts>.<hash>.<ext>".
    let suffix_parts: Vec<&str> = suffix.split('.').collect();
    let original_name = match suffix_parts.len() {
        2 => stem.to_string(),
        n if n >= 3 => format!("{stem}.{}", suffix_parts[n - 1]),
        _ => return None,
    };

    let dir = dir.map(strip_conflicts_segment);
    Some(match dir {
        Some(d) if !d.is_empty() => format!("{d}/{original_name}"),
        _ => original_name,
    })
}

/// Drop the `.conflicts` segment that sits under a sync prefix.
///
/// `knowledge/.conflicts/a` → `knowledge/a`
/// `knowledge/.conflicts`   → `knowledge`
/// `knowledge/a` (legacy)   → `knowledge/a`
fn strip_conflicts_segment(dir: &str) -> String {
    let parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    let mut out: Vec<&str> = Vec::with_capacity(parts.len());
    let mut i = 0;
    while i < parts.len() {
        out.push(parts[i]);
        let is_prefix = ALLOWED_PREFIXES
            .iter()
            .any(|p| parts[i] == p.trim_end_matches('/'));
        if is_prefix && i + 1 < parts.len() && parts[i + 1] == CONFLICTS_DIR {
            i += 2; // skip the `.conflicts` we just looked past
            continue;
        }
        i += 1;
    }
    out.join("/")
}

/// The unix timestamp a sidecar records in its name, or `None` when the name is
/// not a sidecar (or carries a timestamp we cannot parse).
///
/// This is the only record of *when* the conflict happened: the sidecar's own
/// mtime is the time it was written to this disk, which a restore, a copy or a
/// backup restore all move.
pub fn conflict_timestamp(rel_path: &str) -> Option<u64> {
    let filename = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let (_, suffix) = filename.split_once(".conflict.")?;
    suffix.split('.').next()?.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conflict_name_with_extension() {
        let path = Path::new("/ws/knowledge/foo.md");
        let name = conflict_filename(path, 1748332800, "abc123defxxx");
        let filename = name.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "foo.conflict.1748332800.abc123de.md");
        assert_eq!(
            name.parent().unwrap(),
            Path::new("/ws/knowledge/.conflicts")
        );
    }

    #[test]
    fn test_conflict_name_nested_dir() {
        let path = Path::new("/ws/knowledge/a/b/foo.md");
        let name = conflict_filename(path, 1748332800, "abc123defxxx");
        assert_eq!(
            name,
            Path::new("/ws/knowledge/.conflicts/a/b/foo.conflict.1748332800.abc123de.md")
        );
    }

    #[test]
    fn test_conflict_name_no_extension() {
        let path = Path::new("/ws/knowledge/Makefile");
        let name = conflict_filename(path, 9999, "deadbeefabcd");
        let filename = name.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "Makefile.conflict.9999.deadbeef");
        assert_eq!(
            name.parent().unwrap(),
            Path::new("/ws/knowledge/.conflicts")
        );
    }

    #[test]
    fn test_conflict_name_cjk() {
        let path = Path::new("/ws/knowledge/笔记/你好.md");
        let name = conflict_filename(path, 100, "aabbccdd1234");
        assert_eq!(
            name,
            Path::new("/ws/knowledge/.conflicts/笔记/你好.conflict.100.aabbccdd.md")
        );
    }

    #[test]
    fn test_conflict_name_dotfile() {
        // e.g. ".gitignore" — stem is "", ext is "gitignore"
        // rfind('.') at 0 → stem="", ext="gitignore"
        let path = Path::new("/ws/knowledge/.gitignore");
        let name = conflict_filename(path, 100, "aabbccdd1234");
        let filename = name.file_name().unwrap().to_str().unwrap();
        // stem="" ext="gitignore" → ".conflict.100.aabbccdd.gitignore"
        assert!(filename.contains(".conflict."));
        assert!(filename.ends_with(".gitignore"));
        assert_eq!(
            name.parent().unwrap(),
            Path::new("/ws/knowledge/.conflicts")
        );
    }

    #[test]
    fn test_conflict_name_short_hash() {
        // If hash is shorter than 8 chars, take all of it
        let path = Path::new("/ws/knowledge/x.md");
        let name = conflict_filename(path, 1, "ab");
        let filename = name.file_name().unwrap().to_str().unwrap();
        assert!(filename.contains(".conflict.1.ab.md"));
    }

    #[test]
    fn test_same_ts_produces_deterministic_name() {
        let path = Path::new("/ws/knowledge/doc.txt");
        let name1 = conflict_filename(path, 1234567890, "hash1111aaaa");
        let name2 = conflict_filename(path, 1234567890, "hash1111aaaa");
        assert_eq!(name1, name2);
    }

    #[test]
    fn test_different_hashes_produce_different_names() {
        let path = Path::new("/ws/knowledge/doc.txt");
        let name1 = conflict_filename(path, 1000, "aaaa1111bbbb");
        let name2 = conflict_filename(path, 1000, "xxxx9999yyyy");
        assert_ne!(name1, name2);
    }

    #[test]
    fn test_original_from_conflict_roundtrip() {
        // New layout under `.conflicts/`
        assert_eq!(
            original_from_conflict("knowledge/.conflicts/foo.conflict.1748332800.abc123de.md")
                .as_deref(),
            Some("knowledge/foo.md")
        );
        assert_eq!(
            original_from_conflict("knowledge/.conflicts/a/b/foo.conflict.1.aabbccdd.md")
                .as_deref(),
            Some("knowledge/a/b/foo.md")
        );
        // No extension
        assert_eq!(
            original_from_conflict("knowledge/.conflicts/Makefile.conflict.9999.deadbeef")
                .as_deref(),
            Some("knowledge/Makefile")
        );
        // Multi-dot original (only the last segment is the recorded ext)
        assert_eq!(
            original_from_conflict("knowledge/.conflicts/k/foo.tar.conflict.1.aabbccdd.gz")
                .as_deref(),
            Some("knowledge/k/foo.tar.gz")
        );
        // Dotfile
        assert_eq!(
            original_from_conflict("knowledge/.conflicts/.conflict.100.aabbccdd.gitignore")
                .as_deref(),
            Some("knowledge/.gitignore")
        );
        // CJK
        assert_eq!(
            original_from_conflict("knowledge/.conflicts/笔记/你好.conflict.100.aabbccdd.md")
                .as_deref(),
            Some("knowledge/笔记/你好.md")
        );
        // Legacy layout (beside the note) still reverses — resolve + migrate
        assert_eq!(
            original_from_conflict("knowledge/foo.conflict.1748332800.abc123de.md").as_deref(),
            Some("knowledge/foo.md")
        );
        assert_eq!(
            original_from_conflict("knowledge/a/foo.conflict.1.aabbccdd.md").as_deref(),
            Some("knowledge/a/foo.md")
        );
        // Not a conflict file
        assert_eq!(original_from_conflict("knowledge/foo.md"), None);
    }

    #[test]
    fn test_filename_conflict_roundtrip_via_helpers() {
        // conflict_filename → strip workspace → original_from_conflict
        for original in [
            "knowledge/foo.md",
            "knowledge/Makefile",
            "knowledge/a/b/note.txt",
            "knowledge/笔记/你好.md",
        ] {
            let conflict = conflict_filename(
                Path::new(&format!("/ws/{original}")),
                1748332800,
                "abc123defxxx",
            );
            let conflict_rel = conflict
                .strip_prefix("/ws/")
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            assert!(
                conflict_rel.contains("/.conflicts/"),
                "expected .conflicts/ in {conflict_rel}"
            );
            assert_eq!(
                original_from_conflict(&conflict_rel).as_deref(),
                Some(original),
                "failed roundtrip for {original}"
            );
        }
    }

    #[test]
    fn test_conflict_timestamp() {
        assert_eq!(
            conflict_timestamp("knowledge/.conflicts/foo.conflict.1748332800.abc123de.md"),
            Some(1748332800)
        );
        // Legacy path still parses
        assert_eq!(
            conflict_timestamp("knowledge/foo.conflict.1748332800.abc123de.md"),
            Some(1748332800)
        );
        // No extension
        assert_eq!(
            conflict_timestamp("knowledge/.conflicts/Makefile.conflict.9999.deadbeef"),
            Some(9999)
        );
        // Not a sidecar
        assert_eq!(conflict_timestamp("knowledge/foo.md"), None);
        // Sidecar-shaped but the timestamp slot is not a number
        assert_eq!(
            conflict_timestamp("knowledge/.conflicts/foo.conflict.x.abc.md"),
            None
        );
    }

    #[test]
    fn test_is_under_conflicts_dir() {
        assert!(is_under_conflicts_dir("knowledge/.conflicts"));
        assert!(is_under_conflicts_dir(
            "knowledge/.conflicts/a/foo.conflict.1.aabbccdd.md"
        ));
        assert!(!is_under_conflicts_dir("knowledge/foo.md"));
        assert!(!is_under_conflicts_dir("knowledge/a/.conflicts-not"));
        assert!(!is_under_conflicts_dir(
            "knowledge/foo.conflict.1.aabbccdd.md"
        ));
    }

    #[test]
    fn test_migrate_legacy_conflict_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let knowledge = root.join("knowledge/a");
        std::fs::create_dir_all(&knowledge).unwrap();
        let legacy = knowledge.join("foo.conflict.1000.aabbccdd.md");
        std::fs::write(&legacy, b"local copy").unwrap();

        let outcome =
            migrate_legacy_conflict_sidecar(root, "knowledge/a/foo.conflict.1000.aabbccdd.md");
        assert_eq!(
            outcome,
            MigrateOutcome::UnderConflicts(
                "knowledge/.conflicts/a/foo.conflict.1000.aabbccdd.md".into()
            )
        );
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read(root.join("knowledge/.conflicts/a/foo.conflict.1000.aabbccdd.md"))
                .unwrap(),
            b"local copy"
        );
        // Idempotent when already under .conflicts/
        assert_eq!(
            migrate_legacy_conflict_sidecar(
                root,
                "knowledge/.conflicts/a/foo.conflict.1000.aabbccdd.md"
            ),
            MigrateOutcome::UnderConflicts(
                "knowledge/.conflicts/a/foo.conflict.1000.aabbccdd.md".into()
            )
        );
    }

    /// Destination already has the sidecar: remove the legacy leftover. Claiming
    /// success while `remove_file` failed would hide the leftover from listing.
    #[test]
    fn migrate_collision_removes_legacy_when_dst_exists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("knowledge/.conflicts")).unwrap();
        std::fs::write(
            root.join("knowledge/foo.conflict.1000.aabbccdd.md"),
            b"legacy leftover",
        )
        .unwrap();
        std::fs::write(
            root.join("knowledge/.conflicts/foo.conflict.1000.aabbccdd.md"),
            b"already there",
        )
        .unwrap();

        let outcome =
            migrate_legacy_conflict_sidecar(root, "knowledge/foo.conflict.1000.aabbccdd.md");
        assert_eq!(
            outcome,
            MigrateOutcome::UnderConflicts(
                "knowledge/.conflicts/foo.conflict.1000.aabbccdd.md".into()
            )
        );
        assert!(!root.join("knowledge/foo.conflict.1000.aabbccdd.md").exists());
        assert_eq!(
            std::fs::read(root.join("knowledge/.conflicts/foo.conflict.1000.aabbccdd.md"))
                .unwrap(),
            b"already there"
        );
    }

    /// Same collision, but the legacy file cannot be deleted: must report
    /// StillLegacy so the conflicts list keeps seeing it.
    #[test]
    fn migrate_collision_still_legacy_when_remove_fails() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let knowledge = root.join("knowledge");
        std::fs::create_dir_all(knowledge.join(".conflicts")).unwrap();
        let legacy = "knowledge/foo.conflict.1000.aabbccdd.md";
        std::fs::write(root.join(legacy), b"legacy leftover").unwrap();
        std::fs::write(
            root.join("knowledge/.conflicts/foo.conflict.1000.aabbccdd.md"),
            b"already there",
        )
        .unwrap();

        // Deleting a file needs write on the parent directory.
        let mut perms = std::fs::metadata(&knowledge).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&knowledge, perms.clone()).unwrap();

        let outcome = migrate_legacy_conflict_sidecar(root, legacy);

        perms.set_readonly(false);
        std::fs::set_permissions(&knowledge, perms).unwrap();

        assert_eq!(outcome, MigrateOutcome::StillLegacy(legacy.into()));
        assert!(root.join(legacy).is_file());
    }

    /// `create_dir_all` must not be swallowed: a file blocking the `.conflicts`
    /// path leaves the legacy sidecar in place and reports StillLegacy.
    #[test]
    fn migrate_returns_still_legacy_when_conflicts_path_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("knowledge/a")).unwrap();
        // Block mkdir of knowledge/.conflicts/a — `.conflicts` is a regular file.
        std::fs::write(root.join("knowledge/.conflicts"), b"not a directory").unwrap();
        std::fs::write(
            root.join("knowledge/a/foo.conflict.1000.aabbccdd.md"),
            b"stuck",
        )
        .unwrap();

        let legacy = "knowledge/a/foo.conflict.1000.aabbccdd.md";
        assert_eq!(
            migrate_legacy_conflict_sidecar(root, legacy),
            MigrateOutcome::StillLegacy(legacy.into())
        );
        assert!(root.join(legacy).is_file());
    }

    #[tokio::test]
    async fn test_write_conflict_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("knowledge").join("a").join("test.md");
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"original").unwrap();

        let sidecar = write_conflict_sidecar(&original, b"remote content", "abcdef1234567890")
            .await
            .unwrap();

        assert!(sidecar.exists());
        let content = std::fs::read(&sidecar).unwrap();
        assert_eq!(content, b"remote content");
        let name = sidecar.file_name().unwrap().to_str().unwrap();
        assert!(name.contains(".conflict."));
        assert!(name.ends_with(".md"));
        // Lands under knowledge/.conflicts/a/, not beside the note
        assert_eq!(
            sidecar.parent().unwrap(),
            dir.path().join("knowledge/.conflicts/a")
        );
    }
}
