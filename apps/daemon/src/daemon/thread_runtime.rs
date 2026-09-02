//! Lazy thread fork: resume a backend session branched at an anchor
//! agent_reply when a thread session first calls runtimeStart.

use std::sync::Arc;

use tracing::warn;

use crate::backend::Backend;
use crate::config::SessionStore;
use crate::daemon::server::StartRuntimeError;
use crate::proto::amux;
use crate::runtime::backend::{AgentBackend, ForkSpec};
use crate::daemon::session_resume::resolve_parent_binding_for_fork;
use crate::runtime::execution_context::{ExecutionContext, ProcessEnvRevision};

#[derive(Debug, Clone)]
pub(crate) struct ThreadForkParams {
    pub thread_session_id: String,
    pub parent_session_id: String,
    pub root_message_id: String,
    pub workspace_id: String,
    pub worktree: String,
    pub agent_type: amux::AgentType,
}

fn parse_pi_leaf_from_metadata(metadata_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|v| {
            v.pointer("/backend_session/fork_point/pi_leaf_id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.is_empty())
}

fn parse_opencode_message_id_from_metadata(metadata_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|v| {
            v.pointer("/backend_session/fork_point/opencode_message_id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.is_empty())
}

/// Fork parent backend session at anchor; returns new acp session id for resume attach.
pub(crate) async fn fork_thread_binding(
    sessions: &SessionStore,
    backend: &Arc<dyn Backend>,
    agent_backend: &mut dyn AgentBackend,
    context: &ExecutionContext,
    params: &ThreadForkParams,
) -> Result<String, StartRuntimeError> {
    let parent_binding = resolve_parent_binding_for_fork(
        sessions,
        &params.parent_session_id,
        &params.workspace_id,
        params.agent_type,
    )
    .ok_or_else(|| {
        StartRuntimeError::new(
            "PARENT_RUNTIME_NEVER_ATTACHED",
            "parent session has no backend binding to fork from",
            "thread_fork",
        )
    })?;

    let (fork_leaf_id, fork_opencode_message_id) =
        resolve_fork_anchor(backend, params).await.ok_or_else(|| {
            StartRuntimeError::new(
                "THREAD_FORK_ANCHOR_MISSING",
                format!(
                    "no fork anchor metadata for message {}",
                    params.root_message_id
                ),
                "thread_fork",
            )
        })?;

    let ExecutionContext {
        isolation_domain,
        workspace: _,
        working_directory: _,
        spawn_env,
    } = context;
    let process_env_revision = ProcessEnvRevision::from_bindings(&spawn_env.extra_env);
    let spec = ForkSpec {
        parent_acp_session_id: parent_binding.acp_session_id.clone(),
        parent_teamclu_session_id: params.parent_session_id.clone(),
        root_message_id: params.root_message_id.clone(),
        worktree: params.worktree.clone(),
        fork_leaf_id,
        fork_opencode_message_id,
        isolation_domain: isolation_domain.clone(),
        process_env_revision,
        extra_env: spawn_env.extra_env.clone(),
        force_env_override: spawn_env.force_env_override,
    };

    agent_backend
        .fork_session_at(spec)
        .await
        .map_err(|e| {
            StartRuntimeError::new("THREAD_FORK_FAILED", e.to_string(), "thread_fork")
        })
}

async fn resolve_fork_anchor(
    backend: &Arc<dyn Backend>,
    params: &ThreadForkParams,
) -> Option<(Option<String>, Option<String>)> {
    let messages = backend
        .messages_after_cursor(&params.parent_session_id, None)
        .await
        .unwrap_or_else(|e| {
            warn!(
                parent_session_id = %params.parent_session_id,
                error = %e,
                "thread fork: failed to load parent messages for anchor metadata"
            );
            Vec::new()
        });

    for msg in messages {
        if msg.id != params.root_message_id {
            continue;
        }
        return match params.agent_type {
            amux::AgentType::Pi => parse_pi_leaf_from_metadata(&msg.metadata_json)
                .map(|leaf| (Some(leaf), None)),
            amux::AgentType::Opencode => {
                parse_opencode_message_id_from_metadata(&msg.metadata_json)
                    .map(|message_id| (None, Some(message_id)))
            }
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pi_leaf_from_backend_session_metadata() {
        let md = r#"{"backend_session":{"kind":"pi","fork_point":{"pi_leaf_id":"abc123"}}}"#;
        assert_eq!(
            parse_pi_leaf_from_metadata(md).as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn parses_opencode_message_id_from_backend_session_metadata() {
        let md = r#"{"backend_session":{"kind":"opencode","fork_point":{"opencode_message_id":"msg_abc"}}}"#;
        assert_eq!(
            parse_opencode_message_id_from_metadata(md).as_deref(),
            Some("msg_abc")
        );
    }
}
