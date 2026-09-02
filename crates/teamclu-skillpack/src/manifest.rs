//! The installed-state baseline: which files we put on disk, and what they
//! looked like at the moment we finished putting them there.
//!
//! **"At the moment we finished" is load-bearing.** The install pipeline
//! rewrites `SKILL.md`'s frontmatter *after* unpacking the archive, so the
//! bytes on disk never match the bytes in the package. Anything built from the
//! package's own hash — the registry's `contentHash`, for instance — reports
//! every skill as modified, forever. Build the manifest last, from the
//! directory, or not at all.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Our own bookkeeping directory. Excluded from every manifest: it holds the
/// manifest, so including it would make the file describe itself.
pub const EXCLUDED_DIR: &str = ".clawhub";

/// Files up to this size are hashed on every inspection; larger ones keep the
/// size+mtime pre-filter.
///
/// A skill pack is prose and scripts. Hashing a whole team's installed set
/// measured 45ms for 13 packs / 116KB, against an inspection that runs on a
/// 10-minute reconcile and when the panel opens — the fast path was protecting
/// a cost that does not exist, at the price of a verdict that can be wrong.
///
/// The threshold exists because nothing *stops* someone shipping a model or a
/// binary inside a pack, and re-reading that every tick would be a real cost.
/// Such a file keeps the old, weaker check: the uncertainty is confined to
/// files that should not be in a skill pack to begin with.
pub const ALWAYS_HASH_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFile {
    pub sha256: String,
    pub size: u64,
    /// Pre-filter, and only for files past [`ALWAYS_HASH_MAX_BYTES`].
    ///
    /// mtime survives neither a copy nor a clock change, so pairing it with
    /// size was never a sound verdict: `cp -p` and a restore from backup both
    /// put back the original mtime, and an edit that keeps the byte count then
    /// reads as clean. Everything small enough to hash cheaply is now hashed,
    /// which is what the "never a verdict" rule always implied. This stays for
    /// the files where reading the bytes every tick would be the wrong trade.
    #[serde(default)]
    pub mtime_ms: u64,
    /// Tracked separately because `chmod +x` is a real edit that moves ctime,
    /// not mtime — the size/mtime fast path cannot see it.
    #[serde(default)]
    pub exec: bool,
}

/// Relative path (always `/`-separated, for a stable on-disk shape) → file.
pub type FileManifest = BTreeMap<String, ManagedFile>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirtyState {
    Clean,
    Dirty {
        modified: Vec<String>,
        deleted: Vec<String>,
        /// Files present in the pack directory that the baseline never
        /// mentioned — something the user dropped in.
        ///
        /// These count as dirt because the pack directory *is* the package on
        /// the publish path (`build_manifest` measures the whole thing), so an
        /// extra file is not inert: the next publish ships it. Reporting it is
        /// what lets the user see that before it goes out.
        ///
        /// The cost is real and was designed against once already: a skill
        /// whose own script writes a log or cache beside itself now shows up as
        /// dirty, which pauses auto-follow for that pack until the user
        /// publishes (adopting the file) or discards (removing it).
        added: Vec<String>,
    },
    /// No baseline was recorded. Either the pack predates manifests or somebody
    /// created the directory by hand; in both cases we know nothing about what
    /// "unchanged" would mean, so the caller has to choose a policy rather than
    /// us guessing one.
    Unmanaged,
}

