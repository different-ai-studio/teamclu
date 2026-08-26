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
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Directory name under each sync prefix that holds conflict copies.
pub const CONFLICTS_DIR: &str = ".conflicts";

/// Write a conflict sidecar holding `data` for the document at `rel_path`
/// (content-root relative, e.g. `knowledge/a/foo.md`).
///
/// Takes the **relative** path deliberately. The sidecar's home is derived by
/// inserting `.conflicts` after the sync-prefix segment, and every reader
/// ([`original_from_conflict`], [`is_under_conflicts_dir`],
/// [`legacy_rel_to_conflicts_rel`]) anchors on the relative path the same way.
/// Deriving it from the absolute path instead matches a `knowledge` component
/// in the daemon's own home (`AMUXD_HOME=/data/knowledge/…`) and parks the
/// sidecar outside the synced tree, where `scan_conflict_files` never finds it
/// and the user's overwritten bytes disappear from the conflicts UI.
///
/// Returns the absolute path written.
pub async fn write_conflict_sidecar(
    content_root: &Path,
    rel_path: &str,
    data: &[u8],
    cipher_hash: &str,
) -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let conflict_path = content_root.join(conflict_rel_path(rel_path, ts, cipher_hash));

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

/// Sidecar path for the document at `rel_path`, content-root relative.
///
/// `knowledge/a/foo.md` → `knowledge/.conflicts/a/foo.conflict.<ts>.<hash>.md`
/// `knowledge/foo.md`   → `knowledge/.conflicts/foo.conflict.<ts>.<hash>.md`
///
/// A path under no known sync prefix keeps its sidecar beside the original,
/// rather than inventing a root-level `.conflicts/` nothing else reads.
pub fn conflict_rel_path(rel_path: &str, unix_ts: u64, cipher_hash: &str) -> String {
    let rel = rel_path.replace('\\', "/");
    let (dir, filename) = match rel.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, rel.as_str()),
    };
    let conflict_name = conflict_file_name(filename, unix_ts, cipher_hash);
    match dir {
        Some(d) => match insert_conflicts_rel(d) {
            Some(with_conflicts) => format!("{with_conflicts}/{conflict_name}"),
            None => format!("{d}/{conflict_name}"),
        },
        None => conflict_name,
    }
}

/// `foo.md` → `foo.conflict.<ts>.<hash>.md`
///
/// `foo` → `foo.conflict.<ts>.<hash>`; `foo.tar.gz` keeps `foo.tar` as the stem;
/// `.gitignore` has an empty stem, which [`original_from_conflict`] reverses.
fn conflict_file_name(filename: &str, unix_ts: u64, cipher_hash: &str) -> String {
    let (stem, ext) = match filename.rfind('.') {
        Some(dot_pos) => {
            let (s, e) = filename.split_at(dot_pos);
            (s.to_string(), Some(e[1..].to_string())) // e[1..] skips the dot
        }
        None => (filename.to_string(), None),
    };

    let short_hash = &cipher_hash[..cipher_hash.len().min(8)];

    match &ext {
        Some(e) if !e.is_empty() => {
            format!("{stem}.conflict.{unix_ts}.{short_hash}.{e}")
        }
        _ => format!("{stem}.conflict.{unix_ts}.{short_hash}"),
    }
}

