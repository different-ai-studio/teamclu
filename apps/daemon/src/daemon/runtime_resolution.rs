use crate::config::DaemonConfig;
use crate::proto::amux;

/// The one runtime this daemon actually runs, derived from `agents.local_agent`.
/// `None` means the configured name is unknown or its backend isn't runnable
/// (e.g. `local_agent = "opencode"` but no `[agents.opencode]` section, or a
/// typo'd name). pi has no config-section dependency — it's always runnable
/// once selected. Adding a new backend here means one match arm, not touching
/// every call site that used to hardcode "pi" vs "everything else opencode".
fn configured_local_agent(config: &DaemonConfig) -> Option<amux::AgentType> {
    match config.agents.local_agent.as_str() {
        "pi" => Some(amux::AgentType::Pi),
        "cursor" => Some(amux::AgentType::Cursor),
        "opencode" => config
            .agents
            .opencode
            .is_some()
            .then_some(amux::AgentType::Opencode),
        "codex" => config
            .agents
            .codex
            .is_some()
            .then_some(amux::AgentType::Codex),
        // No config-section dependency, same as pi: `default_launch_configs()`
        // always carries a ClaudeCode entry (binary "claude"), so the backend is
        // runnable as soon as it is selected. Requiring `[agents.claude_code]`
        // made claude-code unselectable on any machine where auto-discovery had
        // not written that section — which is every fresh install, since
        // `agent_discover` only detects opencode.
        "claude-code" | "claude_code" | "claude" => Some(amux::AgentType::ClaudeCode),
        _ => None,
    }
}

/// Single-agent mode: the runtime configured by `agents.local_agent` is the
/// only supported backend. Any request is rerouted to it with a log line.
/// Legacy `[agents.claude_code]` / `[agents.codex]` config sections are still
/// parsed for back-compat but only make their backend runnable when
/// `local_agent` is actually set to them.
pub(crate) fn resolve_requested_agent_type(
    config: &DaemonConfig,
    requested: amux::AgentType,
) -> amux::AgentType {
    match configured_local_agent(config) {
        Some(active) => {
            if requested != active && requested != amux::AgentType::Unknown {
                tracing::warn!(
                    requested = ?requested,
                    active = ?active,
                    "requested a different backend; rerouting to the configured local agent (single-agent mode)"
                );
            }
            active
        }
        None => {
            tracing::warn!(
                ?requested,
                local_agent = %config.agents.local_agent,
                "configured local_agent is not runnable (unknown name or missing config section)"
            );
            amux::AgentType::Unknown
        }
    }
}

pub(crate) fn runtime_start_initial_model_override(
    start: &crate::proto::teamclu::RuntimeStartRequest,
) -> Option<String> {
    let model_id = start.model_id.trim();
    (!model_id.is_empty()).then(|| model_id.to_string())
}

pub(crate) fn session_message_model_override(
    message: &crate::proto::teamclu::Message,
) -> Option<String> {
    let model_id = message.model.trim();
    (!model_id.is_empty()).then(|| model_id.to_string())
}

/// Map a backend name (as emitted by `supported_agent_type_names` and stored on
/// cron jobs) to its `amux::AgentType`. Returns `None` for unknown/empty names
/// so callers can fall back to the daemon default. Accepts the common aliases
/// for claude-code so it tolerates either wire spelling.
pub(crate) fn agent_type_from_name(name: &str) -> Option<amux::AgentType> {
    match name.trim() {
        "opencode" => Some(amux::AgentType::Opencode),
        "cursor" => Some(amux::AgentType::Cursor),
        "codex" => Some(amux::AgentType::Codex),
        "claude" | "claude_code" | "claude-code" => Some(amux::AgentType::ClaudeCode),
        "pi" => Some(amux::AgentType::Pi),
        _ => None,
    }
}

/// Canonical wire name for an `AgentType`, the inverse of `agent_type_from_name`
/// (using its canonical spelling, not the aliases it also accepts).
fn agent_type_name(agent_type: amux::AgentType) -> Option<&'static str> {
    match agent_type {
        amux::AgentType::Opencode => Some("opencode"),
        amux::AgentType::Codex => Some("codex"),
        amux::AgentType::ClaudeCode => Some("claude-code"),
        amux::AgentType::Pi => Some("pi"),
        amux::AgentType::Cursor => Some("cursor"),
        amux::AgentType::Unknown => None,
    }
}

