//! Auto-discover the opencode backend on the host and merge into `daemon.toml`.
//!
//! Single-agent mode: opencode is the only backend probed or registered.
//! Legacy `[agents.claude_code]` / `[agents.codex]` sections in existing
//! config files are still parsed (and preserved on save) but never created
//! here and never advertised. Never overwrite an existing `[agents.opencode]`
//! section.

use std::path::Path;

use tracing::info;

use crate::config::{AgentBackendConfig, DaemonConfig};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DiscoveredAgent {
    pub binary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DiscoverReport {
    pub changed: bool,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode: Option<DiscoveredAgent>,
}

impl DiscoverReport {
    fn skipped() -> Self {
        Self {
            skipped: true,
            ..Default::default()
        }
    }
}

/// Probe the host and fill missing `[agents.*]` entries on `config` in memory.
pub fn discover_and_merge(config: &mut DaemonConfig) -> DiscoverReport {
    if auto_discover_disabled(config) {
        return DiscoverReport::skipped();
    }

    let mut report = DiscoverReport::default();

    if config.agents.opencode.is_none() {
        if let Some((binary, version)) = crate::opencode_install::detect_opencode() {
            config.agents.opencode = Some(AgentBackendConfig {
                binary: binary.clone(),
                default_flags: vec!["acp".to_string()],
            });
            report.opencode = Some(DiscoveredAgent {
                binary,
                version: Some(version),
            });
            report.changed = true;
        }
    }

    if report.changed {
        info!(
            opencode = report.opencode.is_some(),
            "auto-discovered agent backends"
        );
    }

    report
}

/// Merge discoveries into `config` and atomically persist when anything changed.
pub fn discover_and_persist(
    config: &mut DaemonConfig,
    path: &Path,
) -> crate::error::Result<DiscoverReport> {
    let report = discover_and_merge(config);
    if report.changed {
        save_atomically(config, path)?;
        info!(path = %path.display(), "wrote auto-discovered agents to daemon.toml");
    }
    Ok(report)
}

fn auto_discover_disabled(config: &DaemonConfig) -> bool {
    if std::env::var_os("AMUXD_NO_AUTO_DISCOVER").is_some() {
        return true;
    }
    !config.agents.auto_discover
}

fn save_atomically(config: &DaemonConfig, path: &Path) -> crate::error::Result<()> {
    let tmp = path.with_extension("toml.tmp");
    config.save(&tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        crate::error::AmuxError::Config(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ActorConfig, AgentsConfig, DaemonConfig, MqttConfig};

    fn base_config() -> DaemonConfig {
        DaemonConfig {
            voice: None,
            actor: ActorConfig {
                id: "dev-1".to_string(),
                name: "Mac".to_string(),
            },
            mqtt: MqttConfig {
                broker_url: "tcp://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: AgentsConfig::default(),
            transport: None,
            team_id: None,
            channels: Default::default(),
            idle_runtime_timeout_secs: None,
            max_attachments: None,
            http: None,
            team_share: crate::config::TeamShareConfig::default(),
            log: None,
            locale: None,
        }
    }

    #[test]
    fn discover_skipped_when_auto_discover_disabled() {
        let mut cfg = base_config();
        cfg.agents.auto_discover = false;
        let report = discover_and_merge(&mut cfg);
        assert!(report.skipped);
        assert!(!report.changed);
    }

    #[test]
    fn discover_does_not_overwrite_existing_sections() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(AgentBackendConfig {
            binary: "/custom/opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });
        cfg.agents.claude_code = Some(AgentBackendConfig {
            binary: "/custom/claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.codex = Some(AgentBackendConfig {
            binary: "/custom/codex".to_string(),
            default_flags: Vec::new(),
        });
        let report = discover_and_merge(&mut cfg);
        assert!(!report.changed);
        assert_eq!(
            cfg.agents.opencode.as_ref().unwrap().binary,
            "/custom/opencode"
        );
    }

    #[test]
    fn persist_writes_tmp_then_renames() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let mut cfg = base_config();
        cfg.agents.opencode = Some(AgentBackendConfig {
            binary: "/tmp/opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        let report = DiscoverReport {
            changed: true,
            opencode: Some(DiscoveredAgent {
                binary: "/tmp/opencode".into(),
                version: None,
            }),
            ..Default::default()
        };
        save_atomically(&cfg, &path).unwrap();
        assert!(path.exists());
        assert!(!path.with_extension("toml.tmp").exists());

        let loaded = DaemonConfig::load(&path).unwrap();
        assert_eq!(
            loaded.agents.opencode.as_ref().unwrap().binary,
            "/tmp/opencode"
        );
        let _ = report;
    }
}
