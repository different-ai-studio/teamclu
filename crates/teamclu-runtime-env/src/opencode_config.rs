//! Single owner for read-modify-write of a workspace's `opencode.json`.
//!
//! All amuxd-side writers acquire the per-path lock and use atomic replace
//! through this module so concurrent tasks cannot leave stale JSON tails.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tracing::warn;

use crate::atomic_write;

pub const OPENCODE_JSON: &str = "opencode.json";
/// Official-brand relative overlay path (legacy constant for callers/docs).
/// Prefer [`runtime_overlay_rel`] / [`runtime_overlay_write_path`].
pub const RUNTIME_OVERLAY_REL: &str = ".teamclu/opencode.runtime.json";
const RUNTIME_OVERLAY_FILE: &str = "opencode.runtime.json";

#[derive(Debug, thiserror::Error)]
pub enum OpencodeConfigError {
    #[error("io: {0}")]
    Io(String),
    #[error("parse: {0}")]
    Parse(String),
}

pub fn opencode_config_path(workspace: &Path) -> PathBuf {
    workspace.join(OPENCODE_JSON)
}

/// The daemon-owned config for the active team
/// (`~/.amuxd/teams/<team>/state/opencode.json`, or the white-label equivalent).
///
/// Holds team-scoped provider rows (`provider.team`) materialized by
/// [`crate::team_provider_sync::sync_global_team_provider`] on spawn and on
/// provider reads. We deliberately never write to the user's hand-edited
/// `~/.config/opencode/opencode.json`.
pub fn global_opencode_config_path() -> PathBuf {
    let home = crate::amuxd_home_from_env();
    crate::amuxd_layout::team_state_dir(&home, &crate::amuxd_layout::active_team(&home))
        .join(OPENCODE_JSON)
}

/// Pre-team-layout location, used only to adopt an existing device config on
/// the first write after upgrading.
fn legacy_global_opencode_config_path() -> PathBuf {
    crate::amuxd_home_from_env().join(OPENCODE_JSON)
}

fn migrate_legacy_global_config() -> Result<(), OpencodeConfigError> {
    let target = global_opencode_config_path();
    let legacy = legacy_global_opencode_config_path();
    if target.exists() || !legacy.is_file() {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| OpencodeConfigError::Io("team config path has no parent".to_string()))?;
    std::fs::create_dir_all(parent).map_err(map_io_err)?;
    std::fs::rename(&legacy, &target).map_err(map_io_err)
}

/// Relative overlay path for the given brand (`{meta}/opencode.runtime.json`).
pub fn runtime_overlay_rel(brand_short_name: &str) -> String {
    format!(
        "{}/{}",
        crate::workspace_meta_dir_name(brand_short_name),
        RUNTIME_OVERLAY_FILE
    )
}

/// Canonical write path for the runtime overlay (brand meta dir).
pub fn runtime_overlay_write_path(workspace: &Path) -> PathBuf {
    crate::workspace_meta_write_path_from_env(workspace, RUNTIME_OVERLAY_FILE)
}

/// Resolve overlay path for reads (canonical, else legacy `.teamclu/`).
pub fn runtime_overlay_path(workspace: &Path) -> PathBuf {
    crate::resolve_workspace_meta_path_from_env(workspace, RUNTIME_OVERLAY_FILE)
}

pub struct OpencodeConfigStore;

impl OpencodeConfigStore {
    /// Load `opencode.json` as a JSON object, recovering a leading object when
    /// trailing garbage is present (non-atomic partial writes).
    pub fn load(workspace: &Path) -> Result<Value, OpencodeConfigError> {
        Self::load_at(&opencode_config_path(workspace))
    }

    /// [`load`] against the daemon-owned global config.
    pub fn load_global() -> Result<Value, OpencodeConfigError> {
        let path = global_opencode_config_path();
        if path.exists() {
            return Self::load_at(&path);
        }
        // Read compatibility is deliberately non-mutating; the next global
        // write atomically adopts this file into the active team's state dir.
        Self::load_at(&legacy_global_opencode_config_path())
    }

    /// Load an explicit config path. Missing file reads as an empty object.
    pub fn load_at(path: &Path) -> Result<Value, OpencodeConfigError> {
        if !path.exists() {
            return Ok(Value::Object(Default::default()));
        }
        let content =
            std::fs::read_to_string(path).map_err(|e| OpencodeConfigError::Io(e.to_string()))?;
        match serde_json::from_str::<Value>(&content) {
            Ok(value) => Ok(value),
            Err(err) => Self::recover_leading_object(path, &content, err),
        }
    }

    /// Raw file bytes when the file exists.
    pub fn load_raw(workspace: &Path) -> Result<Option<String>, OpencodeConfigError> {
        let path = opencode_config_path(workspace);
        if !path.exists() {
            return Ok(None);
        }
        std::fs::read_to_string(&path).map_err(map_io_err).map(Some)
    }

    /// Read-modify-write under the workspace write lock. The mutator returns
    /// `Ok(true)` when the in-memory value changed and should be persisted.
    pub fn apply<F>(workspace: &Path, mutator: F) -> Result<bool, OpencodeConfigError>
    where
        F: FnOnce(&mut Value) -> Result<bool, OpencodeConfigError>,
    {
        Self::apply_at(&opencode_config_path(workspace), mutator)
    }

