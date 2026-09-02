//! Per-app checkout path overrides and directory moves.
//!
//! Overrides live in `teams/<teamId>/state/app-workdir-overrides.json` so each
//! machine can point at its own checkout without touching cloud `workspaces.path`.
//! Moves relocate the entire tree (`.git`, `node_modules`, …): same filesystem
//! uses `rename`, cross-filesystem uses copy + verify + delete. On failure the
//! original directory and override pointer are left unchanged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// Read the override for `app_id`, if any.
pub fn read_override(team_id: &str, app_id: &str) -> Option<PathBuf> {
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return None;
    }
    load_overrides(team_id)
        .ok()
        .and_then(|file| file.overrides.get(app_id).cloned())
        .map(PathBuf::from)
}

/// Every override this team has, as `(app_id, path)`.
///
/// An app checked out somewhere of the user's choosing lives nowhere near the
/// derived root, so a scan of that root alone would report it as "not on this
/// machine" and offer to download it again.
pub fn all_overrides(team_id: &str) -> Vec<(String, PathBuf)> {
    load_overrides(team_id)
        .map(|file| {
            file.overrides
                .into_iter()
                .map(|(app_id, path)| (app_id, PathBuf::from(path)))
                .collect()
        })
        .unwrap_or_default()
}

/// Persist an override, creating the state dir if needed.
pub fn set_override(team_id: &str, app_id: &str, workdir: &Path) -> std::io::Result<()> {
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "app_id must not be empty",
        ));
    }
    let mut file = load_overrides(team_id).unwrap_or_default();
    file.overrides
        .insert(app_id.to_string(), workdir.to_string_lossy().into_owned());
    save_overrides(team_id, &file)
}

/// Drop an override entry when the workdir matches the derived default again.
pub fn clear_override(team_id: &str, app_id: &str) -> std::io::Result<()> {
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Ok(());
    }
    let path = crate::config::layout::app_workdir_overrides_file(team_id);
    let mut file = match load_overrides(team_id) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    if file.overrides.remove(app_id).is_none() {
        return Ok(());
    }
    if file.overrides.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    save_overrides(team_id, &file)
}

/// Move `from` to `to`, including hidden entries such as `.git`.
pub fn move_directory(from: &Path, to: &Path) -> std::io::Result<()> {
    if from == to {
        return Ok(());
    }
    if !from.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("source directory does not exist: {}", from.display()),
        ));
    }
    if to.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("destination already exists: {}", to.display()),
        ));
    }
    if is_path_within(to, from) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination must not be inside the source directory",
        ));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if same_filesystem(from, to) {
        std::fs::rename(from, to)?;
        return Ok(());
    }

    copy_dir_all(from, to)?;
    verify_copy(from, to)?;
    std::fs::remove_dir_all(from)?;
    Ok(())
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct OverridesFile {
    #[serde(default)]
    overrides: BTreeMap<String, String>,
}

fn load_overrides(team_id: &str) -> std::io::Result<OverridesFile> {
    let path = crate::config::layout::app_workdir_overrides_file(team_id);
    let contents = std::fs::read_to_string(&path)?;
    serde_json::from_str(&contents).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("parse app workdir overrides: {e}"),
        )
    })
}

fn save_overrides(team_id: &str, file: &OverridesFile) -> std::io::Result<()> {
    let path = crate::config::layout::app_workdir_overrides_file(team_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(file).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize app workdir overrides: {e}"),
        )
    })?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &path)
}

/// Device id for the filesystem `path` lives on.
///
/// The path itself wins when it exists; the parent is only a fallback for a
/// destination that has not been created yet. Preferring the parent
/// unconditionally answered wrong whenever the checkout is itself a mount
/// point (an external disk mounted straight at the workdir): the two parents
/// matched, `same_filesystem` said true, and `rename` then failed with EXDEV
/// instead of taking the copy path that would have worked.
fn metadata_for_fs_check(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path)
            .ok()
            .or_else(|| path.parent().and_then(|p| std::fs::metadata(p).ok()))?;
        Some(meta.dev())
    }
    #[cfg(windows)]
    {
        volume_serial_for_path(path).map(u64::from)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

#[cfg(windows)]
fn volume_serial_for_path(path: &Path) -> Option<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let root = volume_root_for_path(path)?;
    let mut wide: Vec<u16> = root.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut serial = 0u32;
    // SAFETY: `wide` is a null-terminated UTF-16 path; out pointers are valid.
    let ok = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(serial)
    }
}

/// Root path accepted by `GetVolumeInformationW` (`C:\` or `\\server\share`).
#[cfg(windows)]
fn volume_root_for_path(path: &Path) -> Option<PathBuf> {
    let resolved = if path.exists() {
        path.canonicalize().ok()?
    } else {
        path.parent()?.canonicalize().ok()?
    };
    let raw = resolved.to_string_lossy();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    if raw.starts_with(r"\\") {
        let trimmed = raw.trim_start_matches('\\');
        let server = trimmed.split('\\').next()?;
        let rest = trimmed.strip_prefix(server)?.trim_start_matches('\\');
        let share = rest.split('\\').next()?;
        return Some(PathBuf::from(format!(r"\\{server}\{share}")));
    }
    let colon = raw.find(":\\").or_else(|| raw.find(":/"))?;
    Some(PathBuf::from(&raw[..colon + 2]))
}

