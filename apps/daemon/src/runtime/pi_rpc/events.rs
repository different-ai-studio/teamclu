//! Per-process stdout reader + event routing.
//!
//! One reader task per pi child. Records are split on `\n` only (pi writes
//! one JSON object per line; U+2028 etc. are valid inside strings and must
//! not split records — `read_line` matches that contract). `response` lines
//! are routed back to the awaiting [`super::client::PiClient`] request;
//! everything else is an event.
//!
//! Event → session attribution is mode-dependent:
//! - **Host** children stamp a `sessionId` on every event; routing is a map
//!   lookup, and an unknown id is dropped without touching other sessions.
//! - **LegacyRpc** children emit unattributed events; they belong to the
//!   process's single active session.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::client::PiClient;
use super::process::PoolKey;
use super::{translate, Shared};

pub(super) fn spawn_reader(
    shared: Arc<Shared>,
    key: PoolKey,
    mode: super::process::PiSessionMode,
    proc: std::sync::Weak<super::process::PiProcess>,
    stdout: tokio::process::ChildStdout,
    client: PiClient,
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
                    warn!(worktree = %key.worktree, error = %e, "pi stdout read error");
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
                    debug!(worktree = %key.worktree, error = %e, "pi stdout non-JSON line dropped");
                    continue;
                }
            };
            if json.get("type").and_then(|v| v.as_str()) == Some("response") {
                client.resolve_response(&json);
                continue;
            }
            handle_event(&shared, &key, &client, &json).await;
        }
        // The pi child exited (stdout EOF or read error). A dead child will
        // never emit `agent_end`, so every in-flight turn it owned must be
        // settled here — otherwise those chats hang in "replying" forever.
        // Host mode may own several; legacy owned at most its active one, but
        // sweeping every route on this key covers both.
        let lost: Vec<String> = {
            let routes = shared.routes.lock();
            routes
                .iter()
                .filter(|(_, r)| r.pool_key == key && r.turn_active)
                .map(|(id, _)| id.clone())
                .collect()
        };
        // Backfill only when this was a HOST child that CRASHED: a deliberate
        // kill (eviction, env-change respawn, shutdown) marks the process
        // retired first, and respawning a child right after being told to die
        // would make eviction a no-op. Legacy children can't address a session
        // for replay at all — their turns just close.
        let can_backfill = mode == super::process::PiSessionMode::Host
            && proc.upgrade().map(|p| !p.is_retired()).unwrap_or(false);
        for session_id in lost {
            if can_backfill {
                backfill_and_close(&shared, &key, &session_id).await;
            } else {
                close_turn(&shared, &session_id).await;
            }
        }
        client.fail_all_pending();
        // Same reasoning one level up, for provider logins: the child that
        // would have sent `auth_login_end` is gone, so a flow it was running
        // would poll `running` forever.
        super::auth::fail_on_host_exit(&client, "pi host exited during login");
        info!(worktree = %key.worktree, "pi stdout closed");
    });
}

/// The acp session bound to a LegacyRpc process (host events carry their own).
fn active_session(shared: &Arc<Shared>, key: &PoolKey) -> Option<String> {
    shared
        .pool
        .get(key)
        .and_then(|p| p.active_acp_session.lock().clone())
}

/// Which session an event belongs to: its own `sessionId` (host) or the
/// process's active session (legacy).
fn event_session(shared: &Arc<Shared>, key: &PoolKey, event: &serde_json::Value) -> Option<String> {
    match event.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) if !id.is_empty() => Some(id.to_string()),
        _ => active_session(shared, key),
    }
}

