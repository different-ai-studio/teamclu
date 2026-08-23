//! One-generation `opencode serve` process supervisor.
//!
//! Each supervisor owns one immutable process environment and one generation
//! entry in the shared process-group registry. Crash recovery is lazy:
//! `ensure()` respawns the same generation with the same environment.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

use super::client::ServeClient;
use super::process_registry::ServeProcessRegistry;
use crate::process_util::CommandNoWindow;
use crate::runtime::execution_context::ProcessEnvRevision;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TICK: Duration = Duration::from_millis(200);
/// Wait for `opencode serve` (+ MCP children in its process group) after SIGTERM.
const STOP_GRACE: Duration = Duration::from_millis(500);

struct ServeInstance {
    child: tokio::process::Child,
    client: ServeClient,
    pgid: u32,
}

/// Owns a registered process group until its child is stored by the supervisor.
///
/// Dropping the spawn future during a health check runs this synchronously, so
/// descendants cannot outlive the `Child` handle and block a later respawn.
struct SpawnOwnershipGuard<'a> {
    child: &'a mut tokio::process::Child,
    pgid: u32,
    generation_id: &'a str,
    registry: &'a ServeProcessRegistry,
    armed: bool,
}

impl<'a> SpawnOwnershipGuard<'a> {
    fn new(
        child: &'a mut tokio::process::Child,
        pgid: u32,
        generation_id: &'a str,
        registry: &'a ServeProcessRegistry,
    ) -> Self {
        Self {
            child,
            pgid,
            generation_id,
            registry,
            armed: true,
        }
    }

    fn child_mut(&mut self) -> &mut tokio::process::Child {
        self.child
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SpawnOwnershipGuard<'_> {
    fn drop(&mut self) {
        if !self.armed || !kill_serve_tree(self.child, self.pgid) {
            return;
        }
        if let Err(error) = self.registry.unregister(self.generation_id) {
            warn!(
                generation_id = %self.generation_id,
                pgid = self.pgid,
                %error,
                "failed to unregister cancelled opencode serve spawn"
            );
        }
    }
}

pub struct ServeSupervisor {
    generation_id: String,
    registry: Arc<ServeProcessRegistry>,
    /// `[agents.opencode].binary` override from daemon.toml, when configured.
    binary_override: parking_lot::Mutex<Option<String>>,
    /// Complete environment inherited by every spawn of this generation.
    extra_env: HashMap<String, String>,
    process_env_revision: ProcessEnvRevision,
    state: parking_lot::Mutex<Option<ServeInstance>>,
    /// Serializes spawn attempts without holding `state` across awaits.
    spawn_lock: tokio::sync::Mutex<()>,
    password: String,
    #[cfg(test)]
    test_client: Option<ServeClient>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownOutcome {
    Idle,
    Stopped,
    Survived { pgid: u32 },
}

impl ShutdownOutcome {
    pub fn was_running(self) -> bool {
        !matches!(self, Self::Idle)
    }
}

fn generate_password() -> String {
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            CHARS[rng.gen_range(0..CHARS.len())] as char
        })
        .collect()
}

fn pick_free_port() -> crate::error::Result<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| crate::error::AmuxError::Agent(format!("pick serve port: {e}")))
}

