//! Daemon-owned JSON config files, all under the active team's state dir.
//!
//! These replaced the OpenCode-era `opencode.json` files, which lived in two
//! places nobody chose on purpose: the root of every workspace the user opened
//! (their own repository), and `~/.amuxd/teams/<id>/state/opencode.json`. No
//! OpenCode runtime ships any more, so nothing needed that file name or shape,
//! and writing into the user's repo cost us twice: a file that churned in their
//! working tree, and a file watcher that treated every one of our own writes as
//! an MCP config edit (see `TEAMCLU_MCP_CONFIG_PATH` in `pi_rpc/process.rs`).
//!
//! Layout (`<state>` = `~/.amuxd/teams/<id>/state`):
//!
//! - `<state>/providers.json` — `{ "provider": { "<id>": … } }`: the cloud-managed
//!   `team` provider plus any provider the user added by hand.
//! - `<state>/workspaces/<key>/mcp.json` — `{ "workspace": "<abs path>", "mcp": { … } }`:
//!   the MCP servers this one workspace adds or overrides. `<key>` is derived
//!   from the workspace's absolute path ([`workspace_key`]); `workspace` is
//!   there for whoever is reading the directory, not for lookups.
//! - `<state>/workspaces/<key>/mcp.effective.json` — every layer (device, team,
//!   workspace) merged and normalized into the shape the pi extension bridges.
//!   Written by the daemon; the extension only reads and watches it.
//!
//! There is no migration from `opencode.json`. Old files are neither read nor
//! deleted: a user who still runs the real OpenCode CLI in that repo keeps a
//! working config.

use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::warn;

use crate::atomic_write;

#[derive(Debug, Error)]
pub enum ConfigStoreError {
    #[error("io: {0}")]
    Io(String),
    #[error("parse: {0}")]
    Parse(String),
}

const PROVIDERS_FILE: &str = "providers.json";
const WORKSPACES_DIR: &str = "workspaces";
const WORKSPACE_MCP_FILE: &str = "mcp.json";
const EFFECTIVE_MCP_FILE: &str = "mcp.effective.json";

fn active_state_dir() -> PathBuf {
    let home = crate::amuxd_home_from_env();
    crate::amuxd_layout::team_state_dir(&home, &crate::amuxd_layout::active_team(&home))
}

/// `<state>/providers.json` for the active team.
pub fn providers_config_path() -> PathBuf {
    active_state_dir().join(PROVIDERS_FILE)
}