/// Insert `.conflicts` after the first sync-prefix component of a relative dir.
///
/// `knowledge/a` → `knowledge/.conflicts/a`; `knowledge` → `knowledge/.conflicts`.
/// `None` when the dir is not under a prefix this client mirrors.
fn insert_conflicts_rel(dir: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    let idx = parts.iter().position(|p| {
        ALLOWED_PREFIXES
            .iter()
            .any(|a| *p == a.trim_end_matches('/'))
    })?;
    parts.insert(idx + 1, CONFLICTS_DIR);
    Some(parts.join("/"))
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
///
/// Same anchoring as [`conflict_rel_path`], so a legacy sidecar lands exactly
/// where a freshly written one would.
fn legacy_rel_to_conflicts_rel(rel: &str) -> Option<String> {
    let (dir, filename) = rel.rsplit_once('/')?;
    Some(format!("{}/{filename}", insert_conflicts_rel(dir)?))
}

/// Reconstruct the original file's relative path from a conflict sidecar's
/// relative path. Inverse of [`conflict_rel_path`].
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
        assert_eq!(
            conflict_rel_path("knowledge/foo.md", 1748332800, "abc123defxxx"),
            "knowledge/.conflicts/foo.conflict.1748332800.abc123de.md"
        );
    }

    #[test]
    fn test_conflict_name_nested_dir() {
        assert_eq!(
            conflict_rel_path("knowledge/a/b/foo.md", 1748332800, "abc123defxxx"),
            "knowledge/.conflicts/a/b/foo.conflict.1748332800.abc123de.md"
        );
    }

    #[test]
    fn test_conflict_name_no_extension() {
        assert_eq!(
            conflict_rel_path("knowledge/Makefile", 9999, "deadbeefabcd"),
            "knowledge/.conflicts/Makefile.conflict.9999.deadbeef"
        );
    }

    #[test]
    fn test_conflict_name_cjk() {
        assert_eq!(
            conflict_rel_path("knowledge/笔记/你好.md", 100, "aabbccdd1234"),
            "knowledge/.conflicts/笔记/你好.conflict.100.aabbccdd.md"
        );
    }

    #[test]
    fn test_conflict_name_dotfile() {
        // ".gitignore" — rfind('.') at 0 → stem="", ext="gitignore"
        assert_eq!(
            conflict_rel_path("knowledge/.gitignore", 100, "aabbccdd1234"),
            "knowledge/.conflicts/.conflict.100.aabbccdd.gitignore"
        );
    }

    #[test]
    fn test_conflict_name_short_hash() {
        // If hash is shorter than 8 chars, take all of it
        assert_eq!(
            conflict_rel_path("knowledge/x.md", 1, "ab"),
            "knowledge/.conflicts/x.conflict.1.ab.md"
        );
    }

    #[test]
    fn test_same_ts_produces_deterministic_name() {
        let a = conflict_rel_path("knowledge/doc.txt", 1234567890, "hash1111aaaa");
        let b = conflict_rel_path("knowledge/doc.txt", 1234567890, "hash1111aaaa");
        assert_eq!(a, b);
    }

    #[test]
    fn test_different_hashes_produce_different_names() {
        let a = conflict_rel_path("knowledge/doc.txt", 1000, "aaaa1111bbbb");
        let b = conflict_rel_path("knowledge/doc.txt", 1000, "xxxx9999yyyy");
        assert_ne!(a, b);
    }

    /// Regression: the sidecar path is derived from the RELATIVE sync path, so a
    /// content root that itself contains a `knowledge` component (e.g.
    /// `AMUXD_HOME=/data/knowledge/amuxd`) cannot pull `.conflicts/` out of the
    /// synced tree. Anchoring on the absolute path matched `/data/knowledge`
    /// first and wrote the sidecar where `scan_conflict_files` never looks.
    #[test]
    fn content_root_containing_knowledge_still_writes_inside_the_tree() {
        let content_root = Path::new("/data/knowledge/amuxd/teams/t1/shared");
        let rel = conflict_rel_path("knowledge/a/foo.md", 42, "abcdef012345");
        assert_eq!(
            rel, "knowledge/.conflicts/a/foo.conflict.42.abcdef01.md",
            "sidecar must mirror the relative path, not the absolute one"
        );
        assert_eq!(
            content_root.join(&rel),
            Path::new(
                "/data/knowledge/amuxd/teams/t1/shared/knowledge/.conflicts/a/foo.conflict.42.abcdef01.md"
            )
        );
        assert!(is_under_conflicts_dir(&rel));
        assert_eq!(
            original_from_conflict(&rel).as_deref(),
            Some("knowledge/a/foo.md")
        );
    }

    /// Not under a mirrored prefix → keep the sidecar beside the original rather
    /// than invent a root-level `.conflicts/` no reader knows about.
    #[test]
    fn unknown_prefix_keeps_sidecar_beside_original() {
        assert_eq!(
            conflict_rel_path("elsewhere/foo.md", 7, "aabbccdd"),
            "elsewhere/foo.conflict.7.aabbccdd.md"
        );
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
        // conflict_rel_path → original_from_conflict
        for original in [
            "knowledge/foo.md",
            "knowledge/Makefile",
            "knowledge/a/b/note.txt",
            "knowledge/笔记/你好.md",
        ] {
            let conflict_rel = conflict_rel_path(original, 1748332800, "abc123defxxx");
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

        let sidecar = write_conflict_sidecar(
            dir.path(),
            "knowledge/a/test.md",
            b"remote content",
            "abcdef1234567890",
        )
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
