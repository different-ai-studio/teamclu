//! Replace an installed pack with a new one without touching anything the pack
//! did not put there.
//!
//! The installer used to `remove_dir_all` the target and unpack over the crater.
//! Under auto-follow that runs unattended, so anything a user or a script left
//! in the skill directory disappears on a schedule, with no event they could
//! have connected it to. Knowing the previous file list turns the operation
//! into a precise three-way move: overwrite what the new version ships, delete
//! what it dropped, ignore everything else.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::manifest::{list_managed_paths, to_native, FileManifest};

/// Move `staged`'s contents into `target`.
///
/// `baseline` is the manifest of what is currently installed. `None` means we
/// have no record — files the new version does not ship are then left alone
/// rather than deleted, because without a baseline we cannot tell a stale
/// package file from something the user owns.
pub fn swap_managed_files(
    target: &Path,
    staged: &Path,
    baseline: Option<&FileManifest>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;

    let incoming = list_managed_paths(staged)?;
    let incoming_set: BTreeSet<&str> = incoming.iter().map(String::as_str).collect();

    for rel in &incoming {
        let from = staged.join(to_native(rel));
        let to = target.join(to_native(rel));
        // Staging and target can be the same directory — publishing a new
        // version re-stamps the installed pack in place, and a personal skill
        // that already lives under the skills root shares its path with the
        // team copy. `fs::copy` onto itself truncates the file, so this guard
        // is what stands between "re-baseline" and "delete the user's work".
        if same_file(&from, &to) {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // A path that is now a directory (or a symlink) has to go before a file
        // can take its place; `fs::copy` would just fail.
        match std::fs::symlink_metadata(&to) {
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&to)?,
            Ok(meta) if !meta.is_file() => std::fs::remove_file(&to)?,
            _ => {}
        }
        // `fs::copy` carries the permission bits across, which is what keeps a
        // shipped `check.sh` executable after an upgrade.
        std::fs::copy(&from, &to)?;
    }

    if let Some(baseline) = baseline {
        for rel in baseline.keys() {
            if incoming_set.contains(rel.as_str()) {
                continue;
            }
            let path = target.join(to_native(rel));
            if std::fs::symlink_metadata(&path)
                .map(|m| m.is_file())
                .unwrap_or(false)
            {
                std::fs::remove_file(&path)?;
                if let Some(parent) = path.parent() {
                    prune_empty_ancestors(target, parent.to_path_buf());
                }
            }
        }
    }

    Ok(())
}

/// Uninstall by removing only the files the pack put there.
///
/// The upgrade path goes to some trouble to leave unregistered files alone, and
/// then the uninstall path used to `remove_dir_all` the same directory — so a
/// reconcile tick acting on somebody's uninstall from another machine would
/// destroy notes and outputs that no upgrade would have touched, with no trash
/// copy and no undo. Removing exactly the baseline restores the symmetry.
///
/// `baseline: None` means we have no record of what we installed, so there is
/// no safe subset and the whole directory goes — the caller has already decided
/// that is what "uninstall" means for an unmanaged pack.
///
/// Returns whether the directory is gone. `false` means files the pack never
/// owned kept it alive, which is a normal outcome and not an error.
pub fn remove_managed_files(
    target: &Path,
    baseline: Option<&FileManifest>,
) -> std::io::Result<bool> {
    if !target.exists() {
        return Ok(true);
    }
    let Some(baseline) = baseline else {
        std::fs::remove_dir_all(target)?;
        return Ok(true);
    };

    for rel in baseline.keys() {
        let path = target.join(to_native(rel));
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {
                std::fs::remove_file(&path)?;
                if let Some(parent) = path.parent() {
                    prune_empty_ancestors(target, parent.to_path_buf());
                }
            }
            _ => {}
        }
    }

    // Our own bookkeeping goes with the pack — leaving it behind would make the
    // leftovers look like a half-installed skill on the next scan.
    let origin = target.join(crate::manifest::EXCLUDED_DIR);
    if origin.is_dir() {
        std::fs::remove_dir_all(&origin)?;
    }

    let empty = std::fs::read_dir(target)?.next().is_none();
    if empty {
        std::fs::remove_dir(target)?;
    }
    Ok(empty)
}

