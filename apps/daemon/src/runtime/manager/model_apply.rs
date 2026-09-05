//! Model switching, extracted from `manager.rs`.
//!
//! Forward a `SetModel` onto an agent's ACP command channel and mirror the
//! choice into the daemon-side `agent_state` so the retained
//! `runtime/{id}/state` reflects it immediately. `maybe_apply_model` is the
//! idempotent variant used on the spawn/route path.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the private `agents` map directly.

use crate::runtime::backend;

use super::RuntimeManager;

impl RuntimeManager {
    /// Public wrapper used by the SetModel RPC handler. Forwards to the
    /// adapter and immediately mirrors the choice into `agent_state` so the
    /// actor snapshot on `{actor}/state` reflects the request without waiting
    /// for an out-of-band ack from the adapter.
    ///
    /// `runtime_id` must already be a spawn key — the RPC handler resolves the
    /// client-facing address (session id / `{actor}::{session}`) via
    /// `resolve_command_agent_id` before calling this.
    pub async fn set_model(
        &mut self,
        runtime_id: &str,
        model_id: &str,
    ) -> crate::error::Result<()> {
        self.send_set_model(runtime_id, model_id).await?;
        self.set_current_model(runtime_id, model_id);
        Ok(())
    }

    /// Apply `desired_model` when it differs from the runtime's current model.
    /// Returns true when a new model was forwarded to ACP.
    pub async fn maybe_apply_model(&mut self, runtime_id: &str, desired_model: &str) -> bool {
        let desired = desired_model.trim();
        if desired.is_empty() {
            return false;
        }
        let current = self.current_model(runtime_id).cloned().unwrap_or_default();
        if desired == current {
            return false;
        }
        match self.set_model(runtime_id, desired).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    runtime_id,
                    model_id = desired,
                    "maybe_apply_model failed: {e}"
                );
                false
            }
        }
    }

    /// Forward a `SetModel` command onto the agent's ACP command channel.
    /// The adapter is responsible for performing `session/set_model`; the
    /// caller is responsible for updating `agent_state` once the
    /// command has been queued (we cannot wait for the adapter to confirm
    /// without changing the channel contract).
    pub async fn send_set_model(
        &mut self,
        agent_id: &str,
        model_id: &str,
    ) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            if !self.agents.contains_key(agent_id) {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    agent_id
                )));
            }
            let _ = model_id;
            return Ok(());
        }

        #[cfg(not(test))]
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;
        #[cfg(not(test))]
        let tx = handle
            .cmd_tx
            .as_ref()
            .ok_or_else(|| crate::error::AmuxError::Agent("no ACP command channel".into()))?;
        #[cfg(not(test))]
        tx.send(backend::AcpCommand::SetModel {
            acp_session_id: handle.acp_session_id.clone(),
            model_id: model_id.to_string(),
        })
        .await
        .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
    }
}
