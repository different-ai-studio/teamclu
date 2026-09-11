//! Putting an app's code on a machine: `create`, `reseed`, `download` and
//! `move_workdir`.
//!
//! Ports of the web app's flows — the same daemon calls, in the same order,
//! with the same writes back to the cloud:
//!
//! | here                  | web app                                                     |
//! |-----------------------|-------------------------------------------------------------|
//! | [`create_app`]        | `CreateAppView.submit` + `create` in `stores/apps-store.ts` |
//! | [`run_seed`]          | `runSeed` in `stores/apps-store.ts`                         |
//! | [`download_app`]      | `ensureAppCheckout` in `stores/apps-store.ts`               |
//! | [`move_app_workdir`]  | `handleMoveConfirm` in `components/apps/AppControlPanel.tsx`|
//! | [`bind_workspace_row`]| `bindAppWorkdir` / `ensureAppWorkspaceRow` in `lib/apps/app-session.ts` |
//!
//! They live here, not in the window, because an agent's call has to work
//! whether or not anyone opened the Apps view — and each of them needs the
//! user's bearer and the local daemon together, which only this process holds.
//!
//! Two copies of these flows is the price. Keep them in step: a change to what
//! the web app sends the daemon, or to how it claims the app's workspace row,
//! belongs in both.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{
    app_brief, app_path, app_workdir_on_this_machine, canonical_path, dir_has_files,
    introspect_caller_workspace, is_gitea_managed, mint_git_credential, notify_app_changed,
    redact_deploy_secrets, return_git_credential, row_id, row_str, AppApi, APP_TYPES,
};
use crate::commands::introspect_api::{introspect_current_team, items_of, str_body_field};
use crate::daemon_client::{self as daemon, DaemonError, RequestSpec};

/// The daemon allows a clone five minutes, then commits and pushes the seed.
const SEED_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// A move across filesystems copies the whole tree, `node_modules` included.
const MOVE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// What a new app's type is when the caller does not say: the create dialog's
/// default for a template, and `imported` for code that came from elsewhere.
/// `imported` is spelled out because `apps.type` is NOT NULL and every
/// unrecognised value means `data_app`, which would have every imported repo
/// provision a database on its first deploy.
const DEFAULT_TEMPLATE_TYPE: &str = "static_web";
const IMPORTED_TYPE: &str = "imported";

// ─── Arguments ──────────────────────────────────────────────────────────────

/// Where a new app's code comes from — the create dialog's three sources.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum CreateSource {
    /// A starter template, in a repo this deployment provisions.
    Template,
    /// A repo someone already has, cloned into this machine's checkout.
    Remote(String),
    /// A folder already on this machine.
    LocalDir(String),
}

/// Validate a `create` call without touching anything.
pub(super) fn create_source(v: &Value) -> Result<CreateSource, String> {
    if str_body_field(v, "name", "name").is_none() {
        return Err("create needs `name`".to_string());
    }
    if let Some(visibility) = str_body_field(v, "visibility", "visibility") {
        if !matches!(visibility.as_str(), "personal" | "team") {
            return Err(format!(
                "visibility must be personal or team (got {visibility:?})"
            ));
        }
    }
    if let Some(app_type) = str_body_field(v, "type", "type") {
        if !APP_TYPES.contains(&app_type.as_str()) {
            return Err(format!(
                "type must be one of: {} (got {app_type:?})",
                APP_TYPES.join(", ")
            ));
        }
    }
    match (
        str_body_field(v, "git_remote_url", "gitRemoteUrl"),
        str_body_field(v, "local_dir", "localDir"),
    ) {
        (Some(_), Some(_)) => Err(
            "pass git_remote_url or local_dir, not both — they are two different sources"
                .to_string(),
        ),
        (Some(url), None) => Ok(CreateSource::Remote(url)),
        (None, Some(dir)) if Path::new(&dir).is_absolute() => Ok(CreateSource::LocalDir(dir)),
        (None, Some(dir)) => Err(format!("local_dir must be an absolute path (got {dir:?})")),
        (None, None) => Ok(CreateSource::Template),
    }
}

