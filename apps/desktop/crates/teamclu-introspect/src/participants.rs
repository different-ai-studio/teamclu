//! `manage_participants` — read and change a session's roster from inside it.
//!
//! A thin client over the desktop loopback API, which owns the Cloud API call:
//! only the app has the signed-in user's bearer (so RLS decides what is
//! allowed) and the desktop's current team (so candidates come from the team
//! the user is actually looking at). This binary's job is argument shaping and
//! the session-id default.
//!
//! Adding a participant is visible to another human — the session shows up in
//! their list, history included — so the target is never guessed: pass
//! `actor_id`, or a `name` that matches exactly one actor. Zero or several
//! matches come back as the candidate list, not as a write.
//!
//! `add` / `remove` cover human members only. Joining an agent is a longer
//! story — workspace, backend, runtime — and doing half of it here would leave
//! a mute agent in the roster, so the desktop refuses those and points at the
//! member sheet instead.

use serde_json::{json, Value};

const ACTIONS: [&str; 4] = ["list", "list_candidates", "add", "remove"];

fn str_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = str_arg(arguments, "action").unwrap_or_default();
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!(
            "action must be one of: {}. Got: {}",
            ACTIONS.join(", "),
            if action.is_empty() {
                "(missing)"
            } else {
                &action
            }
        ));
    }

    let session_id = crate::session::resolve_session_id(workspace, arguments)?;
    let mut body = json!({ "action": action, "session_id": session_id });

    if action == "add" || action == "remove" {
        match (str_arg(arguments, "actor_id"), str_arg(arguments, "name")) {
            (Some(_), Some(_)) => {
                return Err("pass actor_id or name, not both".to_string());
            }
            (None, None) => {
                return Err(format!(
                    "{action} needs actor_id or name — run action \"list_candidates\" first to see who can be added"
                ));
            }
            (Some(id), None) => body["actor_id"] = json!(id),
            (None, Some(name)) => body["name"] = json!(name),
        }
    }

    post(api_port, &body).await
}

async fn post(api_port: u16, body: &Value) -> Result<Value, String> {
    crate::desktop_api::post(api_port, "/session-participants", body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";

    fn args(v: Value) -> Value {
        v
    }

    #[tokio::test]
    async fn unknown_action_is_rejected_before_anything_else() {
        // Checked first on purpose: a typo'd action must not resolve a session
        // id (which can fail for its own reasons) or reach the app.
        let err = handle("/tmp", 1, &args(json!({"action": "invite"})))
            .await
            .unwrap_err();
        assert!(err.contains("action must be one of"), "{err}");
    }

    #[tokio::test]
    async fn add_without_a_target_names_the_way_out() {
        let err = handle(
            "/tmp",
            1,
            &args(json!({"action": "add", "session_id": UUID})),
        )
        .await
        .unwrap_err();
        assert!(err.contains("actor_id or name"), "{err}");
        assert!(err.contains("list_candidates"), "{err}");
    }

    #[tokio::test]
    async fn add_refuses_both_target_forms() {
        let err = handle(
            "/tmp",
            1,
            &args(json!({
                "action": "add", "session_id": UUID,
                "actor_id": UUID, "name": "海港"
            })),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not both"), "{err}");
    }

    #[tokio::test]
    async fn list_needs_no_target() {
        // Gets past argument validation into the desktop call — proving `list`
        // does not require actor_id/name. That call fails on the bearer file
        // when no desktop is running here, or on the socket (port 1 refuses)
        // when one is; either message comes from `desktop_api`, not from an
        // argument check.
        let err = handle(
            "/tmp",
            1,
            &args(json!({"action": "list", "session_id": UUID})),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("Request failed") || err.contains("desktop token unavailable"),
            "{err}"
        );
    }
}
