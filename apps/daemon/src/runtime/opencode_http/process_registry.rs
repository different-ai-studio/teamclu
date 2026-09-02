use std::collections::HashMap;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tracing::warn;

#[cfg(windows)]
use crate::process_util::CommandNoWindow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedGroup {
    pub generation_id: String,
    pub pgid: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReapReport {
    pub reaped: Vec<ManagedGroup>,
    pub stale_or_reused: Vec<ManagedGroup>,
    pub survivors: Vec<ManagedGroup>,
}

impl ReapReport {
    pub fn registered_count(&self) -> usize {
        self.reaped.len() + self.stale_or_reused.len() + self.survivors.len()
    }

    pub fn has_survivors(&self) -> bool {
        !self.survivors.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReapOutcome {
    StaleOrReused,
    Reaped,
    Survivor,
}

#[cfg(test)]
static TEST_SURVIVOR_PGIDS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

#[cfg(test)]
pub fn test_mark_survivor_pgid(pgid: u32) {
    TEST_SURVIVOR_PGIDS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(pgid);
}

/// Whether the reaper would currently recognise this group as one of ours.
///
/// Exposed for tests that spawn a fake `opencode serve` and then reap it: a
/// just-`fork`ed child already has a pid and a process group, but until its
/// `execve` completes `/proc/<pid>/cmdline` is EMPTY, so
/// [`group_has_managed_member`] says no and the group is classified
/// `StaleOrReused` rather than `Reaped`. Measured at ~4-8% per group on Linux;
/// on macOS `cmdline_of` shells out to `ps`, and those milliseconds hide the
/// window, which is why this only ever failed on CI.
#[cfg(all(test, unix))]
pub fn test_group_is_verifiable(pgid: u32) -> bool {
    i32::try_from(pgid).is_ok_and(group_has_managed_member)
}

#[cfg(test)]
pub fn test_clear_survivor_pgids() {
    TEST_SURVIVOR_PGIDS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

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

    pub fn reap_all(&self) -> ReapReport {
        let mut report = ReapReport::default();
        for (generation_id, pgid) in self.snapshot() {
            let group = ManagedGroup {
                generation_id: generation_id.clone(),
                pgid,
            };
            match reap_verified_group(pgid) {
                ReapOutcome::StaleOrReused => {
                    if let Err(error) = self.unregister(&generation_id) {
                        warn!(
                            generation_id,
                            pgid,
                            %error,
                            "failed to unregister stale opencode serve group"
                        );
                    }
                    report.stale_or_reused.push(group);
                }
                ReapOutcome::Reaped => {
                    if let Err(error) = self.unregister(&generation_id) {
                        warn!(
                            generation_id,
                            pgid,
                            %error,
                            "failed to unregister reaped opencode serve group"
                        );
                    }
                    report.reaped.push(group);
                }
                ReapOutcome::Survivor => {
                    report.survivors.push(group);
                }
            }
        }
        report
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
fn reap_verified_group(pgid: u32) -> ReapOutcome {
    #[cfg(test)]
    if TEST_SURVIVOR_PGIDS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains(&pgid)
    {
        return ReapOutcome::Survivor;
    }
    let Ok(pgid) = i32::try_from(pgid) else {
        return ReapOutcome::StaleOrReused;
    };
    if !process_group_alive(pgid) {
        return ReapOutcome::StaleOrReused;
    }
    if !group_has_managed_member(pgid) {
        warn!(pgid, "refusing to reap unverified opencode process group");
        return ReapOutcome::StaleOrReused;
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
    if process_group_alive(pgid) && group_has_managed_member(pgid) {
        ReapOutcome::Survivor
    } else {
        ReapOutcome::Reaped
    }
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
fn reap_verified_group(pid: u32) -> ReapOutcome {
    let Ok(output) = std::process::Command::new("tasklist")
        .no_window()
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
    else {
        return ReapOutcome::Survivor;
    };
    let listing = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    if !listing.contains(&format!("\"{pid}\"")) {
        return ReapOutcome::StaleOrReused;
    }
    if !listing.contains("opencode") {
        warn!(pid, "refusing to reap unverified opencode process tree");
        return ReapOutcome::StaleOrReused;
    }
    let _ = std::process::Command::new("taskkill")
        .no_window()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline && windows_pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(50));
    }
    if windows_pid_alive(pid) {
        ReapOutcome::Survivor
    } else {
        ReapOutcome::Reaped
    }
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
fn reap_verified_group(_pgid: u32) -> ReapOutcome {
    ReapOutcome::Survivor
}

#[cfg(not(any(unix, windows)))]
fn registered_group_alive(_pgid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{
        test_clear_survivor_pgids, ManagedGroup, ReapReport, ServeProcessRegistry,
    };

    struct SurvivorGuard;

    impl Drop for SurvivorGuard {
        fn drop(&mut self) {
            test_clear_survivor_pgids();
        }
    }

    #[cfg(unix)]
    fn spawn_fake_opencode_serve(
        home: &std::path::Path,
    ) -> (std::process::Child, u32) {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;

        let binary = home.join("opencode");
        std::fs::write(&binary, "#!/bin/sh\nsleep 30\n").unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();
        let mut child = std::process::Command::new(&binary)
            .arg("serve")
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id();
        // Do not hand back a fake the reaper cannot recognise yet: between
        // `fork` and `execve` the child's `/proc/<pid>/cmdline` is empty, and a
        // reap in that window reports `StaleOrReused` instead of `Reaped`. The
        // deadline is a stuck-process guard, not a latency estimate — this
        // normally settles in well under a millisecond.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline && !super::test_group_is_verifiable(pgid) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        (child, pgid)
    }

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

        let report = registry.reap_all();

        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "an unverified process group must not be signaled"
        );
        assert!(!registry.snapshot().contains_key("stale"));
        assert_eq!(report.stale_or_reused.len(), 1);
        assert_eq!(
            report.stale_or_reused[0],
            ManagedGroup {
                generation_id: "stale".to_string(),
                pgid,
            }
        );
        assert!(report.reaped.is_empty());
        assert!(report.survivors.is_empty());
        let _ = unrelated.kill();
        let _ = unrelated.wait();
    }

    #[cfg(unix)]
    #[test]
    fn reap_cleans_current_and_draining_generations() {
        let _home_guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_home = std::env::var_os("HOME");
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        let path = home.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path);
        let (mut current, current_pgid) = spawn_fake_opencode_serve(home.path());
        let (mut draining_a, draining_a_pgid) = spawn_fake_opencode_serve(home.path());
        let (mut draining_b, draining_b_pgid) = spawn_fake_opencode_serve(home.path());
        registry.register("current", current_pgid).unwrap();
        registry.register("draining-a", draining_a_pgid).unwrap();
        registry.register("draining-b", draining_b_pgid).unwrap();

        let report = registry.reap_all();

        assert_eq!(report.registered_count(), 3);
        assert_eq!(report.reaped.len(), 3);
        assert!(report.stale_or_reused.is_empty());
        assert!(report.survivors.is_empty());
        assert!(registry.snapshot().is_empty());
        let _ = current.wait();
        let _ = draining_a.wait();
        let _ = draining_b.wait();

        match previous_home {
            Some(home) => unsafe { std::env::set_var("HOME", home) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[cfg(unix)]
    #[test]
    fn reap_survivor_keeps_registry_entry() {
        let _guard = SurvivorGuard;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path.clone());
        let (mut child, pgid) = spawn_fake_opencode_serve(dir.path());
        registry.register("stubborn", pgid).unwrap();
        super::test_mark_survivor_pgid(pgid);

        let report = registry.reap_all();

        assert_eq!(report.survivors.len(), 1);
        assert_eq!(report.survivors[0].generation_id, "stubborn");
        assert_eq!(registry.snapshot().get("stubborn"), Some(&pgid));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn second_reap_after_success_is_idempotent() {
        let _home_guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_home = std::env::var_os("HOME");
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        let path = home.path().join("opencode-pgids.json");
        let registry = ServeProcessRegistry::new(path);
        let (mut child, pgid) = spawn_fake_opencode_serve(home.path());
        registry.register("gen-a", pgid).unwrap();

        let first = registry.reap_all();
        let second = registry.reap_all();

        assert_eq!(first.reaped.len(), 1);
        assert_eq!(second.registered_count(), 0);
        assert!(registry.snapshot().is_empty());
        let _ = child.wait();

        match previous_home {
            Some(home) => unsafe { std::env::set_var("HOME", home) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[test]
    fn reap_report_counts_registered_entries() {
        let report = ReapReport {
            reaped: vec![ManagedGroup {
                generation_id: "a".to_string(),
                pgid: 1,
            }],
            stale_or_reused: vec![ManagedGroup {
                generation_id: "b".to_string(),
                pgid: 2,
            }],
            survivors: vec![],
        };
        assert_eq!(report.registered_count(), 2);
        assert!(!report.has_survivors());
    }
}
