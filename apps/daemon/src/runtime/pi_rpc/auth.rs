//! pi provider auth — the daemon half of `pi /login`.
//!
//! pi owns its credentials in one device-wide `auth.json` and its custom
//! providers in one device-wide `models.json`, both reachable only through the
//! pi SDK (`ModelRuntime.login/logout/refresh`). The host (`host.mjs`) exposes
//! that surface as `auth_*` commands; this module is what the HTTP layer talks
//! to.
//!
//! # Why a login is a registry entry and not a request
//!
//! [`crate::runtime::pi_rpc::client::PiClient::request`] times out after 30s. A
//! browser round trip — open the URL, sign in, approve, come back — routinely
//! takes longer, so a login cannot be one request/response pair: the timeout
//! would abandon a flow pi is still running, with no way to answer the prompt
//! it is parked on. Instead `auth_login_start` acks immediately and the flow
//! reports asynchronously through `auth_event` / `auth_prompt` /
//! `auth_login_end`, which land here keyed by a `login_id` the caller chose.
//! The UI polls [`poll`] and answers with [`respond`].
//!
//! # Why the registry is process-global
//!
//! It holds the [`PiClient`] of the child running each flow, so answering a
//! prompt writes straight to that child's stdin. Reaching it through
//! `AgentBackend` instead would mean taking the backend mutex — the one a
//! running turn holds — every 400ms for the duration of a login, and would
//! deadlock a login whose prompt is the only thing that could release it.
//! Device-wide state (one `auth.json`) behind a device-wide registry.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::client::PiClient;

/// Finished logins are kept this long so a UI that polls a moment late still
/// sees the outcome instead of "unknown login".
const FINISHED_TTL: Duration = Duration::from_secs(120);

/// A flow with no traffic at all for this long is presumed dead (its host was
/// killed mid-login) and reaped, so the registry cannot grow without bound.
const STALE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginStatus {
    Running,
    Succeeded,
    Failed,
}

/// The prompt a flow is currently parked on, verbatim from pi's `AuthPrompt`
/// (minus its `AbortSignal`, which the host strips).
#[derive(Debug, Clone, Serialize)]
pub struct PendingPrompt {
    pub prompt_id: String,
    pub prompt: serde_json::Value,
}

struct Login {
    provider_id: String,
    client: PiClient,
    status: LoginStatus,
    /// pi's `AuthEvent`s in arrival order. The UI reads them by index, so this
    /// only ever grows for the life of the flow — an auth flow emits a handful.
    events: Vec<serde_json::Value>,
    prompt: Option<PendingPrompt>,
    error: Option<String>,
    /// Set when the credential was stored but its catalog refresh did not
    /// finish. A warning, never a failure: the login itself succeeded.
    refresh_error: Option<String>,
    finished_at: Option<Instant>,
    touched: Instant,
}

/// What [`poll`] hands back to the HTTP layer.
#[derive(Debug, Clone, Serialize)]
pub struct LoginSnapshot {
    pub provider_id: String,
    pub status: LoginStatus,
    /// Events after the caller's cursor, oldest first.
    pub events: Vec<serde_json::Value>,
    /// Cursor to pass to the next poll.
    pub cursor: usize,
    pub prompt: Option<PendingPrompt>,
    pub error: Option<String>,
    pub refresh_error: Option<String>,
}

fn registry() -> &'static Mutex<HashMap<String, Login>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Login>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop finished flows past their TTL and flows whose host went away.
///
/// Called on every mutation rather than on a timer: the map is tiny (one entry
/// per in-flight login, in practice zero or one) and a timer task would have to
/// outlive the runtime that owns it.
fn prune(map: &mut HashMap<String, Login>) {
    let now = Instant::now();
    map.retain(|_, login| match login.finished_at {
        Some(at) => now.duration_since(at) < FINISHED_TTL,
        None => now.duration_since(login.touched) < STALE_TTL,
    });
}

/// Register a flow just before its `auth_login_start` is sent.
///
/// Registering *first* closes a race the other order loses: the host can emit
/// `auth_prompt` before the ack reaches us, and a prompt for an unknown login
/// would be dropped — leaving the UI waiting on a prompt that already happened.
pub(crate) fn register(login_id: &str, provider_id: &str, client: PiClient) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    prune(&mut map);
    map.insert(
        login_id.to_string(),
        Login {
            provider_id: provider_id.to_string(),
            client,
            status: LoginStatus::Running,
            events: Vec::new(),
            prompt: None,
            error: None,
            refresh_error: None,
            finished_at: None,
            touched: Instant::now(),
        },
    );
}

/// Undo a [`register`] whose `auth_login_start` never got through, so a failed
/// start does not leave a flow that looks like it is still running.
pub(crate) fn unregister(login_id: &str) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(login_id);
}

/// Record an `auth_event` line.
pub(crate) fn record_event(login_id: &str, event: serde_json::Value) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(login) = map.get_mut(login_id) {
        login.events.push(event);
        login.touched = Instant::now();
    }
}

