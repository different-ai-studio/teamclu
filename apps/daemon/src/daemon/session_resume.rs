//! Resolve backend session ids from `runtimes.toml` bindings.

use crate::config::{SessionBinding, SessionStore};
use crate::proto::amux;

pub(crate) const BACKEND_SESSION_NOT_RESUMABLE: &str = "BACKEND_SESSION_NOT_RESUMABLE";

/// Binding key lookup for runtimeStart / resume paths.
pub(crate) fn resolve_backend_session_id(
    store: &SessionStore,
    cloud_session_id: &str,
    agent_type: amux::AgentType,
    workspace_id: &str,
) -> Option<String> {
    store
        .lookup(cloud_session_id, workspace_id, agent_type as i32)
        .map(|b| b.acp_session_id.clone())
        .filter(|id| !id.is_empty())
}

pub(crate) fn binding_for(
    store: &SessionStore,
    cloud_session_id: &str,
    agent_type: amux::AgentType,
    workspace_id: &str,
) -> Option<SessionBinding> {
    store
        .lookup(cloud_session_id, workspace_id, agent_type as i32)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SessionBinding;

    #[test]
    fn lookup_returns_acp_for_matching_key() {
        let mut store = SessionStore::default();
        store.upsert(SessionBinding::new(
            "cloud-1",
            "ws-a",
            amux::AgentType::Opencode as i32,
            "acp-a",
        ));
        store.upsert(SessionBinding::new(
            "cloud-1",
            "ws-b",
            amux::AgentType::Opencode as i32,
            "acp-b",
        ));
        assert_eq!(
            resolve_backend_session_id(
                &store,
                "cloud-1",
                amux::AgentType::Opencode,
                "ws-a"
            )
            .as_deref(),
            Some("acp-a")
        );
    }
}
