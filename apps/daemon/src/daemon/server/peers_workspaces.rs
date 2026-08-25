//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

impl DaemonServer {
    pub(crate) async fn handle_fetch_peers(
        &self,
        request: &crate::proto::teamclu::RpcRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, FetchPeersResult, RpcResponse};

        let peers = self.peers.to_proto_peer_list().peers;
        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::FetchPeersResult(FetchPeersResult {
                peers,
            })),
        }
    }

    pub(crate) async fn handle_fetch_workspaces(
        &self,
        request: &crate::proto::teamclu::RpcRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, FetchWorkspacesResult, RpcResponse};

        let workspaces = self.cloud_workspace_list().await;
        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::FetchWorkspacesResult(
                FetchWorkspacesResult { workspaces },
            )),
        }
    }

    // ─── Peer mutation helpers (shared by legacy collab path + RPC handlers) ───

    /// Authenticates and adds a peer. Returns (accepted, error_text, assigned_role).
    /// Does NOT publish anything — the caller is responsible for any broadcasts
    /// (legacy collab arm republishes peer_list + workspace_list; RPC handler
    /// publishes Notify "peers.changed").
    pub(crate) async fn apply_peer_announce(
        &mut self,
        announce: &amux::PeerAnnounce,
    ) -> (bool, String, amux::MemberRole) {
        match self.auth.authenticate(&announce.auth_token) {
            AuthResult::Accepted { member } => {
                let role = if member.is_owner() {
                    amux::MemberRole::Owner
                } else {
                    amux::MemberRole::Member
                };
                let pi = announce.peer.as_ref();
                let peer_id_str = pi.map(|p| p.peer_id.clone()).unwrap_or_default();
                info!(peer_id = %peer_id_str, member_id = %member.member_id, "peer authenticated");
                self.peers.add_peer(PeerState {
                    peer_id: peer_id_str,
                    member_id: member.member_id.clone(),
                    display_name: member.display_name.clone(),
                    device_type: pi.map(|p| p.device_type.clone()).unwrap_or_default(),
                    role,
                    connected_at: chrono::Utc::now().timestamp(),
                });
                (true, String::new(), role)
            }
            AuthResult::Rejected { reason } => {
                warn!(%reason, "peer rejected");
                (false, reason, amux::MemberRole::Member)
            }
        }
    }

    /// Removes a peer by peer_id. Returns (accepted, error_text).
    /// Does NOT publish anything — the caller is responsible for any broadcasts.
    pub(crate) async fn apply_peer_disconnect(&mut self, peer_id: &str) -> (bool, String) {
        if self.peers.remove_peer(peer_id).is_some() {
            info!(peer_id, "peer disconnected");
            (true, String::new())
        } else {
            (false, format!("unknown peer_id: {}", peer_id))
        }
    }

    // ─── AnnouncePeer / DisconnectPeer RPC handlers ───

    pub(crate) async fn handle_announce_peer(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        announce: &crate::proto::teamclu::AnnouncePeerRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, AnnouncePeerResult, RpcResponse};

        // Construct amux::PeerAnnounce that apply_peer_announce expects.
        let amux_announce = amux::PeerAnnounce {
            peer: announce.peer.clone(),
            auth_token: announce.auth_token.clone(),
        };
        let (accepted, error, assigned_role) = self.apply_peer_announce(&amux_announce).await;

        // Hint subscribers to re-fetch peers.
        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("peers.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::AnnouncePeerResult(
                AnnouncePeerResult {
                    accepted,
                    error,
                    assigned_role: assigned_role as i32,
                },
            )),
        }
    }

    pub(crate) async fn handle_disconnect_peer(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        disconnect: &crate::proto::teamclu::DisconnectPeerRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, DisconnectPeerResult, RpcResponse};

        let (accepted, error) = self.apply_peer_disconnect(&disconnect.peer_id).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("peers.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::DisconnectPeerResult(
                DisconnectPeerResult { accepted, error },
            )),
        }
    }

    /// Cloud-sourced workspace enumeration (`amux.workspaces` is the sole
    /// source of truth — no more local `WorkspaceStore`/`workspaces.toml`).
    /// Lists this daemon's team's workspaces and filters to rows that
    /// resolve to a linkable, on-disk path on *this* machine.
    pub(crate) async fn cloud_workspace_list(&self) -> Vec<amux::WorkspaceInfo> {
        let team_id = self.backend.team_id();
        if team_id.trim().is_empty() {
            return Vec::new();
        }
        let rows = match self
            .backend
            .get_workspaces_by_agent(team_id, self.backend.actor_id())
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                warn!(
                    team_id,
                    "cloud_workspace_list: get_workspaces_by_agent failed: {e}"
                );
                return Vec::new();
            }
        };
        rows.into_iter()
            .filter_map(|row| {
                let (path, display_name) =
                    crate::config::workspace_path::listable_local_workspace(&row)?;
                Some(amux::WorkspaceInfo {
                    workspace_id: row.id,
                    path,
                    display_name,
                })
            })
            .collect()
    }

    /// Applies a workspace add. Returns (success, error_text, resulting_workspace_if_any).
    /// Caller publishes any collab event or Notify hint.
    ///
    /// `amux.workspaces` is the sole source of truth — no more local
    /// `WorkspaceStore`/`workspaces.toml` mirror. This upserts directly via
    /// `backend.upsert_workspace`, which dedups server-side by `(team_id,
    /// path)`, so repeated adds of the same path never mint a second UUID.
    /// The returned cloud row's id is the workspace id handed back to callers.
    ///
    /// Deprecated: workspaces are now created via Cloud API `POST /v1/workspaces`.
    /// This RPC handler is retained for backward wire-compat only.
    pub(crate) async fn apply_add_workspace(
        &mut self,
        add: &amux::AddWorkspace,
    ) -> (bool, String, Option<amux::WorkspaceInfo>) {
        if !is_linkable_workspace_path(&add.path) {
            return (
                false,
                format!(
                    "workspace path must not be inside the daemon config directory (~/.amuxd): {}",
                    add.path
                ),
                None,
            );
        }
        let p = Path::new(&add.path);
        if !p.is_dir() {
            return (
                false,
                format!("path is not a directory: {}", add.path),
                None,
            );
        }
        let canonical = match p.canonicalize() {
            Ok(c) => c,
            Err(e) => return (false, format!("canonicalize {}: {}", add.path, e), None),
        };
        let canonical_str = canonical.to_string_lossy().to_string();
        let display_name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical_str.clone());

        let team_id = self.backend.team_id();
        let row = WorkspaceUpsert {
            team_id,
            agent_id: self.backend.actor_id(),
            name: &display_name,
            path: Some(canonical_str.as_str()),
            archived: false,
            cloud_id: None,
        };
        let remote = match self.backend.upsert_workspace(&row).await {
            Ok(remote) => remote,
            Err(e) => {
                warn!(path = %canonical_str, "workspace cloud upsert failed: {}", e);
                return (false, e.to_string(), None);
            }
        };
        self.workspace_resolver.invalidate_all().await;

        // Promote to the agent's cloud default when none is set yet — mirrors
        // the old "first workspace ever added / no local default" heuristic
        // now that the cloud `agents.default_workspace_id` is the only copy.
        let has_default = self
            .backend
            .get_agent_defaults(self.backend.actor_id())
            .await
            .map(|d| d.default_workspace_id.is_some())
            .unwrap_or(false);
        if !has_default {
            if let Err(e) = self.backend.set_agent_default_workspace(&remote.id).await {
                warn!(
                    workspace_id = %remote.id,
                    path = %canonical_str,
                    "workspace default update failed: {}",
                    e
                );
            } else {
                info!(
                    workspace_id = %remote.id,
                    path = %canonical_str,
                    "workspace default set"
                );
            }
        }

        // On-demand link: a workspace bound to a team must materialize the
        // global dir + symlink now, not wait for the next daemon restart.
        if !team_id.trim().is_empty() {
            let gate = crate::team_link::team_share_gate(self.backend.as_ref(), team_id).await;
            crate::team_link::materialize_or_teardown(gate, team_id, &canonical_str);
            // Pull the team's shared tree now instead of waiting for the timer's
            // next tick, so the team dirs (knowledge/, .mcp/) are there by the
            // time the user looks. Fire-and-forget so registration stays
            // responsive; failures (e.g. team secret not delivered yet) are
            // logged and left to the timer / secret self-heal.
            if crate::config::DaemonConfig::team_share_auto_sync_enabled_from_disk() {
                let dispatcher = self.sync_dispatcher.clone();
                let team = team_id.to_string();
                tokio::spawn(async move {
                    let status = dispatcher
                        .sync_team(&team, crate::sync::dispatch::SyncOptions::default())
                        .await;
                    match status.last_error {
                        Some(err) => warn!(
                            team_id = %team,
                            error = %err,
                            "initial team sync after workspace add failed (will retry via timer/self-heal)"
                        ),
                        None if status.skipped => {
                            tracing::debug!(
                                team_id = %team,
                                "initial team sync skipped (team_share.auto_sync disabled)"
                            );
                        }
                        None => {
                            info!(team_id = %team, "initial team sync after workspace add complete")
                        }
                    }
                });
            }
        }
        if let Some(registry) = self.refresh_watch_registry.as_ref() {
            registry
                .upsert_workspace(crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                    workspace_id: remote.id.clone(),
                    workspace_path: canonical.clone(),
                })
                .await;
        }
        info!(workspace_id = %remote.id, path = %canonical_str, "workspace added");
        if let Err(e) = crate::runtime::supervisor::prepare_workspace(&canonical) {
            warn!(
                path = %canonical_str,
                error = %e,
                "prepare_workspace after workspace add failed"
            );
        }
        // Warm an ACP host for this workspace's real env now, so the user's
        // first session here skips the 20s+ cold spawn. On a fresh install the
        // boot-time prewarm had no workspace to target; this covers the
        // just-created workspace. Fire-and-forget inside.
        self.kick_prewarm_for_workspace(&canonical_str, &remote.id)
            .await;
        let info = amux::WorkspaceInfo {
            workspace_id: remote.id,
            path: canonical_str,
            display_name,
        };
        (true, String::new(), Some(info))
    }

    /// Register a workspace from the HTTP control plane (`POST /v1/workspaces`).
    /// Wraps `apply_add_workspace` (cloud upsert + default + team link, all
    /// idempotent — no local registry write) and publishes the same
    /// `workspaces.changed` notify as the MQTT/RPC path. Returns a JSON line
    /// for the reply channel.
    pub(crate) async fn handle_add_workspace_sock(&mut self, path: &str) -> String {
        let amux_add = amux::AddWorkspace {
            path: path.to_string(),
        };
        let (accepted, error, workspace) = self.apply_add_workspace(&amux_add).await;
        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
            serde_json::json!({
                "ok": true,
                "result": workspace.map(|w| serde_json::json!({
                    "workspace_id": w.workspace_id,
                    "path": w.path,
                    "display_name": w.display_name,
                })),
            })
            .to_string()
        } else {
            serde_json::json!({ "ok": false, "error": error }).to_string()
        }
    }

    /// Applies a workspace remove. Returns (success, error_text).
    ///
    /// Deprecated no-op: with `amux.workspaces` as the sole source of truth
    /// there is no local registry entry to drop, and the backend trait has
    /// no delete/archive-by-id call whose semantics are safe to invent here
    /// (`Backend::upsert_workspace` would require re-supplying `name`/`path`
    /// to avoid nulling them out on archive — data this caller doesn't have).
    /// No RPC/HTTP/UI client currently calls `RemoveWorkspace` in anger; this
    /// keeps the wire contract answering (`accepted: true`, matching the old
    /// "already removed" success shape) without silently corrupting a row.
    /// A real archive/delete needs its own `Backend` method + FC endpoint.
    pub(crate) async fn apply_remove_workspace(
        &mut self,
        remove: &amux::RemoveWorkspace,
    ) -> (bool, String) {
        warn!(
            workspace_id = %remove.workspace_id,
            "apply_remove_workspace: no-op (WorkspaceStore removed; cloud archive not yet implemented)"
        );
        (true, String::new())
    }

    pub(crate) async fn handle_add_workspace(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        add: &crate::proto::teamclu::AddWorkspaceRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, AddWorkspaceResult, RpcResponse};

        let amux_add = amux::AddWorkspace {
            path: add.path.clone(),
        };
        let (accepted, error, workspace) = self.apply_add_workspace(&amux_add).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::AddWorkspaceResult(
                AddWorkspaceResult {
                    accepted,
                    error,
                    workspace,
                },
            )),
        }
    }

    pub(crate) async fn handle_remove_workspace(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        remove: &crate::proto::teamclu::RemoveWorkspaceRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, RemoveWorkspaceResult, RpcResponse};

        let amux_remove = amux::RemoveWorkspace {
            workspace_id: remove.workspace_id.clone(),
        };
        let (accepted, error) = self.apply_remove_workspace(&amux_remove).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RemoveWorkspaceResult(
                RemoveWorkspaceResult { accepted, error },
            )),
        }
    }

    /// Applies a member removal. Returns (success, error_text).
    /// Caller passes `requester_is_owner` because the two callers have
    /// different ways to establish it: legacy collab path looks up the
    /// peer's role via PeerTracker; RPC path looks up the requester_actor_id
    /// through AuthManager::is_owner.
    pub(crate) async fn apply_remove_member(
        &mut self,
        remove: &amux::RemoveMember,
        requester_is_owner: bool,
    ) -> (bool, String) {
        if !requester_is_owner {
            warn!(member_id = %remove.member_id, "remove rejected: not owner");
            return (false, "not owner".to_string());
        }
        match self.auth.remove_member(&remove.member_id) {
            Ok(true) => {
                let kicked = self.peers.remove_by_member_id(&remove.member_id);
                for p in &kicked {
                    info!(peer_id = %p.peer_id, "peer kicked");
                }
                (true, String::new())
            }
            Ok(false) => (false, format!("member not found: {}", remove.member_id)),
            Err(e) => (false, e.to_string()),
        }
    }

    pub(crate) async fn handle_remove_member(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        remove: &crate::proto::teamclu::RemoveMemberRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, RemoveMemberResult, RpcResponse};

        let amux_remove = amux::RemoveMember {
            member_id: remove.member_id.clone(),
        };
        // RPC carries requester identity in payload; resolve is_owner via
        // AuthManager, which is the source of truth for member roles.
        let is_owner = self.auth.is_owner(&request.requester_actor_id);
        let (accepted, error) = self.apply_remove_member(&amux_remove, is_owner).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("members.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RemoveMemberResult(
                RemoveMemberResult { accepted, error },
            )),
        }
    }
}
