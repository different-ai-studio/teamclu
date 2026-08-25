use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Persistent `(cloud session, workspace, agent type) → backend session id` map.
/// Lives in `runtimes.toml`. No lifecycle/status — row presence means resumable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionBinding {
    #[serde(default, alias = "session_id", alias = "collab_session_id")]
    pub cloud_session_id: String,
    pub workspace_id: String,
    pub agent_type: i32,
    pub acp_session_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SessionStore {
    #[serde(default, alias = "sessions")]
    pub bindings: Vec<SessionBinding>,
}

/// Legacy on-disk row (pre-binding refactor). Used only for migration.
#[derive(Debug, Clone, Deserialize)]
struct LegacyStoredSession {
    #[serde(default)]
    runtime_id: String,
    #[serde(default)]
    acp_session_id: String,
    #[serde(default, alias = "collab_session_id")]
    session_id: String,
    #[serde(default)]
    agent_type: i32,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    status: i32,
    #[serde(default)]
    created_at: i64,
}

#[derive(Debug, Default, Deserialize)]
struct LegacySessionStore {
    #[serde(default)]
    sessions: Vec<LegacyStoredSession>,
}

impl SessionBinding {
    pub fn new(
        cloud_session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        agent_type: i32,
        acp_session_id: impl Into<String>,
    ) -> Self {
        Self {
            cloud_session_id: cloud_session_id.into(),
            workspace_id: workspace_id.into(),
            agent_type,
            acp_session_id: acp_session_id.into(),
        }
    }

    fn composite_key(&self) -> (String, String, i32) {
        (
            self.cloud_session_id.clone(),
            self.workspace_id.clone(),
            self.agent_type,
        )
    }
}

