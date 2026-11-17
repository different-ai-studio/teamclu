//! Atomic file writes for shared config files (notably `opencode.json`).
//!
//! `opencode.json` has many independent writers spread across the daemon, the
//! runtime-env crate, and the desktop process. A plain `std::fs::write` opens
//! with `O_TRUNC`, but the byte stream is written at the fd's own offset — so
//! two concurrent writers of different lengths can leave the shorter object
//! followed by the longer writer's stale tail ("trailing characters at line N").
//!
//! Writing to a unique sibling temp file and `rename`-ing it into place makes
//! every write an all-or-nothing swap: a reader always sees exactly one
//! complete file, and a partial/short writer can never leave stale bytes behind
//! a later writer. The temp name embeds pid + a per-process counter so
//! concurrent writers never clobber each other's temp file either.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Registry of per-`opencode.json` write locks, keyed by the config file path.
#[allow(clippy::type_complexity)]
static OPENCODE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

/// Get the shared write lock for one `opencode.json` path.
///
/// All in-process writers of a given workspace's `opencode.json` do their whole
/// read-modify-write under this lock, so concurrent amuxd tasks (a runtime
/// spawn and an HTTP `GET /providers` reconcile, say) serialize instead of
/// clobbering each other's edits. Atomic writes stop *corruption*; this lock
/// stops *lost updates*. Callers hold the returned guard across read AND write:
///
/// ```ignore
/// let lock = opencode_write_lock(&config_path);
/// let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
/// // ... read_json_object(&config_path) ... mutate ... atomic_write(&config_path, ...)
/// ```
pub fn opencode_write_lock(config_path: &Path) -> Arc<Mutex<()>> {
    let key = config_path.to_string_lossy().into_owned();
    let registry = OPENCODE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = registry.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Atomically write `content` to `path` via a unique temp file + rename.
///
/// The temp file is created next to `path` (same directory, so `rename` stays
/// on one filesystem). On success `path` is replaced atomically; on any error
/// the temp file is best-effort removed and the original `path` is untouched.
///
/// On unix the file is created owner-only (0600). These files carry
/// credentials — the team `opencode.json` holds the live AI-gateway token — and
/// the rename replaces the target's inode, so the mode set here is the mode the
/// final file has, whatever the previous file's was.
pub fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let tmp_name = format!("{file_name}.{}.{seq}.tmp", std::process::id());
    let tmp = match path.parent() {
        Some(dir) => dir.join(tmp_name),
        None => Path::new(&tmp_name).to_path_buf(),
    };

    if let Err(e) = write_private(&tmp, content) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Create `path` fresh and write `content` to it, owner-only on unix.
fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_target_with_the_new_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        std::fs::write(&path, "a much longer previous body").unwrap();
        atomic_write(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind");
    }

    #[cfg(unix)]
    #[test]
    fn written_file_is_owner_only_even_over_a_world_readable_one() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        atomic_write(&path, r#"{"apiKey":"secret"}"#).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
