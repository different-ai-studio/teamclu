//! Workspace-scoped runtime queries, extracted from `manager.rs`.
//!
//! Find or stop the runtimes bound to a given workspace (matched by either the
//! worktree path or the workspace id). Used by the supervisor after a settings
//! reload. Pure reads of the manager's private `agents` map plus `stop_runtime`.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches `agents` directly.

use crate::proto::amux;
use crate::runtime::handle::RuntimeHandle;

use super::RuntimeManager;

/// Whether a workspace currently has a live runtime, and whether that runtime
/// is mid-turn. Used by the skills-refresh auto-applier to decide whether a
/// pending change can dispose the cached OpenCode instance now, or must wait.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceOccupancy {
    /// A runtime in this workspace is currently executing a turn.
    Active,
    /// At least one live runtime, none of them mid-turn.
    WarmIdle,
    /// No live runtime for this workspace.
    Cold,
    /// Occupancy could not be confirmed; keep pending rather than guessing.
    Unknown,
}

impl RuntimeManager {
    fn workspace_runtime_matches(
        handle: &RuntimeHandle,
        workspace_path: &str,
        workspace_id: &str,
    ) -> bool {
        handle.worktree == workspace_path
            || handle.workspace_id == workspace_path
            || handle.workspace_id == workspace_id
    }

    /// Active runtimes bound to a workspace path or id.
    pub fn active_handles_for_workspace<'a>(
        &'a self,
        workspace_path: &'a str,
        workspace_id: &'a str,
    ) -> impl Iterator<Item = (&'a String, &'a RuntimeHandle)> + 'a {
        self.agents.iter().filter(move |(_, handle)| {
            Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
                && matches!(
                    handle.status,
                    amux::AgentStatus::Starting
                        | amux::AgentStatus::Active
                        | amux::AgentStatus::Idle
                )
        })
    }

    /// True while any runtime in this workspace is currently executing a turn.
    ///
    /// `Active` is the normal ACP status during a turn. `event_rx == None`
    /// covers the checkout path used by HTTP/gateway/cron turn drivers; while
    /// checked out, the owner is awaiting the turn and `poll_events` must not
    /// drain that channel.
    pub fn workspace_has_active_turn(&self, workspace_path: &str, workspace_id: &str) -> bool {
        self.agents.iter().any(|(_, handle)| {
            Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
                && (matches!(handle.status, amux::AgentStatus::Active) || handle.event_rx.is_none())
        })
    }

    pub fn workspace_occupancy(
        &self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> WorkspaceOccupancy {
        if self.workspace_has_active_turn(workspace_path, workspace_id) {
            WorkspaceOccupancy::Active
        } else if self
            .active_handles_for_workspace(workspace_path, workspace_id)
            .next()
            .is_some()
        {
            WorkspaceOccupancy::WarmIdle
        } else {
            WorkspaceOccupancy::Cold
        }
    }

    /// Resolution snapshot from any live runtime in this workspace.
    pub fn workspace_env_snapshot(
        &self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> Option<(teamclu_runtime_env::ResolvedEnvSnapshot, Option<String>)> {
        self.active_handles_for_workspace(workspace_path, workspace_id)
            .find_map(|(_, handle)| {
                handle
                    .env_snapshot
                    .clone()
                    .map(|snapshot| (snapshot, handle.env_team_id.clone()))
            })
    }

    /// Stop all runtimes for a workspace (used after settings reload).
    pub async fn stop_runtimes_for_workspace(
        &mut self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> usize {
        let ids: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, handle)| {
                Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut stopped = 0usize;
        for id in ids {
            if self.stop_runtime(&id).await.is_some() {
                stopped += 1;
            }
        }
        stopped
    }

    /// Detach workspace runtimes that are safe to resume after a pooled host
    /// refresh.
    ///
    /// A pooled OpenCode generation cannot exit while an attached runtime owns
    /// one of its route leases. Keeping every idle attachment across repeated
    /// config refreshes therefore accumulates draining generations until the
    /// global host cap is exhausted. Idle runtimes can be reconstructed from
    /// their persisted backend session on the next message, so release those
    /// leases before rolling the host. Active and checked-out turns remain on
    /// their current generation and are never interrupted.
    pub async fn stop_idle_runtimes_for_workspace(
        &mut self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> usize {
        let ids: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, handle)| {
                Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
                    && handle.status == amux::AgentStatus::Idle
                    && handle.event_rx.is_some()
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut stopped = 0usize;
        for id in ids {
            if self.stop_runtime(&id).await.is_some() {
                stopped += 1;
            }
        }
        stopped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refresh_cleanup_stops_only_safe_idle_workspace_runtimes() {
        let mut manager = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        manager.add_test_workspace_runtime(
            "idle-target",
            "/tmp/target",
            "ws-target",
            amux::AgentStatus::Idle,
        );
        manager.add_test_workspace_runtime(
            "active-target",
            "/tmp/target",
            "ws-target",
            amux::AgentStatus::Active,
        );
        manager.add_test_workspace_runtime(
            "checked-out-target",
            "/tmp/target",
            "ws-target",
            amux::AgentStatus::Idle,
        );
        manager
            .get_handle_mut("checked-out-target")
            .unwrap()
            .event_rx = None;
        manager.add_test_workspace_runtime(
            "idle-other",
            "/tmp/other",
            "ws-other",
            amux::AgentStatus::Idle,
        );

        assert_eq!(
            manager
                .stop_idle_runtimes_for_workspace("/tmp/target", "ws-target")
                .await,
            1
        );

        let ids = manager.agent_ids();
        assert!(!ids.iter().any(|id| id == "idle-target"));
        assert!(ids.iter().any(|id| id == "active-target"));
        assert!(ids.iter().any(|id| id == "checked-out-target"));
        assert!(ids.iter().any(|id| id == "idle-other"));
    }

    #[test]
    fn occupancy_distinguishes_active_warm_idle_and_cold() {
        let mut manager = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        manager.add_test_workspace_runtime(
            "busy",
            "/tmp/active",
            "ws-active",
            amux::AgentStatus::Active,
        );
        manager.add_test_workspace_runtime("idle", "/tmp/idle", "ws-idle", amux::AgentStatus::Idle);

        assert_eq!(
            manager.workspace_occupancy("/tmp/active", "ws-active"),
            WorkspaceOccupancy::Active
        );
        assert_eq!(
            manager.workspace_occupancy("/tmp/idle", "ws-idle"),
            WorkspaceOccupancy::WarmIdle
        );
        assert_eq!(
            manager.workspace_occupancy("/tmp/missing", "ws-missing"),
            WorkspaceOccupancy::Cold
        );
    }
}
