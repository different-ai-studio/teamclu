//! Putting an app's code on this machine: `create`, its seed, `reseed`,
//! `download`, and recording where the checkout is.
//!
//! Ports of the web app's flows — the same daemon calls, in the same order,
//! with the same writes back to the cloud:
//!
//! | here                     | web app                                                     |
//! |--------------------------|-------------------------------------------------------------|
//! | [`AppOps::create`]       | `CreateAppView.submit` + `create` in `stores/apps-store.ts` |
//! | [`run_seed`]             | `runSeed` in `stores/apps-store.ts`                         |
//! | [`AppOps::download`]     | `ensureAppCheckout` in `stores/apps-store.ts`               |
//! | [`bind_workspace_row`]   | `bindAppWorkdir` / `ensureAppWorkspaceRow` in `lib/apps/app-session.ts` |
//!
//! Two copies of these flows is the price of an agent's call working whether
//! or not anyone opened the Apps view. Keep them in step: a change to what the
//! web app sends the daemon, or to how it claims the app's workspace row,
//! belongs in both.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::daemon::{daemon_error_text, DAEMON_DOWN};
use crate::deploy::{mint_git_credential, return_git_credential};
use crate::row::{app_brief, app_path, is_gitea_managed, items_of, row_id, row_str, APP_TYPES};
use crate::status::dir_has_files;
use crate::{AppOps, Method};

/// The daemon allows a clone five minutes, then commits and pushes the seed.
pub const SEED_TIMEOUT: Duration = Duration::from_secs(10 * 60);

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
pub enum CreateSource {
    /// A starter template, in a repo this deployment provisions.
    Template,
    /// A repo someone already has, cloned into this machine's checkout.
    Remote(String),
    /// A folder already on this machine.
    LocalDir(String),
}

/// A `create` call, as the caller spelled it.
#[derive(Debug, Clone, Default)]
pub struct CreateArgs {
    pub name: Option<String>,
    /// `personal` (the default) or `team`.
    pub visibility: Option<String>,
    /// One of [`APP_TYPES`].
    pub app_type: Option<String>,
    pub git_remote_url: Option<String>,
    pub local_dir: Option<String>,
}

impl CreateArgs {
    /// Validate without touching anything, so a mistake costs no round trip
    /// and reads as the mistake it is.
    pub fn source(&self) -> Result<CreateSource, String> {
        if self.name.is_none() {
            return Err("create needs a name".to_string());
        }
        if let Some(visibility) = &self.visibility {
            if !matches!(visibility.as_str(), "personal" | "team") {
                return Err(format!(
                    "visibility must be personal or team (got {visibility:?})"
                ));
            }
        }
        if let Some(app_type) = &self.app_type {
            if !APP_TYPES.contains(&app_type.as_str()) {
                return Err(format!(
                    "type must be one of: {} (got {app_type:?})",
                    APP_TYPES.join(", ")
                ));
            }
        }
        match (&self.git_remote_url, &self.local_dir) {
            (Some(_), Some(_)) => Err(
                "pass a git remote or a local directory, not both — they are two different sources"
                    .to_string(),
            ),
            (Some(url), None) => Ok(CreateSource::Remote(url.clone())),
            (None, Some(dir)) if Path::new(dir).is_absolute() => {
                Ok(CreateSource::LocalDir(dir.clone()))
            }
            (None, Some(dir)) => Err(format!(
                "the local directory must be an absolute path (got {dir:?})"
            )),
            (None, None) => Ok(CreateSource::Template),
        }
    }
}

/// Reseeding writes a starter template, or clones, into the app's checkout —
/// which is exactly right for an app whose checkout was never written, and
/// exactly wrong for one that works. The control panel offers it on the same
/// three states (`canReseed`).
pub(crate) fn reseed_allowed(provision_status: &str) -> Result<(), String> {
    if matches!(provision_status, "pending" | "repo_created" | "error") {
        return Ok(());
    }
    Err(format!(
        "reseed is for an app whose code was never written or failed to be (provision_status pending, repo_created or error); this one is {provision_status:?}. Reseeding a working app would write the starter template or a clone over it."
    ))
}

// ─── The app's workspace row ────────────────────────────────────────────────