impl DirtyState {
    pub fn is_dirty(&self) -> bool {
        matches!(self, Self::Dirty { .. })
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    Ok(sha256_hex(&std::fs::read(path)?))
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn exec_bit(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn exec_bit(_meta: &std::fs::Metadata) -> bool {
    false
}

pub(crate) fn to_native(rel: &str) -> PathBuf {
    if std::path::MAIN_SEPARATOR == '/' {
        PathBuf::from(rel)
    } else {
        PathBuf::from(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    }
}

/// Every regular file under `dir`, `.clawhub/` aside, as `/`-separated relative
/// paths in sorted order.
///
/// This is the single definition of "a file the pack owns" — the manifest and
/// the upgrade swap both go through it, so neither can drift into a different
/// idea of which files are in scope.
///
/// Symlinks are skipped rather than followed: packages are extracted as plain
/// files (see the installer's zip extraction), so a symlink in here is
/// something a user added, and following one is how a directory walk turns
/// into an infinite loop.
pub fn list_managed_paths(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

pub fn build_manifest(dir: &Path) -> std::io::Result<FileManifest> {
    build_manifest_for(dir, &list_managed_paths(dir)?)
}

/// Build a baseline covering exactly `rels`, ignoring whatever else is in the
/// directory.
///
/// This is the one to use after an upgrade. [`build_manifest`] measures the
/// whole directory, which on a second install quietly adopts everything the
/// swap deliberately left alone — a script's own log file, a note the user
/// dropped in — into the set of files the pack claims to own. The next time
/// that script runs, its log is "modified", auto-follow stops for good, and the
/// conflict UI asks the user to decide about a file they never touched. Pass
/// the package's own file list and none of that can happen.
///
/// Paths that are not on disk are skipped rather than failing the call: a
/// package may ship a file the frontmatter rewrite then removes, and a missing
/// entry is simply one fewer thing to compare.
pub fn build_manifest_for(dir: &Path, rels: &[String]) -> std::io::Result<FileManifest> {
    let mut out = FileManifest::new();
    for rel in rels {
        let path = dir.join(to_native(rel));
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        out.insert(
            rel.clone(),
            ManagedFile {
                sha256: file_sha256(&path)?,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                exec: exec_bit(&meta),
            },
        );
    }
    Ok(out)
}

fn walk(root: &Path, current: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            // Only the top-level `.clawhub` is ours; one nested deeper belongs
            // to the package and is measured like anything else.
            if path.parent() == Some(root) && entry.file_name() == EXCLUDED_DIR {
                continue;
            }
            walk(root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        out.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(())
}

/// Compare what is on disk against the baseline.
///
/// Only files named in the baseline are examined. Anything else in the
/// directory — a script's cache, a note the user dropped in — is deliberately
/// invisible here and survives upgrades untouched.
pub fn inspect(dir: &Path, baseline: Option<&FileManifest>) -> DirtyState {
    let Some(baseline) = baseline else {
        return DirtyState::Unmanaged;
    };
    if baseline.is_empty() {
        return DirtyState::Unmanaged;
    }

    let mut modified = Vec::new();
    let mut deleted = Vec::new();

    for (rel, want) in baseline {
        let full = dir.join(to_native(rel));
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            deleted.push(rel.clone());
            continue;
        };
        if !meta.is_file() {
            // Replaced by a directory or a symlink — not our file any more.
            modified.push(rel.clone());
            continue;
        }
        if exec_bit(&meta) != want.exec {
            modified.push(rel.clone());
            continue;
        }
        // Same size AND same mtime is only allowed to mean "clean" for a file
        // too big to hash on every pass. See ALWAYS_HASH_MAX_BYTES.
        if want.size > ALWAYS_HASH_MAX_BYTES
            && meta.len() == want.size
            && mtime_ms(&meta) == want.mtime_ms
        {
            continue;
        }
        match file_sha256(&full) {
            Ok(actual) if actual == want.sha256 => {}
            // An unreadable file counts as modified: we cannot prove it is
            // still ours, and silently overwriting it is the one outcome that
            // is never recoverable.
            _ => modified.push(rel.clone()),
        }
    }

    // Anything on disk the baseline never listed. `list_managed_paths` already
    // drops `.clawhub/` (our own bookkeeping) and symlinks, so this is exactly
    // "files a person or a script put here".
    let added: Vec<String> = match list_managed_paths(dir) {
        Ok(on_disk) => on_disk
            .into_iter()
            .filter(|rel| !baseline.contains_key(rel))
            .collect(),
        // Unreadable directory: the per-file loop above has already reported
        // every baseline entry as deleted, so claiming additions on top would
        // be noise.
        Err(_) => Vec::new(),
    };

    if modified.is_empty() && deleted.is_empty() && added.is_empty() {
        DirtyState::Clean
    } else {
        DirtyState::Dirty {
            modified,
            deleted,
            added,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set a file's mtime to an exact millisecond, so a test can reproduce the
    /// "same size, same mtime" state on purpose.
    fn set_mtime_ms(path: &Path, ms: u64) {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(when).unwrap();
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("deploy-check");
        write(&dir, "SKILL.md", "---\nname: deploy-check\n---\nbody\n");
        write(&dir, "scripts/check.sh", "#!/bin/sh\necho hi\n");
        (tmp, dir)
    }

    #[test]
    fn a_freshly_built_manifest_is_clean_against_its_own_directory() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(inspect(&dir, Some(&m)), DirtyState::Clean);
    }

    #[test]
    fn bookkeeping_is_not_part_of_the_measurement() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        // Writing origin.json after the manifest must not make the skill dirty,
        // or every install would be born in conflict.
        write(&dir, ".clawhub/origin.json", "{}\n");
        assert!(!m.contains_key(".clawhub/origin.json"));
        assert_eq!(inspect(&dir, Some(&m)), DirtyState::Clean);
    }

    #[test]
    fn edits_and_deletions_are_reported_by_path() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        write(&dir, "SKILL.md", "---\nname: deploy-check\n---\nedited\n");
        std::fs::remove_file(dir.join("scripts/check.sh")).unwrap();

        match inspect(&dir, Some(&m)) {
            DirtyState::Dirty {
                modified, deleted, ..
            } => {
                assert_eq!(modified, vec!["SKILL.md".to_string()]);
                assert_eq!(deleted, vec!["scripts/check.sh".to_string()]);
            }
            other => panic!("expected dirty, got {:?}", other),
        }
    }

    #[test]
    fn files_the_package_never_shipped_are_reported_as_added() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        // A script writing its cache next to itself used to be waved through,
        // to keep auto-follow from stalling on a file nobody edited. It is now
        // reported instead: the publish path measures the whole directory, so
        // staying silent meant shipping a file the author never saw. The pack
        // pauses in the conflict UI until they publish or discard it.
        write(&dir, "cache/run.log", "noise\n");
        match inspect(&dir, Some(&m)) {
            DirtyState::Dirty { added, .. } => {
                assert_eq!(added, vec!["cache/run.log".to_string()]);
            }
            other => panic!("expected an addition, got {other:?}"),
        }
    }

    #[test]
    fn same_size_content_still_counts_as_modified() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        let path = dir.join("SKILL.md");
        let original = std::fs::read_to_string(&path).unwrap();
        let swapped = original.replace("body", "b0dy");
        assert_eq!(swapped.len(), original.len());
        std::fs::write(&path, swapped).unwrap();
        // Equal length: only the hash can tell these apart. No longer any need
        // to defeat a fast path first — a file this size is always hashed.
        assert!(inspect(&dir, Some(&m)).is_dirty());
    }

    /// The blind spot the size+mtime pre-filter used to have, in the shape that
    /// actually produces it: an edit that keeps both the byte count and the
    /// original mtime. `cp -p`, a restore from backup and rsync's `-t` all do
    /// exactly this.
    #[test]
    fn an_edit_that_restores_size_and_mtime_is_still_caught() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        let path = dir.join("SKILL.md");
        let original = std::fs::read_to_string(&path).unwrap();
        let swapped = original.replace("body", "b0dy");
        assert_eq!(swapped.len(), original.len());
        std::fs::write(&path, &swapped).unwrap();

        // Put the recorded mtime back, so size AND mtime both match the
        // baseline — the exact state the old fast path waved through.
        let baseline_mtime = m.get("SKILL.md").unwrap().mtime_ms;
        set_mtime_ms(&path, baseline_mtime);
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), m.get("SKILL.md").unwrap().size);
        assert_eq!(mtime_ms(&meta), baseline_mtime);