impl ServeSupervisor {
    pub fn new(
        generation_id: String,
        registry: Arc<ServeProcessRegistry>,
        extra_env: HashMap<String, String>,
        revision: ProcessEnvRevision,
    ) -> Self {
        Self {
            generation_id,
            registry,
            binary_override: parking_lot::Mutex::new(None),
            extra_env,
            process_env_revision: revision,
            state: parking_lot::Mutex::new(None),
            spawn_lock: tokio::sync::Mutex::new(()),
            password: generate_password(),
            #[cfg(test)]
            test_client: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_with_base_url(
        generation_id: String,
        revision: ProcessEnvRevision,
        base_url: String,
    ) -> Self {
        let password = generate_password();
        let registry = Arc::new(ServeProcessRegistry::new(
            tempfile::tempdir()
                .expect("temporary process registry")
                .keep()
                .join("opencode-pgids.json"),
        ));
        Self {
            generation_id,
            registry,
            binary_override: parking_lot::Mutex::new(None),
            extra_env: HashMap::new(),
            process_env_revision: revision,
            state: parking_lot::Mutex::new(None),
            spawn_lock: tokio::sync::Mutex::new(()),
            test_client: Some(ServeClient::new(base_url, password.clone())),
            password,
        }
    }

    /// Record the configured opencode binary (from `AgentLaunchConfig`).
    /// `"claude"` (the serde default) counts as unconfigured.
    pub fn set_binary_hint(&self, binary: &str) {
        if !binary.is_empty() && binary != "claude" && binary != "opencode" {
            *self.binary_override.lock() = Some(binary.to_string());
        }
    }

    pub fn process_env_revision(&self) -> &ProcessEnvRevision {
        &self.process_env_revision
    }

    /// Legacy diagnostics now reflect this generation's immutable environment.
    pub fn active_env_fingerprint(&self) -> Option<String> {
        self.is_running()
            .then(|| teamclu_runtime_env::resolved_env::fingerprint_bindings(&self.extra_env))
    }

    pub fn requested_env_fingerprint(&self, _workspace: &str) -> Option<String> {
        Some(teamclu_runtime_env::resolved_env::fingerprint_bindings(
            &self.extra_env,
        ))
    }

    /// A generation cannot conflict with its own immutable environment.
    pub fn snapshot_conflict_workspace(&self, _workspace: &str) -> Option<String> {
        None
    }

    /// Count of immutable env keys inherited by this generation.
    pub fn cached_env_key_count(&self) -> usize {
        self.extra_env.len()
    }

    /// Immutable key names inherited by this generation (sorted, no values exposed).
    pub fn cached_env_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.extra_env.keys().cloned().collect();
        keys.sort_by(|left, right| left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase()));
        keys
    }

    /// True when a serve child is currently tracked and alive.
    pub fn is_running(&self) -> bool {
        let mut guard = self.state.lock();
        match guard.as_mut() {
            Some(inst) => match inst.child.try_wait() {
                Ok(None) => true,
                _ => {
                    let mut inst = guard.take().expect("serve instance present");
                    if !self.finish_process_group(&mut inst) {
                        *guard = Some(inst);
                    }
                    false
                }
            },
            None => false,
        }
    }

    /// Kill the current serve process group (serve + MCP children). Next
    /// `ensure()` respawns. Used on daemon stop and after provider auth/config
    /// changes. A surviving process group remains owned by this supervisor.
    pub fn shutdown(&self) -> ShutdownOutcome {
        let taken = self.state.lock().take();
        match taken {
            Some(mut inst) => {
                if self.finish_process_group(&mut inst) {
                    info!(generation_id = %self.generation_id, "opencode serve process group shut down");
                    ShutdownOutcome::Stopped
                } else {
                    let pgid = inst.pgid;
                    self.state.lock().replace(inst);
                    ShutdownOutcome::Survived { pgid }
                }
            }
            None => ShutdownOutcome::Idle,
        }
    }

    /// Ensure the global serve instance is up; returns a client for it.
    pub async fn ensure(&self) -> crate::error::Result<ServeClient> {
        #[cfg(test)]
        if let Some(client) = self.test_client.clone() {
            return Ok(client);
        }
        if let Some(client) = self.client_if_running()? {
            return Ok(client);
        }
        let _guard = self.spawn_lock.lock().await;
        if let Some(client) = self.client_if_running()? {
            return Ok(client);
        }
        if let Some(pgid) = self.registry.live_pgid(&self.generation_id) {
            return Err(surviving_group_error(&self.generation_id, pgid));
        }
        self.spawn().await
    }

    fn client_if_running(&self) -> crate::error::Result<Option<ServeClient>> {
        let mut guard = self.state.lock();
        let Some(inst) = guard.as_mut() else {
            return Ok(None);
        };
        match inst.child.try_wait() {
            Ok(None) => Ok(Some(inst.client.clone())),
            other => {
                warn!(exit = ?other, "opencode serve process is gone; will respawn");
                let mut inst = guard.take().expect("serve instance present");
                if self.finish_process_group(&mut inst) {
                    Ok(None)
                } else {
                    let pgid = inst.pgid;
                    *guard = Some(inst);
                    Err(surviving_group_error(&self.generation_id, pgid))
                }
            }
        }
    }

    fn finish_process_group(&self, inst: &mut ServeInstance) -> bool {
        if kill_serve_tree(&mut inst.child, inst.pgid) {
            if let Err(error) = self.registry.unregister(&self.generation_id) {
                warn!(
                    generation_id = %self.generation_id,
                    pgid = inst.pgid,
                    %error,
                    "failed to unregister dead opencode serve group"
                );
            }
            true
        } else {
            false
        }
    }

