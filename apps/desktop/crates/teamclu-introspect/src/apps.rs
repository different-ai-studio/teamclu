//! `manage_app` / `manage_app_data` — publish an app, read why it broke, and
//! look at what it stored.
//!
//! Thin clients over the desktop loopback API, which owns both halves of the
//! work: only the app holds the signed-in user's cloud bearer (so the Cloud API
//! decides what this agent may do — `admin` to deploy or write a row, `prompt`
//! to read one) and only it can reach the local daemon that builds the artifact.
//! This binary shapes arguments and rejects the mistakes that do not need a
//! round trip.
//!
//! The app is named by `app_id`, or by `app_name` when that matches exactly one
//! app in the current team, or — with neither — by the workspace the agent is
//! running in, which the desktop matches against the checkouts this machine
//! holds. Deploying publishes to the public internet and `update_row` writes
//! production data, so an ambiguous name comes back as the candidate list
//! rather than acting on a guess; a directory, by contrast, either is an app's
//! checkout or is not.

use serde_json::{json, Value};

const MANAGE_ACTIONS: [&str; 4] = ["list", "status", "deploy", "logs"];
const DATA_ACTIONS: [&str; 4] = ["tables", "rows", "update_row", "delete_row"];

fn str_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn require_action(arguments: &Value, allowed: &[&str]) -> Result<String, String> {
    let action = str_arg(arguments, "action").unwrap_or_default();
    if !allowed.contains(&action.as_str()) {
        return Err(format!(
            "action must be one of: {}. Got: {}",
            allowed.join(", "),
            if action.is_empty() {
                "(missing)"
            } else {
                &action
            }
        ));
    }
    Ok(action)
}

/// Copy the app selector onto the outgoing body, refusing both forms at once.
///
/// Neither form is not an error here: the desktop then resolves the app from
/// `workspace_path` — the checkout the agent is actually working in. Only the
/// desktop can do that (it knows the team and can ask the daemon where each
/// app lives), and it is the case this tool used to dead-end on.
fn attach_app_selector(arguments: &Value, body: &mut Value) -> Result<(), String> {
    match (str_arg(arguments, "app_id"), str_arg(arguments, "app_name")) {
        (Some(_), Some(_)) => Err("pass app_id or app_name, not both".to_string()),
        (None, None) => Ok(()),
        (Some(id), None) => {
            body["app_id"] = json!(id);
            Ok(())
        }
        (None, Some(name)) => {
            body["app_name"] = json!(name);
            Ok(())
        }
    }
}

/// Forward the arguments the desktop reads for one action, and nothing else.
fn copy_args(arguments: &Value, body: &mut Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = arguments.get(*key) {
            if !value.is_null() {
                body[*key] = value.clone();
            }
        }
    }
}

/// The body `/app-manage` receives, so the argument rules are testable without
/// a desktop to post them to.
fn manage_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let action = require_action(arguments, &MANAGE_ACTIONS)?;
    let mut body = json!({ "action": action, "workspace_path": workspace });

    if action != "list" {
        attach_app_selector(arguments, &mut body)?;
    }
    if action == "logs" {
        copy_args(
            arguments,
            &mut body,
            &["since_minutes", "limit", "kind", "contains", "request_id"],
        );
    }
    Ok(body)
}

pub async fn handle_manage(
    workspace: &str,
    api_port: u16,
    arguments: &Value,
) -> Result<Value, String> {
    let body = manage_body(workspace, arguments)?;
    crate::desktop_api::post(api_port, "/app-manage", &body).await
}

