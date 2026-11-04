//! `<amuxd logs>/install-pi.log` — a durable copy of everything one
//! `install-pi` narrates.
//!
//! The narration otherwise lives only on the sidecar's pipes, which the desktop
//! app turns into UI events and then drops. A user stuck on the first-run
//! wizard therefore had nothing to send us: on 2026-11-04 a fresh machine
//! failed with only `Node.js v24.20.0` on screen — the last line of a Node
//! crash trace, whose actual error sat a few lines above and was gone.
//!
//! Every [`super::progress`] line is appended here with a timestamp, npm's own
//! output included (it is forwarded as `output` events). Best-effort
//! throughout: a log that cannot be opened or written never fails an install.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Rotate once the file passes this, keeping one previous generation as
/// `install-pi.log.1`. A full npm install narrates well under 100 KiB, so this
/// holds several attempts — enough for "it failed, then failed again".
const ROTATE_AT_BYTES: u64 = 1024 * 1024;

static LOG: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn path() -> PathBuf {
    crate::config::layout::logs_dir().join("install-pi.log")
}

/// Open (or rotate and open) the log for this run and write a header. Until
/// this is called, [`write`] is a no-op.
pub(super) fn begin(force: bool) {
    begin_at(&path(), force);
}

fn begin_at(path: &Path, force: bool) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > ROTATE_AT_BYTES) {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        let _ = std::fs::rename(path, PathBuf::from(rotated));
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok();
    *LOG.lock().unwrap_or_else(|e| e.into_inner()) = file;
    write(
        "begin",
        &format!(
            "amuxd {} install-pi{} — pi {}, Node.js {}, {} {}",
            env!("CARGO_PKG_VERSION"),
            if force { " --force" } else { "" },
            super::required_version(),
            super::required_node_version(),
            std::env::consts::OS,
            std::env::consts::ARCH,
        ),
    );
}

/// Append one line. Multi-line messages (npm tails, error chains) are written
/// as-is under a single timestamp, so a pasted log reads like the terminal.
pub(super) fn write(event: &str, message: &str) {
    let mut guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(file) = guard.as_mut() {
        let at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "{at} [{event}] {message}");
    }
}

/// Close the log after the run's last line.
pub(super) fn end() {
    *LOG.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test owns the process-wide LOG: separate tests would race on it.
    #[test]
    fn appends_across_runs_and_rotates_a_large_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("install-pi.log");

        begin_at(&path, false);
        write("output", "npm error code ENOTFOUND\nNode.js v24.20.0");
        end();
        write("output", "after end: dropped");

        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("[begin] amuxd "), "{body}");
        assert!(body.contains("[output] npm error code ENOTFOUND\nNode.js v24.20.0"));
        assert!(!body.contains("dropped"));

        std::fs::write(&path, vec![b'x'; (ROTATE_AT_BYTES + 1) as usize]).unwrap();
        begin_at(&path, true);
        end();
        let rotated = dir.path().join("logs").join("install-pi.log.1");
        assert_eq!(
            std::fs::metadata(&rotated).unwrap().len(),
            ROTATE_AT_BYTES + 1
        );
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert!(fresh.contains("install-pi --force"), "{fresh}");
    }
}
