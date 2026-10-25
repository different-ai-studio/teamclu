//! Moving a checkout on this machine: `move_workdir`, and who a seed commits as.
//!
//! `create`, `reseed` and `download` are `teamclu-apps` (shared with
//! `amuxd app …`). [`move_app_workdir`] is a port of `handleMoveConfirm` in
//! `components/apps/AppControlPanel.tsx` that only this surface offers so far,
//! built from the same crate pieces; keep it in step with the web app.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use teamclu_apps::{bind_workspace_fields, daemon_error_text, AppOps, DAEMON_DOWN};

use super::{
    canonical_path, introspect_caller_workspace, notify_app_changed, row_id, row_str, DesktopDaemon,
};
use crate::commands::introspect_api::str_body_field;

/// A move across filesystems copies the whole tree, `node_modules` included.
const MOVE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

// ─── Arguments ──────────────────────────────────────────────────────────────

/// Validate a `move_workdir` destination without touching anything.
pub(super) fn move_destination(v: &Value) -> Result<String, String> {
    let dest = str_body_field(v, "dest_path", "destPath")
        .ok_or("move_workdir needs `dest_path` — the absolute path to move the checkout to")?;
    if !Path::new(&dest).is_absolute() {
        return Err(format!("dest_path must be an absolute path (got {dest:?})"));
    }
    Ok(dest)
}

/// Whether `checkout` is the directory the calling agent is running in, or
/// holds it. Moving it would pull the working directory out from under the
/// very session that asked.
fn moves_callers_own_checkout(checkout: &Path, caller_workspace: &Path) -> bool {
    caller_workspace.starts_with(checkout)
}

// ─── Who is committing ──────────────────────────────────────────────────────

/// The claims of a JWT, unverified — read only for a display name, never for a
/// decision; the Cloud API verifies the same token on every call.
fn jwt_claims(token: &str) -> Option<Value> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The git author a seed commits as: the signed-in user, the way
/// `resolveSeedGitUserIdentity` reads them off the session. Either half may be
/// missing (a phone sign-in has no email); the daemon has its own default.
pub(super) fn seed_git_identity(bearer: &str) -> (Option<String>, Option<String>) {
    let Some(claims) = jwt_claims(bearer) else {
        return (None, None);
    };
    let email = row_str(&claims, "email").map(str::to_string);
    let meta = claims.get("user_metadata").cloned().unwrap_or(Value::Null);
    let name = row_str(&meta, "full_name")
        .or_else(|| row_str(&meta, "name"))
        .map(str::to_string)
        .or_else(|| {
            email
                .as_deref()
                .and_then(|e| e.split('@').next())
                .filter(|local| !local.is_empty())
                .map(str::to_string)
        });
    (name, email)
}

// ─── download / move ────────────────────────────────────────────────────────

/// `move_workdir` — relocate this machine's checkout of the app, whole.
///
/// Not the checkout the caller is running in: that would pull the working
/// directory out from under the session that asked, mid-turn. The control
/// panel can move it, because a person clicking there is not standing inside.
pub(super) async fn move_app_workdir(
    app: &AppHandle,
    ops: &AppOps<'_>,
    row: &Value,
    v: &Value,
) -> Result<Value, String> {
    let dest = move_destination(v)?;
    let app_id = row_id(row)?;
    let current = ops.app_workdir_on_this_machine(row).await.map(|(w, _)| w);
    if let (Some(current), Some(caller)) = (current.as_deref(), introspect_caller_workspace(app, v))
    {
        if moves_callers_own_checkout(&canonical_path(current), &canonical_path(&caller)) {
            return Err(format!(
                "{current} is the checkout this agent is running in; moving it would pull the directory out from under this session. Ask the user to move it from the app's control panel (本机路径 → 移动目录)."
            ));
        }
    }

    let path = format!("/v1/apps/{}/move-workdir", urlencoding::encode(&app_id));
    let body = json!({ "appId": app_id, "teamId": row_str(row, "teamId"), "destPath": dest });
    let out = DesktopDaemon
        .post(&path, "workspace:write", &body, MOVE_TIMEOUT)
        .await
        .map_err(|e| {
            if e.unreachable {
                DAEMON_DOWN.to_string()
            } else {
                format!(
                    "Moving the checkout failed: {}. The original directory was left where it was.",
                    daemon_error_text(&e)
                )
            }
        })?;
    let workdir = row_str(&out, "workdir").unwrap_or(&dest).to_string();

    // The cloud row too, not just the daemon's pointer: that row is what
    // runtime-start resolves to a path, so leaving it on the old directory
    // keeps any open session running against a path that no longer exists.
    let mut report = json!({
        "ok": true,
        "action": "move_workdir",
        "app_id": app_id,
        "from": current,
        "workdir": workdir,
    });
    bind_workspace_fields(ops, row, &workdir, &mut report).await;
    notify_app_changed(app, row);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_client::DaemonError;

    #[test]
    fn moving_the_callers_own_checkout_is_refused_but_not_a_sibling() {
        let checkout = Path::new("/home/u/.amuxd/teams/t/apps/a1");
        assert!(moves_callers_own_checkout(checkout, checkout));
        assert!(moves_callers_own_checkout(checkout, &checkout.join("src")));
        assert!(!moves_callers_own_checkout(
            checkout,
            Path::new("/home/u/.amuxd/teams/t/apps/a10")
        ));
        assert!(move_destination(&json!({ "dest_path": "apps/a1" })).is_err());
        assert!(move_destination(&json!({})).is_err());
    }

    #[test]
    fn a_daemon_problem_body_reads_as_its_detail() {
        let e = DaemonError::Status {
            path: "/v1/apps/seed".into(),
            status: 500,
            body: r#"{"type":"https://teamclu/errors/internal","title":"Internal","status":500,"detail":"git clone timed out after 5 minutes","code":"internal"}"#.into(),
        };
        let text = daemon_error_text(&super::super::daemon_failure(&e));
        assert!(text.starts_with("git clone timed out"), "{text}");
        assert!(text.contains("credential helper"), "{text}");

        let e = DaemonError::Status {
            path: "/v1/apps/seed".into(),
            status: 502,
            body: "<html>bad gateway</html>".into(),
        };
        assert!(daemon_error_text(&super::super::daemon_failure(&e)).contains("HTTP 502"));
        assert!(super::super::daemon_failure(&DaemonError::NotRunning).unreachable);
    }

    fn token_with(claims: Value) -> String {
        use base64::Engine as _;
        let enc = |v: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap())
        };
        format!("{}.{}.sig", enc(&json!({ "alg": "HS256" })), enc(&claims))
    }

    #[test]
    fn the_seed_commits_as_the_signed_in_user() {
        let full = token_with(
            json!({ "email": "hai@example.com", "user_metadata": { "full_name": "海港" } }),
        );
        assert_eq!(
            seed_git_identity(&full),
            (Some("海港".into()), Some("hai@example.com".into()))
        );
        let email_only = token_with(json!({ "email": "wei@example.com" }));
        assert_eq!(seed_git_identity(&email_only).0.as_deref(), Some("wei"));
        // A phone sign-in has neither; the daemon's default applies.
        assert_eq!(
            seed_git_identity(&token_with(json!({ "phone": "86..." }))),
            (None, None)
        );
        assert_eq!(seed_git_identity("not-a-jwt"), (None, None));
    }
}
