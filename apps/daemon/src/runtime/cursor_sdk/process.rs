//! Per-worktree cursor-bridge process pool.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::info;

use super::{events, Shared};
use crate::process_util::CommandNoWindow;
use crate::runtime::sidecar::bridge_path::default_cursor_bridge_main;
use crate::runtime::sidecar::client::SidecarClient;

pub(crate) struct CursorProcess {
    pub(crate) client: SidecarClient,
    child: parking_lot::Mutex<tokio::process::Child>,
    env_fingerprint: String,
}

impl CursorProcess {
    pub(crate) fn is_alive(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(None))
    }

    pub(crate) fn kill(&self) {
        let _ = self.child.lock().start_kill();
    }
}

pub(crate) struct CursorProcessPool {
    procs: parking_lot::Mutex<HashMap<String, Arc<CursorProcess>>>,
    bridge_command: parking_lot::Mutex<Option<Vec<String>>>,
    api_key: parking_lot::Mutex<Option<String>>,
    default_model: parking_lot::Mutex<String>,
    /// Extra env from spawn assembly; applied on (re)spawn.
    extra_env: parking_lot::Mutex<HashMap<String, String>>,
    force_env_override: parking_lot::Mutex<bool>,
}

impl CursorProcessPool {
    pub(crate) fn new() -> Self {
        Self {
            procs: parking_lot::Mutex::new(HashMap::new()),
            bridge_command: parking_lot::Mutex::new(None),
            api_key: parking_lot::Mutex::new(None),
            default_model: parking_lot::Mutex::new("composer-2.5".to_string()),
            extra_env: parking_lot::Mutex::new(HashMap::new()),
            force_env_override: parking_lot::Mutex::new(false),
        }
    }