fn same_filesystem(a: &Path, b: &Path) -> bool {
    match (metadata_for_fs_check(a), metadata_for_fs_check(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn is_path_within(child: &Path, parent: &Path) -> bool {
    child.starts_with(parent)
}

/// Recreate a symlink at `dst` pointing at the same (possibly relative) target.
#[cfg(unix)]
fn copy_symlink(target: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, dst)
}

#[cfg(windows)]
fn copy_symlink(target: &Path, dst: &Path) -> std::io::Result<()> {
    // Windows needs the flavour up front; resolve the target relative to the
    // link's own directory to decide. Creating symlinks may require developer
    // mode — failing loudly is the point, see copy_dir_all.
    let resolved = dst.parent().map(|p| p.join(target));
    if resolved.map(|p| p.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(target, dst)
    } else {
        std::os::windows::fs::symlink_file(target, dst)
    }
}

/// Copy `from` into `to`, preserving symlinks as symlinks.
///
/// Symlinks are not an edge case here: a pnpm checkout's `node_modules` is
/// almost entirely links into the global store. Handling only `is_dir()` /
/// `is_file()` skipped every one of them silently, and because
/// [`dir_fingerprint`] also counted files only, [`verify_copy`] then compared
/// two trees that both omitted the links and reported success — after which
/// `move_directory` deleted the original. Anything this cannot reproduce must
/// surface as an error, never as a quiet omission.
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in WalkDir::new(from).follow_links(false).into_iter() {
        let entry = entry?;
        let rel = entry.path().strip_prefix(from).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("strip_prefix: {e}"))
        })?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let dst = to.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            let target = std::fs::read_link(entry.path())?;
            copy_symlink(&target, &dst)?;
        } else if file_type.is_dir() {
            std::fs::create_dir_all(&dst)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dst)?;
        } else {
            // Sockets, fifos, devices: refuse rather than drop them and then
            // delete the source.
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "cannot move unsupported file type: {}",
                    entry.path().display()
                ),
            ));
        }
    }
    Ok(())
}

/// What a fingerprint records about one entry.
///
/// Directories and symlinks are in here on purpose: the original recorded only
/// files, so a copy that lost every symlink still fingerprinted identically on
/// both sides and passed verification.
#[derive(Debug, PartialEq, Eq)]
enum FsEntry {
    Dir,
    File(u64),
    Symlink(PathBuf),
}

fn dir_fingerprint(root: &Path) -> std::io::Result<BTreeMap<PathBuf, FsEntry>> {
    let mut map = BTreeMap::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter() {
        let entry = entry?;
        let rel = entry.path().strip_prefix(root).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("strip_prefix: {e}"))
        })?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let file_type = entry.file_type();
        let recorded = if file_type.is_symlink() {
            FsEntry::Symlink(std::fs::read_link(entry.path())?)
        } else if file_type.is_dir() {
            FsEntry::Dir
        } else if file_type.is_file() {
            // `symlink_metadata` so a link is never sized through its target.
            FsEntry::File(std::fs::symlink_metadata(entry.path())?.len())
        } else {
            continue;
        };
        map.insert(rel.to_path_buf(), recorded);
    }
    Ok(map)
}

fn verify_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    let src = dir_fingerprint(from)?;
    let dst = dir_fingerprint(to)?;
    if src.len() != dst.len() {
        let _ = std::fs::remove_dir_all(to);
        return Err(verify_mismatch());
    }
    for (rel, entry) in src {
        let Some(other) = dst.get(&rel) else {
            let _ = std::fs::remove_dir_all(to);
            return Err(verify_mismatch());
        };
        if *other != entry {
            let _ = std::fs::remove_dir_all(to);
            return Err(verify_mismatch());
        }
        // Only regular files get a byte comparison; a symlink is fully
        // described by its target, and reading through one would compare the
        // file it points at instead.
        if let FsEntry::File(_) = entry {
            let from_bytes = std::fs::read(from.join(&rel))?;
            let to_bytes = std::fs::read(to.join(&rel))?;
            if from_bytes != to_bytes {
                let _ = std::fs::remove_dir_all(to);
                return Err(verify_mismatch());
            }
        }
    }
    Ok(())
}