/// `workspacePathsMatch` from `stores/session-utils.ts`, including its order
/// of normalisation, so both copies agree on which row is this directory's.
pub fn workspace_paths_match(a: &str, b: &str) -> bool {
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
async fn bind_workspace_row(
    ops: &AppOps<'_>,
    row: &Value,
    workdir: &str,
) -> Result<String, String> {
    let agent_id = ops
        .daemon
        .actor_id()
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
        let listing = ops
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
                    let saved = ops
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

    let listing = ops
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
    let created = ops
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
pub async fn bind_workspace_fields(
    ops: &AppOps<'_>,
    row: &Value,
    workdir: &str,
    report: &mut Value,
) {
    match bind_workspace_row(ops, row, workdir).await {
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
pub async fn write_provision_status(ops: &AppOps<'_>, row: &Value, status: &str) {
    if let Ok(app_id) = row_id(row) {
        let _ = ops
            .cloud
            .send(
                Method::Patch,
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
pub async fn run_seed(
    ops: &AppOps<'_>,
    row: &Value,
    adopt_existing: bool,
    clone_url: Option<&str>,
) -> Value {
    let app_id = row_str(row, "id").unwrap_or_default().to_string();
    let remote = clone_url.or_else(|| row_str(row, "gitRemoteUrl"));

    let credential = if is_gitea_managed(row) && row_str(row, "gitRemoteUrl").is_some() {
        match mint_git_credential(ops, &app_id).await {
            Ok(cred) => Some(cred),
            Err(e) => {
                write_provision_status(ops, row, "error").await;
                return json!({
                    "outcome": "failed",
                    "error": format!("Could not get a deploy key for the app's repository: {e}"),
                });
            }
        }
    } else {
        None
    };

    let (git_user_name, git_user_email) = ops.host.git_identity();
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

    let seeded = ops.daemon.seed(&body, SEED_TIMEOUT).await;
    if let Some(cred) = &credential {
        return_git_credential(ops, &app_id, cred.deploy_key_id).await;
    }

    match seeded {
        Ok(out) => {
            let mut report = json!({ "outcome": "seeded" });
            if let Some(workdir) = row_str(&out, "workdir") {
                report["workdir"] = json!(workdir);
                bind_workspace_fields(ops, row, workdir, &mut report).await;
            }
            write_provision_status(ops, row, "ready").await;
            report
        }
        Err(e) if e.unreachable => json!({
            "outcome": "unreachable",
            "error": format!(
                "{DAEMON_DOWN} The app stays pending; run {} once amuxd is up.",
                ops.surface().step("manage_app", "reseed")
            ),
        }),
        Err(e) => {
            write_provision_status(ops, row, "error").await;
            json!({ "outcome": "failed", "error": daemon_error_text(&e) })
        }
    }
}

/// Seed only a row that still needs it. A local checkout arrives `ready`, and
/// seeding it would write the starter template over the user's own files —
/// the status is the guard, not the flag, so a row that reached `ready` some
/// other way is treated the same.
async fn seed_if_needed(
    ops: &AppOps<'_>,
    row: &Value,
    adopt_existing: bool,
    clone_url: Option<&str>,
) -> Value {
    match row_str(row, "provisionStatus") {
        Some("pending" | "repo_created") => run_seed(ops, row, adopt_existing, clone_url).await,
        other => json!({ "outcome": "not_needed", "provision_status": other }),
    }
}

// ─── create ─────────────────────────────────────────────────────────────────

impl AppOps<'_> {
    /// `POST /v1/apps`. It creates the Gitea repo before it answers — the web
    /// app waits for that with no timeout, and a 30 s client default would
    /// report an app the server went on to create as a failure.
    async fn post_app(&self, body: &Value) -> Result<Value, String> {
        self.call(
            Method::Post,
            "/v1/apps",
            Some(body),
            Some(Duration::from_secs(120)),
            "Creating the app",
        )
        .await
    }

    /// Drop a row that was created only so a clone could run, after that clone
    /// failed. Best-effort: the clone's reason is what the caller needs.
    async fn discard_created_app(&self, row: &Value) {
        let Ok(app_id) = row_id(row) else {
            return;
        };
        let _ = self
            .call(
                Method::Delete,
                &app_path(&app_id, ""),
                None,
                Some(Duration::from_secs(120)),
                "Removing the app whose clone failed",
            )
            .await;
    }

    /// Whether a folder is a git checkout, and its `origin` when it has one.
    async fn folder_origin(&self, dir: &str) -> Result<Option<String>, String> {
        match self.daemon.inspect_dir(dir).await {
            Ok(out) if out.get("isGitRepo").and_then(Value::as_bool) == Some(true) => {
                Ok(row_str(&out, "gitRemoteUrl").map(str::to_string))
            }
            Ok(_) => Ok(None),
            Err(e) if e.unreachable => Err(
                "The local amuxd is not running, so the folder cannot be checked and no app was created."
                    .to_string(),
            ),
            Err(e) => Err(format!("Checking {dir} failed: {}", daemon_error_text(&e))),
        }
    }

    /// Point the app at a directory already on this machine, leaving it in place.
    async fn bind_workdir(&self, row: &Value, dir: &str) -> Result<String, String> {
        let app_id = row_id(row)?;
        let team_id = row_str(row, "teamId").unwrap_or("");
        match self.daemon.bind_workdir(&app_id, team_id, dir).await {
            Ok(out) => Ok(row_str(&out, "workdir").unwrap_or(dir).to_string()),
            Err(e) if e.unreachable => Err(DAEMON_DOWN.to_string()),
            Err(e) => Err(daemon_error_text(&e)),
        }
    }

    /// `create` — a new app in `team_id`, and its code on this machine.
    ///
    /// The row is created first. A template or local-folder app keeps it even
    /// when the checkout step fails, as the dialog does, and the reply says
    /// which step failed and how to finish. An import whose clone fails is
    /// removed instead, again as the dialog does: a row with no code and a
    /// repository this machine could not reach is an empty shell that looks
    /// like a created app.
    pub async fn create(&self, team_id: &str, args: &CreateArgs) -> Result<Value, String> {
        let source = args.source()?;
        let mut create_body = json!({
            "teamId": team_id,
            "name": args.name,
            "visibility": args.visibility.clone().unwrap_or_else(|| "personal".to_string()),
        });
        let type_or =
            |default: &str| json!(args.app_type.clone().unwrap_or_else(|| default.to_string()));

        let (row, checkout) = match &source {
            CreateSource::Template => {
                create_body["type"] = type_or(DEFAULT_TEMPLATE_TYPE);
                let row = self.post_app(&create_body).await?;
                let checkout = seed_if_needed(self, &row, false, None).await;
                (row, checkout)
            }
            CreateSource::Remote(url) => {
                create_body["type"] = type_or(IMPORTED_TYPE);
                create_body["gitRemoteUrl"] = json!(url);
                let row = self.post_app(&create_body).await?;
                let checkout = seed_if_needed(self, &row, false, Some(url)).await;
                if row_str(&checkout, "outcome") == Some("failed") {
                    self.discard_created_app(&row).await;
                    self.host.app_changed(&row);
                    return Err(format!(
                        "Cloning {url} failed, so the app was not kept: {}",
                        row_str(&checkout, "error").unwrap_or("unknown failure")
                    ));
                }
                (row, checkout)
            }
            CreateSource::LocalDir(dir) => {
                // Checked before any row exists: a folder that is not there, or
                // a daemon that cannot look at it, should not leave an app behind.
                if !Path::new(dir).is_dir() {
                    return Err(format!("{dir} is not a directory on this machine"));
                }
                let origin = self.folder_origin(dir).await?;
                create_body["type"] = type_or(IMPORTED_TYPE);
                match origin {
                    // A checkout with a remote of its own: nothing to provision
                    // and nothing to write, so the row comes back ready.
                    Some(origin) => {
                        create_body["gitRemoteUrl"] = json!(origin);
                        create_body["localOnly"] = json!(true);
                        let row = self.post_app(&create_body).await?;
                        match self.bind_workdir(&row, dir).await {
                            Ok(workdir) => {
                                let mut checkout =
                                    json!({ "outcome": "bound", "workdir": workdir });
                                bind_workspace_fields(self, &row, &workdir, &mut checkout).await;
                                (row, checkout)
                            }
                            Err(e) => {
                                let checkout = json!({ "outcome": "failed", "error": format!("Could not point the app at {dir}: {e}") });
                                (row, checkout)
                            }
                        }
                    }
                    // Not a repo, or one nobody pushed: the app gets a repo of
                    // ours, published from this folder as it stands.
                    None => {
                        let row = self.post_app(&create_body).await?;
                        // Bound BEFORE seeding: the seed resolves the workdir
                        // from this binding, and seeding first would publish an
                        // empty default directory and leave the folder unattached.
                        match self.bind_workdir(&row, dir).await {
                            Ok(_) => {
                                let checkout = seed_if_needed(self, &row, true, None).await;
                                (row, checkout)
                            }
                            Err(e) => {
                                write_provision_status(self, &row, "error").await;
                                let checkout = json!({ "outcome": "failed", "error": format!("Could not use {dir}: {e}") });
                                (row, checkout)
                            }
                        }
                    }
                }
            }
        };

        self.host.app_changed(&row);
        let app_id = row_id(&row)?;
        let fresh = self
            .get(&app_path(&app_id, ""), "Reading the new app")
            .await
            .unwrap_or(row);
        let outcome = row_str(&checkout, "outcome").unwrap_or("").to_string();
        let ok = matches!(outcome.as_str(), "seeded" | "bound" | "not_needed");
        let surface = self.surface();
        let next = match outcome.as_str() {
            "seeded" | "bound" => format!(
                "The code is on this machine at checkout.workdir. Edit it there, commit, then deploy with {}.",
                surface.step("manage_app", "deploy")
            ),
            "unreachable" => format!(
                "Start amuxd, then run {} on this app.",
                surface.step("manage_app", "reseed")
            ),
            "failed" => format!(
                "The app exists but has no code yet. Fix the cause above, then run {} on this app.",
                surface.step("manage_app", "reseed")
            ),
            _ => format!(
                "Check the app with {}.",
                surface.step("manage_app", "status")
            ),
        };
        Ok(json!({
            "ok": ok,
            "action": "create",
            "app": app_brief(&fresh),
            "checkout": checkout,
            "next": next,
        }))
    }

    /// `reseed` — write the app's code again, for an app whose seed never ran
    /// or failed.
    pub async fn reseed(&self, row: &Value) -> Result<Value, String> {
        reseed_allowed(row_str(row, "provisionStatus").unwrap_or(""))?;
        let report = run_seed(self, row, false, None).await;
        self.host.app_changed(row);
        if row_str(&report, "outcome") != Some("seeded") {
            return Err(format!(
                "reseed did not complete: {}",
                row_str(&report, "error").unwrap_or("unknown failure")
            ));
        }
        Ok(json!({
            "ok": true,
            "action": "reseed",
            "app_id": row_id(row)?,
            "checkout": report,
        }))
    }
}

/// Whether an app in `provision_status` has anything to download.
///
/// A hosted repo short of `ready` was never seeded, so a clone would fetch an
/// empty repository. An imported one is not ours to be unready: its status
/// only says whether the creator's own clone worked, and the repository is
/// there to fetch either way. Same rule as `ensureAppCheckout`.
fn download_allowed(
    surface: crate::Surface,
    provision_status: &str,
    gitea_managed: bool,
    has_remote: bool,
) -> Result<(), String> {
    if provision_status == "ready" || (!gitea_managed && has_remote) {
        return Ok(());
    }
    Err(format!(
        "This app's code has not been written anywhere yet (provision_status {provision_status:?}), so there is nothing to download. Run {} on it first.",
        surface.step("manage_app", "reseed")
    ))
}

impl AppOps<'_> {
    /// `download` — put a team app's code on this machine.
    ///
    /// Nothing is cloned over a directory that already has files in it,
    /// because the only thing that could do there is destroy the checkout
    /// someone has.
    pub async fn download(&self, row: &Value) -> Result<Value, String> {
        let app_id = row_id(row)?;
        let status = row_str(row, "provisionStatus").unwrap_or("");
        download_allowed(
            self.surface(),
            status,
            is_gitea_managed(row),
            row_str(row, "gitRemoteUrl").is_some(),
        )?;
        let (workdir, device) = self
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
                mint_git_credential(self, &app_id)
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

        let (git_user_name, git_user_email) = self.host.git_identity();
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
        let cloned = self.daemon.seed(&body, SEED_TIMEOUT).await;
        if let Some(cred) = &credential {
            return_git_credential(self, &app_id, cred.deploy_key_id).await;
        }
        let out = cloned.map_err(|e| {
            if e.unreachable {
                DAEMON_DOWN.to_string()
            } else {
                format!("Cloning the app failed: {}", daemon_error_text(&e))
            }
        })?;

        let workdir = row_str(&out, "workdir").unwrap_or(&workdir).to_string();
        // An import whose first clone failed elsewhere now has its code here,
        // which is what `ready` means. The server lets only an admin write it;
        // for anyone else the write is refused and the download still stands.
        if status != "ready" {
            write_provision_status(self, row, "ready").await;
        }
        let mut report = json!({
            "ok": true,
            "action": "download",
            "app_id": app_id,
            "workdir": workdir,
            "device_name": device,
            "already_present": false,
        });
        bind_workspace_fields(self, row, &workdir, &mut report).await;
        self.host.app_changed(row);
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{FakeCloud, FakeDaemon, TestHost};
    use crate::{DaemonError, Surface};

    fn args(f: impl FnOnce(&mut CreateArgs)) -> CreateArgs {
        let mut a = CreateArgs {
            name: Some("x".into()),
            ..Default::default()
        };
        f(&mut a);
        a
    }

    #[test]
    fn create_picks_its_source_and_refuses_ambiguity() {
        assert_eq!(args(|_| {}).source().unwrap(), CreateSource::Template);
        assert_eq!(
            args(|a| a.git_remote_url = Some("https://github.com/o/r.git".into()))
                .source()
                .unwrap(),
            CreateSource::Remote("https://github.com/o/r.git".into())
        );
        assert_eq!(
            args(|a| a.local_dir = Some("/work/site".into()))
                .source()
                .unwrap(),
            CreateSource::LocalDir("/work/site".into())
        );

        assert!(CreateArgs::default().source().unwrap_err().contains("name"));
        assert!(args(|a| {
            a.git_remote_url = Some("u".into());
            a.local_dir = Some("/d".into());
        })
        .source()
        .unwrap_err()
        .contains("not both"));
        assert!(args(|a| a.local_dir = Some("site".into()))
            .source()
            .unwrap_err()
            .contains("absolute"));
        assert!(
            args(|a| a.app_type = Some("fullstack_tanstack_postgres".into()))
                .source()
                .unwrap_err()
                .contains("static_web")
        );
        assert!(args(|a| a.visibility = Some("public".into()))
            .source()
            .unwrap_err()
            .contains("personal or team"));
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
    fn an_import_downloads_whatever_its_status_but_a_hosted_repo_must_be_ready() {
        let ok = |status, gitea, remote| download_allowed(Surface::Mcp, status, gitea, remote);
        assert!(ok("ready", true, true).is_ok());
        for status in ["pending", "repo_created", "error"] {
            // A hosted repo short of ready was never seeded and would clone empty.
            assert!(ok(status, true, true).is_err(), "{status}");
            // An import's status is the creator's own clone; the repo is still there.
            assert!(ok(status, false, true).is_ok(), "{status}");
        }
        // With no remote there is nothing to fetch from, whatever the status.
        assert!(ok("error", false, false).is_err());
    }

    #[tokio::test]
    async fn a_hosted_app_downloads_with_a_minted_key_it_then_returns() {
        let cloud = FakeCloud::default();
        cloud.reply(
            Method::Get,
            "/v1/apps/a1/git-credential",
            json!({ "remoteUrl": "ssh://git@gitea/t/a1.git", "privateKeyPem": "PEM", "deployKeyId": 3 }),
        );
        cloud.reply(Method::Delete, "/v1/apps/a1/git-credential/3", json!({}));
        cloud.reply(
            Method::Get,
            "/v1/workspaces?teamId=t1&limit=200&agentId=agent-1",
            json!({ "items": [{ "id": "ws-9", "path": "/nonexistent-checkout/a1" }] }),
        );
        let daemon = FakeDaemon::default();
        *daemon.seed.lock().unwrap() = Some(Ok(
            json!({ "status": "ready", "workdir": "/nonexistent-checkout/a1" }),
        ));
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);
        let row = json!({ "id": "a1", "teamId": "t1", "provisionStatus": "ready", "gitAuthKind": "gitea_deploy_key" });

        let out = ops.download(&row).await.unwrap();
        assert_eq!(out["already_present"], false);
        assert_eq!(out["workspace_id"], "ws-9");
        let seed = daemon.seeds.lock().unwrap()[0].clone();
        assert_eq!(seed["cloneOnly"], true);
        assert_eq!(seed["gitRemoteUrl"], "ssh://git@gitea/t/a1.git");
        assert_eq!(seed["deployKeyPem"], "PEM");
        assert_eq!(
            cloud
                .calls_to(Method::Delete, "/v1/apps/a1/git-credential/3")
                .len(),
            1
        );
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

    /// A template app: the server answers with a Gitea-managed `repo_created`
    /// row, the seed pushes the template with a minted key, and the key goes
    /// back afterwards.
    #[tokio::test]
    async fn a_template_app_is_created_seeded_and_bound() {
        let cloud = FakeCloud::default();
        let row = json!({
            "id": "a1", "teamId": "t1", "name": "记账", "type": "static_web",
            "provisionStatus": "repo_created", "gitAuthKind": "gitea_deploy_key",
            "gitRemoteUrl": "ssh://git@gitea/t/a1.git",
        });
        cloud.reply(Method::Post, "/v1/apps", row.clone());
        cloud.reply(
            Method::Get,
            "/v1/apps/a1/git-credential",
            json!({ "remoteUrl": "ssh://git@gitea/t/a1.git", "privateKeyPem": "PEM", "deployKeyId": 7 }),
        );
        cloud.reply(Method::Delete, "/v1/apps/a1/git-credential/7", json!({}));
        cloud.reply(Method::Patch, "/v1/apps/a1", json!({}));
        cloud.reply(
            Method::Get,
            "/v1/workspaces?teamId=t1&limit=200&agentId=agent-1",
            json!({ "items": [] }),
        );
        cloud.reply(Method::Post, "/v1/workspaces", json!({ "id": "ws-1" }));
        let daemon = FakeDaemon::default();
        *daemon.seed.lock().unwrap() =
            Some(Ok(json!({ "status": "seeded", "workdir": "/apps/a1" })));
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);

        let out = ops
            .create(
                "t1",
                &CreateArgs {
                    name: Some("记账".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["checkout"]["workdir"], "/apps/a1");
        assert_eq!(out["checkout"]["workspace_id"], "ws-1");
        assert!(out["next"].as_str().unwrap().contains("`amuxd app deploy`"));

        let create = cloud.calls_to(Method::Post, "/v1/apps")[0].clone().unwrap();
        assert_eq!(create["type"], "static_web");
        assert_eq!(create["visibility"], "personal");
        assert_eq!(daemon.seeds.lock().unwrap()[0]["deployKeyPem"], "PEM");
        assert_eq!(
            cloud
                .calls_to(Method::Delete, "/v1/apps/a1/git-credential/7")
                .len(),
            1
        );
        let status = cloud.calls_to(Method::Patch, "/v1/apps/a1");
        assert_eq!(status[0].as_ref().unwrap()["provisionStatus"], "ready");
    }

    #[tokio::test]
    async fn an_import_whose_clone_fails_is_not_kept() {
        let cloud = FakeCloud::default();
        cloud.reply(
            Method::Post,
            "/v1/apps",
            json!({ "id": "a2", "teamId": "t1", "provisionStatus": "pending", "gitRemoteUrl": "https://github.com/o/r.git" }),
        );
        cloud.reply(Method::Delete, "/v1/apps/a2", json!({}));
        cloud.reply(Method::Patch, "/v1/apps/a2", json!({}));
        let daemon = FakeDaemon::default();
        *daemon.seed.lock().unwrap() = Some(Err(DaemonError::failed("repository not found")));
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);

        let err = ops
            .create(
                "t1",
                &CreateArgs {
                    name: Some("r".into()),
                    git_remote_url: Some("https://github.com/o/r.git".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(
            err.contains("not kept") && err.contains("repository not found"),
            "{err}"
        );
        assert_eq!(cloud.calls_to(Method::Delete, "/v1/apps/a2").len(), 1);
        let create = cloud.calls_to(Method::Post, "/v1/apps")[0].clone().unwrap();
        assert_eq!(create["type"], "imported");
    }
}
