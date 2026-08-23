use std::collections::HashMap;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tracing::warn;

#[cfg(windows)]
use crate::process_util::CommandNoWindow;

pub struct ServeProcessRegistry {
    path: PathBuf,
    groups: parking_lot::Mutex<HashMap<String, u32>>,
}

impl ServeProcessRegistry {
    pub fn new(path: PathBuf) -> Self {
        let groups = read_groups(&path);
        Self {
            path,
            groups: parking_lot::Mutex::new(groups),
        }
    }

    pub fn register(&self, generation_id: &str, pgid: u32) -> io::Result<()> {
        if generation_id.is_empty() || pgid <= 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "generation id must be non-empty and pgid must be greater than one",
            ));
        }
        let mut groups = self.groups.lock();
        if let Some(existing_pgid) = groups.get(generation_id).copied() {
            if existing_pgid != pgid && registered_group_alive(existing_pgid) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "generation {generation_id} still owns live process group {existing_pgid}"
                    ),
                ));
            }
        }
        let mut updated = groups.clone();
        updated.insert(generation_id.to_string(), pgid);
        persist_groups(&self.path, &updated)?;
        *groups = updated;
        Ok(())
    }

    pub fn unregister(&self, generation_id: &str) -> io::Result<()> {
        let mut groups = self.groups.lock();
        let mut updated = groups.clone();
        updated.remove(generation_id);
        persist_groups(&self.path, &updated)?;
        *groups = updated;
        Ok(())
    }

    pub fn snapshot(&self) -> HashMap<String, u32> {
        self.groups.lock().clone()
    }

    pub fn live_pgid(&self, generation_id: &str) -> Option<u32> {
        self.groups
            .lock()
            .get(generation_id)
            .copied()
            .filter(|pgid| registered_group_alive(*pgid))
    }

    pub fn reap_all(&self) {
        for (generation_id, pgid) in self.snapshot() {
            if reap_verified_group(pgid) {
                if let Err(error) = self.unregister(&generation_id) {
                    warn!(
                        generation_id,
                        pgid,
                        %error,
                        "failed to unregister reaped opencode serve group"
                    );
                }
            }
        }
    }
}

impl Default for ServeProcessRegistry {
    fn default() -> Self {
        Self::new(teamclu_runtime_env::amuxd_home_from_env().join("opencode-pgids.json"))
    }
}

fn read_groups(path: &PathBuf) -> HashMap<String, u32> {
    let Ok(body) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
        return HashMap::new();
    };
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(generation_id, value)| {
            let pgid = value.as_u64().and_then(|value| u32::try_from(value).ok())?;
            (pgid > 1 && !generation_id.is_empty()).then(|| (generation_id.clone(), pgid))
        })
        .collect()
}

fn persist_groups(path: &PathBuf, groups: &HashMap<String, u32>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(groups).map_err(io::Error::other)?;
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("opencode-pgids.json"))
        .to_string_lossy();
    let (tmp, mut file) = loop {
        let counter = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            counter
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => break (tmp, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    drop(file);

    #[cfg(windows)]
    let replaced = (|| {
        // Windows rename cannot replace an existing file, so replacement is
        // remove-then-rename. Unix keeps the atomic rename-over-destination path.
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        std::fs::rename(&tmp, path)
    })();
    #[cfg(not(windows))]
    let replaced = std::fs::rename(&tmp, path);

    if replaced.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    replaced
}

#[cfg(unix)]
fn reap_verified_group(pgid: u32) -> bool {
    let Ok(pgid) = i32::try_from(pgid) else {
        return true;
    };
    if !process_group_alive(pgid) {
        return true;
    }
    if !group_has_managed_member(pgid) {
        warn!(pgid, "refusing to reap unverified opencode process group");
        return true;
    }
    unsafe {
        let _ = libc::kill(-pgid, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && process_group_alive(pgid) {
        std::thread::sleep(Duration::from_millis(50));
    }
    if process_group_alive(pgid) && group_has_managed_member(pgid) {
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline && process_group_alive(pgid) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    // A killed child can remain as a zombie until its parent waits for it.
    // kill(-pgid, 0) still reports that group as present, but it no longer
    // contains a managed process and must not keep a stale registry entry.
    !process_group_alive(pgid) || !group_has_managed_member(pgid)
}

#[cfg(unix)]
fn process_group_alive(pgid: i32) -> bool {
    pgid > 1 && unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(unix)]
fn registered_group_alive(pgid: u32) -> bool {
    i32::try_from(pgid).is_ok_and(process_group_alive)
}

#[cfg(unix)]
fn group_has_managed_member(pgid: i32) -> bool {
    let Ok(out) = std::process::Command::new("pgrep")
        .args(["-g", &pgid.to_string()])
        .output()
    else {
        return false;
    };
    out.status.success()
        && String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<i32>().ok())
            .any(|pid| {
                cmdline_of(pid).is_some_and(|cmdline| {
                    let lower = cmdline.to_ascii_lowercase();
                    (lower.contains("opencode") && lower.contains("serve"))
                        || lower.contains("remote-tools-mcp")
                })
            })
}

#[cfg(unix)]
fn cmdline_of(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|body| body.replace('\0', " "))
        .or_else(|| {
            let output = std::process::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "command="])
                .output()
                .ok()?;
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
        })
}