/// Validate a `move_workdir` destination without touching anything.
pub(super) fn move_destination(v: &Value) -> Result<String, String> {
    let dest = str_body_field(v, "dest_path", "destPath")
        .ok_or("move_workdir needs `dest_path` — the absolute path to move the checkout to")?;
    if !Path::new(&dest).is_absolute() {
        return Err(format!("dest_path must be an absolute path (got {dest:?})"));
    }
    Ok(dest)
}

/// Reseeding writes a starter template, or clones, into the app's checkout —
/// which is exactly right for an app whose checkout was never written, and
/// exactly wrong for one that works. The control panel offers it on the same
/// three states (`canReseed`).
fn reseed_allowed(provision_status: &str) -> Result<(), String> {
    if matches!(provision_status, "pending" | "repo_created" | "error") {
        return Ok(());
    }
    Err(format!(
        "reseed is for an app whose code was never written or failed to be (provision_status pending, repo_created or error); this one is {provision_status:?}. Reseeding a working app would write the starter template or a clone over it."
    ))
}

/// Whether `checkout` is the directory the calling agent is running in, or
/// holds it. Moving it would pull the working directory out from under the
/// very session that asked.
fn moves_callers_own_checkout(checkout: &Path, caller_workspace: &Path) -> bool {
    caller_workspace.starts_with(checkout)
}

// ─── The daemon ─────────────────────────────────────────────────────────────

/// The daemon is not there at all, as opposed to there and refusing.
///
/// The web app's test is "the request never got a status" (`status === 0`);
/// this is the same line drawn on the client's error type.
fn daemon_unreachable(e: &DaemonError) -> bool {
    match e {
        DaemonError::NotRunning | DaemonError::InvalidPort(_) => true,
        DaemonError::ExchangeTransport(source) => source.is_connect(),
        DaemonError::Transport { source, .. } => source.is_connect(),
        _ => false,
    }
}

/// Credentials pasted into a repo address, cut out of text on its way into a
/// reply.
///
/// The server strips them before the address is stored; the clone still gets
/// the address as typed, and a clone that fails quotes it. Same rule as the
/// server's `stripUrlCredentials`: http(s) loses the whole userinfo, ssh and
/// git only the password — `git@` is part of those addresses.
fn redact_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        let scheme: String = head[..idx]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        out.push_str(head);
        let end = tail
            .find(|c: char| matches!(c, '/' | '?' | '#') || c.is_whitespace())
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                let userinfo = &authority[..at];
                if matches!(scheme.to_ascii_lowercase().as_str(), "ssh" | "git") {
                    out.push_str(userinfo.split(':').next().unwrap_or(""));
                    if userinfo.contains(':') {
                        out.push_str(":<redacted>");
                    }
                } else {
                    out.push_str("<redacted>");
                }
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// What the daemon said, as a sentence: the `detail` of its problem body when
/// it answered with one, secrets removed, and the one failure whose cause is
/// invisible explained.
fn daemon_error_text(e: &DaemonError) -> String {
    let text = match e {
        DaemonError::Status { status, body, .. } => serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|b| {
                row_str(&b, "detail")
                    .or_else(|| row_str(&b, "title"))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| {
                format!(
                    "HTTP {status}: {}",
                    body.chars().take(300).collect::<String>()
                )
            }),
        other => other.to_string(),
    };
    let text = redact_url_credentials(&redact_deploy_secrets(&text));
    // Mirrors `mapSeedErrorReason`: git was asked nothing and printed nothing,
    // because it is the machine's credential helper that is waiting — often on
    // a window that has nowhere to appear.
    if text.contains("git clone timed out") {
        return format!(
            "{text} — usually this machine's git credential helper is waiting for a login prompt that cannot appear. Clone the repository once in a terminal, then retry."
        );
    }
    text
}

const DAEMON_DOWN: &str =
    "The local amuxd is not running, so nothing could be written on this machine.";