    pub(crate) fn configure(
        &self,
        bridge_command: Option<Vec<String>>,
        api_key: Option<String>,
        default_model: Option<String>,
    ) {
        if let Some(cmd) = bridge_command.filter(|c| !c.is_empty()) {
            *self.bridge_command.lock() = Some(cmd);
        }
        if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
            *self.api_key.lock() = Some(key);
        }
        if let Some(model) = default_model.filter(|m| !m.trim().is_empty()) {
            *self.default_model.lock() = model;
        }
    }

    /// Merge session env into the env applied at (re)spawn (first-wins per key).
    pub(crate) fn merge_extra_env(&self, extra_env: &HashMap<String, String>, force: bool) {
        if force {
            *self.force_env_override.lock() = true;
        }
        if extra_env.is_empty() {
            return;
        }
        let mut env = self.extra_env.lock();
        for (k, v) in extra_env {
            env.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }

    fn env_fingerprint(&self) -> String {
        let cmd = self
            .bridge_command
            .lock()
            .clone()
            .unwrap_or_else(default_bridge_command);
        let key = self.api_key.lock().clone().unwrap_or_default();
        let model = self.default_model.lock().clone();
        let force = *self.force_env_override.lock();
        let mut extra: Vec<String> = self
            .extra_env
            .lock()
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        extra.sort();
        format!(
            "cmd={cmd:?}\x1fkey={key}\x1fmodel={model}\x1fforce={force}\x1fextra={}",
            extra.join("\x1e")
        )
    }

    pub(crate) fn get(&self, worktree: &str) -> Option<Arc<CursorProcess>> {
        let mut procs = self.procs.lock();
        match procs.get(worktree) {
            Some(p) if p.is_alive() => Some(Arc::clone(p)),
            Some(_) => {
                procs.remove(worktree);
                None
            }
            None => None,
        }
    }

    pub(crate) fn any_live(&self) -> Option<Arc<CursorProcess>> {
        self.procs
            .lock()
            .values()
            .find(|p| p.is_alive())
            .map(Arc::clone)
    }

    pub(crate) fn live_count(&self) -> usize {
        self.procs.lock().values().filter(|p| p.is_alive()).count()
    }

    pub(crate) fn kill_all(&self) -> usize {
        let procs: Vec<Arc<CursorProcess>> = self.procs.lock().drain().map(|(_, p)| p).collect();
        let mut killed = 0;
        for p in procs {
            if p.is_alive() {
                p.kill();
                killed += 1;
            }
        }
        killed
    }

    pub(crate) fn ensure(
        &self,
        shared: &Arc<Shared>,
        worktree: &str,
    ) -> crate::error::Result<Arc<CursorProcess>> {
        let want = self.env_fingerprint();
        if let Some(p) = self.get(worktree) {
            if p.env_fingerprint == want {
                return Ok(p);
            }
            info!(worktree, "cursor bridge env changed; respawning");
            p.kill();
            self.procs.lock().remove(worktree);
        }
        let proc = self.spawn(shared, worktree)?;
        self.procs
            .lock()
            .insert(worktree.to_string(), Arc::clone(&proc));
        Ok(proc)
    }

    fn spawn(
        &self,
        shared: &Arc<Shared>,
        worktree: &str,
    ) -> crate::error::Result<Arc<CursorProcess>> {
        let bridge = self
            .bridge_command
            .lock()
            .clone()
            .unwrap_or_else(default_bridge_command);
        if bridge.is_empty() {
            return Err(crate::error::AmuxError::Agent(
                "cursor bridge command is empty".into(),
            ));
        }

        let api_key = self
            .api_key
            .lock()
            .clone()
            .or_else(|| std::env::var("CURSOR_API_KEY").ok())
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(
                    "CURSOR_API_KEY is not set; add it to your personal env (Settings → Env Vars) or export the env var"
                        .into(),
                )
            })?;

        let mut cmd = tokio::process::Command::new(&bridge[0]);
        cmd.no_window();
        for arg in bridge.iter().skip(1) {
            cmd.arg(arg);
        }
        cmd.current_dir(worktree)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd.env(
            "PATH",
            crate::runtime::opencode_http::enriched_spawn_path(
                std::env::var("PATH").ok().as_deref(),
                dirs::home_dir().as_deref(),
            ),
        );
        let force = *self.force_env_override.lock();
        for (k, v) in self.extra_env.lock().iter() {
            if force || std::env::var_os(k).is_none() {
                cmd.env(k, v);
            }
        }
        // Always win over any injected duplicate.
        cmd.env("CURSOR_API_KEY", api_key);

        info!(worktree, bridge = ?bridge, "spawning cursor-bridge");
        let mut child = cmd.spawn().map_err(|e| {
            let hint = if e.kind() == std::io::ErrorKind::NotFound {
                "node or cursor-bridge not found; run npm install in apps/daemon/cursor-bridge"
                    .to_string()
            } else {
                format!("spawn cursor-bridge: {e}")
            };
            crate::error::AmuxError::Agent(hint)
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("cursor stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("cursor stdout unavailable".into()))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                tracing::debug!(target: "cursor_bridge", "{trimmed}");
                            }
                        }
                    }
                }
            });
        }

        let client = SidecarClient::new(stdin);
        events::spawn_reader(
            Arc::clone(shared),
            worktree.to_string(),
            stdout,
            client.clone(),
        );

        Ok(Arc::new(CursorProcess {
            client,
            child: parking_lot::Mutex::new(child),
            env_fingerprint: self.env_fingerprint(),
        }))
    }
}

pub fn default_bridge_main() -> PathBuf {
    default_cursor_bridge_main()
}

pub fn default_bridge_command() -> Vec<String> {
    vec![
        "node".to_string(),
        default_cursor_bridge_main().to_string_lossy().into_owned(),
        "--mode".to_string(),
        "rpc".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bridge_command_includes_main_script() {
        let cmd = default_bridge_command();
        assert_eq!(cmd[0], "node");
        assert!(cmd[1].ends_with("cursor-bridge/src/main.mjs"));
        assert!(default_bridge_main().is_file());
    }
}
