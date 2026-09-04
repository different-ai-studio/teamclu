//! Which runtime a request runs on, and what this daemon advertises.
//!
//! There is one answer: pi (#1247). Every client, stored session, cron job and
//! cloud row that names another `AgentType` still resolves here — to pi, with
//! a log line — because most of the data the daemon meets was written when
//! there were four runtimes (`agents.default_agent_type = 'opencode'` is the
//! common case on the cloud, and every desktop before this change sent the
//! type it computed). Rejecting those would brick every existing agent on
//! upgrade; coercing them is the migration.
//!
//! This is deliberately the only place that decides, so nothing else in the
//! daemon needs a `match agent_type` to know what it runs.

use crate::proto::amux;

/// The one runtime this daemon runs.
pub(crate) const LOCAL_AGENT: amux::AgentType = amux::AgentType::Pi;

/// The public name of [`LOCAL_AGENT`], as the cloud `agents.agent_types` row
/// and the model-catalog grouping spell it.
pub(crate) const LOCAL_AGENT_NAME: &str = "pi";

/// Resolve a requested type to the runtime this daemon runs.
///
/// Anything other than pi (or Unknown, which means "you pick") is rerouted
/// with a warning rather than refused — see the module docs.
pub(crate) fn resolve_requested_agent_type(requested: amux::AgentType) -> amux::AgentType {
    if requested != LOCAL_AGENT && requested != amux::AgentType::Unknown {
        tracing::warn!(
            requested = ?requested,
            "requested a backend this daemon no longer runs; rerouting to pi"
        );
    }
    LOCAL_AGENT
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
    let model = message.model.trim();
    (!model.is_empty()).then(|| model.to_string())
}

/// Map a stored backend name onto its `AgentType`. Cron jobs and old runtime
/// rows carry these; the result is still fed through
/// [`resolve_requested_agent_type`], so a legacy name lands on pi rather than
/// failing.
pub(crate) fn agent_type_from_name(name: &str) -> Option<amux::AgentType> {
    match name.trim() {
        "pi" => Some(amux::AgentType::Pi),
        "opencode" => Some(amux::AgentType::Opencode),
        "claude" | "claude-code" | "claude_code" => Some(amux::AgentType::ClaudeCode),
        "codex" => Some(amux::AgentType::Codex),
        "cursor" => Some(amux::AgentType::Cursor),
        _ => None,
    }
}

/// What this device advertises as the default on its cloud `agents` row.
pub(crate) fn default_advertised_agent_type(supported_types: &[String]) -> Option<String> {
    supported_types.first().cloned()
}

/// The backend names this daemon advertises: exactly one.
pub(crate) fn supported_agent_type_names() -> Vec<String> {
    vec![LOCAL_AGENT_NAME.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_request_resolves_to_pi() {
        for requested in [
            amux::AgentType::Unknown,
            amux::AgentType::Pi,
            amux::AgentType::Opencode,
            amux::AgentType::ClaudeCode,
            amux::AgentType::Codex,
            amux::AgentType::Cursor,
        ] {
            assert_eq!(resolve_requested_agent_type(requested), amux::AgentType::Pi);
        }
    }

    #[test]
    fn only_pi_is_advertised_and_it_is_the_default() {
        let supported = supported_agent_type_names();
        assert_eq!(supported, vec!["pi".to_string()]);
        assert_eq!(
            default_advertised_agent_type(&supported).as_deref(),
            Some("pi")
        );
        assert_eq!(default_advertised_agent_type(&[]), None);
    }

    #[test]
    fn legacy_backend_names_still_parse_so_they_can_be_rerouted() {
        // A cron job created for opencode must run (on pi), not fail to parse.
        assert_eq!(
            agent_type_from_name("opencode"),
            Some(amux::AgentType::Opencode)
        );
        assert_eq!(
            resolve_requested_agent_type(agent_type_from_name("opencode").unwrap()),
            amux::AgentType::Pi
        );
        assert_eq!(agent_type_from_name("pi"), Some(amux::AgentType::Pi));
        assert_eq!(
            agent_type_from_name("claude-code"),
            Some(amux::AgentType::ClaudeCode)
        );
        assert_eq!(agent_type_from_name(""), None);
        assert_eq!(agent_type_from_name("typo"), None);
    }

    #[test]
    fn runtime_start_model_id_becomes_initial_spawn_override() {
        let start = crate::proto::teamclu::RuntimeStartRequest {
            model_id: " openai/gpt-5 ".to_string(),
            ..Default::default()
        };
        assert_eq!(
            runtime_start_initial_model_override(&start).as_deref(),
            Some("openai/gpt-5")
        );
        let blank = crate::proto::teamclu::RuntimeStartRequest::default();
        assert_eq!(runtime_start_initial_model_override(&blank), None);
    }

    #[test]
    fn session_message_model_becomes_route_override() {
        let message = crate::proto::teamclu::Message {
            model: "anthropic/claude-sonnet-5".to_string(),
            ..Default::default()
        };
        assert_eq!(
            session_message_model_override(&message).as_deref(),
            Some("anthropic/claude-sonnet-5")
        );
        let blank = crate::proto::teamclu::Message::default();
        assert_eq!(session_message_model_override(&blank), None);
    }
}
