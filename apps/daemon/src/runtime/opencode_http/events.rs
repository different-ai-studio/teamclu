//! SSE subscription + per-session event routing.
//!
//! One SSE task per distinct canonical worktree directory (`GET /event` is
//! directory-scoped). Each task reconnects with backoff — which also covers
//! serve restarts, since it re-`ensure()`s the supervisor on every attempt —
//! parses `data: {json}` lines, and routes events by `sessionID` to the
//! registered per-session route.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::host_pool::{HostGeneration, HostLifecycle};
use super::translate;
#[cfg(test)]
use super::ServeSupervisor;

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

async fn ensure_live(
    shared: &Arc<HostGeneration>,
) -> crate::error::Result<super::client::ServeClient> {
    if shared.lifecycle() == HostLifecycle::Stopped {
        return Err(crate::error::AmuxError::Agent(
            "opencode host generation is stopped".to_string(),
        ));
    }
    let client = shared.serve.ensure().await?;
    if shared.lifecycle() == HostLifecycle::Stopped {
        shared.serve.shutdown();
        return Err(crate::error::AmuxError::Agent(
            "opencode host generation retired while starting".to_string(),
        ));
    }
    Ok(client)
}

#[cfg(test)]
pub(super) fn supervisor_for_route(
    generation: &Arc<HostGeneration>,
    session_id: &str,
) -> Option<Arc<ServeSupervisor>> {
    generation
        .routes
        .lock()
        .contains_key(session_id)
        .then(|| Arc::clone(&generation.serve))
}

/// Ensure a running SSE task for `directory` (canonicalized by the caller).
pub(super) fn ensure_sse_task(shared: &Arc<HostGeneration>, directory: &str) {
    if shared.lifecycle() == HostLifecycle::Stopped {
        return;
    }
    let mut tasks = shared.sse_tasks.lock();
    if let Some(handle) = tasks.get(directory) {
        if !handle.is_finished() {
            return;
        }
    }
    let dir = directory.to_string();
    let shared_clone = Arc::clone(shared);
    tasks.insert(
        directory.to_string(),
        tokio::spawn(sse_loop(shared_clone, dir)),
    );
}

