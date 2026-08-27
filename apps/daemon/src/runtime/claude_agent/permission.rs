//! Permission requests from the Agent SDK's `canUseTool` callback.
//!
//! The whole loop is in-process on the bridge side: `canUseTool` returns a
//! promise, so the bridge blocks the tool call until we answer. That means —
//! unlike `cursor_sdk` — there is no hooks file in the user's repo, no socket
//! round-trip through a spawned helper, and a deny genuinely stops the call
//! with a message the model reads.
//!
//! Because the SDK is blocked rather than polling, this path **fails closed**:
//! if we cannot route the request, denying is correct (the turn continues with
//! a refusal the model can react to), whereas allowing would run a tool nobody
//! approved.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tracing::warn;

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::opencode_http::translate::permission_options;

use super::types::{BridgeInstanceId, BridgeRouteKey};
use super::Shared;

pub(crate) struct PendingPermission {
    pub(crate) route_key: BridgeRouteKey,
    /// Bridge-local request id (`perm-N`) used when replying over JSONL RPC.
    pub(crate) bridge_request_id: String,
    pub(crate) worktree: String,
    /// The SDK's own "always allow" rule suggestions, echoed back verbatim on
    /// an `always` grant so the persisted rule matches the real tool call.
    pub(crate) suggestions: Value,
    pub(crate) can_always: bool,
}

fn describe(tool_name: &str, input: &Value) -> String {
    for key in ["command", "file_path", "path", "url", "pattern", "query"] {
        if let Some(v) = input.get(key).and_then(|v| v.as_str()) {
            if !v.is_empty() {
                return format!("{tool_name}: {v}");
            }
        }
    }
    tool_name.to_string()
}

fn params_from_input(input: &Value) -> HashMap<String, String> {
    match input {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                (k.clone(), s)
            })
            .collect(),
        _ => HashMap::new(),
    }
}

/// Options to show the human. "Always allow" is offered only when the SDK
/// supplied rule suggestions — otherwise the grant could not be persisted and
/// the button would silently behave like a one-shot allow.
fn options_for(can_always: bool) -> Vec<amux::AcpPermissionOption> {
    permission_options()
        .into_iter()
        .filter(|o| can_always || o.option_id != "always")
        .collect()
}

/// Route one `permission_request` event to clients. Registers the pending
/// request; the answer arrives later as `AcpCommand::ResolvePermission`.
pub(super) async fn handle_request(
    shared: &Arc<Shared>,
    session_id: &str,
    bridge_id: &BridgeInstanceId,
    session_key: &str,
    event: &Value,
) {
    let bridge_request_id = event
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if bridge_request_id.is_empty() {
        return;
    }
    let tool_name = event
        .get("toolName")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = event
        .get("input")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let can_always = event
        .get("canAlways")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Snapshot under the lock, then decide — the guard must not be alive
    // across an await (parking_lot guards are not Send).
    let snapshot = shared.routes.lock().get(session_id).map(|route| {
        (
            route.event_tx.clone(),
            route.turn_requester.clone(),
            route.turn_reply_to.clone(),
            route.worktree.clone(),
            route.connected,
        )
    });
    let Some((event_tx, requester, reply_to, worktree, connected)) = snapshot else {
        warn!(
            session_id,
            bridge_request_id, "claude permission for unknown session; denying"
        );
        deny_unrouted(shared, bridge_id, session_key, &bridge_request_id).await;
        return;
    };
    if !connected {
        warn!(
            session_id,
            bridge_request_id, "claude permission for disconnected session; denying"
        );
        deny_unrouted(shared, bridge_id, session_key, &bridge_request_id).await;
        return;
    }

    let route_key = BridgeRouteKey::new(bridge_id.clone(), session_key);
    let public_request_id = route_key.public_permission_id(&bridge_request_id);

    let mut params = params_from_input(&input);
    params.insert("request_id".to_string(), public_request_id.clone());
    if let Some(actor) = requester {
        params.insert("requester_actor_id".to_string(), actor);
    }

    shared.permissions.lock().insert(
        public_request_id.clone(),
        PendingPermission {
            route_key: route_key.clone(),
            bridge_request_id: bridge_request_id.clone(),
            worktree: worktree.clone(),
            suggestions: event
                .get("suggestions")
                .cloned()
                .unwrap_or(Value::Array(Vec::new())),
            can_always,
        },
    );

    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::PermissionRequest(
            amux::AcpPermissionRequest {
                request_id: public_request_id,
                tool_name: tool_name.clone(),
                description: describe(&tool_name, &input),
                params,
                options: options_for(can_always),
            },
        )),
        model: String::new(),
    };
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    if event_tx
        .send(AcpEventFrame::new(session_id.to_string(), ev).with_reply_to(reply_to))
        .await
        .is_err()
    {
        shared.permissions.lock().remove(&route_key.public_permission_id(&bridge_request_id));
        warn!(
            session_id,
            "claude permission: event channel closed; denying"
        );
        deny_unrouted(shared, bridge_id, session_key, &bridge_request_id).await;
    }
}