    fn register_spawned_group(
        &self,
        child: &mut tokio::process::Child,
        pgid: u32,
    ) -> crate::error::Result<()> {
        self.registry
            .register(&self.generation_id, pgid)
            .map_err(|error| {
                if !kill_serve_tree(child, pgid) {
                    warn!(
                        generation_id = %self.generation_id,
                        pgid,
                        "unregistered opencode serve group survived spawn cleanup"
                    );
                }
                crate::error::AmuxError::Agent(format!(
                    "register opencode serve process group: {error}"
                ))
            })
    }

    async fn spawn(&self) -> crate::error::Result<ServeClient> {
        let configured = self.binary_override.lock().clone();
        let binary = crate::opencode_install::resolve_binary(configured.as_deref());
        let port = pick_free_port()?;
        let base = format!("http://127.0.0.1:{port}");

        let mut cmd = tokio::process::Command::new(&binary);
        cmd.no_window();
        cmd.arg("serve")
            .arg("--port")
            .arg(port.to_string())
            .arg("--hostname")
            .arg("127.0.0.1");
        cmd.env(
            "PATH",
            super::enriched_spawn_path(
                std::env::var("PATH").ok().as_deref(),
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from)
                    .as_deref(),
            ),
        );
        cmd.env("OPENCODE_SERVER_PASSWORD", &self.password);
        for (k, v) in &self.extra_env {
            if std::env::var_os(k).is_none() {
                cmd.env(k, v);
            }
        }
        // Last: OpenCode has a single OPENCODE_CONFIG. Point it at the
        // generated adapter so team MCP is in the process env from the first
        // spawn so every host generation starts with the reconciled team config.
        if let Some(team_id) = crate::config::team_mcp::onboarded_team_id() {
            let _ = crate::runtime::team_cloud_config::sync_opencode_generated(&team_id);
            cmd.env(
                "OPENCODE_CONFIG",
                crate::runtime::team_cloud_config::team_cloud_mcp_opencode_generated_file(&team_id),
            );
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // Own process group so shutdown can SIGTERM/SIGKILL the whole tree
        // (serve + MCP children like remote-tools-mcp), not just the leader.
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        info!(
            binary = %binary,
            port,
            generation_id = %self.generation_id,
            "spawning opencode serve generation"
        );
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                crate::error::agent_binary_missing(
                    "opencode",
                    format_args!("spawn opencode serve ({binary}): {e}"),
                )
            } else {
                crate::error::AmuxError::Agent(format!("spawn opencode serve ({binary}): {e}"))
            }
        })?;
        let pgid = child.id().ok_or_else(|| {
            crate::error::AmuxError::Agent(
                "spawned opencode serve did not expose a process id".into(),
            )
        })?;
        self.register_spawned_group(&mut child, pgid)?;
        let mut spawn_owner =
            SpawnOwnershipGuard::new(&mut child, pgid, &self.generation_id, &self.registry);

        if let Some(stdout) = spawn_owner.child_mut().stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "opencode_serve", "{line}");
                }
            });
        }
        if let Some(stderr) = spawn_owner.child_mut().stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    warn!(target: "opencode_serve", "{line}");
                }
            });
        }

        let client = ServeClient::new(base.clone(), self.password.clone());
        let started = Instant::now();
        loop {
            if client.health().await {
                break;
            }
            if let Ok(Some(status)) = spawn_owner.child_mut().try_wait() {
                let group_dead = kill_serve_tree(spawn_owner.child_mut(), pgid);
                spawn_owner.disarm();
                if group_dead {
                    let _ = self.registry.unregister(&self.generation_id);
                }
                return Err(crate::error::AmuxError::Agent(format!(
                    "opencode serve exited during startup: {status}"
                )));
            }
            if started.elapsed() > HEALTH_TIMEOUT {
                let group_dead = kill_serve_tree(spawn_owner.child_mut(), pgid);
                spawn_owner.disarm();
                if group_dead {
                    let _ = self.registry.unregister(&self.generation_id);
                }
                return Err(crate::error::AmuxError::Agent(
                    "opencode serve health check timed out".into(),
                ));
            }
            tokio::time::sleep(HEALTH_TICK).await;
        }
        info!(base = %base, ready_ms = started.elapsed().as_millis() as u64, "opencode serve ready");

        spawn_owner.disarm();
        drop(spawn_owner);
        *self.state.lock() = Some(ServeInstance {
            child,
            client: client.clone(),
            pgid,
        });
        Ok(client)
    }
}

