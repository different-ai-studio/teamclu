use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub type TerminalId = String;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalSummary {
    pub id: TerminalId,
    pub shell: String,
    pub pid: u32,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalError {
    #[allow(dead_code)]
    #[error("shell not found")]
    ShellNotFound,
    #[error("cwd not allowed: {0}")]
    CwdNotAllowed(String),
    #[error("cwd not found: {0}")]
    CwdNotFound(String),
    #[error("pty closed")]
    PtyClosed,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("bad request: {0}")]
    BadRequest(String),
}

pub struct Registry {
    handles: RwLock<HashMap<TerminalId, Arc<crate::terminal::pty::PtyHandle>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            handles: RwLock::new(HashMap::new()),
        }
    }

    pub fn insert(&self, id: TerminalId, handle: Arc<crate::terminal::pty::PtyHandle>) {
        self.handles.write().unwrap().insert(id, handle);
    }

    pub fn get(&self, id: &str) -> Option<Arc<crate::terminal::pty::PtyHandle>> {
        self.handles.read().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<crate::terminal::pty::PtyHandle>> {
        self.handles.write().unwrap().remove(id)
    }

    pub fn list_summaries(&self, workspace_id: Option<&str>) -> Vec<TerminalSummary> {
        self.handles
            .read()
            .unwrap()
            .values()
            .filter(|h| workspace_id.is_none_or(|w| h.workspace_id == w))
            .map(|h| TerminalSummary {
                id: h.id.clone(),
                shell: h.shell.clone(),
                pid: h.pid,
                status: h.status(),
                exit_code: h.exit_code(),
            })
            .collect()
    }

    pub fn kill_all(&self) {
        for (_, h) in self.handles.write().unwrap().drain() {
            h.kill();
        }
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_lists_zero() {
        let r = Registry::new();
        assert_eq!(r.list_summaries(None).len(), 0);
    }

    #[test]
    fn remove_missing_returns_none() {
        let r = Registry::new();
        assert!(r.remove("nonexistent").is_none());
    }

    #[test]
    fn get_missing_returns_none() {
        let r = Registry::new();
        assert!(r.get("nonexistent").is_none());
    }
}
