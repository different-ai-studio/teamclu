//! Per-worktree claude-bridge process pool.
//!
//! Structurally the same as `cursor_sdk/process.rs`: one Node child per
//! canonical worktree, respawned when the env fingerprint changes. The
//! differences are the bridge path and that the API key is *optional* — the
//! Agent SDK falls back to whatever `claude` login already exists on the host,
//! so refusing to spawn without a key would break subscription users.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::info;

use crate::process_util::CommandNoWindow;
use crate::runtime::sidecar::bridge_path::default_claude_bridge_main;
use crate::runtime::sidecar::client::SidecarClient;

use super::{events, types::BridgeInstanceId, Shared};

pub(crate) struct ClaudeProcess {
    pub(crate) client: SidecarClient,
    pub(crate) bridge_id: BridgeInstanceId,
    child: parking_lot::Mutex<tokio::process::Child>,
    env_fingerprint: String,
}

impl ClaudeProcess {
    pub(crate) fn is_alive(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(None))
    }

    pub(crate) fn kill(&self) {
        let _ = self.child.lock().start_kill();
    }
}

pub(crate) struct ClaudeProcessPool {
    procs: parking_lot::Mutex<HashMap<String, Arc<ClaudeProcess>>>,
    bridge_command: parking_lot::Mutex<Option<Vec<String>>>,
    api_key: parking_lot::Mutex<Option<String>>,
    default_model: parking_lot::Mutex<String>,
    /// Extra env from spawn assembly; applied on (re)spawn.
    extra_env: parking_lot::Mutex<HashMap<String, String>>,
    force_env_override: parking_lot::Mutex<bool>,
}

impl ClaudeProcessPool {
    pub(crate) fn new() -> Self {
        Self {
            procs: parking_lot::Mutex::new(HashMap::new()),
            bridge_command: parking_lot::Mutex::new(None),
            api_key: parking_lot::Mutex::new(None),
            default_model: parking_lot::Mutex::new(String::new()),
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

    pub(crate) fn get(&self, worktree: &str) -> Option<Arc<ClaudeProcess>> {
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

    pub(crate) fn any_live(&self) -> Option<Arc<ClaudeProcess>> {
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
        let procs: Vec<Arc<ClaudeProcess>> = self.procs.lock().drain().map(|(_, p)| p).collect();
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
    ) -> crate::error::Result<Arc<ClaudeProcess>> {
        let want = self.env_fingerprint();
        if let Some(p) = self.get(worktree) {
            if p.env_fingerprint == want {
                return Ok(p);
            }
            info!(worktree, "claude bridge env changed; respawning");
            let stale_bridge = p.bridge_id.clone();
            p.kill();
            self.procs.lock().remove(worktree);
            let shared = Arc::clone(shared);
            let wt = worktree.to_string();
            tokio::spawn(async move {
                events::invalidate_bridge(&shared, &stale_bridge, &wt).await;
            });
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
    ) -> crate::error::Result<Arc<ClaudeProcess>> {
        let bridge = self
            .bridge_command
            .lock()
            .clone()
            .unwrap_or_else(default_bridge_command);
        if bridge.is_empty() {
            return Err(crate::error::AmuxError::Agent(
                "claude bridge command is empty".into(),
            ));
        }

        // Optional on purpose: with no key the Agent SDK uses the host's own
        // `claude` login (subscription auth), which is the common desktop case.
        let api_key = self.api_key.lock().clone().filter(|k| !k.trim().is_empty());

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
        // Only override when we actually have one; otherwise leave whatever
        // the host env provides so the SDK's own auth resolution still works.
        if let Some(api_key) = api_key {
            cmd.env("ANTHROPIC_API_KEY", api_key);
        }

        info!(worktree, bridge = ?bridge, "spawning claude-bridge");
        let mut child = cmd.spawn().map_err(|e| {
            let hint = if e.kind() == std::io::ErrorKind::NotFound {
                "node or claude-bridge not found; run npm install in apps/daemon/claude-bridge"
                    .to_string()
            } else {
                format!("spawn claude-bridge: {e}")
            };
            crate::error::AmuxError::Agent(hint)
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("claude stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("claude stdout unavailable".into()))?;
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
                                tracing::debug!(target: "claude_bridge", "{trimmed}");
                            }
                        }
                    }
                }
            });
        }

        let client = SidecarClient::new(stdin);
        let bridge_id = BridgeInstanceId::new_unique();
        events::spawn_reader(
            Arc::clone(shared),
            bridge_id.clone(),
            worktree.to_string(),
            stdout,
            client.clone(),
        );

        Ok(Arc::new(ClaudeProcess {
            client,
            bridge_id,
            child: parking_lot::Mutex::new(child),
            env_fingerprint: self.env_fingerprint(),
        }))
    }
}

pub fn default_bridge_main() -> PathBuf {
    default_claude_bridge_main()
}

pub fn default_bridge_command() -> Vec<String> {
    vec![
        "node".to_string(),
        default_bridge_main().to_string_lossy().into_owned(),
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
        assert!(cmd[1].ends_with("claude-bridge/src/main.mjs"));
    }
}
