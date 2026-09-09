//! Agent turn cancellation and session restart, extracted from `manager.rs`.
//!
//! Cancel the in-flight ACP turn for an agent (by daemon `agent_id` or by ACP
//! session uuid), or restart a session by stopping its runtime so the next
//! prompt re-spawns a fresh one.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the private `agents` map directly.

use super::RuntimeManager;

impl RuntimeManager {
    /// Cancel the current turn for an agent.
    pub async fn cancel_agent(&mut self, agent_id: &str) -> crate::error::Result<()> {
        let acp_session_id = self
            .agents
            .get(agent_id)
            .ok_or_else(|| crate::error::AmuxError::Agent(format!("agent {} not found", agent_id)))?
            .acp_session_id
            .clone();
        crate::runtime::agent_trace::log_runtime_cancel(agent_id, &acp_session_id);
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;

        handle.cancel().await
    }

    /// Cancel the in-flight turn for the agent identified by `acp_sid`
    /// (the 36-char uuid stored on `RuntimeHandle.acp_session_id`).
    /// Used by `AmuxdAgentHandle::cancel` to translate a gateway-side logical
    /// id (resolved via `logical_to_acp`) into a runtime handle without
    /// the gateway needing to know about the daemon's 8-char `agent_id`.
    pub async fn cancel_by_acp_session(&mut self, acp_sid: &str) -> crate::error::Result<()> {
        let agent_id = self.agent_id_by_acp_session(acp_sid).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("no runtime for acp_session_id {acp_sid}"))
        })?;
        let handle = self.agents.get(&agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("handle missing for agent_id {agent_id}"))
        })?;
        handle.cancel().await
    }

    /// ACP cancel does not flip occupancy. A hung bash stays `Active`, so
    /// `workspace_has_active_turn` keeps refusing reload / the next prompt.
    /// After a driver has given up, cancel first; if the handle is still a
    /// mid-turn occupant, stop it so the next message can spawn fresh.
    pub async fn release_after_abandoned_turn(&mut self, agent_id: &str) {
        if let Err(e) = self.cancel_agent(agent_id).await {
            tracing::warn!(
                agent_id,
                error = %e,
                "cancel after abandoned turn failed"
            );
        }
        let still_occupying = self.agents.get(agent_id).is_some_and(|h| {
            matches!(h.status, crate::proto::amux::AgentStatus::Active) || h.event_rx.is_none()
        });
        if still_occupying {
            tracing::warn!(
                agent_id,
                "abandoned turn still occupying workspace; stopping runtime"
            );
            let _ = self.stop_runtime(agent_id).await;
        }
    }

    pub async fn restart_session(&mut self, agent_id: &str) -> crate::error::Result<()> {
        if self.stop_runtime(agent_id).await.is_some() {
            Ok(())
        } else {
            Err(crate::error::AmuxError::Agent(format!(
                "agent {} not found",
                agent_id
            )))
        }
    }
}