/// Cloud-facing default backend: the first (single-agent mode: only) supported
/// type. Returns `None` when there are no supported types (caller should skip
/// cloud advertise).
pub(crate) fn default_advertised_agent_type(supported_types: &[String]) -> Option<String> {
    supported_types.first().cloned()
}

/// Single-agent mode: only the configured `agents.local_agent` runtime is
/// advertised, and only when it's actually runnable (see
/// `configured_local_agent`). Legacy `[agents.claude_code]` / `[agents.codex]`
/// sections are accepted in config files but only advertised when
/// `local_agent` selects them.
pub(crate) fn supported_agent_type_names(config: &DaemonConfig) -> Vec<String> {
    if config.agents.local_agent == "cursor" {
        return configured_local_agent(config)
            .map(|_| vec!["cursor".to_string()])
            .unwrap_or_default();
    }
    match configured_local_agent(config).and_then(agent_type_name) {
        Some(name) => vec![name.to_string()],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> DaemonConfig {
        DaemonConfig {
            voice: None,
            actor: crate::config::ActorConfig {
                id: "dev-1".to_string(),
                name: "Mac".to_string(),
            },
            mqtt: crate::config::MqttConfig {
                broker_url: "tcp://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: crate::config::AgentsConfig::default(),
            transport: None,
            team_id: None,
            channels: crate::config::ChannelsConfig::default(),
            idle_runtime_timeout_secs: None,
            max_attachments: None,
            http: None,
            team_share: crate::config::TeamShareConfig::default(),
            log: None,
            locale: None,
        }
    }

    #[test]
    fn resolves_claude_request_to_opencode_when_only_opencode_is_configured() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::ClaudeCode),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn preserves_explicit_non_claude_request() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn resolves_unknown_request_to_opencode_when_only_opencode_is_configured() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Opencode
        );
    }

    #[test]
    fn legacy_requests_reroute_to_opencode_even_when_legacy_sections_present() {
        let mut cfg = base_config();
        // Back-compat: legacy sections still parse but are ignored.
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.codex = Some(crate::config::AgentBackendConfig {
            binary: "codex".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        for requested in [
            amux::AgentType::Unknown,
            amux::AgentType::ClaudeCode,
            amux::AgentType::Codex,
            amux::AgentType::Opencode,
        ] {
            assert_eq!(
                resolve_requested_agent_type(&cfg, requested),
                amux::AgentType::Opencode
            );
        }
    }

    #[test]
    fn legacy_sections_alone_resolve_nothing() {
        // claude/codex config sections no longer make a backend runnable.
        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.codex = Some(crate::config::AgentBackendConfig {
            binary: "codex".to_string(),
            default_flags: Vec::new(),
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
            amux::AgentType::Unknown
        );
    }

    #[test]
    fn runtime_start_model_id_becomes_initial_spawn_override() {
        let start = crate::proto::teamclu::RuntimeStartRequest {
            model_id: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };

        assert_eq!(
            runtime_start_initial_model_override(&start).as_deref(),
            Some("opencode/deepseek-v4-flash-free")
        );
    }

    #[test]
    fn agent_type_from_name_maps_known_backends() {
        assert_eq!(
            agent_type_from_name("opencode"),
            Some(amux::AgentType::Opencode)
        );
        assert_eq!(agent_type_from_name("codex"), Some(amux::AgentType::Codex));
        assert_eq!(
            agent_type_from_name("claude"),
            Some(amux::AgentType::ClaudeCode)
        );
        // claude-code aliases tolerated for either wire spelling.
        assert_eq!(
            agent_type_from_name("claude-code"),
            Some(amux::AgentType::ClaudeCode)
        );
        assert_eq!(
            agent_type_from_name("claude_code"),
            Some(amux::AgentType::ClaudeCode)
        );
    }

    #[test]
    fn agent_type_from_name_returns_none_for_unknown_or_empty() {
        assert_eq!(agent_type_from_name(""), None);
        assert_eq!(agent_type_from_name("gpt"), None);
    }

    #[test]
    fn runtime_start_empty_model_id_has_no_initial_spawn_override() {
        let start = crate::proto::teamclu::RuntimeStartRequest {
            model_id: "   ".to_string(),
            ..Default::default()
        };

        assert_eq!(runtime_start_initial_model_override(&start), None);
    }

    #[test]
    fn session_message_model_becomes_route_override() {
        let message = crate::proto::teamclu::Message {
            model: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };

        assert_eq!(
            session_message_model_override(&message).as_deref(),
            Some("opencode/deepseek-v4-flash-free")
        );
    }

    #[test]
    fn session_message_empty_model_has_no_route_override() {
        let message = crate::proto::teamclu::Message {
            model: "   ".to_string(),
            ..Default::default()
        };

        assert_eq!(session_message_model_override(&message), None);
    }

    #[test]
    fn default_advertised_agent_type_is_first_supported_or_none() {
        // Single-agent mode: `supported_types` holds exactly one entry (the
        // configured local_agent), so the first is the advertised backend.
        assert_eq!(
            default_advertised_agent_type(&["opencode".into()]),
            Some("opencode".into())
        );
        assert_eq!(
            default_advertised_agent_type(&["pi".into()]),
            Some("pi".into())
        );
        assert_eq!(default_advertised_agent_type(&[]), None);
    }

    #[test]
    fn pi_local_agent_resolves_and_advertises_pi() {
        let mut cfg = base_config();
        cfg.agents.local_agent = "pi".to_string();
        // pi does not need an [agents.opencode] section.
        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Pi
        );
        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::ClaudeCode),
            amux::AgentType::Pi
        );
        assert_eq!(supported_agent_type_names(&cfg), vec!["pi".to_string()]);
    }

    #[test]
    fn supported_agent_type_names_is_opencode_only() {
        assert!(supported_agent_type_names(&base_config()).is_empty());

        let mut cfg = base_config();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });
        // Legacy claude section alone advertises nothing.
        assert!(supported_agent_type_names(&cfg).is_empty());

        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });
        assert_eq!(
            supported_agent_type_names(&cfg),
            vec!["opencode".to_string()]
        );
    }

    #[test]
    fn claude_code_local_agent_resolves_and_advertises_claude_code_when_configured() {
        let mut cfg = base_config();
        cfg.agents.local_agent = "claude-code".to_string();
        cfg.agents.claude_code = Some(crate::config::AgentBackendConfig {
            binary: "claude".to_string(),
            default_flags: Vec::new(),
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
            amux::AgentType::ClaudeCode
        );
        assert_eq!(
            supported_agent_type_names(&cfg),
            vec!["claude-code".to_string()]
        );
    }

    #[test]
    fn claude_code_is_selectable_without_a_config_section() {
        // `default_launch_configs()` always carries a ClaudeCode entry, so the
        // backend runs as soon as it is selected — same deal as pi. Requiring
        // `[agents.claude_code]` made it unselectable on a fresh install, where
        // `agent_discover` only ever writes the opencode section.
        for spelling in ["claude-code", "claude_code", "claude"] {
            let mut cfg = base_config();
            cfg.agents.local_agent = spelling.to_string();
            assert!(cfg.agents.claude_code.is_none());

            assert_eq!(
                resolve_requested_agent_type(&cfg, amux::AgentType::Opencode),
                amux::AgentType::ClaudeCode,
                "{spelling} should reroute to claude"
            );
            assert_eq!(
                supported_agent_type_names(&cfg),
                vec!["claude-code".to_string()],
                "{spelling} should advertise the canonical wire name"
            );
        }
    }

    #[test]
    fn codex_local_agent_without_config_section_resolves_to_unknown() {
        // Selecting a backend by name isn't enough — its config section (or,
        // for pi, nothing) must actually back it, or it's not runnable.
        let mut cfg = base_config();
        cfg.agents.local_agent = "codex".to_string();

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Unknown
        );
        assert!(supported_agent_type_names(&cfg).is_empty());
    }

    #[test]
    fn unknown_local_agent_name_resolves_to_unknown() {
        let mut cfg = base_config();
        cfg.agents.local_agent = "some-typo".to_string();
        cfg.agents.opencode = Some(crate::config::AgentBackendConfig {
            binary: "opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        assert_eq!(
            resolve_requested_agent_type(&cfg, amux::AgentType::Unknown),
            amux::AgentType::Unknown
        );
    }

    #[test]
    fn unknown_request_stays_unknown_when_no_backends_configured() {
        assert_eq!(
            resolve_requested_agent_type(&base_config(), amux::AgentType::Unknown),
            amux::AgentType::Unknown
        );
    }
}
