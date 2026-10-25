//! Reading a Cloud API app row, and the shapes an agent is shown.

use serde_json::{json, Value};

/// The types an app may be created as or changed to. The legacy stored id is
/// readable, never written.
pub const APP_TYPES: [&str; 4] = ["static_web", "slides", "data_app", "imported"];

/// `/v1/apps/<id><rest>`, with the id encoded.
pub fn app_path(app_id: &str, rest: &str) -> String {
    format!("/v1/apps/{}{rest}", urlencoding::encode(app_id))
}

/// A non-empty string field of a Cloud API row.
pub fn row_str<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn row_id(row: &Value) -> Result<String, String> {
    row_str(row, "id")
        .map(str::to_string)
        .ok_or_else(|| "app row has no id".to_string())
}

/// The rows of a `{ items: [...] }` page.
pub fn items_of(v: &Value) -> Vec<Value> {
    v.get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Whether this deployment provisioned the app's repo on Gitea and holds a
/// deploy key for it. False for an app imported from someone else's remote:
/// `git-head` and `git-credential` both 404 on it, and its deploy builds the
/// checkout as it sits. Mirrors `isGiteaManaged` in `stores/apps-store.ts`.
pub fn is_gitea_managed(row: &Value) -> bool {
    row_str(row, "gitAuthKind") == Some("gitea_deploy_key")
}

/// The handful of fields that identify an app and say whether it is up.
///
/// `publicUrl` is the address the product hands out; `fcEndpoint` is the raw FC
/// hostname and is only the app's address on a deployment with no apps domain.
/// One `url` rather than both, so the agent cannot quote the wrong one.
pub fn app_brief(row: &Value) -> Value {
    let f = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    let url = row
        .get("publicUrl")
        .filter(|v| v.is_string())
        .or_else(|| row.get("fcEndpoint"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "id": f("id"),
        "name": f("name"),
        "type": f("type"),
        "visibility": f("visibility"),
        "url": url,
        "provision_status": f("provisionStatus"),
        "fc_status": f("fcStatus"),
        "undeploy_operation": f("undeployOperation"),
        "auth_mode": f("authMode"),
        "auth_mode_pending_redeploy": f("authModePendingRedeploy"),
        "git_commit_sha": f("gitCommitSha"),
    })
}

/// Everything an operator sets on the app row, in the names `update` takes.
///
/// The `*_pending_redeploy` flags are the server's own derivation, read
/// straight off the row: each says the running function still lags a setting,
/// and only the server knows what the function was built with.
pub fn app_settings(row: &Value) -> Value {
    let f = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    let mut out = app_brief(row);
    out["type_pending_redeploy"] = json!(row
        .get("typePendingRedeploy")
        .and_then(Value::as_bool)
        .unwrap_or(false));
    out["env_pending_redeploy"] = json!(row
        .get("envPendingRedeploy")
        .and_then(Value::as_bool)
        .unwrap_or(false));
    out["auth_audience"] = f("authAudience");
    out["auth_scope"] = f("authScope");
    out["auth_rules"] = row.get("authRules").cloned().unwrap_or(json!([]));
    out
}

/// Seven characters is what every git UI shows and what people paste.
fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// The control panel's "代码版本" line, for an agent.
///
/// Ported from `describeCodeVersion` in `AppControlPanel.tsx`, states and all:
/// only one of them is the happy path, and the easy mistakes are reading
/// `gitCommitSha` as "what is serving" (it is stamped when a deploy STARTS, so
/// on an app that is not live it names what was attempted) and reading an
/// uncountable distance as "up to date" (a force-push away from the deployed
/// commit makes the forge unable to compare them).
pub fn describe_code_version(row: &Value, head: Option<&Value>) -> String {
    if !is_gitea_managed(row) {
        return "This app uses an external repository, so its branch cannot be read from here."
            .to_string();
    }
    let Some(head) = head else {
        return "The app's repository could not be read right now.".to_string();
    };
    let sha = row_str(head, "sha").unwrap_or("");
    let branch = row_str(head, "branch").unwrap_or("the default branch");
    let Some(deployed) = row_str(head, "deployedSha") else {
        return format!("Never deployed. Branch {branch} is at {}.", short_sha(sha));
    };
    if row_str(row, "fcStatus") != Some("live") {
        return format!(
            "The last deploy attempted {} but did not go live. Branch {branch} is at {}.",
            short_sha(deployed),
            short_sha(sha)
        );
    }
    let undeployed = head.get("undeployedCommits").and_then(Value::as_u64);
    if undeployed == Some(0) || deployed == sha {
        return format!(
            "Live on {}, the latest commit on {branch}.",
            short_sha(deployed)
        );
    }
    match undeployed {
        None => format!(
            "Live on {}; {branch} has changes that are not deployed.",
            short_sha(deployed)
        ),
        Some(n) => format!(
            "Live on {}; {branch} has {n} commit(s) that are not deployed.",
            short_sha(deployed)
        ),
    }
}

/// Only revision facts from the selected daemon's manifest enter status.
pub fn add_checkout_snapshot(out: &mut Value, manifest: &Value) {
    out["checkout_git_commit_sha"] = manifest
        .get("gitCommitSha")
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or(Value::Null);
    out["checkout_clean"] = manifest
        .get("clean")
        .filter(|value| value.is_boolean())
        .cloned()
        .unwrap_or(Value::Null);
    out["checkout_content_digest"] = manifest
        .get("contentDigest")
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or(Value::Null);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_brief_prefers_the_public_url_over_the_raw_function_host() {
        // `fcEndpoint` carries a random suffix and is not the address the
        // product hands out. Reporting both would have the agent quote the one
        // that stops working the moment a vanity domain exists.
        let with_vanity = json!({
            "id": "app-1", "name": "Notes",
            "publicUrl": "https://notes-0c0a97bf.apps.example.com",
            "fcEndpoint": "https://raw-suffix.fcapp.run",
        });
        assert_eq!(
            app_brief(&with_vanity)["url"],
            "https://notes-0c0a97bf.apps.example.com"
        );

        let no_vanity = json!({
            "id": "app-1", "publicUrl": Value::Null,
            "fcEndpoint": "https://raw-suffix.fcapp.run",
        });
        assert_eq!(no_vanity["fcEndpoint"], app_brief(&no_vanity)["url"]);
    }

    #[test]
    fn status_exposes_selected_checkout_revision_and_cleanliness() {
        let mut status = json!({});
        add_checkout_snapshot(
            &mut status,
            &json!({ "gitCommitSha": "abc123", "clean": false, "contentDigest": "sha256:source" }),
        );
        assert_eq!(status["checkout_git_commit_sha"], "abc123");
        assert_eq!(status["checkout_clean"], false);
        assert_eq!(status["checkout_content_digest"], "sha256:source");
    }

    fn gitea_row(fc_status: &str) -> Value {
        json!({ "gitAuthKind": "gitea_deploy_key", "fcStatus": fc_status })
    }

    #[test]
    fn code_version_covers_every_state_the_panel_does() {
        let head = |deployed: Value, undeployed: Value| json!({ "sha": "a3f91c2aa", "branch": "main", "deployedSha": deployed, "undeployedCommits": undeployed });

        let external = json!({ "gitAuthKind": Value::Null, "fcStatus": "live" });
        assert!(describe_code_version(&external, None).contains("external repository"));
        assert!(describe_code_version(&gitea_row("live"), None).contains("could not be read"));

        let never = describe_code_version(
            &gitea_row("not_deployed"),
            Some(&head(Value::Null, Value::Null)),
        );
        assert!(
            never.starts_with("Never deployed") && never.contains("a3f91c2"),
            "{never}"
        );

        // Stamped at deploy START: on a row that is not live this names what
        // was attempted, and must not read as "up to date".
        let failed = describe_code_version(
            &gitea_row("deploy_error"),
            Some(&head(json!("a3f91c2aa"), json!(0))),
        );
        assert!(failed.contains("did not go live"), "{failed}");

        let current = describe_code_version(
            &gitea_row("live"),
            Some(&head(json!("a3f91c2aa"), json!(0))),
        );
        assert!(current.contains("latest commit on main"), "{current}");

        // A force-push makes the distance uncountable: say there are changes,
        // never "up to date".
        let unknown = describe_code_version(
            &gitea_row("live"),
            Some(&head(json!("b7e2d10bb"), Value::Null)),
        );
        assert!(
            unknown.contains("changes that are not deployed"),
            "{unknown}"
        );

        let behind = describe_code_version(
            &gitea_row("live"),
            Some(&head(json!("b7e2d10bb"), json!(3))),
        );
        assert!(
            behind.contains("3 commit(s)") && behind.contains("b7e2d10"),
            "{behind}"
        );
    }
}