#[cfg(windows)]
fn reap_verified_group(pid: u32) -> bool {
    let Ok(output) = std::process::Command::new("tasklist")
        .no_window()
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
    else {
        return false;
    };
    let listing = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    if !listing.contains(&format!("\"{pid}\"")) {
        return true;
    }
    if !listing.contains("opencode") {
        warn!(pid, "refusing to reap unverified opencode process tree");
        return true;
    }
    let _ = std::process::Command::new("taskkill")
        .no_window()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline && windows_pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(50));
    }
    !windows_pid_alive(pid)
}

#[cfg(windows)]
fn windows_pid_alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .no_window()
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()
        .is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        })
}

#[cfg(windows)]
fn registered_group_alive(pid: u32) -> bool {
    windows_pid_alive(pid)
}

#[cfg(not(any(unix, windows)))]
fn reap_verified_group(_pgid: u32) -> bool {
    false
}

#[cfg(not(any(unix, windows)))]
fn registered_group_alive(_pgid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::ServeProcessRegistry;

    #[test]
    fn default_registry_uses_branded_amuxd_home() {
        let registry = ServeProcessRegistry::default();
        assert_eq!(
            registry.path,
            teamclu_runtime_env::amuxd_home_from_env().join("opencode-pgids.json")
        );
    }

    #[test]
    fn registering_multiple_generations_persists_each_group() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path.clone());

        registry.register("gen-a", 41001).unwrap();
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        registry.register("gen-b", 41002).unwrap();

        let reloaded = ServeProcessRegistry::new(path);
        assert_eq!(reloaded.snapshot().get("gen-a"), Some(&41001));
        assert_eq!(reloaded.snapshot().get("gen-b"), Some(&41002));
    }

    #[test]
    fn unregistering_one_generation_preserves_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path.clone());
        registry.register("gen-a", 42001).unwrap();
        registry.register("gen-b", 42002).unwrap();

        registry.unregister("gen-a").unwrap();

        let reloaded = ServeProcessRegistry::new(path);
        assert!(!reloaded.snapshot().contains_key("gen-a"));
        assert_eq!(reloaded.snapshot().get("gen-b"), Some(&42002));
    }

    #[cfg(unix)]
    #[test]
    fn registering_generation_refuses_to_overwrite_a_live_group() {
        use std::os::unix::process::CommandExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path.clone());
        let mut live = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let live_pgid = live.id();
        registry.register("gen-a", live_pgid).unwrap();

        let error = registry.register("gen-a", 42003).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(registry.snapshot().get("gen-a"), Some(&live_pgid));
        assert_eq!(
            ServeProcessRegistry::new(path).snapshot().get("gen-a"),
            Some(&live_pgid)
        );
        let _ = live.kill();
        let _ = live.wait();
    }

    #[test]
    fn malformed_and_stale_entries_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-pgids.json");
        std::fs::write(
            &path,
            r#"{"valid":43001,"zero":0,"negative":-3,"text":"43002","nested":{}}"#,
        )
        .unwrap();

        let registry = ServeProcessRegistry::new(path);

        assert_eq!(
            registry.snapshot(),
            std::collections::HashMap::from([("valid".to_string(), 43001)])
        );
    }

    #[cfg(unix)]
    #[test]
    fn reap_ignores_an_unrelated_process_group() {
        use std::os::unix::process::CommandExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path);
        let mut unrelated = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = unrelated.id();
        registry.register("stale", pgid).unwrap();

        registry.reap_all();

        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "an unverified process group must not be signaled"
        );
        assert!(!registry.snapshot().contains_key("stale"));
        let _ = unrelated.kill();
        let _ = unrelated.wait();
    }
}