        assert!(
            inspect(&dir, Some(&m)).is_dirty(),
            "content changed; matching size and mtime must not be taken as clean"
        );
    }

    /// The exception, stated as a test so it cannot rot into an accident: past
    /// the threshold the old pre-filter still applies, because re-reading a
    /// file that big on every tick is the wrong trade.
    #[test]
    fn a_file_past_the_threshold_keeps_the_pre_filter() {
        let (_tmp, dir) = fixture();
        let path = dir.join("big.bin");
        let size = (ALWAYS_HASH_MAX_BYTES + 1) as usize;
        std::fs::write(&path, vec![b'a'; size]).unwrap();
        let m = build_manifest(&dir).unwrap();

        // Same length, different bytes, original mtime restored.
        let baseline_mtime = m.get("big.bin").unwrap().mtime_ms;
        std::fs::write(&path, vec![b'b'; size]).unwrap();
        set_mtime_ms(&path, baseline_mtime);

        assert_eq!(
            inspect(&dir, Some(&m)),
            DirtyState::Clean,
            "the documented cost of keeping the fast path for large files"
        );
    }

    #[cfg(unix)]
    #[test]
    fn chmod_alone_is_a_modification() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        let path = dir.join("scripts/check.sh");
        // chmod moves ctime, not mtime — the size/mtime fast path is blind to
        // it, which is exactly why exec is compared on every pass.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        match inspect(&dir, Some(&m)) {
            DirtyState::Dirty { modified, .. } => {
                assert_eq!(modified, vec!["scripts/check.sh".to_string()]);
            }
            other => panic!("expected dirty, got {:?}", other),
        }
    }

    #[test]
    fn a_scoped_manifest_ignores_what_the_package_did_not_ship() {
        // The upgrade case: a scoped baseline must not ADOPT the script's own
        // log, or every later write to it would read as "modified".
        let (_tmp, dir) = fixture();
        write(&dir, "cache/run.log", "noise\n");
        let shipped = vec!["SKILL.md".to_string(), "scripts/check.sh".to_string()];

        let scoped = build_manifest_for(&dir, &shipped).unwrap();

        assert_eq!(scoped.len(), 2);
        assert!(!scoped.contains_key("cache/run.log"));
        assert!(build_manifest(&dir).unwrap().contains_key("cache/run.log"));

        // It is still not `modified` — but it IS reported as added, and that is
        // a deliberate change of policy: the publish path measures the whole
        // directory, so this file would ship with the next version. The user
        // has to see it. The price is that a pack whose script writes beside
        // itself sits in the conflict UI until they publish or discard.
        write(&dir, "cache/run.log", "more noise\n");
        match inspect(&dir, Some(&scoped)) {
            DirtyState::Dirty {
                modified,
                deleted,
                added,
            } => {
                assert!(modified.is_empty(), "the log is not a baseline file");
                assert!(deleted.is_empty());
                assert_eq!(added, vec!["cache/run.log".to_string()]);
            }
            other => panic!("expected the stray file to be reported: {other:?}"),
        }
    }

    #[test]
    fn a_file_the_user_drops_in_is_added_not_modified() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        write(&dir, "notes.md", "my own notes\n");

        match inspect(&dir, Some(&m)) {
            DirtyState::Dirty {
                modified,
                deleted,
                added,
            } => {
                assert!(modified.is_empty());
                assert!(deleted.is_empty());
                assert_eq!(added, vec!["notes.md".to_string()]);
            }
            other => panic!("a new file must be dirt: {other:?}"),
        }
    }

    #[test]
    fn our_own_bookkeeping_directory_is_never_an_addition() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        // `.clawhub/` holds the baseline itself — reporting it would make every
        // installed pack permanently dirty.
        write(&dir, &format!("{EXCLUDED_DIR}/origin.json"), "{}\n");
        assert_eq!(inspect(&dir, Some(&m)), DirtyState::Clean);
    }

    #[test]
    fn a_scoped_manifest_skips_paths_that_are_not_there() {
        let (_tmp, dir) = fixture();
        let shipped = vec!["SKILL.md".to_string(), "gone.md".to_string()];
        let scoped = build_manifest_for(&dir, &shipped).unwrap();
        assert_eq!(scoped.len(), 1);
        assert!(scoped.contains_key("SKILL.md"));
    }

    #[test]
    fn no_baseline_is_unmanaged_not_clean() {
        let (_tmp, dir) = fixture();
        assert_eq!(inspect(&dir, None), DirtyState::Unmanaged);
        assert_eq!(
            inspect(&dir, Some(&FileManifest::new())),
            DirtyState::Unmanaged
        );
    }
}
