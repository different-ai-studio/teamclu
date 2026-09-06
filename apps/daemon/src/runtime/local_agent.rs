//! Which runtime this daemon runs — shared by HTTP (no `daemon` module) and
//! `daemon::runtime_resolution`.

use crate::proto::amux;

/// The one runtime this daemon runs (ADR-0014).
pub const LOCAL_AGENT: amux::AgentType = amux::AgentType::Pi;

/// Wire name for [`LOCAL_AGENT`] (`agents.agent_types`, HTTP `agent_type`).
pub const LOCAL_AGENT_NAME: &str = "pi";

pub fn local_agent_type_name() -> &'static str {
    LOCAL_AGENT_NAME
}

/// Resolve a requested type to the runtime this daemon runs.
///
/// Legacy names (`opencode`, `claude`, …) are rerouted with a warning rather
/// than refused, so stored rows and old HTTP clients keep working.
pub fn resolve_local_agent_type(requested: amux::AgentType) -> amux::AgentType {
    if requested != LOCAL_AGENT && requested != amux::AgentType::Unknown {
        tracing::warn!(
            requested = ?requested,
            "requested a backend this daemon no longer runs; rerouting to pi"
        );
    }
    LOCAL_AGENT
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
            assert_eq!(resolve_local_agent_type(requested), amux::AgentType::Pi);
        }
    }
}
