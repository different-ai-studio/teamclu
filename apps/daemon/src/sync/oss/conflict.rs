//! Conflict sidecar file management (spec §4.4).
//!
//! Name format: `<dir>/<stem>.conflict.<unix_ts>.<short_cipher_hash[0..8]>.<ext>`
//! (or no ext if original had none).
//!
//! Scanner skips all `*.conflict.*` files so they are never uploaded.
//!
//! [`original_from_conflict`] and [`conflict_timestamp`] are the read side:
//! `GET /v1/team/conflicts` turns a sidecar back into "which document conflicted,
//! and when", which is what the resolution UI decides against.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Write a conflict sidecar file containing `data` alongside the original `abs_path`.
/// Returns the path of the conflict file written.
pub async fn write_conflict_sidecar(
    abs_path: &Path,
    data: &[u8],
    cipher_hash: &str,
) -> Result<std::path::PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let conflict_path = conflict_filename(abs_path, ts, cipher_hash);

    tokio::fs::write(&conflict_path, data)
        .await
        .map_err(|e| format!("conflict: write {}: {e}", conflict_path.display()))?;

    Ok(conflict_path)
}

/// Construct the conflict filename for a given original path, timestamp and cipher_hash.
/// This is public so the scanner test can exercise it.
pub fn conflict_filename(original: &Path, unix_ts: u64, cipher_hash: &str) -> std::path::PathBuf {
    let dir = original.parent().unwrap_or_else(|| Path::new("."));
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

    dir.join(conflict_name)
}

/// Reconstruct the original file's relative path from a conflict sidecar's
/// relative path. Inverse of [`conflict_filename`].
///
/// `<dir>/<stem>.conflict.<ts>.<hash>[.<ext>]` → `<dir>/<stem>[.<ext>]`
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

    Some(match dir {
        Some(d) => format!("{d}/{original_name}"),
        None => original_name,
    })
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
        let path = Path::new("/ws/skills/foo.md");
        let name = conflict_filename(path, 1748332800, "abc123defxxx");
        let filename = name.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "foo.conflict.1748332800.abc123de.md");
        assert_eq!(name.parent().unwrap(), Path::new("/ws/skills"));
    }

    #[test]
    fn test_conflict_name_no_extension() {
        let path = Path::new("/ws/skills/Makefile");
        let name = conflict_filename(path, 9999, "deadbeefabcd");
        let filename = name.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "Makefile.conflict.9999.deadbeef");
    }

    #[test]
    fn test_conflict_name_dotfile() {
        // e.g. ".gitignore" — stem is "", ext is "gitignore"
        // rfind('.') at 0 → stem="", ext="gitignore"
        let path = Path::new("/ws/skills/.gitignore");
        let name = conflict_filename(path, 100, "aabbccdd1234");
        let filename = name.file_name().unwrap().to_str().unwrap();
        // stem="" ext="gitignore" → ".conflict.100.aabbccdd.gitignore"
        assert!(filename.contains(".conflict."));
        assert!(filename.ends_with(".gitignore"));
    }

    #[test]
    fn test_conflict_name_short_hash() {
        // If hash is shorter than 8 chars, take all of it
        let path = Path::new("/ws/skills/x.md");
        let name = conflict_filename(path, 1, "ab");
        let filename = name.file_name().unwrap().to_str().unwrap();
        assert!(filename.contains(".conflict.1.ab.md"));
    }

    #[test]
    fn test_same_ts_produces_deterministic_name() {
        let path = Path::new("/ws/skills/doc.txt");
        let name1 = conflict_filename(path, 1234567890, "hash1111aaaa");
        let name2 = conflict_filename(path, 1234567890, "hash1111aaaa");
        assert_eq!(name1, name2);
    }

    #[test]
    fn test_different_hashes_produce_different_names() {
        let path = Path::new("/ws/skills/doc.txt");
        let name1 = conflict_filename(path, 1000, "aaaa1111bbbb");
        let name2 = conflict_filename(path, 1000, "xxxx9999yyyy");
        assert_ne!(name1, name2);
    }

    #[test]
    fn test_original_from_conflict_roundtrip() {
        // With extension
        assert_eq!(
            original_from_conflict("knowledge/foo.conflict.1748332800.abc123de.md").as_deref(),
            Some("knowledge/foo.md")
        );
        // No extension
        assert_eq!(
            original_from_conflict("knowledge/Makefile.conflict.9999.deadbeef").as_deref(),
            Some("knowledge/Makefile")
        );
        // Multi-dot original (only the last segment is the recorded ext)
        assert_eq!(
            original_from_conflict("k/foo.tar.conflict.1.aabbccdd.gz").as_deref(),
            Some("k/foo.tar.gz")
        );
        // Dotfile
        assert_eq!(
            original_from_conflict("knowledge/.conflict.100.aabbccdd.gitignore").as_deref(),
            Some("knowledge/.gitignore")
        );
        // Root-level (no dir)
        assert_eq!(
            original_from_conflict("foo.conflict.1.abcd1234.md").as_deref(),
            Some("foo.md")
        );
        // Not a conflict file
        assert_eq!(original_from_conflict("knowledge/foo.md"), None);
    }

    #[test]
    fn test_filename_conflict_roundtrip_via_helpers() {
        // conflict_filename → original_from_conflict should recover the original.
        for original in ["knowledge/foo.md", "k/Makefile", "a/b/note.txt"] {
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
            conflict_timestamp("knowledge/foo.conflict.1748332800.abc123de.md"),
            Some(1748332800)
        );
        // No extension
        assert_eq!(
            conflict_timestamp("knowledge/Makefile.conflict.9999.deadbeef"),
            Some(9999)
        );
        // Not a sidecar
        assert_eq!(conflict_timestamp("knowledge/foo.md"), None);
        // Sidecar-shaped but the timestamp slot is not a number
        assert_eq!(conflict_timestamp("knowledge/foo.conflict.x.abc.md"), None);
    }

    #[tokio::test]
    async fn test_write_conflict_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("knowledge").join("test.md");
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
    }
}