impl SessionStore {
    #[allow(dead_code)]
    pub fn default_path() -> PathBuf {
        super::layout::active_state_dir().join("runtimes.toml")
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;

        // Legacy `[[sessions]]` rows must go through migration dedup even when
        // they deserialize via the `sessions` alias on `bindings`.
        if content.contains("[[sessions]]") {
            let legacy: LegacySessionStore = toml::from_str(&content).map_err(|e| {
                crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
            })?;
            return Ok(Self::from_legacy_rows(legacy.sessions));
        }

        let store: SessionStore = toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })?;
        Ok(store.deduped())
    }

    /// Collapse duplicate composite keys (last row wins). Safety net for hand-edited files.
    fn deduped(self) -> Self {
        let mut by_key: HashMap<(String, String, i32), SessionBinding> = HashMap::new();
        for binding in self.bindings {
            by_key.insert(binding.composite_key(), binding);
        }
        Self {
            bindings: by_key.into_values().collect(),
        }
    }

    fn from_legacy_rows(rows: Vec<LegacyStoredSession>) -> Self {
        let mut grouped: HashMap<(String, String, i32), Vec<&LegacyStoredSession>> =
            HashMap::new();
        for row in &rows {
            let session_id = if !row.session_id.is_empty() {
                row.session_id.clone()
            } else {
                row.runtime_id.clone()
            };
            if session_id.is_empty() || row.workspace_id.is_empty() {
                continue;
            }
            grouped
                .entry((session_id, row.workspace_id.clone(), row.agent_type))
                .or_default()
                .push(row);
        }

        let mut bindings = Vec::new();
        for ((cloud_session_id, workspace_id, agent_type), mut group) in grouped {
            group.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            let Some(acp_session_id) = group
                .iter()
                .find_map(|row| {
                    if row.acp_session_id.is_empty() {
                        None
                    } else {
                        Some(row.acp_session_id.clone())
                    }
                })
            else {
                continue;
            };
            bindings.push(SessionBinding {
                cloud_session_id,
                workspace_id,
                agent_type,
                acp_session_id,
            });
        }
        Self { bindings }
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn upsert(&mut self, binding: SessionBinding) {
        let key = binding.composite_key();
        if let Some(existing) = self
            .bindings
            .iter_mut()
            .find(|b| b.composite_key() == key)
        {
            *existing = binding;
        } else {
            self.bindings.push(binding);
        }
    }

    pub fn lookup(
        &self,
        cloud_session_id: &str,
        workspace_id: &str,
        agent_type: i32,
    ) -> Option<&SessionBinding> {
        self.bindings.iter().find(|b| {
            b.cloud_session_id == cloud_session_id
                && b.workspace_id == workspace_id
                && b.agent_type == agent_type
        })
    }

    pub fn all_for_session(&self, cloud_session_id: &str) -> Vec<&SessionBinding> {
        self.bindings
            .iter()
            .filter(|b| b.cloud_session_id == cloud_session_id)
            .collect()
    }

    pub fn delete(&mut self, cloud_session_id: &str, workspace_id: &str, agent_type: i32) {
        self.bindings.retain(|b| {
            !(b.cloud_session_id == cloud_session_id
                && b.workspace_id == workspace_id
                && b.agent_type == agent_type)
        });
    }

    pub fn delete_for_session(&mut self, cloud_session_id: &str) {
        self.bindings
            .retain(|b| b.cloud_session_id != cloud_session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_keeps_composite_key_unique() {
        let mut store = SessionStore::default();
        store.upsert(SessionBinding::new("s1", "ws-a", 1, "acp-1"));
        store.upsert(SessionBinding::new("s1", "ws-a", 1, "acp-2"));
        assert_eq!(store.bindings.len(), 1);
        assert_eq!(store.lookup("s1", "ws-a", 1).unwrap().acp_session_id, "acp-2");
    }

    #[test]
    fn migrate_legacy_stopped_row_is_resurrected() {
        let legacy = LegacySessionStore {
            sessions: vec![LegacyStoredSession {
                runtime_id: "rt-1".into(),
                acp_session_id: "acp-old".into(),
                session_id: "cloud-1".into(),
                agent_type: 3,
                workspace_id: "ws-a".into(),
                status: crate::proto::amux::AgentStatus::Stopped as i32,
                created_at: 10,
            }],
        };
        let store = SessionStore::from_legacy_rows(legacy.sessions);
        assert_eq!(store.bindings.len(), 1);
        assert_eq!(store.lookup("cloud-1", "ws-a", 3).unwrap().acp_session_id, "acp-old");
    }

    #[test]
    fn migrate_legacy_picks_newest_non_empty_acp_for_same_key() {
        let legacy = LegacySessionStore {
            sessions: vec![
                LegacyStoredSession {
                    runtime_id: "old".into(),
                    acp_session_id: "acp-old".into(),
                    session_id: "cloud-1".into(),
                    agent_type: 3,
                    workspace_id: "ws-a".into(),
                    status: 0,
                    created_at: 1,
                },
                LegacyStoredSession {
                    runtime_id: "new".into(),
                    acp_session_id: "acp-new".into(),
                    session_id: "cloud-1".into(),
                    agent_type: 3,
                    workspace_id: "ws-a".into(),
                    status: 0,
                    created_at: 5,
                },
            ],
        };
        let store = SessionStore::from_legacy_rows(legacy.sessions);
        assert_eq!(store.bindings.len(), 1);
        assert_eq!(
            store.lookup("cloud-1", "ws-a", 3).unwrap().acp_session_id,
            "acp-new"
        );
    }

    #[test]
    fn migrate_legacy_skips_group_with_empty_acp() {
        let legacy = LegacySessionStore {
            sessions: vec![LegacyStoredSession {
                runtime_id: "rt".into(),
                acp_session_id: String::new(),
                session_id: "cloud-1".into(),
                agent_type: 3,
                workspace_id: "ws-a".into(),
                status: 0,
                created_at: 1,
            }],
        };
        let store = SessionStore::from_legacy_rows(legacy.sessions);
        assert!(store.bindings.is_empty());
    }

    #[test]
    fn load_legacy_sessions_alias_runs_migration_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtimes.toml");
        std::fs::write(
            &path,
            r#"
[[sessions]]
runtime_id = "old"
session_id = "cloud-1"
agent_type = 3
workspace_id = "ws-a"
acp_session_id = "acp-old"
created_at = 1

[[sessions]]
runtime_id = "new"
session_id = "cloud-1"
agent_type = 3
workspace_id = "ws-a"
acp_session_id = "acp-new"
created_at = 5
"#,
        )
        .unwrap();
        let store = SessionStore::load(&path).unwrap();
        assert_eq!(store.bindings.len(), 1);
        assert_eq!(
            store.lookup("cloud-1", "ws-a", 3).unwrap().acp_session_id,
            "acp-new"
        );
    }

    #[test]
    fn delete_for_session_removes_all_workspace_rows() {
        let mut store = SessionStore::default();
        store.upsert(SessionBinding::new("s1", "ws-a", 1, "acp-a"));
        store.upsert(SessionBinding::new("s1", "ws-b", 1, "acp-b"));
        store.upsert(SessionBinding::new("s2", "ws-a", 1, "acp-c"));
        store.delete_for_session("s1");
        assert_eq!(store.bindings.len(), 1);
        assert_eq!(store.bindings[0].cloud_session_id, "s2");
    }
}