/// Whether two paths name the same existing file.
///
/// Compares canonical paths rather than the paths as given, so `a/../a/x` and
/// `a/x` are recognised as one file.
fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Walk up from a directory we just emptied, removing levels that are now bare.
///
/// Scoped to the ancestors of files we actually deleted rather than sweeping
/// the whole tree: an empty directory the user created deliberately is theirs,
/// and a general "prune empties" pass would take it.
fn prune_empty_ancestors(root: &Path, mut dir: PathBuf) {
    while dir != root && dir.starts_with(root) {
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return;
                }
            }
            Err(_) => return,
        }
        if std::fs::remove_dir(&dir).is_err() {
            return;
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{build_manifest, inspect, DirtyState};

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn upgrades_replace_shipped_files_and_drop_removed_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        write(&target, "SKILL.md", "v1\n");
        write(&target, "refs/old.md", "gone in v2\n");
        let baseline = build_manifest(&target).unwrap();

        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "v2\n");
        write(&staged, "scripts/new.sh", "echo new\n");

        swap_managed_files(&target, &staged, Some(&baseline)).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "v2\n"
        );
        assert!(target.join("scripts/new.sh").is_file());
        assert!(!target.join("refs/old.md").exists());
        // The directory that held only the dropped file goes with it.
        assert!(!target.join("refs").exists());
    }

    #[test]
    fn files_the_pack_never_owned_survive_the_upgrade() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        write(&target, "SKILL.md", "v1\n");
        let baseline = build_manifest(&target).unwrap();
        // Written after install: a script's cache and a note from the user.
        write(&target, "cache/run.log", "noise\n");
        write(&target, "NOTES.md", "mine\n");

        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "v2\n");

        swap_managed_files(&target, &staged, Some(&baseline)).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("NOTES.md")).unwrap(),
            "mine\n"
        );
        assert!(target.join("cache/run.log").is_file());
    }

    #[test]
    fn without_a_baseline_nothing_is_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        write(&target, "SKILL.md", "v1\n");
        write(&target, "refs/old.md", "unknown provenance\n");

        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "v2\n");

        swap_managed_files(&target, &staged, None).unwrap();

        assert!(target.join("refs/old.md").is_file());
    }

    #[test]
    fn a_fresh_install_is_the_same_operation() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "v1\n");

        swap_managed_files(&target, &staged, None).unwrap();

        let manifest = build_manifest(&target).unwrap();
        assert_eq!(inspect(&target, Some(&manifest)), DirtyState::Clean);
    }

    #[test]
    fn staging_onto_itself_leaves_the_files_intact() {
        // Publishing a new version re-stamps the pack from its own directory,
        // and a personal skill living under the skills root already shares its
        // path with the team copy. `fs::copy` onto itself truncates, so without
        // the guard this is how a publish deletes the thing being published.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("installed");
        write(&dir, "SKILL.md", "the content being published\n");
        write(&dir, "scripts/check.sh", "echo hi\n");
        let baseline = build_manifest(&dir).unwrap();

        swap_managed_files(&dir, &dir, Some(&baseline)).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "the content being published\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("scripts/check.sh")).unwrap(),
            "echo hi\n"
        );
        assert_eq!(inspect(&dir, Some(&baseline)), DirtyState::Clean);
    }

    #[test]
    fn uninstall_takes_the_pack_and_leaves_the_users_files() {
        // The upgrade path goes out of its way to preserve these; a background
        // uninstall triggered from another machine must not be the one
        // operation that deletes them.
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        write(&target, "SKILL.md", "v1\n");
        write(&target, "scripts/check.sh", "echo hi\n");
        let baseline = build_manifest(&target).unwrap();
        write(&target, "NOTES.md", "mine\n");
        write(&target, ".clawhub/origin.json", "{}\n");

        let gone = remove_managed_files(&target, Some(&baseline)).unwrap();

        assert!(!gone, "files the pack never owned keep the directory alive");
        assert!(!target.join("SKILL.md").exists());
        assert!(!target.join("scripts").exists());
        assert!(
            !target.join(".clawhub").exists(),
            "our bookkeeping goes too"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("NOTES.md")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn uninstall_removes_the_directory_when_nothing_is_left() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        write(&target, "SKILL.md", "v1\n");
        let baseline = build_manifest(&target).unwrap();
        write(&target, ".clawhub/origin.json", "{}\n");

        assert!(remove_managed_files(&target, Some(&baseline)).unwrap());
        assert!(!target.exists());
    }

    #[test]
    fn uninstall_without_a_baseline_takes_everything() {
        // No record of what we installed means no safe subset to remove.
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        write(&target, "SKILL.md", "v1\n");

        assert!(remove_managed_files(&target, None).unwrap());
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_executable_bit_survives() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("installed");
        let staged = tmp.path().join("staged");
        write(&staged, "run.sh", "#!/bin/sh\n");
        std::fs::set_permissions(
            staged.join("run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        swap_managed_files(&target, &staged, None).unwrap();

        let mode = std::fs::metadata(target.join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert!(
            mode & 0o111 != 0,
            "expected the shipped script to stay executable"
        );
    }
}