pub async fn handle_data(
    workspace: &str,
    api_port: u16,
    arguments: &Value,
) -> Result<Value, String> {
    let action = require_action(arguments, &DATA_ACTIONS)?;
    let mut body = json!({ "action": action, "workspace_path": workspace });
    attach_app_selector(arguments, &mut body)?;

    if action != "tables" {
        let table = str_arg(arguments, "table").ok_or_else(|| {
            format!("{action} needs `table` — run action \"tables\" first to see what exists")
        })?;
        body["table"] = json!(table);
    }

    match action.as_str() {
        "rows" => copy_args(
            arguments,
            &mut body,
            &[
                "limit",
                "after",
                "direction",
                "filter_column",
                "filter_op",
                "filter_value",
            ],
        ),
        "update_row" | "delete_row" => {
            // Addressed by primary key only. `key` is the column → value map for
            // this row's primary key; `row_key` is the opaque form a previous
            // reply handed back, accepted so a caller can pass one straight
            // through.
            if arguments.get("key").is_none() && str_arg(arguments, "row_key").is_none() {
                return Err(format!(
                    "{action} needs `key` — an object of the row's primary-key columns, e.g. {{\"id\": 42}}"
                ));
            }
            if action == "update_row" && !arguments.get("patch").is_some_and(Value::is_object) {
                return Err(
                    "update_row needs `patch` — an object of column → new value".to_string()
                );
            }
            copy_args(arguments, &mut body, &["key", "row_key", "patch"]);
        }
        _ => {}
    }

    crate::desktop_api::post(api_port, "/app-data", &body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "0c0a97bf-d615-47f1-b471-45cb717f1629";

    const WS: &str = "/Users/x/apps/demo";

    #[test]
    fn unknown_action_is_rejected_before_anything_else() {
        // Checked first on purpose: a typo'd action must not reach the desktop
        // and must not read as "the app is missing".
        let err = manage_body(WS, &json!({ "action": "publish" })).unwrap_err();
        assert!(err.contains("action must be one of"), "{err}");
    }

    #[test]
    fn deploy_without_a_target_defers_to_the_workspace() {
        // The desktop resolves the app from the checkout the agent is in, so an
        // unnamed deploy must reach it instead of being refused here.
        let body = manage_body(WS, &json!({ "action": "deploy" })).unwrap();
        assert_eq!(body["workspace_path"], json!(WS));
        assert!(body.get("app_id").is_none());
        assert!(body.get("app_name").is_none());
    }

    #[test]
    fn the_workspace_travels_with_every_action() {
        let body = manage_body(WS, &json!({ "action": "list" })).unwrap();
        assert_eq!(body["workspace_path"], json!(WS));
    }

    #[test]
    fn an_explicit_target_still_wins() {
        let body = manage_body(WS, &json!({ "action": "deploy", "app_id": APP })).unwrap();
        assert_eq!(body["app_id"], json!(APP));
    }

    #[test]
    fn deploy_refuses_both_target_forms() {
        let err = manage_body(
            WS,
            &json!({ "action": "deploy", "app_id": APP, "app_name": "记账" }),
        )
        .unwrap_err();
        assert!(err.contains("not both"), "{err}");
    }

    #[tokio::test]
    async fn rows_needs_a_table() {
        let err = handle_data(WS, 1, &json!({ "action": "rows", "app_id": APP }))
            .await
            .unwrap_err();
        assert!(err.contains("needs `table`"), "{err}");
    }

    #[tokio::test]
    async fn update_row_needs_a_key() {
        let err = handle_data(
            WS,
            1,
            &json!({
                "action": "update_row", "app_id": APP,
                "table": "entries", "patch": { "title": "x" }
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("needs `key`"), "{err}");
    }

    #[tokio::test]
    async fn update_row_needs_a_patch_object() {
        let err = handle_data(
            WS,
            1,
            &json!({
                "action": "update_row", "app_id": APP,
                "table": "entries", "key": { "id": 42 }, "patch": "title=x"
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("needs `patch`"), "{err}");
    }

    #[tokio::test]
    async fn delete_row_needs_no_patch() {
        // Reaches the desktop (and fails to connect on port 1) rather than being
        // rejected here: the argument check must not demand a patch to delete.
        let err = handle_data(
            WS,
            1,
            &json!({
                "action": "delete_row", "app_id": APP,
                "table": "entries", "key": { "id": 42 }
            }),
        )
        .await
        .unwrap_err();
        assert!(!err.contains("needs `patch`"), "{err}");
    }

    #[test]
    fn copy_args_skips_absent_and_null() {
        let mut body = json!({ "action": "logs" });
        copy_args(
            &json!({ "limit": 20, "contains": Value::Null }),
            &mut body,
            &["limit", "contains", "kind"],
        );
        assert_eq!(body["limit"], json!(20));
        assert!(body.get("contains").is_none());
        assert!(body.get("kind").is_none());
    }
}