async fn daemon_post(
    path: &str,
    scope: &'static str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, DaemonError> {
    daemon::call_discovered::<_, Value>(
        RequestSpec::post(path, &[scope]).timeout(timeout),
        Some(body),
    )
    .await
}

/// Whether a folder is a git checkout, and its `origin` when it has one.
async fn daemon_folder_origin(dir: &str) -> Result<Option<String>, String> {
    match daemon_post(
        "/v1/apps/inspect-dir",
        "workspace:read",
        &json!({ "path": dir }),
        Duration::from_secs(30),
    )
    .await
    {
        Ok(out) if out.get("isGitRepo").and_then(Value::as_bool) == Some(true) => {
            Ok(row_str(&out, "gitRemoteUrl").map(str::to_string))
        }
        Ok(_) => Ok(None),
        Err(e) if daemon_unreachable(&e) => Err(
            "The local amuxd is not running, so the folder cannot be checked and no app was created."
                .to_string(),
        ),
        Err(e) => Err(format!("Checking {dir} failed: {}", daemon_error_text(&e))),
    }
}

/// Point the app at a directory already on this machine, leaving it in place.
async fn daemon_bind_workdir(row: &Value, dir: &str) -> Result<String, String> {
    let app_id = row_id(row)?;
    let path = format!("/v1/apps/{}/bind-workdir", urlencoding::encode(&app_id));
    let body = json!({ "teamId": row_str(row, "teamId"), "workdir": dir });
    match daemon_post(&path, "workspace:write", &body, Duration::from_secs(30)).await {
        Ok(out) => Ok(row_str(&out, "workdir").unwrap_or(dir).to_string()),
        Err(e) if daemon_unreachable(&e) => Err(DAEMON_DOWN.to_string()),
        Err(e) => Err(daemon_error_text(&e)),
    }
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
fn seed_git_identity(bearer: &str) -> (Option<String>, Option<String>) {
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

// ─── The app's workspace row ────────────────────────────────────────────────

/// `workspacePathsMatch` from `stores/session-utils.ts`, including its order
/// of normalisation, so both copies agree on which row is this directory's.
fn workspace_paths_match(a: &str, b: &str) -> bool {
    let normalise = |s: &str| s.trim_end_matches('/').replace('\\', "/");
    let (na, nb) = (normalise(a), normalise(b));
    na == nb || tilde_suffix_matches(&na, &nb) || tilde_suffix_matches(&nb, &na)
}

/// `~/rel/path` against `/abs/.../rel/path`: the whole tilde-relative suffix,
/// not just the last component, so `~/TeamClu` does not match every
/// teammate's `/Users/<name>/TeamClu` row.
fn tilde_suffix_matches(tilde_path: &str, absolute_path: &str) -> bool {
    let Some(rel) = tilde_path.strip_prefix("~/") else {
        return false;
    };
    let rel_parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if rel_parts.is_empty() {
        return false;
    }
    let abs_parts: Vec<&str> = absolute_path.split('/').filter(|p| !p.is_empty()).collect();
    abs_parts.len() >= rel_parts.len()
        && abs_parts[abs_parts.len() - rel_parts.len()..] == rel_parts[..]
}

/// This machine's daemon, as the actor its workspace rows belong to.
async fn local_daemon_actor_id() -> Option<String> {
    if let Some(id) = daemon::cached_actor_id() {
        return Some(id);
    }
    let endpoint = daemon::discover().ok()?;
    daemon::refresh_actor_id(&endpoint).await.ok().flatten()
}

/// Record where this machine keeps the app's checkout, on the workspace row
/// that stands for this machine's copy.
///
/// A port of `ensureAppWorkspaceRow`, rule for rule. The app's own row
/// (`apps.workspace_id`) is claimed only when it has no path yet or already
/// names this directory. A row with a different path belongs to another
/// machine's copy of the app — the same account on two computers has two
/// daemons and two checkouts against one `apps.workspace_id` — and is left
/// alone; this machine gets a row of its own, found by path or created.
///
/// Without this the app's workspace stays path-less until someone opens a
/// session on it, and a path-less workspace is one runtime-start resolves by
/// falling back to whatever folder the desktop happens to have open.
///
/// `createdByMemberId` is sent as null: the server derives it from the bearer
/// and ignores what a client says.
async fn bind_workspace_row(api: &AppApi, row: &Value, workdir: &str) -> Result<String, String> {
    let agent_id = local_daemon_actor_id()
        .await
        .ok_or("the local daemon has not reported which actor it is")?;
    let team_id = row_str(row, "teamId").ok_or("app row has no team")?;
    let app_name = row_str(row, "name").unwrap_or("app");
    let saved_id = |saved: Value| {
        row_str(&saved, "id")
            .map(str::to_string)
            .ok_or_else(|| "the workspace write returned no id".to_string())
    };

    if let Some(workspace_id) = row_str(row, "workspaceId") {
        let listing = api
            .post(
                "/v1/workspaces/by-ids",
                &json!({ "teamId": team_id, "ids": [workspace_id] }),
                "Reading the app's workspace row",
            )
            .await?;
        if let Some(workspace) = items_of(&listing).into_iter().next() {
            match row_str(&workspace, "path").or_else(|| row_str(&workspace, "slug")) {
                Some(path) if workspace_paths_match(path, workdir) => {
                    return Ok(workspace_id.to_string())
                }
                // Unclaimed: minted with the app, never bound to a directory.
                // Its existing name is kept — renaming it could collide with
                // one the user already has.
                None => {
                    let saved = api
                        .post(
                            "/v1/workspaces",
                            &json!({
                                "id": workspace_id,
                                "teamId": team_id,
                                "agentId": agent_id,
                                "createdByMemberId": null,
                                "name": row_str(&workspace, "name").unwrap_or(app_name),
                                "path": workdir,
                                "archived": false,
                            }),
                            "Recording where the app's checkout is",
                        )
                        .await?;
                    return saved_id(saved);
                }
                // Another machine's copy: fall through to this machine's own.
                Some(_) => {}
            }
        }
    }

    let listing = api
        .get(
            &format!(
                "/v1/workspaces?teamId={}&limit=200&agentId={}",
                urlencoding::encode(team_id),
                urlencoding::encode(&agent_id)
            ),
            "Listing this machine's workspaces",
        )
        .await?;
    if let Some(existing) = items_of(&listing).iter().find(|w| {
        w.get("archived").and_then(Value::as_bool) != Some(true)
            && row_str(w, "path")
                .or_else(|| row_str(w, "slug"))
                .is_some_and(|path| workspace_paths_match(path, workdir))
    }) {
        if let Some(id) = row_str(existing, "id") {
            return Ok(id.to_string());
        }
    }
    let created = api
        .post(
            "/v1/workspaces",
            &json!({
                "teamId": team_id,
                "agentId": agent_id,
                "createdByMemberId": null,
                "name": app_name,
                "path": workdir,
                "archived": false,
            }),
            "Registering this machine's workspace for the app",
        )
        .await?;
    saved_id(created)
}

/// The binding's outcome, as fields on a reply. Best-effort like the web
/// app's — a failed binding does not undo a checkout that exists — but said,
/// because the agent is the only one who would otherwise never find out.
async fn bind_workspace_fields(api: &AppApi, row: &Value, workdir: &str, report: &mut Value) {
    match bind_workspace_row(api, row, workdir).await {
        Ok(id) => report["workspace_id"] = json!(id),
        Err(e) => {
            report["workspace_warning"] = json!(format!(
                "The checkout is in place, but where it is could not be recorded ({e}). Opening a session on the app from TeamClu records it."
            ))
        }
    }
}

// ─── Seeding ────────────────────────────────────────────────────────────────

/// Write a terminal provision status back. Only `ready` and `error`; a daemon
/// that could not be reached writes nothing, so the row stays where reseed is
/// still offered.
async fn write_provision_status(api: &AppApi, row: &Value, status: &str) {
    if let Ok(app_id) = row_id(row) {
        let _ = api
            .send(
                reqwest::Method::PATCH,
                &app_path(&app_id, ""),
                Some(&json!({ "provisionStatus": status })),
                None,
            )
            .await;
    }
}

/// Seed the app's checkout: the starter template pushed to its repo, a clone
/// of an imported repo, or (with `adopt_existing`) a folder published as it is.
///
/// A port of `runSeed`. Whether a deploy key is fetched is keyed on how the
/// repo is authenticated, not on the row's status — requiring `repo_created`
/// made a reseed from `error` fetch no key, fall into the clone-only path, and
/// report an empty app as ready.
///
/// `clone_url` is the address as the caller typed it, when it differs from the
/// stored one: the server strips credentials before writing the row, and the
/// clone is the one call that still needs them.
///
/// Returns a report whose `outcome` is `seeded`, `failed` or `unreachable`.
async fn run_seed(
    api: &AppApi,
    row: &Value,
    adopt_existing: bool,
    clone_url: Option<&str>,
) -> Value {
    let app_id = row_str(row, "id").unwrap_or_default().to_string();
    let remote = clone_url.or_else(|| row_str(row, "gitRemoteUrl"));

    let credential = if is_gitea_managed(row) && row_str(row, "gitRemoteUrl").is_some() {
        match mint_git_credential(api, &app_id).await {
            Ok(cred) => Some(cred),
            Err(e) => {
                write_provision_status(api, row, "error").await;
                return json!({
                    "outcome": "failed",
                    "error": format!("Could not get a deploy key for the app's repository: {e}"),
                });
            }
        }
    } else {
        None
    };

    let (git_user_name, git_user_email) = seed_git_identity(api.bearer());
    let mut body = json!({
        "appId": app_id,
        "teamId": row_str(row, "teamId"),
        "appName": row_str(row, "name"),
        "appType": row_str(row, "type"),
    });
    if let Some(remote) = remote {
        body["gitRemoteUrl"] = json!(remote);
    }
    if let Some(cred) = &credential {
        body["deployKeyPem"] = json!(cred.private_key_pem.trim());
    }
    if adopt_existing {
        body["adoptExisting"] = json!(true);
    }
    if let Some(name) = git_user_name {
        body["gitUserName"] = json!(name);
    }
    if let Some(email) = git_user_email {
        body["gitUserEmail"] = json!(email);
    }

    let seeded = daemon_post("/v1/apps/seed", "workspace:write", &body, SEED_TIMEOUT).await;
    if let Some(cred) = &credential {
        return_git_credential(api, &app_id, cred.deploy_key_id).await;
    }

    match seeded {
        Ok(out) => {
            let mut report = json!({ "outcome": "seeded" });
            if let Some(workdir) = row_str(&out, "workdir") {
                report["workdir"] = json!(workdir);
                bind_workspace_fields(api, row, workdir, &mut report).await;
            }
            write_provision_status(api, row, "ready").await;
            report
        }
        Err(e) if daemon_unreachable(&e) => json!({
            "outcome": "unreachable",
            "error": format!("{DAEMON_DOWN} The app stays pending; run manage_app action \"reseed\" once amuxd is up."),
        }),
        Err(e) => {
            write_provision_status(api, row, "error").await;
            json!({ "outcome": "failed", "error": daemon_error_text(&e) })
        }
    }
}

/// Seed only a row that still needs it. A local checkout arrives `ready`, and
/// seeding it would write the starter template over the user's own files —
/// the status is the guard, not the flag, so a row that reached `ready` some
/// other way is treated the same.
async fn seed_if_needed(
    api: &AppApi,
    row: &Value,
    adopt_existing: bool,
    clone_url: Option<&str>,
) -> Value {
    match row_str(row, "provisionStatus") {
        Some("pending" | "repo_created") => run_seed(api, row, adopt_existing, clone_url).await,
        other => json!({ "outcome": "not_needed", "provision_status": other }),
    }
}

// ─── create ─────────────────────────────────────────────────────────────────

/// `POST /v1/apps`. It creates the Gitea repo before it answers — the web app
/// waits for that with no timeout, and the shared client's 30 s would report
/// an app the server went on to create as a failure.
async fn post_app(api: &AppApi, body: &Value) -> Result<Value, String> {
    api.call(
        reqwest::Method::POST,
        "/v1/apps",
        Some(body),
        Some(Duration::from_secs(120)),
        "Creating the app",
    )
    .await
}

/// `create` — a new app, and its code on this machine.
///
/// The row is created first and stays even when the checkout step fails, as it
/// does from the dialog; the reply says which step failed and how to finish.
pub(super) async fn create_app(app: &AppHandle, api: &AppApi, v: &Value) -> Result<Value, String> {
    let source = create_source(v)?;
    let team_id = introspect_current_team(app).await?;
    let requested_type = str_body_field(v, "type", "type");
    let mut create_body = json!({
        "teamId": team_id,
        "name": str_body_field(v, "name", "name"),
        "visibility": str_body_field(v, "visibility", "visibility").unwrap_or_else(|| "personal".to_string()),
    });
    let type_or = |default: &str| {
        json!(requested_type
            .clone()
            .unwrap_or_else(|| default.to_string()))
    };

    let (row, checkout) = match &source {
        CreateSource::Template => {
            create_body["type"] = type_or(DEFAULT_TEMPLATE_TYPE);
            let row = post_app(api, &create_body).await?;
            let checkout = seed_if_needed(api, &row, false, None).await;
            (row, checkout)
        }
        CreateSource::Remote(url) => {
            create_body["type"] = type_or(IMPORTED_TYPE);
            create_body["gitRemoteUrl"] = json!(url);
            let row = post_app(api, &create_body).await?;
            let checkout = seed_if_needed(api, &row, false, Some(url)).await;
            (row, checkout)
        }
        CreateSource::LocalDir(dir) => {
            // Checked before any row exists: a folder that is not there, or a
            // daemon that cannot look at it, should not leave an app behind.
            if !Path::new(dir).is_dir() {
                return Err(format!("{dir} is not a directory on this machine"));
            }
            let origin = daemon_folder_origin(dir).await?;
            create_body["type"] = type_or(IMPORTED_TYPE);
            match origin {
                // A checkout with a remote of its own: nothing to provision and
                // nothing to write, so the row comes back ready.
                Some(origin) => {
                    create_body["gitRemoteUrl"] = json!(origin);
                    create_body["localOnly"] = json!(true);
                    let row = post_app(api, &create_body).await?;
                    match daemon_bind_workdir(&row, dir).await {
                        Ok(workdir) => {
                            let mut checkout = json!({ "outcome": "bound", "workdir": workdir });
                            bind_workspace_fields(api, &row, &workdir, &mut checkout).await;
                            (row, checkout)
                        }
                        Err(e) => {
                            let checkout = json!({ "outcome": "failed", "error": format!("Could not point the app at {dir}: {e}") });
                            (row, checkout)
                        }
                    }
                }
                // Not a repo, or one nobody pushed: the app gets a repo of ours,
                // published from this folder as it stands.
                None => {
                    let row = post_app(api, &create_body).await?;
                    // Bound BEFORE seeding: the seed resolves the workdir from
                    // this binding, and seeding first would publish an empty
                    // default directory and leave the folder unattached.
                    match daemon_bind_workdir(&row, dir).await {
                        Ok(_) => {
                            let checkout = seed_if_needed(api, &row, true, None).await;
                            (row, checkout)
                        }
                        Err(e) => {
                            write_provision_status(api, &row, "error").await;
                            let checkout = json!({ "outcome": "failed", "error": format!("Could not use {dir}: {e}") });
                            (row, checkout)
                        }
                    }
                }
            }
        }
    };

    notify_app_changed(app, &row);
    let app_id = row_id(&row)?;
    let fresh = api
        .get(&app_path(&app_id, ""), "Reading the new app")
        .await
        .unwrap_or(row);
    let outcome = row_str(&checkout, "outcome").unwrap_or("").to_string();
    let ok = matches!(outcome.as_str(), "seeded" | "bound" | "not_needed");
    let next = match outcome.as_str() {
        "seeded" | "bound" => "The code is on this machine at checkout.workdir. Open the app in TeamClu to work on it in a session there; deploy with manage_app action \"deploy\".",
        "unreachable" => "Start amuxd, then run manage_app action \"reseed\" on this app.",
        "failed" => "The app exists but has no code yet. Fix the cause above, then run manage_app action \"reseed\" on this app.",
        _ => "Check the app with manage_app action \"status\".",
    };
    Ok(json!({
        "ok": ok,
        "action": "create",
        "app": app_brief(&fresh),
        "checkout": checkout,
        "next": next,
    }))
}

// ─── reseed / download / move ───────────────────────────────────────────────

/// A failed checkout report, as the error a tool call returns.
fn checkout_error(action: &str, report: &Value) -> String {
    format!(
        "{action} did not complete: {}",
        row_str(report, "error").unwrap_or("unknown failure")
    )
}

/// `reseed` — write the app's code again, for an app whose seed never ran or
/// failed.
pub(super) async fn reseed_app(
    app: &AppHandle,
    api: &AppApi,
    row: &Value,
) -> Result<Value, String> {
    reseed_allowed(row_str(row, "provisionStatus").unwrap_or(""))?;
    let report = run_seed(api, row, false, None).await;
    notify_app_changed(app, row);
    if row_str(&report, "outcome") != Some("seeded") {
        return Err(checkout_error("reseed", &report));
    }
    Ok(json!({
        "ok": true,
        "action": "reseed",
        "app_id": row_id(row)?,
        "checkout": report,
    }))
}

/// `download` — put a team app's code on this machine.
///
/// A port of `ensureAppCheckout`: nothing is cloned over a directory that
/// already has files in it, because the only thing that could do there is
/// destroy the checkout someone has.
pub(super) async fn download_app(
    app: &AppHandle,
    api: &AppApi,
    row: &Value,
) -> Result<Value, String> {
    let app_id = row_id(row)?;
    let status = row_str(row, "provisionStatus").unwrap_or("");
    if status != "ready" {
        return Err(format!(
            "This app's code has not been written anywhere yet (provision_status {status:?}), so there is nothing to download. Run reseed on it first."
        ));
    }
    let (workdir, device) = app_workdir_on_this_machine(row).await.ok_or(DAEMON_DOWN)?;
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
            mint_git_credential(api, &app_id)
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

    let (git_user_name, git_user_email) = seed_git_identity(api.bearer());
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
    let cloned = daemon_post("/v1/apps/seed", "workspace:write", &body, SEED_TIMEOUT).await;
    if let Some(cred) = &credential {
        return_git_credential(api, &app_id, cred.deploy_key_id).await;
    }
    let out = cloned.map_err(|e| {
        if daemon_unreachable(&e) {
            DAEMON_DOWN.to_string()
        } else {
            format!("Cloning the app failed: {}", daemon_error_text(&e))
        }
    })?;

    let workdir = row_str(&out, "workdir").unwrap_or(&workdir).to_string();
    let mut report = json!({
        "ok": true,
        "action": "download",
        "app_id": app_id,
        "workdir": workdir,
        "device_name": device,
        "already_present": false,
    });
    bind_workspace_fields(api, row, &workdir, &mut report).await;
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
    api: &AppApi,
    row: &Value,
    v: &Value,
) -> Result<Value, String> {
    let dest = move_destination(v)?;
    let app_id = row_id(row)?;
    let current = app_workdir_on_this_machine(row).await.map(|(w, _)| w);
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
    let out = daemon_post(&path, "workspace:write", &body, MOVE_TIMEOUT)
        .await
        .map_err(|e| {
            if daemon_unreachable(&e) {
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
    bind_workspace_fields(api, row, &workdir, &mut report).await;
    notify_app_changed(app, row);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_picks_its_source_and_refuses_ambiguity() {
        assert_eq!(
            create_source(&json!({ "name": "记账" })).unwrap(),
            CreateSource::Template
        );
        assert_eq!(
            create_source(&json!({ "name": "x", "git_remote_url": "https://github.com/o/r.git" }))
                .unwrap(),
            CreateSource::Remote("https://github.com/o/r.git".into())
        );
        assert_eq!(
            create_source(&json!({ "name": "x", "local_dir": "/work/site" })).unwrap(),
            CreateSource::LocalDir("/work/site".into())
        );

        assert!(create_source(&json!({})).unwrap_err().contains("name"));
        assert!(
            create_source(&json!({ "name": "x", "git_remote_url": "u", "local_dir": "/d" }))
                .unwrap_err()
                .contains("not both")
        );
        assert!(create_source(&json!({ "name": "x", "local_dir": "site" }))
            .unwrap_err()
            .contains("absolute"));
        assert!(
            create_source(&json!({ "name": "x", "type": "fullstack_tanstack_postgres" }))
                .unwrap_err()
                .contains("static_web")
        );
        assert!(
            create_source(&json!({ "name": "x", "visibility": "public" }))
                .unwrap_err()
                .contains("personal or team")
        );
    }

    #[test]
    fn reseed_is_only_for_an_app_without_working_code() {
        for status in ["pending", "repo_created", "error"] {
            assert!(reseed_allowed(status).is_ok(), "{status}");
        }
        let err = reseed_allowed("ready").unwrap_err();
        assert!(err.contains("over it"), "{err}");
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
    fn workspace_paths_match_the_way_the_web_app_matches_them() {
        assert!(workspace_paths_match("/Users/u/apps/a/", "/Users/u/apps/a"));
        assert!(workspace_paths_match("C:\\apps\\a", "C:/apps/a"));
        assert!(workspace_paths_match(
            "~/teams/t/apps/a",
            "/Users/u/teams/t/apps/a"
        ));
        assert!(workspace_paths_match(
            "/Users/u/teams/t/apps/a",
            "~/teams/t/apps/a"
        ));
        // The whole tilde suffix, not just its last component.
        assert!(!workspace_paths_match(
            "~/TeamClu",
            "/Users/other/Projects/TeamClu-2"
        ));
        assert!(!workspace_paths_match("~/apps/a", "/Users/u/work/b"));
        assert!(!workspace_paths_match("~/", "/Users/u"));
    }

    #[test]
    fn repo_credentials_never_reach_a_reply() {
        let text = "git clone https://x:ghp_secret@github.com/o/r.git failed";
        let safe = redact_url_credentials(text);
        assert!(!safe.contains("ghp_secret"), "{safe}");
        assert!(safe.contains("@github.com/o/r.git"), "{safe}");

        // ssh keeps the user (it is the address), loses a password.
        assert_eq!(
            redact_url_credentials("ssh://git:pw@git.example.com:2222/o/r.git"),
            "ssh://git:<redacted>@git.example.com:2222/o/r.git"
        );
        assert_eq!(
            redact_url_credentials("ssh://git@git.example.com/o/r.git"),
            "ssh://git@git.example.com/o/r.git"
        );
        assert_eq!(redact_url_credentials("no url here"), "no url here");
    }

    #[test]
    fn a_daemon_problem_body_reads_as_its_detail() {
        let e = DaemonError::Status {
            path: "/v1/apps/seed".into(),
            status: 500,
            body: r#"{"type":"https://teamclu/errors/internal","title":"Internal","status":500,"detail":"git clone timed out after 5 minutes","code":"internal"}"#.into(),
        };
        let text = daemon_error_text(&e);
        assert!(text.starts_with("git clone timed out"), "{text}");
        assert!(text.contains("credential helper"), "{text}");

        let e = DaemonError::Status {
            path: "/v1/apps/seed".into(),
            status: 502,
            body: "<html>bad gateway</html>".into(),
        };
        assert!(daemon_error_text(&e).contains("HTTP 502"));
        assert!(daemon_unreachable(&DaemonError::NotRunning));
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