/// Record an `auth_prompt` line — the flow is now waiting on the user.
pub(crate) fn record_prompt(login_id: &str, prompt_id: &str, prompt: serde_json::Value) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(login) = map.get_mut(login_id) {
        login.prompt = Some(PendingPrompt {
            prompt_id: prompt_id.to_string(),
            prompt,
        });
        login.touched = Instant::now();
    }
}

/// Clear a prompt pi abandoned (`auth_prompt_cancel`).
///
/// This is the normal end of the "paste your code" box in a browser flow: pi
/// races that prompt against its own loopback callback server and aborts it
/// when the callback wins. Only the *current* prompt is cleared — a late cancel
/// for a superseded prompt must not blank the one the user is now answering.
pub(crate) fn cancel_prompt(login_id: &str, prompt_id: &str) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(login) = map.get_mut(login_id) {
        if login
            .prompt
            .as_ref()
            .is_some_and(|p| p.prompt_id == prompt_id)
        {
            login.prompt = None;
        }
        login.touched = Instant::now();
    }
}

/// Record `auth_login_end`.
pub(crate) fn record_end(
    login_id: &str,
    success: bool,
    error: Option<String>,
    refresh_error: Option<String>,
) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(login) = map.get_mut(login_id) {
        login.status = if success {
            LoginStatus::Succeeded
        } else {
            LoginStatus::Failed
        };
        login.error = error;
        login.refresh_error = refresh_error;
        login.prompt = None;
        login.finished_at = Some(Instant::now());
        login.touched = Instant::now();
    }
}

/// Fail every flow that was running on the child that just died.
///
/// Without this a host crash mid-login leaves the UI polling `running` forever:
/// no `auth_login_end` is coming, because the process that would have sent it
/// is gone. Scoped by client identity so a crash on one worktree's host cannot
/// cancel a login being driven by another's.
pub(crate) fn fail_on_host_exit(client: &PiClient, reason: &str) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    for login in map.values_mut() {
        if login.status == LoginStatus::Running && login.client.same_process(client) {
            login.status = LoginStatus::Failed;
            login.error = Some(reason.to_string());
            login.prompt = None;
            login.finished_at = Some(Instant::now());
        }
    }
}

/// State since `cursor`, or `None` when the login is unknown (never started, or
/// already reaped).
pub fn poll(login_id: &str, cursor: usize) -> Option<LoginSnapshot> {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let login = map.get_mut(login_id)?;
    login.touched = Instant::now();
    let from = cursor.min(login.events.len());
    Some(LoginSnapshot {
        provider_id: login.provider_id.clone(),
        status: login.status,
        events: login.events[from..].to_vec(),
        cursor: login.events.len(),
        prompt: login.prompt.clone(),
        error: login.error.clone(),
        refresh_error: login.refresh_error.clone(),
    })
}

/// Answer (or refuse) the prompt a flow is parked on.
///
/// `prompt_id` is checked against the outstanding prompt so a stale answer —
/// the user hitting enter just as pi's callback server won the race — cannot be
/// delivered as the answer to whatever pi asked next.
pub async fn respond(
    login_id: &str,
    prompt_id: &str,
    value: Option<String>,
    cancelled: bool,
) -> Result<(), String> {
    let client = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let login = map
            .get_mut(login_id)
            .ok_or_else(|| format!("unknown pi login: {login_id}"))?;
        if login.status != LoginStatus::Running {
            return Err("pi login already finished".to_string());
        }
        match login.prompt.as_ref() {
            Some(p) if p.prompt_id == prompt_id => {}
            Some(_) => return Err("pi login prompt superseded".to_string()),
            None => return Err("pi login is not waiting for input".to_string()),
        }
        login.prompt = None;
        login.touched = Instant::now();
        login.client.clone()
    };

    let mut msg = serde_json::json!({
        "type": "auth_prompt_response",
        "loginId": login_id,
        "promptId": prompt_id,
    });
    if cancelled {
        msg["cancelled"] = serde_json::json!(true);
    } else {
        msg["value"] = serde_json::json!(value.unwrap_or_default());
    }
    client.notify(msg).await.map_err(|e| e.to_string())
}

