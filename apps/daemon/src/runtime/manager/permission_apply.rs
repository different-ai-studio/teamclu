//! Session permission policy updates without respawning the pi host.

use crate::runtime::backend;
use crate::runtime::permission_policy::PermissionPolicy;

use super::RuntimeManager;

impl RuntimeManager {
    /// Forward a permission-policy change to the pi route for this session.
    pub async fn set_session_permission_policy(
        &mut self,
        teamclu_session_id: &str,
        permission: PermissionPolicy,
    ) -> crate::error::Result<Vec<String>> {
        #[cfg(test)]
        {
            if !self.agents.contains_key(teamclu_session_id) {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    teamclu_session_id
                )));
            }
            let _ = permission;
            return Ok(Vec::new());
        }

        #[cfg(not(test))]
        let handle = self.agents.get(teamclu_session_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", teamclu_session_id))
        })?;
        #[cfg(not(test))]
        let acp_session_id = handle.acp_session_id.clone();
        #[cfg(not(test))]
        if acp_session_id.trim().is_empty() {
            return Err(crate::error::AmuxError::Agent(
                "session has no acp_session_id yet".into(),
            ));
        }
        #[cfg(not(test))]
        let tx = handle
            .cmd_tx
            .as_ref()
            .ok_or_else(|| crate::error::AmuxError::Agent("no ACP command channel".into()))?;
        #[cfg(not(test))]
        let (cleared_tx, cleared_rx) = tokio::sync::oneshot::channel();
        #[cfg(not(test))]
        tx.send(backend::AcpCommand::SetSessionPermission {
            acp_session_id,
            permission,
            cleared_tx: Some(cleared_tx),
        })
        .await
        .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))?;
        #[cfg(not(test))]
        match tokio::time::timeout(std::time::Duration::from_secs(5), cleared_rx).await {
            Ok(Ok(ids)) => Ok(ids),
            Ok(Err(_)) => Err(crate::error::AmuxError::Agent(
                "session permission policy ack channel closed before reply".into(),
            )),
            Err(_) => {
                tracing::warn!(
                    teamclu_session_id,
                    "timed out waiting for session permission policy ack"
                );
                Err(crate::error::AmuxError::Agent(
                    "timed out waiting for session permission policy ack".into(),
                ))
            }
        }
    }
}
