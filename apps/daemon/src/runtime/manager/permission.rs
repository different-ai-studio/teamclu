//! Permission-response routing, extracted from `manager.rs`.
//!
//! Desktop clients grant/deny an agent's pending ACP permission request by
//! runtime id. The id may be stale (an old MQTT retain), so these helpers map
//! it back to a live runtime before forwarding the response to the handle.
//!
//! This is a child module of `runtime::manager`, so the `impl RuntimeManager`
//! block reaches the manager's private `agents` map (and the test-only
//! `permission_log`) directly.

use crate::proto::amux;

use super::RuntimeManager;

impl RuntimeManager {
    /// Reply to a pending permission request for an agent.
    pub async fn reply_permission(
        &mut self,
        agent_id: &str,
        request_id: &str,
        granted: bool,
        option_id: Option<String>,
    ) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            if !self.agents.contains_key(agent_id) {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    agent_id
                )));
            }
            self.permission_log.push((request_id.to_string(), granted));
            return Ok(());
        }

        #[cfg(not(test))]
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;
        #[cfg(not(test))]
        handle
            .resolve_permission(request_id, granted, option_id)
            .await
    }

    /// Backward-compatible alias for older call sites that still speak
    /// in terms of permission resolution.
    pub async fn resolve_permission(
        &mut self,
        agent_id: &str,
        request_id: &str,
        granted: bool,
        option_id: Option<String>,
    ) -> crate::error::Result<()> {
        self.reply_permission(agent_id, request_id, granted, option_id)
            .await
    }

    /// Answer (or reject) a pending opencode `question` tool request,
    /// retargeting stale topic runtime ids like permission responses.
    pub async fn answer_question_for_topic(
        &mut self,
        topic_runtime_id: &str,
        request_id: &str,
        answers_json: &str,
        reject: bool,
        answered_by: &str,
    ) -> crate::error::Result<()> {
        let agent_key = self
            .resolve_permission_runtime_key(topic_runtime_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", topic_runtime_id))
            })?;
        #[cfg(test)]
        {
            let _ = (request_id, answers_json, reject, answered_by, agent_key);
            return Ok(());
        }
        #[cfg(not(test))]
        {
            let handle = self.agents.get(&agent_key).ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", agent_key))
            })?;
            handle
                .answer_question(request_id, answers_json, reject, answered_by)
                .await
        }
    }

    /// Map a command-topic runtime id to a live agent key. Desktop clients can
    /// target a stale spawn id from an old MQTT retain; when exactly one
    /// active runtime exists, route the grant/deny there instead.
    pub fn resolve_permission_runtime_key(&self, topic_runtime_id: &str) -> Option<String> {
        if self.agents.contains_key(topic_runtime_id) {
            return Some(topic_runtime_id.to_string());
        }
        let active: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| {
                matches!(
                    h.status,
                    amux::AgentStatus::Starting
                        | amux::AgentStatus::Active
                        | amux::AgentStatus::Idle
                )
            })
            .map(|(id, _)| id.clone())
            .collect();
        if active.len() == 1 {
            return Some(active[0].clone());
        }
        None
    }

    /// Like [`resolve_permission`] but retargets stale topic runtime ids.
    pub async fn resolve_permission_for_topic(
        &mut self,
        topic_runtime_id: &str,
        request_id: &str,
        granted: bool,
        option_id: Option<String>,
    ) -> crate::error::Result<()> {
        let agent_key = self
            .resolve_permission_runtime_key(topic_runtime_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", topic_runtime_id))
            })?;
        if agent_key != topic_runtime_id {
            tracing::warn!(
                requested_runtime_id = topic_runtime_id,
                resolved_runtime_id = %agent_key,
                "permission response retargeted to active runtime"
            );
        }
        self.resolve_permission(&agent_key, request_id, granted, option_id)
            .await
    }
}
