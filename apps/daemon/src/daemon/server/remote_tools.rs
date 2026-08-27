//! Unix-sock remote-tool-call handler (deduplicated).

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;

use super::DaemonServer;

impl DaemonServer {
    pub(crate) async fn prepare_remote_tool_context_for_turn(
        &self,
        runtime_id: &str,
        teamclu_session_id: &str,
        requester_actor_id: &str,
    ) {
        // ── Remote-tool per-turn prompt injection (PAUSED) ─────────────────
        // Host-level `amuxd-remote-tools` MCP auto-inject is already off
        // (`runtime/supervisor.rs`). This hook still ran on every @mention /
        // RPC prompt and prefixed user text with `remote_context_instructions`
        // (rtctx_* + amuxd-remote-tools routing hints via
        // `RuntimeHandle::next_prompt_context` → `send_prompt_with_requester`).
        //
        // To restore end-to-end remote tools:
        // 1. Re-enable MCP baseline in `supervisor.rs` (strip/remove pause).
        // 2. Uncomment the block below.
        // 3. See `docs/remote-tools.md`.
        let _ = (runtime_id, teamclu_session_id, requester_actor_id);
        return;

        /*
        let (acp_session_id, worktree) = {
            let agents = self.agents.lock().await;
            agents
                .get_handle(runtime_id)
                .map(|h| (h.acp_session_id.clone(), h.worktree.clone()))
                .unwrap_or_default()
        };
        let _ = worktree;
        let remote_context_id = self.remote_tool_turn_contexts.lock().await.create(
            runtime_id,
            &acp_session_id,
            teamclu_session_id,
            requester_actor_id,
        );
        match remote_context_id {
            Some(id) => {
                let instructions = crate::remote_tools::remote_context_instructions(&id);
                if !instructions.is_empty() {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(runtime_id) {
                        handle.next_prompt_context = instructions;
                    }
                }
            }
            None => {}
        }
        */
    }

    pub(crate) async fn spawn_remote_tool_sock_handler(
        &self,
        payload: Value,
        reply_tx: oneshot::Sender<String>,
    ) {
        let remote_context_id = payload
            .get("remote_context_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let tool_name = payload
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let arguments = payload
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let context = {
            self.remote_tool_turn_contexts
                .lock()
                .await
                .resolve(&remote_context_id)
        };
        let rpc_client = Arc::clone(&self.rpc_client);
        let actor_id = self.actor_id.clone();
        tokio::spawn(async move {
            let resp = match context {
                Some(context) => {
                    crate::remote_tools::proxy::handle_sock_invoke_for_target(
                        &rpc_client,
                        &actor_id,
                        &context.requester_actor_id,
                        &context.teamclu_session_id,
                        &tool_name,
                        &arguments,
                    )
                    .await
                }
                None => crate::remote_tools::proxy::sock_err(
                    "invalid_remote_context",
                    "missing or expired remote_context_id for remote tool call",
                ),
            };
            let _ = reply_tx.send(resp.to_string());
        });
    }
}
