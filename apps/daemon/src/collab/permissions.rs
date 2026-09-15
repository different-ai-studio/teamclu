use crate::proto::amux;
use std::collections::{HashMap, HashSet};

pub struct PermissionManager {
    pending: HashSet<String>,
    resolved: HashSet<String>,
    pending_by_session: HashMap<String, HashSet<String>>,
}

impl PermissionManager {
    pub fn new() -> Self {
        Self {
            pending: HashSet::new(),
            resolved: HashSet::new(),
            pending_by_session: HashMap::new(),
        }
    }

    pub fn check_command_permission(
        &self,
        role: amux::MemberRole,
        command: &amux::acp_command::Command,
    ) -> Result<(), String> {
        match command {
            amux::acp_command::Command::StartAgent(_)
            | amux::acp_command::Command::StopAgent(_) => {
                if role != amux::MemberRole::Owner {
                    return Err("permission denied: owner only".into());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn check_agent_busy(&self, status: amux::AgentStatus) -> Result<(), String> {
        if status == amux::AgentStatus::Active {
            return Err("agent is busy".into());
        }
        Ok(())
    }

    pub fn register_pending(&mut self, request_id: &str, session_id: &str) {
        let request_id = request_id.trim();
        let session_id = session_id.trim();
        if request_id.is_empty() || session_id.is_empty() {
            return;
        }
        self.pending.insert(request_id.to_string());
        self.pending_by_session
            .entry(session_id.to_string())
            .or_default()
            .insert(request_id.to_string());
    }

    pub fn try_resolve_permission(&mut self, request_id: &str) -> bool {
        let request_id = request_id.trim();
        if request_id.is_empty() {
            return false;
        }
        self.pending.remove(request_id);
        for ids in self.pending_by_session.values_mut() {
            ids.remove(request_id);
        }
        self.pending_by_session.retain(|_, ids| !ids.is_empty());
        self.resolved.insert(request_id.to_string())
    }

    pub fn session_has_pending(&self, session_id: &str) -> bool {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return false;
        }
        self.pending_by_session
            .get(session_id)
            .is_some_and(|ids| !ids.is_empty())
    }

    /// Pending permission ids for a session when its attachment is torn down.
    pub fn take_pending_for_session(&mut self, session_id: &str) -> Vec<String> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Vec::new();
        }
        let Some(ids) = self.pending_by_session.remove(session_id) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if self.pending.remove(&id) {
                out.push(id);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn start_agent_cmd() -> amux::acp_command::Command {
        amux::acp_command::Command::StartAgent(amux::AcpStartAgent {
            workspace_id: "ws".into(),
            ..Default::default()
        })
    }

    fn stop_agent_cmd() -> amux::acp_command::Command {
        amux::acp_command::Command::StopAgent(amux::AcpStopAgent {})
    }

    fn send_prompt_cmd() -> amux::acp_command::Command {
        amux::acp_command::Command::SendPrompt(amux::AcpSendPrompt {
            text: "hi".into(),
            ..Default::default()
        })
    }

    #[test]
    fn owner_can_start_agent() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Owner, &start_agent_cmd())
            .is_ok());
    }

    #[test]
    fn member_cannot_start_agent() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Member, &start_agent_cmd())
            .is_err());
    }

    #[test]
    fn member_cannot_stop_agent() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Member, &stop_agent_cmd())
            .is_err());
    }

    #[test]
    fn member_can_send_prompt() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Member, &send_prompt_cmd())
            .is_ok());
    }

    #[test]
    fn active_agent_is_busy() {
        let pm = PermissionManager::new();
        assert!(pm.check_agent_busy(amux::AgentStatus::Active).is_err());
    }

    #[test]
    fn idle_agent_not_busy() {
        let pm = PermissionManager::new();
        assert!(pm.check_agent_busy(amux::AgentStatus::Idle).is_ok());
    }

    #[test]
    fn pending_and_resolve_flow() {
        let mut pm = PermissionManager::new();
        pm.register_pending("req-1", "sess-1");
        assert!(pm.try_resolve_permission("req-1"));
        assert!(!pm.try_resolve_permission("req-1"));
    }

    #[test]
    fn take_pending_for_session_drains_only_that_session() {
        let mut pm = PermissionManager::new();
        pm.register_pending("req-1", "sess-1");
        pm.register_pending("req-2", "sess-2");
        let drained = pm.take_pending_for_session("sess-1");
        assert_eq!(drained, vec!["req-1".to_string()]);
        assert_eq!(pm.take_pending_for_session("sess-1"), Vec::<String>::new());
        assert_eq!(pm.take_pending_for_session("sess-2"), vec!["req-2".to_string()]);
    }

    #[test]
    fn resolve_unknown_id_returns_true_first_time() {
        let mut pm = PermissionManager::new();
        assert!(pm.try_resolve_permission("unknown"));
    }
}
