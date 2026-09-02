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

/// Parent session binding for thread fork. Tries the thread's workspace first, then
/// any binding row for the parent session (parent may have run under another workspace).
pub(crate) fn resolve_parent_binding_for_fork(
    store: &SessionStore,
    parent_session_id: &str,
    preferred_workspace_id: &str,
    agent_type: amux::AgentType,
) -> Option<SessionBinding> {
    if !preferred_workspace_id.is_empty() {
        if let Some(binding) = binding_for(
            store,
            parent_session_id,
            agent_type,
            preferred_workspace_id,
        ) {
            return Some(binding);
        }
    }
    store
        .all_for_session(parent_session_id)
        .into_iter()
        .filter(|b| {
            b.agent_type == agent_type as i32 && !b.acp_session_id.trim().is_empty()
        })
        .next_back()
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

    #[test]
    fn parent_binding_for_fork_falls_back_to_other_workspace() {
        let mut store = SessionStore::default();
        store.upsert(SessionBinding::new(
            "parent-1",
            "ws-parent",
            amux::AgentType::Opencode as i32,
            "acp-parent",
        ));
        let binding = resolve_parent_binding_for_fork(
            &store,
            "parent-1",
            "ws-thread",
            amux::AgentType::Opencode,
        )
        .expect("parent binding");
        assert_eq!(binding.workspace_id, "ws-parent");
        assert_eq!(binding.acp_session_id, "acp-parent");
    }
}