async fn sse_loop(shared: Arc<HostGeneration>, directory: String) {
    let mut backoff = BACKOFF_MIN;
    loop {
        if shared.lifecycle() == HostLifecycle::Stopped {
            shared.mark_sse_disconnected(&directory);
            return;
        }
        shared.mark_sse_disconnected(&directory);
        let client = match ensure_live(&shared).await {
            Ok(c) => c,
            Err(e) => {
                warn!(directory = %directory, error = %e, "SSE: serve unavailable; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        match client.event_stream(&directory).await {
            Ok(resp) => {
                info!(directory = %directory, "opencode SSE subscribed");
                backoff = BACKOFF_MIN;
                shared.mark_sse_connected(&directory);
                // Events emitted while the stream was down are gone (no
                // replay) — read back anything an active turn missed.
                spawn_reconcile_task(&shared, directory.clone());
                let mut stream = resp.bytes_stream();
                let mut buf = Vec::new();
                while let Some(chunk) = stream.next().await {
                    shared.touch_sse_read(&directory);
                    let chunk = match chunk {
                        Ok(c) => c,
                        Err(e) => {
                            warn!(directory = %directory, error = %e, "SSE read error");
                            break;
                        }
                    };
                    buf.extend_from_slice(&chunk);
                    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=pos).collect();
                        let line = String::from_utf8_lossy(&line);
                        let line = line.trim_end();
                        if let Some(payload) = line
                            .strip_prefix("data: ")
                            .or_else(|| line.strip_prefix("data:"))
                        {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                                handle_event(&shared, &json).await;
                            }
                        }
                    }
                }
                shared.mark_sse_disconnected(&directory);
                warn!(directory = %directory, "opencode SSE stream ended; reconnecting");
            }
            Err(e) => {
                shared.mark_sse_disconnected(&directory);
                warn!(directory = %directory, error = %e, "SSE subscribe failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
        // Nothing left to route for? Keep the subscription anyway — sessions
        // for this directory may be re-attached after a daemon-side resume.
        tokio::time::sleep(BACKOFF_MIN).await;
    }
}

fn spawn_reconcile_task(shared: &Arc<HostGeneration>, directory: String) {
    let mut tasks = shared.reconcile_tasks.lock();
    tasks.retain(|task| !task.is_finished());
    if shared.lifecycle() == HostLifecycle::Stopped {
        return;
    }
    let generation = Arc::clone(shared);
    tasks.push(tokio::spawn(reconcile_turns_after_reconnect(
        generation, directory,
    )));
}

/// After an SSE (re)subscribe, events emitted during the gap are lost — the
/// stream has no cursor/replay. For every turn still marked active in this
/// directory, read the persisted messages back and replay the tail through
/// the normal translate path: suffix-diffing and tool-signature dedupe drop
/// everything already emitted, so only the missing pieces reach clients.
/// When opencode finished the turn during the gap (last assistant message
/// carries `time.completed`), the missed `session.idle` is synthesized so the
/// turn closes instead of hanging until the watchdog aborts it as stalled.
async fn reconcile_turns_after_reconnect(shared: Arc<HostGeneration>, directory: String) {
    if shared.lifecycle() == HostLifecycle::Stopped {
        return;
    }
    let session_ids: Vec<String> = {
        let routes = shared.routes.lock();
        routes
            .iter()
            .filter(|(_, r)| {
                r.directory == directory && r.turn_active && r.parent_session_id.is_none()
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    if session_ids.is_empty() {
        return;
    }
    if shared.lifecycle() == HostLifecycle::Stopped {
        return;
    }
    let client = match ensure_live(&shared).await {
        Ok(c) => c,
        Err(_) => return,
    };
    for session_id in session_ids {
        let messages = match client.session_messages(&directory, &session_id).await {
            Ok(m) => m,
            Err(e) => {
                warn!(session_id, error = %e, "post-reconnect message read failed");
                continue;
            }
        };
        // Only the tail can have been lost mid-turn: the current user prompt
        // plus the assistant response being generated.
        let tail = messages.len().saturating_sub(2);
        let mut assistant_completed = false;
        for message in &messages[tail..] {
            let info = message
                .get("info")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            handle_event(
                &shared,
                &serde_json::json!({"type": "message.updated", "properties": {"info": info}}),
            )
            .await;
            if let Some(parts) = message.get("parts").and_then(|v| v.as_array()) {
                for part in parts {
                    handle_event(
                        &shared,
                        &serde_json::json!({"type": "message.part.updated", "properties": {"part": part}}),
                    )
                    .await;
                }
            }
            if info.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                assistant_completed = info
                    .pointer("/time/completed")
                    .is_some_and(|v| !v.is_null());
            }
        }
        if assistant_completed {
            info!(
                session_id,
                "turn finished during SSE gap; synthesizing session.idle"
            );
            handle_session_idle(&shared, &session_id).await;
        }
    }
}

fn event_session_id(event_type: &str, props: &serde_json::Value) -> Option<String> {
    props
        .get("sessionID")
        .and_then(|v| v.as_str())
        .or_else(|| props.pointer("/part/sessionID").and_then(|v| v.as_str()))
        .or_else(|| props.pointer("/info/sessionID").and_then(|v| v.as_str()))
        .or_else(|| {
            // session.updated / session.created carry the Session object.
            if event_type.starts_with("session.") {
                props.pointer("/info/id").and_then(|v| v.as_str())
            } else {
                None
            }
        })
        .map(str::to_string)
}

async fn handle_event(shared: &Arc<HostGeneration>, event: &serde_json::Value) {
    let Some(event_type) = event.get("type").and_then(|v| v.as_str()) else {
        return;
    };
    if event_type.starts_with("server.")
        || event_type.starts_with("storage.")
        || event_type.starts_with("file.")
        || event_type.starts_with("lsp.")
    {
        return;
    }
    let props = event
        .get("properties")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let Some(session_id) = event_session_id(event_type, &props) else {
        return;
    };

    match event_type {
        "permission.asked" => handle_permission_asked(shared, &session_id, &props).await,
        "session.idle" => handle_session_idle(shared, &session_id).await,
        "session.created" => handle_session_created(shared, &session_id, &props).await,
        "session.updated" => handle_session_updated(shared, &session_id, &props).await,
        "session.status" => handle_session_status(shared, &session_id, &props).await,
        "question.asked" => handle_question_asked(shared, &session_id, &props).await,
        "question.replied" | "question.rejected" => {
            handle_question_resolved(shared, &session_id, event_type, &props).await
        }
        _ => {
            // Pure translation path (text/reasoning/tool deltas, errors).
            let (events, event_tx, reply_to) = {
                let mut routes = shared.routes.lock();
                let Some(route) = routes.get_mut(&session_id) else {
                    debug!(
                        session_id,
                        event_type, "SSE event for unrouted session dropped"
                    );
                    return;
                };
                if route.turn_active && super::is_turn_progress_event(event_type) {
                    route.turn_last_event_at = std::time::Instant::now();
                }
                let parent_id = route.parent_session_id.clone();
                let events = translate::translate_event(&mut route.translate, event_type, &props);
                if !events.is_empty() {
                    route.turn_saw_output = true;
                }
                // Track in-flight tool calls: while one is running, opencode
                // emits nothing, so the stuck-turn watchdog widens its budget.
                for ev in &events {
                    match ev.event.as_ref() {
                        Some(amux::acp_event::Event::ToolUse(tu)) => {
                            route.tools_in_flight.insert(tu.tool_id.clone());
                        }
                        Some(amux::acp_event::Event::ToolResult(tr)) => {
                            route.tools_in_flight.remove(&tr.tool_id);
                        }
                        _ => {}
                    }
                }
                let out = (events, route.event_tx.clone(), route.turn_reply_to.clone());
                // Keep parent's stuck-turn clock alive while the subagent works.
                if let Some(parent_id) = parent_id {
                    if let Some(parent) = routes.get_mut(&parent_id) {
                        if parent.turn_active && super::is_turn_progress_event(event_type) {
                            parent.turn_last_event_at = std::time::Instant::now();
                        }
                    }
                }
                out
            };
            for ev in events {
                crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
                let _ = event_tx
                    .send(
                        AcpEventFrame::new(session_id.clone(), ev).with_reply_to(reply_to.clone()),
                    )
                    .await;
            }
        }
    }
}

async fn handle_permission_asked(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let permission_id = props
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // Subagent sessions created by opencode `task` are not attach()'d by amuxd.
    // Register a lightweight child route (parent event_tx + directory) so the
    // ask reaches the desktop while reply still targets this session_id.
    if !shared.routes.lock().contains_key(session_id) {
        if let Some(parent_id) = resolve_routed_ancestor_session_id(shared, session_id).await {
            if !shared.ensure_child_route(session_id, &parent_id) {
                warn!(
                    session_id,
                    parent_id = %parent_id,
                    "permission.asked: parent route missing; dropping"
                );
                return;
            }
        } else {
            // Nothing to reply on and nobody to ask: opencode keeps waiting on
            // this permission, so the turn stalls until its timeout. Say so —
            // the bare "unrouted session" line read like a harmless skip.
            warn!(
                session_id,
                permission_id = %permission_id,
                "permission.asked: no routed ancestor session; dropping (the turn will stall on it)"
            );
            return;
        }
    }

    let (permission, directory, event_tx, requester, is_child) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            warn!(session_id, "permission.asked for unrouted session");
            return;
        };
        (
            route.permission,
            route.directory.clone(),
            route.event_tx.clone(),
            route.turn_requester.clone(),
            route.parent_session_id.is_some(),
        )
    };

    if permission.is_full_access() {
        // Full-access sessions (gateway conversations, cron jobs) have no human
        // to ask — auto-allow rather than wait forever. If the auto-reply
        // itself fails, abort the turn so channel clients are not stuck for
        // the full gateway timeout with nobody able to approve.
        info!(session_id, permission_id = %permission_id, "auto-allow full-access permission");
        let respond_ok = match ensure_live(shared).await {
            Ok(client) => client
                .permission_respond(&directory, session_id, &permission_id, "once")
                .await
                .map_err(|e| {
                    warn!(session_id, error = %e, "gateway permission auto-reply failed");
                    e
                })
                .is_ok(),
            Err(e) => {
                warn!(session_id, error = %e, "gateway permission auto-reply: serve unavailable");
                false
            }
        };
        if !respond_ok {
            super::abort_turn_with_error(
                shared,
                session_id,
                "permission auto-allow failed".into(),
                format!(
                    "full-access session could not auto-approve permission {permission_id}; aborting turn"
                ),
            )
            .await;
        }
        return;
    }

    // Reply path looks up this map by request id → opencode session id. Keep
    // the *child* id here even when frames ride the parent's event_tx.
    shared
        .permissions
        .lock()
        .insert(permission_id.clone(), session_id.to_string());
    let child_sid = is_child.then_some(session_id);
    let ev = translate::permission_request_event(props, requester.as_deref(), child_sid);
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let reply_to = shared
        .routes
        .lock()
        .get(session_id)
        .and_then(|r| r.turn_reply_to.clone());
    shared.touch_turn_transport_activity(session_id);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

/// opencode `session.created` / updated Session objects carry `parentID` for
/// task subagents. Register a child→parent route alias early so later
/// permission / tool events are not dropped as "unrouted".
async fn handle_session_created(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    props: &serde_json::Value,
) {
    maybe_register_subagent_route(shared, session_id, props);
}

fn session_info_parent_id(props: &serde_json::Value) -> Option<String> {
    props
        .pointer("/info/parentID")
        .or_else(|| props.get("parentID"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn maybe_register_subagent_route(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let Some(parent_id) = session_info_parent_id(props) else {
        return;
    };
    let _ = shared.ensure_child_route(session_id, &parent_id);
    if let Some(service) = shared.context_service() {
        service.register_child_session(
            crate::proto::amux::AgentType::Opencode,
            &shared.generation_id,
            session_id,
            &parent_id,
        );
    }
}

/// Look up `Session.parentID` for an unrouted child via `GET /session/{id}`
/// across known worktree directories.
/// Walk up from `child_id` to the nearest ancestor that has a live route.
///
/// `resolve_parent_session_id` climbs exactly one level, which is all a
/// `task` subagent needs. A subagent that spawns its own subagent is one level
/// deeper: its parent is itself unrouted, `ensure_child_route` refuses to
/// adopt it, and the permission ask is dropped — the turn then waits on an
/// approval that was never shown to anyone. Climbing until a routed ancestor
/// appears keeps those asks reachable.
const MAX_SUBAGENT_PARENT_DEPTH: usize = 8;

async fn resolve_routed_ancestor_session_id(
    shared: &Arc<HostGeneration>,
    child_id: &str,
) -> Option<String> {
    let mut current = child_id.to_string();
    for _ in 0..MAX_SUBAGENT_PARENT_DEPTH {
        let parent = resolve_parent_session_id(shared, &current).await?;
        if shared.routes.lock().contains_key(&parent) {
            return Some(parent);
        }
        if parent == current {
            return None;
        }
        current = parent;
    }
    None
}

async fn resolve_parent_session_id(shared: &Arc<HostGeneration>, child_id: &str) -> Option<String> {
    {
        let routes = shared.routes.lock();
        if let Some(parent) = routes
            .get(child_id)
            .and_then(|r| r.parent_session_id.clone())
        {
            return Some(parent);
        }
    }
    let directories: Vec<String> = {
        let routes = shared.routes.lock();
        let mut dirs: Vec<String> = routes.values().map(|r| r.directory.clone()).collect();
        dirs.sort();
        dirs.dedup();
        dirs
    };
    if directories.is_empty() {
        return None;
    }
    let client = ensure_live(shared).await.ok()?;
    for directory in directories {
        match client.get_session(&directory, child_id).await {
            Ok(Some(session)) => {
                return session
                    .get("parentID")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
            Ok(None) => continue,
            Err(e) => {
                debug!(
                    child_id,
                    directory = %directory,
                    error = %e,
                    "get_session while resolving subagent parent failed"
                );
            }
        }
    }
    None
}

/// opencode's `question` tool asks the user to pick/type answers. Register
/// the request (id → session, for the reply endpoint) and forward the full
/// request JSON to clients as a `question_asked` raw control event; the
/// desktop renders it as an interactive QuestionCard on the tool call.
///
/// Full-access sessions get no card: nobody is watching a cron run, and a
/// pending question is explicitly *not* treated as a stalled turn by the
/// watchdog (see `turn_activity` in `mod.rs`), so leaving it open hangs the
/// run until the cron timeout. Reject it instead — the agent is told the
/// question went unanswered and carries on.
async fn handle_question_asked(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let Some(request_id) = props.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    if !shared.routes.lock().contains_key(session_id) {
        if let Some(parent_id) = resolve_parent_session_id(shared, session_id).await {
            if !shared.ensure_child_route(session_id, &parent_id) {
                warn!(
                    session_id,
                    parent_id = %parent_id,
                    "question.asked: parent route missing; dropping"
                );
                return;
            }
        } else {
            warn!(session_id, "question.asked for unrouted session");
            return;
        }
    }
    let full_access = {
        let routes = shared.routes.lock();
        match routes.get(session_id) {
            Some(route) => route
                .permission
                .is_full_access()
                .then(|| route.directory.clone()),
            None => {
                warn!(session_id, "question.asked for unrouted session");
                None
            }
        }
    };
    if let Some(directory) = full_access {
        // Same fail-closed path as permissions: unanswered questions park the
        // stuck-turn watchdog, so a failed reject must end the turn.
        info!(session_id, request_id, "auto-reject full-access question");
        let reject_ok = match ensure_live(shared).await {
            Ok(client) => client
                .question_reject(&directory, request_id)
                .await
                .map_err(|e| {
                    warn!(session_id, error = %e, "full-access question auto-reject failed");
                    e
                })
                .is_ok(),
            Err(e) => {
                warn!(session_id, error = %e, "full-access question auto-reject: serve unavailable");
                false
            }
        };
        if !reject_ok {
            super::abort_turn_with_error(
                shared,
                session_id,
                "question auto-reject failed".into(),
                format!(
                    "full-access session could not auto-reject question {request_id}; aborting turn"
                ),
            )
            .await;
        }
        return;
    }
    shared
        .questions
        .lock()
        .insert(request_id.to_string(), session_id.to_string());
    shared.touch_turn_transport_activity(session_id);
    forward_question_raw(shared, session_id, "question_asked", props).await;
}

/// question.replied / question.rejected — drop the pending registration and
/// tell clients to clear the interactive card.
async fn handle_question_resolved(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    event_type: &str,
    props: &serde_json::Value,
) {
    if let Some(request_id) = props.get("requestID").and_then(|v| v.as_str()) {
        shared.questions.lock().remove(request_id);
    }
    let method = if event_type == "question.replied" {
        "question_replied"
    } else {
        "question_rejected"
    };
    forward_question_raw(shared, session_id, method, props).await;
}

/// Re-sync pending questions for a session from `GET /question` — SSE
/// `question.asked` fires once and is lost across daemon restarts or
/// subscription gaps, leaving the client with a spinner and no card. Called
/// on session attach.
pub(super) async fn resync_pending_questions(shared: &Arc<HostGeneration>, session_id: &str) {
    let directory = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        route.directory.clone()
    };
    let client = match ensure_live(shared).await {
        Ok(c) => c,
        Err(_) => return,
    };
    let Ok(list) = client.question_list(&directory).await else {
        return;
    };
    for request in list {
        if request.get("sessionID").and_then(|v| v.as_str()) != Some(session_id) {
            continue;
        }
        let Some(request_id) = request.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        info!(
            session_id,
            request_id, "re-syncing pending opencode question"
        );
        shared
            .questions
            .lock()
            .insert(request_id.to_string(), session_id.to_string());
        forward_question_raw(shared, session_id, "question_asked", &request).await;
    }
}

async fn forward_question_raw(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    method: &str,
    props: &serde_json::Value,
) {
    let (event_tx, reply_to) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            warn!(session_id, method, "question event for unrouted session");
            return;
        };
        (route.event_tx.clone(), route.turn_reply_to.clone())
    };
    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
            method: method.into(),
            json_payload: serde_json::to_vec(props).unwrap_or_default(),
        })),
        model: String::new(),
    };
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

/// `session.status` carries opencode's provider-retry state — the only place
/// a failed upstream request (out of credit, usage limit, rate limit) is
/// surfaced as an event: the assistant message keeps `error: null` while
/// opencode retries internally. When the next attempt is scheduled beyond
/// the stuck-turn window there is no point waiting — abort the turn and show
/// the provider's own message (e.g. "monthly usage limit reached…"). The
/// watchdog's `/session/status` polling covers the case where this event is
/// missed across an SSE reconnect.
async fn handle_session_status(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    props: &serde_json::Value,
) {
    shared.touch_turn_transport_activity(session_id);
    let status = props.get("status").unwrap_or(&serde_json::Value::Null);
    if status.get("type").and_then(|v| v.as_str()) != Some("retry") {
        return;
    }
    let message = status
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("provider error")
        .to_string();
    let next_ms = status.get("next").and_then(|v| v.as_i64()).unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let wait = next_ms.saturating_sub(now_ms);
    warn!(
        session_id,
        message = %message,
        next_in_s = wait / 1000,
        "opencode provider retry status"
    );
    // A permanent failure (quota exhausted, out of credit) reports the exact
    // same message on every retry no matter how short opencode's backoff is —
    // seeing it twice is proof the wait won't help, so don't sit through the
    // stuck-turn window just because each individual step is short.
    let repeats = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return;
        };
        let count = match &mut route.retry_streak {
            Some((last, count)) if last == &message => {
                *count += 1;
                *count
            }
            _ => {
                route.retry_streak = Some((message.clone(), 1));
                1
            }
        };
        count
    };
    if repeats >= 2 {
        super::abort_turn_with_error(
            shared,
            session_id,
            "model provider error".to_string(),
            message,
        )
        .await;
        return;
    }
    // Retries due within the stuck-turn window may still succeed — let them
    // run; the watchdog remains the backstop.
    if wait <= super::FIRST_OUTPUT_TIMEOUT.as_millis() as i64 {
        return;
    }
    super::abort_turn_with_error(
        shared,
        session_id,
        "model provider error".to_string(),
        message,
    )
    .await;
}