async fn handle_event(
    shared: &Arc<Shared>,
    key: &PoolKey,
    client: &PiClient,
    event: &serde_json::Value,
) {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type == "extension_ui_request" {
        handle_ui_request(shared, key, client, event).await;
        return;
    }
    // Provider-auth lines are host-level and carry no `sessionId`. They must be
    // claimed here, above `event_session`: its fallback would attribute them to
    // "whichever session is active" and deliver a login prompt into a chat.
    if super::auth::handle_host_event(event_type, event) {
        if event_type == "auth_login_end"
            && event.get("success").and_then(|v| v.as_bool()) == Some(true)
        {
            broadcast_auth_refresh(shared, client, event);
        }
        return;
    }
    // Host bookkeeping lines, not session events.
    if event_type == "host_ready" || event_type == "host_error" {
        if event_type == "host_error" {
            warn!(worktree = %key.worktree, event = %event, "pi host reported a startup error");
        }
        return;
    }
    let Some(session_id) = event_session(shared, key, event) else {
        debug!(worktree = %key.worktree, event_type, "pi event with no session dropped");
        return;
    };

    match event_type {
        "agent_start" => {
            if let Some(route) = shared.routes.lock().get_mut(&session_id) {
                route.translate.reset_turn();
                // A prompt sent while pi was busy is queued as `followUp`, so
                // it starts its own run after the current one ends — and that
                // first `agent_end` already cleared `turn_active`. Without
                // re-arming here the queued run would finish with `close_turn`
                // bailing on `!turn_active`, leaving the caller without the
                // Active→Idle for a reply it did receive.
                route.turn_active = true;
            }
        }
        // A pi agent run can contain multiple turns: each tool-use cycle ends
        // one `turn_end` and begins another `turn_start`. Ending the TeamClu
        // stream there finalizes the first partial reply, so subsequent text
        // is rendered as a second message. Only `agent_end` completes the
        // prompt as a whole. `turn_active` keeps the stdout-EOF fallback
        // idempotent if pi exits immediately after this event.
        event_type if completes_agent_run(event_type) => {
            // The host stamps the session's leaf entry id onto `agent_end`;
            // remembered per route as the "since" cursor for crash backfill.
            if let Some(leaf) = event.get("leafId").and_then(|v| v.as_str()) {
                if let Some(route) = shared.routes.lock().get_mut(&session_id) {
                    route.last_entry_id = Some(leaf.to_string());
                }
            }
            close_turn(shared, &session_id).await;
        }
        _ => {
            let (events, event_tx, reply_to) = {
                let mut routes = shared.routes.lock();
                let Some(route) = routes.get_mut(&session_id) else {
                    // Unknown session (already detached, or an id this daemon
                    // never issued): drop it; other sessions are unaffected.
                    debug!(
                        session_id,
                        event_type, "pi event for unrouted session dropped"
                    );
                    return;
                };
                (
                    translate::translate_event(&mut route.translate, event),
                    route.event_tx.clone(),
                    route.turn_reply_to.clone(),
                )
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

fn completes_agent_run(event_type: &str) -> bool {
    event_type == "agent_end"
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
        let ev = crate::runtime::acp_translate::status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        );
        crate::runtime::agent_trace::log_acp_event(session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
            .await;
    }
}

/// A child died mid-turn. The LLM stream is gone — the turn cannot resume —
/// but whatever pi persisted to the session jsonl before dying may include
/// pieces the client never saw (text after the last flushed delta, results of
/// tools that were still running). Respawn the child, read the entries after
/// the route's last known leaf (`get_entries since`), replay the unseen tail
/// through the session's translate state (which suffix-dedupes against what
/// already streamed), then settle the turn.
///
/// Every failure path still closes the turn: replay is best-effort, the
/// Active→Idle is not.
async fn backfill_and_close(shared: &Arc<Shared>, key: &PoolKey, session_id: &str) {
    let (since, session_path) = {
        let routes = shared.routes.lock();
        match routes.get(session_id) {
            Some(route) => (route.last_entry_id.clone(), route.session_path.clone()),
            None => return,
        }
    };
    // Without a cursor the only "since" is the whole history — replaying that
    // would duplicate the entire conversation. Close plainly instead.
    let Some(since) = since else {
        close_turn(shared, session_id).await;
        return;
    };
    let replayed = try_backfill(shared, key, session_id, &session_path, &since).await;
    if let Err(e) = replayed {
        warn!(session_id, error = %e, "pi crash backfill failed; closing turn without replay");
    }
    close_turn(shared, session_id).await;
}

async fn try_backfill(
    shared: &Arc<Shared>,
    key: &PoolKey,
    session_id: &str,
    session_path: &str,
    since: &str,
) -> crate::error::Result<()> {
    let proc = shared.pool.ensure(shared, key)?;
    if proc.mode != super::process::PiSessionMode::Host {
        // The respawn came back in legacy mode (config flipped, package
        // vanished): it can't address a session without switching into it.
        return Ok(());
    }
    let opened = proc
        .client
        .request(serde_json::json!({"type": "open_session", "sessionPath": session_path}))
        .await?;
    let opened_id = opened
        .pointer("/data/sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if opened_id != session_id {
        return Err(crate::error::AmuxError::Agent(format!(
            "pi host reopened {session_path} as {opened_id}, expected {session_id}"
        )));
    }
    proc.open_sessions
        .lock()
        .insert(session_id.to_string(), std::time::Instant::now());
    let entries = proc
        .client
        .request(serde_json::json!({
            "type": "get_entries", "sessionId": session_id, "since": since
        }))
        .await?;
    let empty = Vec::new();
    let entries = entries
        .pointer("/data/entries")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let (events, event_tx, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return Ok(());
        };
        (
            translate::replay_entries(&mut route.translate, entries),
            route.event_tx.clone(),
            route.turn_reply_to.clone(),
        )
    };
    info!(
        session_id,
        replayed = events.len(),
        "pi crash backfill replayed persisted tail"
    );
    for ev in events {
        crate::runtime::agent_trace::log_acp_event(session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to.clone()))
            .await;
    }
    Ok(())
}

/// Tell every *other* live child to reload the provider a login just unlocked.
///
/// Logins run on their own child (see `pi_auth_request`), and each child holds
/// its own `ModelRuntime`. Without this, a provider signed in from the settings
/// pane stays invisible to the sessions already running until their child is
/// respawned — which is exactly the property reusing a session's child used to
/// buy, and the reason it is safe to stop doing that.
///
/// Detached rather than awaited: this reader task is the only thing draining
/// that child's stdout, and `auth_refresh` waits on a network catalog fetch.
/// Awaiting it here would stall every event from the child that just answered.
/// Best-effort by design — a child that fails to refresh still picks the
/// credential up from `auth.json` the next time it starts.
fn broadcast_auth_refresh(shared: &Arc<Shared>, origin: &PiClient, event: &serde_json::Value) {
    let provider_id = event
        .get("providerId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let targets: Vec<_> = shared
        .pool
        .all_live()
        .into_iter()
        // The child that ran the login already refreshed itself as part of it.
        .filter(|p| !p.client.same_process(origin))
        .collect();
    if targets.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut cmd = serde_json::json!({"type": "auth_refresh"});
        if let Some(provider_id) = provider_id {
            cmd["providerId"] = serde_json::json!(provider_id);
        }
        for proc in targets {
            if let Err(e) = proc.client.request(cmd.clone()).await {
                debug!(error = %e, "pi auth_refresh fan-out failed for one child");
            }
        }
    });
}