fn verify_mismatch() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Other,
        "copy verification failed: file tree mismatch",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_round_trip_and_clear() {
        let home = tempfile::tempdir().unwrap();
        let team_id = "team-a";
        let state = home.path().join("teams").join(team_id).join("state");
        std::fs::create_dir_all(&state).unwrap();

        let overrides = state.join("app-workdir-overrides.json");
        assert_eq!(
            overrides,
            app_workdir_overrides_file_in(home.path(), team_id)
        );

        let custom = home.path().join("custom").join("app-1");
        set_override_in(home.path(), team_id, "app-1", &custom).unwrap();
        assert_eq!(
            read_override_in(home.path(), team_id, "app-1").as_deref(),
            Some(custom.as_path())
        );

        clear_override_in(home.path(), team_id, "app-1").unwrap();
        assert!(read_override_in(home.path(), team_id, "app-1").is_none());
        assert!(!overrides.exists());
    }

    #[test]
    fn same_filesystem_move_is_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        std::fs::create_dir_all(from.join(".git")).unwrap();
        std::fs::write(from.join(".git/config"), b"git").unwrap();
        std::fs::write(from.join("index.html"), b"hello").unwrap();

        let to = tmp.path().join("to");
        move_directory(&from, &to).unwrap();

        assert!(!from.exists());
        assert!(to.join(".git/config").is_file());
        assert_eq!(
            std::fs::read_to_string(to.join("index.html")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn move_refuses_nonempty_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        std::fs::create_dir_all(&from).unwrap();
        let to = tmp.path().join("to");
        std::fs::create_dir_all(to.join("occupied")).unwrap();

        let err = move_directory(&from, &to).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(from.is_dir());
    }

    #[test]
    fn move_keeps_source_when_verify_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.txt"), b"one").unwrap();

        let to = tmp.path().join("to");
        copy_dir_all(&from, &to).unwrap();
        std::fs::write(to.join("a.txt"), b"two").unwrap();

        let err = verify_copy(&from, &to).unwrap_err();
        assert!(err.to_string().contains("verification failed"));
        assert!(!to.exists(), "failed verify must remove partial copy");
        assert!(from.join("a.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn copy_preserves_symlinks() {
        // A pnpm checkout's node_modules is almost entirely symlinks into the
        // global store. Copying only files dropped every one of them.
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        std::fs::create_dir_all(from.join("node_modules")).unwrap();
        std::fs::write(from.join("real.js"), b"module").unwrap();
        std::os::unix::fs::symlink("../real.js", from.join("node_modules/dep.js")).unwrap();
        std::os::unix::fs::symlink("/nowhere", from.join("node_modules/dangling")).unwrap();

        let to = tmp.path().join("to");
        copy_dir_all(&from, &to).unwrap();
        verify_copy(&from, &to).unwrap();

        let link = to.join("node_modules/dep.js");
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "symlink must stay a symlink, not become a copy of its target"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new("../real.js"));
        // A dangling link still round-trips: it is the link we move, not its target.
        assert_eq!(
            std::fs::read_link(to.join("node_modules/dangling")).unwrap(),
            Path::new("/nowhere")
        );
    }

    #[cfg(unix)]
    #[test]
    fn verify_rejects_a_copy_that_lost_a_symlink() {
        // The regression that made this dangerous: symlinks were absent from
        // both fingerprints, so a copy missing them verified clean and the
        // source was then deleted.
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("real.js"), b"module").unwrap();
        std::os::unix::fs::symlink("real.js", from.join("link.js")).unwrap();

        let to = tmp.path().join("to");
        copy_dir_all(&from, &to).unwrap();
        std::fs::remove_file(to.join("link.js")).unwrap();

        let err = verify_copy(&from, &to).unwrap_err();
        assert!(err.to_string().contains("verification failed"));
        assert!(
            from.join("link.js").exists(),
            "source must survive a failed verify"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verify_rejects_a_symlink_repointed_at_another_target() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.js"), b"a").unwrap();
        std::fs::write(from.join("b.js"), b"b").unwrap();
        std::os::unix::fs::symlink("a.js", from.join("link.js")).unwrap();

        let to = tmp.path().join("to");
        copy_dir_all(&from, &to).unwrap();
        std::fs::remove_file(to.join("link.js")).unwrap();
        std::os::unix::fs::symlink("b.js", to.join("link.js")).unwrap();

        assert!(verify_copy(&from, &to).is_err());
    }

    fn app_workdir_overrides_file_in(home: &Path, team_id: &str) -> PathBuf {
        home.join("teams")
            .join(team_id)
            .join("state")
            .join("app-workdir-overrides.json")
    }

    fn read_override_in(home: &Path, team_id: &str, app_id: &str) -> Option<PathBuf> {
        let path = app_workdir_overrides_file_in(home, team_id);
        let contents = std::fs::read_to_string(&path).ok()?;
        let file: OverridesFile = serde_json::from_str(&contents).ok()?;
        file.overrides.get(app_id).cloned().map(PathBuf::from)
    }

    fn set_override_in(
        home: &Path,
        team_id: &str,
        app_id: &str,
        workdir: &Path,
    ) -> std::io::Result<()> {
        let path = app_workdir_overrides_file_in(home, team_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file: OverridesFile = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        file.overrides
            .insert(app_id.to_string(), workdir.to_string_lossy().into_owned());
        std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap())
    }

    fn clear_override_in(home: &Path, team_id: &str, app_id: &str) -> std::io::Result<()> {
        let path = app_workdir_overrides_file_in(home, team_id);
        let mut file: OverridesFile = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => return Ok(()),
        };
        file.overrides.remove(app_id);
        if file.overrides.is_empty() {
            let _ = std::fs::remove_file(&path);
        } else {
            std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap())?;
        }
        Ok(())
    }
}