    /// [`apply`] against the daemon-owned global config.
    pub fn apply_global<F>(mutator: F) -> Result<bool, OpencodeConfigError>
    where
        F: FnOnce(&mut Value) -> Result<bool, OpencodeConfigError>,
    {
        migrate_legacy_global_config()?;
        Self::apply_at(&global_opencode_config_path(), mutator)
    }

    /// Read-modify-write an explicit config path under its write lock.
    pub fn apply_at<F>(path: &Path, mutator: F) -> Result<bool, OpencodeConfigError>
    where
        F: FnOnce(&mut Value) -> Result<bool, OpencodeConfigError>,
    {
        let write_lock = atomic_write::opencode_write_lock(path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = Self::load_at(path)?;
        if !mutator(&mut config)? {
            return Ok(false);
        }
        Self::write_value_at(path, &config)?;
        Ok(true)
    }

    pub fn write_value(workspace: &Path, value: &Value) -> Result<(), OpencodeConfigError> {
        Self::write_value_locked_at(&opencode_config_path(workspace), value)
    }

    /// [`write_value`] against the daemon-owned global config.
    pub fn write_value_global(value: &Value) -> Result<(), OpencodeConfigError> {
        migrate_legacy_global_config()?;
        Self::write_value_locked_at(&global_opencode_config_path(), value)
    }

    /// Write an explicit config path under its write lock.
    pub fn write_value_locked_at(path: &Path, value: &Value) -> Result<(), OpencodeConfigError> {
        let write_lock = atomic_write::opencode_write_lock(path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        Self::write_value_at(path, value)
    }

    pub fn write_raw(path: &Path, content: &str) -> Result<(), OpencodeConfigError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(map_io_err)?;
        }
        atomic_write::atomic_write(path, content).map_err(map_io_err)
    }

    fn write_value_at(path: &Path, value: &Value) -> Result<(), OpencodeConfigError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(map_io_err)?;
        }
        let mut content = serde_json::to_string_pretty(value)
            .map_err(|e| OpencodeConfigError::Parse(e.to_string()))?;
        if !content.ends_with('\n') {
            content.push('\n');
        }
        atomic_write::atomic_write(path, &content).map_err(map_io_err)
    }

    fn recover_leading_object(
        path: &Path,
        content: &str,
        original_err: serde_json::Error,
    ) -> Result<Value, OpencodeConfigError> {
        let mut stream = serde_json::Deserializer::from_str(content).into_iter::<Value>();
        let recovered = match stream.next() {
            Some(Ok(value)) if value.is_object() => value,
            _ => return Err(OpencodeConfigError::Parse(original_err.to_string())),
        };

        let backup = path.with_extension("json.corrupt.bak");
        if let Err(e) = std::fs::write(&backup, content) {
            warn!(
                path = %path.display(),
                error = %e,
                "opencode_config: failed to back up corrupt config; leaving file untouched"
            );
            return Ok(recovered);
        }

        match serde_json::to_string_pretty(&recovered) {
            Ok(clean) => {
                if let Err(e) = atomic_write::atomic_write(path, &format!("{clean}\n")) {
                    warn!(
                        path = %path.display(),
                        error = %e,
                        "opencode_config: failed to rewrite recovered config"
                    );
                } else {
                    warn!(
                        path = %path.display(),
                        backup = %backup.display(),
                        "opencode_config: recovered corrupt config (trailing bytes dropped); backup saved"
                    );
                }
            }
            Err(e) => warn!(
                path = %path.display(),
                error = %e,
                "opencode_config: could not re-serialize recovered config"
            ),
        }

        Ok(recovered)
    }
}

fn map_io_err(e: std::io::Error) -> OpencodeConfigError {
    OpencodeConfigError::Io(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn isolate_global_config() -> (
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
    fn global_config_is_scoped_to_active_team_state() {
        let (_lock, home, _guard) = isolate_global_config();
        assert_eq!(
            global_opencode_config_path(),
            home.path().join("teams/team-a/state/opencode.json")
        );
    }

    #[test]
    fn applying_global_config_adopts_legacy_root_file() {
        let (_lock, home, _guard) = isolate_global_config();
        let legacy = home.path().join(OPENCODE_JSON);
        fs::write(&legacy, r#"{ "provider": { "mine": {} } }"#).unwrap();

        OpencodeConfigStore::apply_global(|config| {
            config["provider"]["team"] = serde_json::json!({});
            Ok(true)
        })
        .unwrap();

        assert!(!legacy.exists());
        let migrated = fs::read_to_string(global_opencode_config_path()).unwrap();
        assert!(migrated.contains("\"mine\""));
        assert!(migrated.contains("\"team\""));
    }

    #[test]
    fn apply_persists_mutated_object_once() {
        let dir = tempfile::tempdir().unwrap();
        OpencodeConfigStore::apply(dir.path(), |cfg| {
            cfg.as_object_mut().unwrap().insert(
                "permission".to_string(),
                serde_json::json!({ "bash": "ask" }),
            );
            Ok(true)
        })
        .unwrap();

        let loaded = OpencodeConfigStore::load(dir.path()).unwrap();
        assert_eq!(loaded["permission"]["bash"], "ask");
    }

    #[test]
    fn load_recovers_trailing_garbage() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            "{\"mcp\":{}}\n\"trailing\": true",
        )
        .unwrap();
        let loaded = OpencodeConfigStore::load(dir.path()).unwrap();
        assert!(loaded.get("mcp").is_some());
        let on_disk = fs::read_to_string(dir.path().join("opencode.json")).unwrap();
        assert!(!on_disk.contains("trailing"));
    }
}