/// Dialog methods block pi until an `extension_ui_response` arrives; a
/// missing reply hangs the extension. Confirm dialogs are the permission
/// channel; select dialogs carrying the TeamClu question marker are the
/// `question` tool; other dialog methods get cancelled (unsupported over
/// amux).
async fn handle_ui_request(
    shared: &Arc<Shared>,
    key: &PoolKey,
    client: &PiClient,
    event: &serde_json::Value,
) {
    let id = event
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let method = event.get("method").and_then(|v| v.as_str()).unwrap_or("");
    match method {
        "confirm" => {
            let Some(session_id) = event_session(shared, key, event) else {
                warn!(worktree = %key.worktree, "pi confirm with no session; rejecting");
                let _ = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "confirmed": false
                    }))
                    .await;
                return;
            };
            let (permission, event_tx, requester, reply_to) = {
                let routes = shared.routes.lock();
                let Some(route) = routes.get(&session_id) else {
                    return;
                };
                (
                    route.permission,
                    route.event_tx.clone(),
                    route.turn_requester.clone(),
                    route.turn_reply_to.clone(),
                )
            };
            if permission.is_full_access() {
                // Full-access sessions (gateway, cron) have no human to ask.
                info!(session_id, ui_id = %id, "auto-allow full-access pi confirm");
                if let Err(e) = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "confirmed": true
                    }))
                    .await
                {
                    warn!(session_id, error = %e, "full-access pi confirm auto-reply failed");
                }
                return;
            }
            let always_pattern = event
                .get("message")
                .and_then(|v| v.as_str())
                .and_then(translate::extract_always_pattern);
            shared.permissions.lock().insert(
                id,
                super::PendingPermission {
                    session_id: session_id.clone(),
                    always_pattern,
                },
            );
            let ev = translate::permission_request_event(event, requester.as_deref());
            crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
            let _ = event_tx
                .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
                .await;
        }
        "select" => {
            // The TeamClu extension's `question` tool rides the select dialog,
            // marking its title. Everything else is an ordinary select, which
            // has no amux surface — cancel it so the extension isn't blocked.
            let question = event
                .get("title")
                .and_then(|v| v.as_str())
                .and_then(translate::parse_question_payload);
            let Some(payload) = question else {
                warn!(worktree = %key.worktree, method, "unsupported pi dialog method; cancelling");
                let _ = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "cancelled": true
                    }))
                    .await;
                return;
            };
            let Some(session_id) = event_session(shared, key, event) else {
                warn!(worktree = %key.worktree, "pi question with no session; cancelling");
                let _ = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "cancelled": true
                    }))
                    .await;
                return;
            };
            let (permission, event_tx, reply_to) = {
                let routes = shared.routes.lock();
                let Some(route) = routes.get(&session_id) else {
                    return;
                };
                (
                    route.permission,
                    route.event_tx.clone(),
                    route.turn_reply_to.clone(),
                )
            };
            if permission.is_full_access() {
                // Same policy as opencode's question handling: unattended
                // sessions auto-reject — the tool reports "dismissed" and the
                // agent proceeds, instead of parking a card nobody will answer.
                info!(session_id, ui_id = %id, "auto-cancel full-access pi question");
                let _ = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "cancelled": true
                    }))
                    .await;
                return;
            }
            shared
                .questions
                .lock()
                .insert(id.clone(), session_id.clone());
            let ev = translate::question_asked_event(&id, &payload);
            crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
            let _ = event_tx
                .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
                .await;
        }
        // Other dialog methods block until answered — cancel them.
        "input" | "editor" => {
            warn!(worktree = %key.worktree, method, "unsupported pi dialog method; cancelling");
            let _ = client
                .notify(serde_json::json!({
                    "type": "extension_ui_response", "id": id, "cancelled": true
                }))
                .await;
        }
        // Fire-and-forget methods (notify/setStatus/setWidget/…): no reply.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_agent_end_completes_the_prompt() {
        assert!(completes_agent_run("agent_end"));
        // A tool-using prompt has one turn_end for each model/tool cycle.
        // Closing here splits a single streamed reply into separate messages.
        assert!(!completes_agent_run("turn_end"));
        assert!(!completes_agent_run("turn_start"));
        assert!(!completes_agent_run("agent_start"));
    }

    fn test_shared() -> Arc<Shared> {
        Shared::new()
    }

    fn test_route(
        pool_key: PoolKey,
        session_path: &str,
    ) -> (
        super::super::Route,
        tokio::sync::mpsc::Receiver<AcpEventFrame>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        (
            super::super::Route {
                event_tx: tx,
                permission: crate::runtime::permission_policy::PermissionPolicy::Ask,
                pool_key,
                session_path: session_path.to_string(),
                turn_active: false,
                turn_reply_to: None,
                turn_requester: None,
                translate: translate::TranslateState::default(),
                last_entry_id: None,
            },
            rx,
        )
    }

    /// A `PiClient` for tests: writes land in a `cat` child (unix) whose
    /// output nobody reads — we only need a live stdin to construct clients.
    #[cfg(unix)]
    fn test_client() -> PiClient {
        let mut child = tokio::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn cat");
        PiClient::new(child.stdin.take().expect("stdin"))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn events_route_by_session_id_and_unknown_ids_are_dropped() {
        let shared = test_shared();
        let key = super::super::process::test_pool_key("/w");
        let (route_a, mut rx_a) = test_route(key.clone(), "/s/a.jsonl");
        let (route_b, mut rx_b) = test_route(key.clone(), "/s/b.jsonl");
        shared.routes.lock().insert("pi:/s/a.jsonl".into(), route_a);
        shared.routes.lock().insert("pi:/s/b.jsonl".into(), route_b);
        let client = test_client();

        // Text delta tagged for A reaches only A.
        let ev: serde_json::Value = serde_json::json!({
            "type": "message_update",
            "sessionId": "pi:/s/a.jsonl",
            "assistantMessageEvent": {"type": "text_delta", "delta": "hi", "contentIndex": 0}
        });
        handle_event(&shared, &key, &client, &ev).await;
        let frame = rx_a.try_recv().expect("A got its event");
        assert_eq!(frame.acp_session_id, "pi:/s/a.jsonl");
        assert!(rx_b.try_recv().is_err(), "B must not see A's event");

        // Unknown session id: dropped, neither route disturbed.
        let unknown: serde_json::Value = serde_json::json!({
            "type": "message_update",
            "sessionId": "pi:/s/ghost.jsonl",
            "assistantMessageEvent": {"type": "text_delta", "delta": "x", "contentIndex": 0}
        });
        handle_event(&shared, &key, &client, &unknown).await;
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_end_closes_only_its_own_session() {
        let shared = test_shared();
        let key = super::super::process::test_pool_key("/w");
        let (mut route_a, mut rx_a) = test_route(key.clone(), "/s/a.jsonl");
        let (mut route_b, mut rx_b) = test_route(key.clone(), "/s/b.jsonl");
        route_a.turn_active = true;
        route_b.turn_active = true;
        shared.routes.lock().insert("pi:/s/a.jsonl".into(), route_a);
        shared.routes.lock().insert("pi:/s/b.jsonl".into(), route_b);
        let client = test_client();

        let end: serde_json::Value = serde_json::json!({
            "type": "agent_end", "sessionId": "pi:/s/a.jsonl", "leafId": "e-42"
        });
        handle_event(&shared, &key, &client, &end).await;

        // A settled (status frame emitted, turn closed, leaf recorded)…
        assert!(rx_a.try_recv().is_ok(), "A gets its Active→Idle");
        {
            let routes = shared.routes.lock();
            let a = routes.get("pi:/s/a.jsonl").unwrap();
            assert!(!a.turn_active);
            assert_eq!(a.last_entry_id.as_deref(), Some("e-42"));
            // …while B is still mid-turn.
            assert!(routes.get("pi:/s/b.jsonl").unwrap().turn_active);
        }
        assert!(rx_b.try_recv().is_err(), "B keeps streaming");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn question_select_becomes_question_asked_event() {
        let shared = test_shared();
        let key = super::super::process::test_pool_key("/w");
        let (route, mut rx) = test_route(key.clone(), "/s/a.jsonl");
        shared.routes.lock().insert("pi:/s/a.jsonl".into(), route);
        let client = test_client();

        let payload = serde_json::json!({
            "toolCallId": "call_9",
            "questions": [{"question": "Deploy?", "options": [{"label": "yes"}]}]
        });
        let title = format!("{}{}", translate::QUESTION_MARKER, payload);
        let ev = serde_json::json!({
            "type": "extension_ui_request", "id": "ui_7", "sessionId": "pi:/s/a.jsonl",
            "method": "select", "title": title, "options": ["yes"]
        });
        handle_event(&shared, &key, &client, &ev).await;

        assert_eq!(
            shared.questions.lock().get("ui_7").map(String::as_str),
            Some("pi:/s/a.jsonl"),
            "question registered for AnswerQuestion routing"
        );
        let frame = rx.try_recv().expect("question_asked forwarded");
        match frame.event.event.as_ref().unwrap() {
            amux::acp_event::Event::Raw(raw) => {
                assert_eq!(raw.method, "question_asked");
                let body: serde_json::Value = serde_json::from_slice(&raw.json_payload).unwrap();
                assert_eq!(body["id"], "ui_7");
                assert_eq!(body["tool"]["callID"], "call_9");
                assert_eq!(body["questions"][0]["question"], "Deploy?");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
