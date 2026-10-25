//! Putting a team app's code on this machine: `download` and `move_workdir`.
//!
//! `create` and `reseed` are `teamclu-apps` (shared with `amuxd app …`); these
//! two are ports of the web app's flows that only this surface offers so far,
//! built from the same crate pieces:
//!
//! | here                  | web app                                                     |
//! |-----------------------|-------------------------------------------------------------|
//! | [`download_app`]      | `ensureAppCheckout` in `stores/apps-store.ts`               |
//! | [`move_app_workdir`]  | `handleMoveConfirm` in `components/apps/AppControlPanel.tsx`|
//!
//! Keep them in step with the web app: a change to what it sends the daemon,
//! or to how it claims the app's workspace row, belongs here too.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use teamclu_apps::{
    bind_workspace_fields, daemon_error_text, mint_git_credential, return_git_credential,
    write_provision_status, AppOps, DAEMON_DOWN, SEED_TIMEOUT,
};

use super::{
    canonical_path, dir_has_files, introspect_caller_workspace, is_gitea_managed,
    notify_app_changed, row_id, row_str, DesktopDaemon,
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

/// Whether an app in `provision_status` has anything to download.
///
/// A hosted repo short of `ready` was never seeded, so a clone would fetch an
/// empty repository. An imported one is not ours to be unready: its status
/// only says whether the creator's own clone worked, and the repository is
/// there to fetch either way. Same rule as `ensureAppCheckout`.
fn download_allowed(
    provision_status: &str,
    gitea_managed: bool,
    has_remote: bool,
) -> Result<(), String> {
    if provision_status == "ready" || (!gitea_managed && has_remote) {
        return Ok(());
    }
    Err(format!(
        "This app's code has not been written anywhere yet (provision_status {provision_status:?}), so there is nothing to download. Run reseed on it first."
    ))
}

/// `download` — put a team app's code on this machine.
///
/// A port of `ensureAppCheckout`: nothing is cloned over a directory that
/// already has files in it, because the only thing that could do there is
/// destroy the checkout someone has.
pub(super) async fn download_app(
    app: &AppHandle,
    ops: &AppOps<'_>,
    row: &Value,
) -> Result<Value, String> {
    let app_id = row_id(row)?;
    let status = row_str(row, "provisionStatus").unwrap_or("");
    download_allowed(
        status,
        is_gitea_managed(row),
        row_str(row, "gitRemoteUrl").is_some(),
    )?;
    let (workdir, device) = ops
        .app_workdir_on_this_machine(row)
        .await
        .ok_or(DAEMON_DOWN)?;
    if dir_has_files(&workdir) {
        return Ok(json!({
            "ok": true,
            "action": "download",
            "app_id": app_id,
            "workdir": workdir,
            "device_name": device,
            "already_present": true,
            "note": "This machine already holds a checkout there; nothing was cloned over it.",
        }));
    }

    let credential = if is_gitea_managed(row) {
        Some(
            mint_git_credential(ops, &app_id)
                .await
                .map_err(|e| format!("No access to this app's repository: {e}"))?,
        )
    } else {
        None
    };
    let remote = match (&credential, row_str(row, "gitRemoteUrl")) {
        (Some(cred), _) => cred.remote_url.clone(),
        (None, Some(url)) => url.to_string(),
        // An app with no remote of any kind has nothing to fetch — its code
        // only ever existed on the machine that made it.
        (None, None) => {
            return Err(
                "This app has no repository address to download from; its code only exists on the machine that created it."
                    .to_string(),
            )
        }
    };

    let (git_user_name, git_user_email) = ops.host.git_identity();
    let mut body = json!({
        "appId": app_id,
        "teamId": row_str(row, "teamId"),
        "gitRemoteUrl": remote,
        "cloneOnly": true,
    });
    if let Some(cred) = &credential {
        body["deployKeyPem"] = json!(cred.private_key_pem.trim());
    }
    if let Some(name) = git_user_name {
        body["gitUserName"] = json!(name);
    }
    if let Some(email) = git_user_email {
        body["gitUserEmail"] = json!(email);
    }
    let cloned = ops.daemon.seed(&body, SEED_TIMEOUT).await;
    if let Some(cred) = &credential {
        return_git_credential(ops, &app_id, cred.deploy_key_id).await;
    }
    let out = cloned.map_err(|e| {
        if e.unreachable {
            DAEMON_DOWN.to_string()
        } else {
            format!("Cloning the app failed: {}", daemon_error_text(&e))
        }
    })?;

    let workdir = row_str(&out, "workdir").unwrap_or(&workdir).to_string();
    // An import whose first clone failed elsewhere now has its code here, which
    // is what `ready` means. The server lets only an admin write it; for anyone
    // else the write is refused and the download still stands.
    if status != "ready" {
        write_provision_status(ops, row, "ready").await;
    }
    let mut report = json!({
        "ok": true,
        "action": "download",
        "app_id": app_id,
        "workdir": workdir,
        "device_name": device,
        "already_present": false,
    });
    bind_workspace_fields(ops, row, &workdir, &mut report).await;
    notify_app_changed(app, row);
    Ok(report)
}

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
    fn an_import_downloads_whatever_its_status_but_a_hosted_repo_must_be_ready() {
        assert!(download_allowed("ready", true, true).is_ok());
        for status in ["pending", "repo_created", "error"] {
            // A hosted repo short of ready was never seeded and would clone empty.
            assert!(download_allowed(status, true, true).is_err(), "{status}");
            // An import's status is the creator's own clone; the repo is still there.
            assert!(download_allowed(status, false, true).is_ok(), "{status}");
        }
        // With no remote there is nothing to fetch from, whatever the status.
        assert!(download_allowed("error", false, false).is_err());
    }

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