/// Ask the host to abort a running flow. The `auth_login_end` that follows is
/// what actually settles it here.
pub async fn cancel(login_id: &str) -> Result<(), String> {
    let client = {
        let map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let login = map
            .get(login_id)
            .ok_or_else(|| format!("unknown pi login: {login_id}"))?;
        login.client.clone()
    };
    client
        .request(serde_json::json!({"type": "auth_login_cancel", "loginId": login_id}))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Route a host `auth_*` line into the registry. Returns false when the line is
/// not one of ours, so the caller can keep dispatching it as a session event.
pub(crate) fn handle_host_event(event_type: &str, event: &serde_json::Value) -> bool {
    let login_id = event.get("loginId").and_then(|v| v.as_str());
    match event_type {
        "auth_event" => {
            if let Some(id) = login_id {
                record_event(
                    id,
                    event
                        .get("event")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            true
        }
        "auth_prompt" => {
            if let (Some(id), Some(prompt_id)) =
                (login_id, event.get("promptId").and_then(|v| v.as_str()))
            {
                record_prompt(
                    id,
                    prompt_id,
                    event
                        .get("prompt")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            true
        }
        "auth_prompt_cancel" => {
            if let (Some(id), Some(prompt_id)) =
                (login_id, event.get("promptId").and_then(|v| v.as_str()))
            {
                cancel_prompt(id, prompt_id);
            }
            true
        }
        "auth_login_end" => {
            if let Some(id) = login_id {
                record_end(
                    id,
                    event
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    event
                        .get("error")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    event
                        .get("refreshError")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                );
            }
            true
        }
        _ => false,
    }
}

/// Test-only reset: the registry is process-global, so a test that leaves a
/// flow behind would be visible to the next one.
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    registry().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `poll` is a cursor read, not a drain: two readers (a re-render, a retry)
    /// must both be able to replay from where they left off.
    #[tokio::test]
    async fn poll_returns_events_after_the_cursor() {
        reset_for_tests();
        let mut map = registry().lock().unwrap();
        map.insert(
            "L".into(),
            Login {
                provider_id: "openai-codex".into(),
                client: PiClient::for_tests(),
                status: LoginStatus::Running,
                events: vec![serde_json::json!({"type": "progress"})],
                prompt: None,
                error: None,
                refresh_error: None,
                finished_at: None,
                touched: Instant::now(),
            },
        );
        drop(map);

        let first = poll("L", 0).expect("registered");
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.cursor, 1);
        let second = poll("L", first.cursor).expect("registered");
        assert!(second.events.is_empty(), "{:?}", second.events);
        assert_eq!(second.cursor, 1);
    }

    /// A cancel for a prompt that is no longer current must leave the current
    /// one alone — pi cancels the superseded "paste your code" box *after*
    /// having asked something else in a retry.
    #[tokio::test]
    async fn stale_prompt_cancel_leaves_the_current_prompt() {
        reset_for_tests();
        register("L2", "openrouter", PiClient::for_tests());
        record_prompt("L2", "p1", serde_json::json!({"type": "manual_code"}));
        record_prompt("L2", "p2", serde_json::json!({"type": "secret"}));
        cancel_prompt("L2", "p1");
        let snap = poll("L2", 0).expect("registered");
        assert_eq!(snap.prompt.expect("prompt kept").prompt_id, "p2");
        cancel_prompt("L2", "p2");
        assert!(poll("L2", 0).expect("registered").prompt.is_none());
    }

    /// A dead host must settle its own flows — nothing else will send
    /// `auth_login_end`, and a UI polling `running` would hang forever — while
    /// leaving a login running on a different host alone.
    #[tokio::test]
    async fn host_exit_fails_only_that_hosts_running_logins() {
        reset_for_tests();
        let dying = PiClient::for_tests();
        let other = PiClient::for_tests();
        register("L3", "anthropic", dying.clone());
        record_end("L3", true, None, None);
        register("L4", "xai", dying.clone());
        register("L5", "openrouter", other);
        fail_on_host_exit(&dying, "pi host exited");

        assert_eq!(poll("L3", 0).unwrap().status, LoginStatus::Succeeded);
        let failed = poll("L4", 0).unwrap();
        assert_eq!(failed.status, LoginStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("pi host exited"));
        assert_eq!(poll("L5", 0).unwrap().status, LoginStatus::Running);
    }

    #[tokio::test]
    async fn respond_rejects_a_superseded_prompt_id() {
        reset_for_tests();
        register("L5", "github-copilot", PiClient::for_tests());
        record_prompt("L5", "p1", serde_json::json!({"type": "manual_code"}));
        let err = respond("L5", "p0", Some("x".into()), false)
            .await
            .expect_err("stale prompt id must not be delivered");
        assert!(err.contains("superseded"), "{err}");
    }

    /// `handle_host_event` is the fork in the event router: it must claim every
    /// `auth_*` line (they carry no `sessionId` and would otherwise be
    /// mis-attributed to whichever session is active) and nothing else.
    #[test]
    fn only_auth_lines_are_claimed() {
        reset_for_tests();
        for t in [
            "auth_event",
            "auth_prompt",
            "auth_prompt_cancel",
            "auth_login_end",
        ] {
            assert!(
                handle_host_event(t, &serde_json::json!({"loginId": "L"})),
                "{t} must be claimed"
            );
        }
        for t in ["agent_start", "message_update", "extension_ui_request"] {
            assert!(
                !handle_host_event(t, &serde_json::json!({})),
                "{t} must pass through"
            );
        }
    }
}