/// A stable directory name for one workspace: the first 16 hex digits of the
/// SHA-256 of its absolute path, canonicalized when it exists so `a/../b` and a
/// symlinked path land on the same key as the real one.
pub fn workspace_key(workspace: &Path) -> String {
    let resolved = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let digest = Sha256::digest(resolved.to_string_lossy().as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `<state>/workspaces/` for the active team: one directory per workspace.
pub fn workspaces_config_dir() -> PathBuf {
    active_state_dir().join(WORKSPACES_DIR)
}

/// `<state>/workspaces/<key>/` for the active team.
pub fn workspace_config_dir(workspace: &Path) -> PathBuf {
    workspaces_config_dir().join(workspace_key(workspace))
}

/// File name of the effective MCP map inside a workspace's config dir.
pub const EFFECTIVE_MCP_FILE_NAME: &str = EFFECTIVE_MCP_FILE;

/// The workspace's own MCP layer.
pub fn workspace_mcp_path(workspace: &Path) -> PathBuf {
    workspace_config_dir(workspace).join(WORKSPACE_MCP_FILE)
}

/// The merged, pi-ready MCP map for the workspace.
pub fn effective_mcp_path(workspace: &Path) -> PathBuf {
    workspace_config_dir(workspace).join(EFFECTIVE_MCP_FILE)
}

/// Read-modify-write access to one JSON file, safe against the other writers in
/// this process (per-path lock) and against readers in other processes (atomic
/// rename).
pub struct ConfigStore;

impl ConfigStore {
    /// Load the file as JSON. A missing file reads as an empty object; a file
    /// with trailing garbage after a complete object is recovered (and the
    /// original kept as `*.json.corrupt.bak`).
    pub fn load_at(path: &Path) -> Result<Value, ConfigStoreError> {
        if !path.exists() {
            return Ok(Value::Object(Default::default()));
        }
        let content = std::fs::read_to_string(path).map_err(map_io_err)?;
        match serde_json::from_str::<Value>(&content) {
            Ok(value) => Ok(value),
            Err(err) => Self::recover_leading_object(path, &content, err),
        }
    }

    /// Read-modify-write under the path's write lock. The mutator returns
    /// `Ok(true)` when the value changed and should be persisted.
    pub fn apply_at<F>(path: &Path, mutator: F) -> Result<bool, ConfigStoreError>
    where
        F: FnOnce(&mut Value) -> Result<bool, ConfigStoreError>,
    {
        let write_lock = atomic_write::config_write_lock(path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = Self::load_at(path)?;
        if !mutator(&mut config)? {
            return Ok(false);
        }
        Self::write_value_at(path, &config)?;
        Ok(true)
    }

    /// Replace the file's contents under its write lock. Skips the write (and
    /// returns `false`) when the file already holds exactly this value, so a
    /// watcher on it only fires for real changes.
    pub fn write_if_changed_at(path: &Path, value: &Value) -> Result<bool, ConfigStoreError> {
        let write_lock = atomic_write::config_write_lock(path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        if path.exists() && Self::load_at(path).ok().as_ref() == Some(value) {
            return Ok(false);
        }
        Self::write_value_at(path, value)?;
        Ok(true)
    }

    /// The providers file for the active team.
    pub fn load_providers() -> Result<Value, ConfigStoreError> {
        Self::load_at(&providers_config_path())
    }

    pub fn apply_providers<F>(mutator: F) -> Result<bool, ConfigStoreError>
    where
        F: FnOnce(&mut Value) -> Result<bool, ConfigStoreError>,
    {
        Self::apply_at(&providers_config_path(), mutator)
    }

    /// The workspace's own MCP layer file.
    pub fn load_workspace_mcp(workspace: &Path) -> Result<Value, ConfigStoreError> {
        Self::load_at(&workspace_mcp_path(workspace))
    }

    /// Read-modify-write the workspace MCP layer. The `workspace` breadcrumb is
    /// stamped on every write.
    pub fn apply_workspace_mcp<F>(workspace: &Path, mutator: F) -> Result<bool, ConfigStoreError>
    where
        F: FnOnce(&mut Value) -> Result<bool, ConfigStoreError>,
    {
        Self::apply_at(&workspace_mcp_path(workspace), |config| {
            if !mutator(config)? {
                return Ok(false);
            }
            if let Some(obj) = config.as_object_mut() {
                obj.insert(
                    "workspace".to_string(),
                    Value::String(workspace.to_string_lossy().into_owned()),
                );
            }
            Ok(true)
        })
    }

    fn write_value_at(path: &Path, value: &Value) -> Result<(), ConfigStoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(map_io_err)?;
        }
        let mut content = serde_json::to_string_pretty(value)
            .map_err(|e| ConfigStoreError::Parse(e.to_string()))?;
        if !content.ends_with('\n') {
            content.push('\n');
        }
        atomic_write::atomic_write(path, &content).map_err(map_io_err)
    }

    fn recover_leading_object(
        path: &Path,
        content: &str,
        original_err: serde_json::Error,
    ) -> Result<Value, ConfigStoreError> {
        let mut stream = serde_json::Deserializer::from_str(content).into_iter::<Value>();
        let recovered = match stream.next() {
            Some(Ok(value)) if value.is_object() => value,
            _ => return Err(ConfigStoreError::Parse(original_err.to_string())),
        };

        let backup = path.with_extension("json.corrupt.bak");
        if let Err(e) = std::fs::write(&backup, content) {
            warn!(
                path = %path.display(),
                error = %e,
                "config_store: failed to back up corrupt config; leaving file untouched"
            );
            return Ok(recovered);
        }

        match serde_json::to_string_pretty(&recovered) {
            Ok(clean) => {
                if let Err(e) = atomic_write::atomic_write(path, &format!("{clean}\n")) {
                    warn!(
                        path = %path.display(),
                        error = %e,
                        "config_store: failed to rewrite recovered config"
                    );
                } else {
                    warn!(
                        path = %path.display(),
                        backup = %backup.display(),
                        "config_store: recovered corrupt config (trailing bytes dropped); backup saved"
                    );
                }
            }
            Err(e) => warn!(
                path = %path.display(),
                error = %e,
                "config_store: could not re-serialize recovered config"
            ),
        }

        Ok(recovered)
    }
}

fn map_io_err(e: std::io::Error) -> ConfigStoreError {
    ConfigStoreError::Io(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn isolate() -> (
        std::sync::MutexGuard<'static, ()>,
        tempfile::TempDir,
        crate::test_util::AmuxdHomeGuard,
    ) {
        let lock = crate::test_util::home_env_lock();
        let home = tempfile::tempdir().unwrap();
        let guard = crate::test_util::AmuxdHomeGuard::set(home.path());
        fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-a\"\n",
        )
        .unwrap();
        (lock, home, guard)
    }

    #[test]
    fn providers_live_in_the_active_teams_state() {
        let (_lock, home, _guard) = isolate();
        assert_eq!(
            providers_config_path(),
            home.path().join("teams/team-a/state/providers.json")
        );
    }

    #[test]
    fn workspace_files_are_keyed_by_path_and_never_in_the_workspace() {
        let (_lock, home, _guard) = isolate();
        let ws = tempfile::tempdir().unwrap();
        let mcp = workspace_mcp_path(ws.path());
        assert!(mcp.starts_with(home.path().join("teams/team-a/state/workspaces")));
        assert!(!mcp.starts_with(ws.path()));
        assert_eq!(mcp.parent(), effective_mcp_path(ws.path()).parent());

        let other = tempfile::tempdir().unwrap();
        assert_ne!(workspace_key(ws.path()), workspace_key(other.path()));
        assert_eq!(workspace_key(ws.path()), workspace_key(ws.path()));
        assert_eq!(workspace_key(ws.path()).len(), 16);
    }

    #[test]
    fn workspace_mcp_writes_carry_the_workspace_breadcrumb() {
        let (_lock, _home, _guard) = isolate();
        let ws = tempfile::tempdir().unwrap();
        ConfigStore::apply_workspace_mcp(ws.path(), |cfg| {
            cfg["mcp"] = serde_json::json!({ "x": { "type": "local", "command": ["x"] } });
            Ok(true)
        })
        .unwrap();
        let loaded = ConfigStore::load_workspace_mcp(ws.path()).unwrap();
        assert_eq!(loaded["mcp"]["x"]["command"][0], "x");
        assert_eq!(loaded["workspace"], ws.path().to_string_lossy().as_ref());
        assert!(!ws.path().join("opencode.json").exists());
    }

    #[test]
    fn write_if_changed_skips_identical_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        let value = serde_json::json!({ "a": 1 });
        assert!(ConfigStore::write_if_changed_at(&path, &value).unwrap());
        assert!(!ConfigStore::write_if_changed_at(&path, &value).unwrap());
        assert!(ConfigStore::write_if_changed_at(&path, &serde_json::json!({ "a": 2 })).unwrap());
    }

    #[test]
    fn load_recovers_trailing_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        fs::write(&path, "{\"mcp\":{}}\n\"trailing\": true").unwrap();
        let loaded = ConfigStore::load_at(&path).unwrap();
        assert!(loaded.get("mcp").is_some());
        assert!(!fs::read_to_string(&path).unwrap().contains("trailing"));
    }
}