async fn deny_unrouted(
    shared: &Arc<Shared>,
    bridge_id: &BridgeInstanceId,
    session_key: &str,
    bridge_request_id: &str,
) {
    reply(
        shared,
        bridge_id,
        session_key,
        bridge_request_id,
        serde_json::json!({
            "requestId": bridge_request_id,
            "granted": false,
            "message": "TeamClu could not route this approval request.",
            "interrupt": true,
        }),
    )
    .await;
}

async fn reply(
    shared: &Arc<Shared>,
    bridge_id: &BridgeInstanceId,
    session_key: &str,
    bridge_request_id: &str,
    params: Value,
) {
    let worktree = shared
        .routes
        .lock()
        .values()
        .find(|route| route.bridge_id == *bridge_id && route.session_key == session_key)
        .map(|route| route.worktree.clone())
        .unwrap_or_default();
    let Some(proc) = shared.pool.get(&worktree) else {
        warn!(bridge_request_id, worktree, "claude permission reply: bridge gone");
        return;
    };
    if proc.bridge_id != *bridge_id {
        warn!(
            bridge_request_id,
            worktree,
            "claude permission reply: stale bridge generation"
        );
        return;
    }
    if let Err(e) = proc.client.request("resolve_permission", params).await {
        warn!(bridge_request_id, error = %e, "claude permission reply failed");
    }
}

/// Answer a pending request (from `AcpCommand::ResolvePermission`).
pub(crate) async fn resolve(
    shared: &Arc<Shared>,
    request_id: &str,
    granted: bool,
    option_id: Option<&str>,
) {
    let Some(pending) = shared.permissions.lock().remove(request_id) else {
        warn!(request_id, "no pending claude permission");
        return;
    };
    let always = granted && option_id == Some("always") && pending.can_always;
    let params = if granted {
        serde_json::json!({
            "requestId": pending.bridge_request_id,
            "granted": true,
            "always": always,
            "suggestions": pending.suggestions,
        })
    } else {
        serde_json::json!({
            "requestId": pending.bridge_request_id,
            "granted": false,
            "message": "The user rejected this tool call. Pick another approach or ask what to do instead.",
            // A bare rejection with no guidance should stop the turn rather
            // than let the model keep hammering at the same action.
            "interrupt": true,
        })
    };
    reply(
        shared,
        &pending.route_key.bridge_id,
        &pending.route_key.session_key,
        &pending.bridge_request_id,
        params,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describe_prefers_the_most_specific_input_field() {
        assert_eq!(
            describe("Bash", &json!({"command": "rm -rf /", "cwd": "/w"})),
            "Bash: rm -rf /"
        );
        assert_eq!(
            describe("Read", &json!({"file_path": "/w/a.rs"})),
            "Read: /w/a.rs"
        );
        assert_eq!(describe("Grep", &json!({"pattern": "TODO"})), "Grep: TODO");
        assert_eq!(describe("Weird", &json!({"n": 1})), "Weird");
    }

    #[test]
    fn always_is_offered_only_when_the_sdk_can_persist_it() {
        let with = options_for(true);
        assert_eq!(with.len(), 3);
        assert!(with.iter().any(|o| o.option_id == "always"));

        let without = options_for(false);
        assert_eq!(without.len(), 2);
        assert!(!without.iter().any(|o| o.option_id == "always"));
        // once / reject must survive.
        assert!(without.iter().any(|o| o.option_id == "once"));
        assert!(without.iter().any(|o| o.option_id == "reject"));
    }

    #[test]
    fn params_stringify_non_string_values() {
        let params = params_from_input(&json!({"a": "x", "n": 3}));
        assert_eq!(params.get("a").map(String::as_str), Some("x"));
        assert_eq!(params.get("n").map(String::as_str), Some("3"));
        assert!(params_from_input(&json!("scalar")).is_empty());
    }
}
