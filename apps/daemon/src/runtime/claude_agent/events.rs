//! claude-bridge stdout event routing.
//!
//! Unlike `cursor_sdk`, permission requests arrive **on this stream** rather
//! than out-of-band: the Agent SDK's `canUseTool` callback lives inside the
//! bridge process, so the bridge simply blocks and emits a `permission_request`
//! event. That removes the whole hooks-file / socket-callback apparatus the
//! cursor backend needs.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::sidecar::client::SidecarClient;

use super::types::{BridgeInstanceId, BridgeRouteKey};
use super::{permission, translate, Shared};

pub(super) fn spawn_reader(
    shared: Arc<Shared>,
    bridge_id: BridgeInstanceId,
    worktree: String,
    stdout: tokio::process::ChildStdout,
    client: SidecarClient,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    warn!(worktree, bridge_id = bridge_id.as_str(), error = %e, "claude stdout read error");
                    break;
                }
            }
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    debug!(worktree, error = %e, "claude stdout non-JSON dropped");
                    continue;
                }
            };
            if json.get("id").is_some() {
                client.resolve_response(&json);
                continue;
            }
            if json.get("event").is_some() {
                handle_event(&shared, &bridge_id, &json).await;
            }
        }
        invalidate_bridge(&shared, &bridge_id, &worktree).await;
        client.fail_all_pending();
        info!(worktree, bridge_id = bridge_id.as_str(), "claude bridge stdout closed");
    });
}

/// Drop routing state for every session bound to a dead bridge generation.
pub(super) async fn invalidate_bridge(
    shared: &Arc<Shared>,
    bridge_id: &BridgeInstanceId,
    worktree: &str,
) {
    let affected: Vec<(String, mpsc::Sender<AcpEventFrame>, Option<String>)> = {
        let mut routes = shared.routes.lock();
        routes
            .iter_mut()
            .filter(|(_, route)| route.bridge_id == *bridge_id)
            .map(|(session_id, route)| {
                route.connected = false;
                (
                    session_id.clone(),
                    route.event_tx.clone(),
                    route.turn_reply_to.clone(),
                )
            })
            .collect()
    };

    for (session_id, event_tx, reply_to) in affected {
        let ev = amux::AcpEvent {
            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                message: "claude bridge disconnected".into(),
                details: format!(
                    "bridge {} for worktree {worktree} exited; re-attach to continue",
                    bridge_id.as_str()
                ),
            })),
            model: String::new(),
        };
        crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id.clone(), ev).with_reply_to(reply_to.clone()))
            .await;
        close_turn(shared, &session_id).await;
    }

    let route_keys: Vec<String> = shared
        .routes
        .lock()
        .iter()
        .filter(|(_, route)| route.bridge_id == *bridge_id)
        .map(|(_, route)| route.route_key.encode())
        .collect();
    {
        let mut session_routes = shared.session_routes.lock();
        for key in route_keys {
            session_routes.remove(&key);
        }
    }

    shared
        .permissions
        .lock()
        .retain(|_, pending| pending.route_key.bridge_id != *bridge_id);
}

/// The bridge keys events by its own session handle; map it to our acp id.
fn acp_session_for(
    shared: &Arc<Shared>,
    bridge_id: &BridgeInstanceId,
    session_key: &str,
) -> Option<String> {
    let encoded = BridgeRouteKey::new(bridge_id.clone(), session_key).encode();
    shared.session_routes.lock().get(&encoded).cloned()
}

/// Claude bridge `slash_commands` event → ACP available commands (production parse path).
pub fn available_commands_from_slash_commands_event(
    event: &serde_json::Value,
) -> Vec<amux::AcpAvailableCommand> {
    event
        .get("commands")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(|v| v.as_str())?;
                    if name.is_empty() {
                        return None;
                    }
                    Some(amux::AcpAvailableCommand {
                        name: name.to_string(),
                        description: c
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_hint: c
                            .get("inputHint")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn emit_slash_commands(shared: &Arc<Shared>, session_id: &str, event: &serde_json::Value) {
    let commands = available_commands_from_slash_commands_event(event);
    if commands.is_empty() {
        return;
    }

    let event_tx = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        if !route.connected {
            return;
        }
        route.event_tx.clone()
    };

    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::AvailableCommands(
            amux::AcpAvailableCommands { commands },
        )),
        model: String::new(),
    };
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id.to_string(), ev))
        .await;
}

async fn handle_event(
    shared: &Arc<Shared>,
    bridge_id: &BridgeInstanceId,
    event: &serde_json::Value,
) {
    let event_name = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let session_key = event
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if session_key.is_empty() {
        return;
    }
    let Some(session_id) = acp_session_for(shared, bridge_id, session_key) else {
        debug!(
            session_key,
            bridge_id = bridge_id.as_str(),
            event_name,
            "claude event before session was routed; dropped"
        );
        return;
    };

    {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(&session_id) else {
            return;
        };
        if route.bridge_id != *bridge_id || !route.connected {
            debug!(
                session_id,
                event_name,
                "claude event for stale bridge generation dropped"
            );
            return;
        }
    }

    if event_name == "permission_request" {
        permission::handle_request(shared, &session_id, bridge_id, session_key, event).await;
        return;
    }

    if event_name == "slash_commands" {
        emit_slash_commands(shared, &session_id, event).await;
        return;
    }

    if event_name == "turn_end" {
        close_turn(shared, &session_id).await;
    }

    let (events, event_tx, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(&session_id) else {
            debug!(
                session_id,
                event_name, "claude event for unrouted session dropped"
            );
            return;
        };
        if route.bridge_id != *bridge_id || !route.connected {
            return;
        }
        if event_name == "turn_start" {
            route.turn_active = true;
        }
        // `turn_end` carries the model that actually ran the turn (the SDK's
        // `result.modelUsage` key), which is the only authoritative reading.
        if event_name == "turn_end" {
            if let Some(model) = event
                .get("model")
                .and_then(|v| v.as_str())
                .filter(|m| !m.is_empty())
            {
                let flat = super::flat_model_id(model);
                if route.model != flat {
                    debug!(session_id, from = %route.model, to = %flat, "claude run model changed");
                    route.model = flat;
                }
            }
        }
        (
            translate::translate_event(event),
            route.event_tx.clone(),
            route.turn_reply_to.clone(),
        )
    };

    for ev in events {
        crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id.clone(), ev).with_reply_to(reply_to.clone()))
            .await;
    }
}

pub(super) async fn close_turn(shared: &Arc<Shared>, session_id: &str) {
    let closed = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return;
        };
        if !route.turn_active {
            None
        } else {
            route.turn_active = false;
            let reply_to = route.turn_reply_to.take();
            route.turn_requester = None;
            Some((route.event_tx.clone(), reply_to))
        }
    };
    if let Some((event_tx, reply_to)) = closed {
        let ev = crate::runtime::opencode_http::translate::status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        );
        crate::runtime::agent_trace::log_acp_event(session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id.to_string(), ev).with_reply_to(reply_to))
            .await;
    }
}