fn surviving_group_error(generation_id: &str, pgid: u32) -> crate::error::AmuxError {
    crate::error::AmuxError::Agent(format!(
        "opencode serve process group {pgid} for generation {generation_id} is still alive after cleanup; refusing to respawn until cleanup succeeds"
    ))
}

/// SIGTERM the serve process group, wait briefly, then SIGKILL the group.
/// Children (MCP servers) inherit the group from `setpgid(0,0)` at spawn.
///
/// The generation registry entry is removed only once the *whole group* is
/// confirmed dead. A reaped leader with surviving MCP children stays
/// registered so `amuxd stop` can still find them.
fn kill_serve_tree(child: &mut tokio::process::Child, pgid: u32) -> bool {
    #[cfg(unix)]
    {
        if let Ok(pgid) = i32::try_from(pgid) {
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGTERM);
            }
            let mut leader_reaped = false;
            let deadline = Instant::now() + STOP_GRACE;
            loop {
                if !leader_reaped {
                    match child.try_wait() {
                        Ok(Some(_)) => leader_reaped = true,
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
                if leader_reaped && !process_group_alive(pgid) {
                    return true;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGKILL);
            }
            let _ = child.start_kill();
            let _ = child.try_wait();
            // Give the kernel a moment to tear the group down after SIGKILL.
            let kill_deadline = Instant::now() + Duration::from_millis(300);
            while Instant::now() < kill_deadline && process_group_alive(pgid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            if process_group_alive(pgid) {
                warn!(
                    pgid,
                    "opencode serve group survived SIGKILL; keeping registry entry"
                );
            }
            return !process_group_alive(pgid);
        }
        let _ = child.start_kill();
        let _ = child.try_wait();
        true
    }
    #[cfg(windows)]
    {
        // taskkill /T terminates the whole child tree (serve + MCP children);
        // Child::start_kill alone would only hit the leader.
        let _ = std::process::Command::new("taskkill")
            .no_window()
            .args(["/PID", &pgid.to_string(), "/T", "/F"])
            .output();
        let _ = child.start_kill();
        let _ = child.try_wait();
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline && windows_pid_alive(pgid) {
            std::thread::sleep(Duration::from_millis(50));
        }
        !windows_pid_alive(pgid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.start_kill();
        let _ = child.try_wait();
        false
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

/// `kill(-pgid, 0)` succeeds while any member of the group exists.
#[cfg(unix)]
fn process_group_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[cfg(unix)]
    #[tokio::test]
    async fn registration_failure_reaps_spawned_process_group() {
        use std::os::unix::process::CommandExt;

        let dir = tempfile::tempdir().unwrap();
        let blocked_parent = dir.path().join("not-a-directory");
        std::fs::write(&blocked_parent, "file").unwrap();
        let registry = Arc::new(super::super::process_registry::ServeProcessRegistry::new(
            blocked_parent.join("opencode-pgids.json"),
        ));
        let revision =
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&HashMap::new());
        let serve = ServeSupervisor::new(
            "gen-a".to_string(),
            registry.clone(),
            HashMap::new(),
            revision,
        );
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 30 & wait")
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id().unwrap();

        let error = serve.register_spawned_group(&mut child, pgid).unwrap_err();

        assert!(error
            .to_string()
            .contains("register opencode serve process group"));
        assert!(!process_group_alive(i32::try_from(pgid).unwrap()));
        assert!(!registry.snapshot().contains_key("gen-a"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_spawn_ownership_reaps_registered_process_group() {
        use std::os::unix::process::CommandExt;

        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(super::super::process_registry::ServeProcessRegistry::new(
            dir.path().join("opencode-pgids.json"),
        ));
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 30 & wait")
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id().unwrap();
        registry.register("gen-a", pgid).unwrap();

        drop(SpawnOwnershipGuard::new(
            &mut child,
            pgid,
            "gen-a",
            registry.as_ref(),
        ));

        assert!(!process_group_alive(i32::try_from(pgid).unwrap()));
        assert!(!registry.snapshot().contains_key("gen-a"));
    }

    #[test]
    fn constructor_captures_immutable_process_environment() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(super::super::process_registry::ServeProcessRegistry::new(
            dir.path().join("opencode-pgids.json"),
        ));
        let env = HashMap::from([
            ("API_KEY".to_string(), "secret".to_string()),
            ("REGION".to_string(), "local".to_string()),
        ]);
        let revision = crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&env);

        let serve = ServeSupervisor::new("gen-a".to_string(), registry, env, revision.clone());

        assert_eq!(serve.process_env_revision(), &revision);
        assert_eq!(serve.cached_env_key_count(), 2);
    }
}