/// opencode auto-generates a session title from the first exchange and
/// announces it via `session.updated`. Forward it as the existing
/// `session_title` raw control event; the daemon server decides whether the
/// TeamClu session still carries a default title worth replacing.
async fn handle_session_updated(
    shared: &Arc<HostGeneration>,
    session_id: &str,
    props: &serde_json::Value,
) {
    // Task subagents may only surface parentID on updated (or we missed created).
    maybe_register_subagent_route(shared, session_id, props);

    let title = props
        .pointer("/info/title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or_default();
    // "New session - <timestamp>" is opencode's own placeholder.
    if title.is_empty() || title.starts_with("New session") {
        return;
    }
    let (event_tx, reply_to) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        // Subagent title updates are noise for the TeamClu session title.
        if route.parent_session_id.is_some() {
            return;
        }
        (route.event_tx.clone(), route.turn_reply_to.clone())
    };
    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
            method: "session_title".into(),
            json_payload: title.as_bytes().to_vec(),
        })),
        model: String::new(),
    };
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

async fn handle_session_idle(shared: &Arc<HostGeneration>, session_id: &str) {
    let closed = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return;
        };
        route.tools_in_flight.clear();
        if route.turn_active {
            route.turn_active = false;
            let reply_to = route.turn_reply_to.take();
            route.turn_requester = None;
            Some((route.event_tx.clone(), reply_to))
        } else if route.parent_session_id.is_none() {
            // The turn was already closed daemon-side (watchdog abort, cancel
            // fallback, failed submit) while opencode kept running. Whatever
            // streamed in after that close sits in the aggregator with no
            // terminal event to flush it — emit the Active→Idle anyway; an
            // aggregator with empty buffers emits nothing, so this is
            // idempotent. Child (task-subagent) sessions must not get this:
            // their frames ride the parent's channel and a synthetic idle
            // would flush the parent's turn mid-run.
            Some((route.event_tx.clone(), None))
        } else {
            None
        }
    };
    if let Some((event_tx, reply_to)) = closed {
        let ev = translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle);
        crate::runtime::agent_trace::log_acp_event(session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};

    #[tokio::test]
    async fn stopped_generation_sse_loop_exits_before_ensuring_serve() {
        let generation = HostGeneration::test_for_routing(
            "stopped-sse",
            IsolationDomainKey::Workspace("stopped-sse".to_string()),
            ProcessEnvRevision::from_bindings(&HashMap::new()),
        );
        generation
            .serve
            .set_binary_hint("/definitely/missing/opencode");
        generation.test_mark_stopped();

        tokio::time::timeout(
            Duration::from_millis(100),
            sse_loop(generation, "/ws".to_string()),
        )
        .await
        .expect("stopped generation must exit without attempting serve.ensure()");
    }

    #[tokio::test]
    async fn stopped_generation_cannot_ensure_a_serve_for_reconciliation() {
        let generation = HostGeneration::test_for_routing(
            "stopped-reconcile",
            IsolationDomainKey::Workspace("stopped-reconcile".to_string()),
            ProcessEnvRevision::from_bindings(&HashMap::new()),
        );
        generation
            .serve
            .set_binary_hint("/definitely/missing/opencode");
        generation.test_mark_stopped();

        let result = tokio::time::timeout(Duration::from_millis(100), ensure_live(&generation))
            .await
            .expect("lifecycle guard must return without attempting to spawn");

        assert!(result.is_err());
    }
}
