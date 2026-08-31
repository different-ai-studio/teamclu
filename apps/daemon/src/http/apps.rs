//! `POST /v1/apps/seed` — put an app's files into its checkout.
//!
//! Seeding is the blocking write-template flow in
//! [`crate::sync::app_seed::seed_app_repo`]. It needs no network: the templates
//! are compiled into this binary ([`crate::sync::app_templates`]). The daemon
//! owns it because it is the one with the filesystem; the desktop kicks it over
//! loopback right after the cloud API creates the app row.
//!
//! ### Body shape — optional `workdir`
//!
//! `workdir` is an *optional* explicit absolute path to seed into. When the
//! caller (the desktop) omits it — which it does, because the desktop does not
//! know a local path for the app — the daemon resolves a per-app workdir under
//! the app's own team: `<amuxd home>/teams/<teamId>/apps/<appId>`. When
//! `workdir` *is* present and non-empty, it is used verbatim.
//!
//! `teamId` is therefore load-bearing, not bookkeeping: it used to be ignored
//! in favour of whichever team this daemon happened to be claimed by, so an app
//! created after a team switch landed in another team's directory. `appId` is
//! load-bearing too when `workdir` is omitted (it names the subdir).
//!
//! The daemon's workspace registry only maps ids → paths through the actor
//! channel (see `register_workspace`), and an app's checkout does not yet exist
//! in any registry. `workspaceId` is accepted for caller bookkeeping only.
//! The target may already exist — seeding writes over it.
//!
//! ### Seeding vs cloning vs Gitea push
//!
//! Three paths, depending on the body:
//!
//! - **`gitRemoteUrl` + `deployKeyPem`** — write the starter template, init git,
//!   commit, and push to Gitea (`status: "seeded"`, `gitCommitSha` returned).
//! - **`gitRemoteUrl` only** — clone an existing repo; no template
//!   ([`crate::sync::app_clone`], `status: "ready"`).
//! - **Neither** — template only, backwards compatible (`status: "ready"`).

use std::path::PathBuf;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

/// The daemon's data root for per-app checkouts: `teams/<active>/apps`.
///
/// It used to say it mirrored `DaemonConfig::config_dir()` while actually
/// re-deriving `$HOME/.amuxd` by hand — so it honoured neither `$AMUXD_HOME`
/// nor the brand, and a white-label daemon cloned apps into the official
/// build's home. Call the real thing.
///
/// It then lived under `state/`, which is daemon bookkeeping; an app checkout
/// is the user's own project. Existing checkouts are moved by
/// [`migrate_legacy_apps_root`], which the daemon calls once at startup.
///
/// This function only computes a path. It briefly did the migration too, and a
/// plain `cargo test` — which runs against the real `$HOME` — then renamed a
/// developer's actual app directory as a side effect of asking where apps live.
pub fn apps_data_root() -> PathBuf {
    crate::config::layout::active_apps_dir()
}

/// Move `state/apps` to its new home beside it, once. Called at startup.
///
/// A rename, so every checkout keeps its identity, its git history and its
/// `node_modules`. Skipped when the destination already exists: merging two
/// app roots is not a decision this function can make, and the legacy one is
/// left untouched for recovery rather than deleted.
///
/// Deliberately NOT called from `apps_data_root()`: a path accessor that moves
/// directories rewrote a developer's home during an ordinary `cargo test`.
pub fn migrate_legacy_apps_root() {
    let legacy = crate::config::layout::active_state_dir().join("apps");
    migrate_legacy_apps_root_from(&legacy, &apps_data_root());
}

/// [`migrate_legacy_apps_root`] with both paths given, so the rule is testable
/// without pointing the whole daemon at a temp home.
fn migrate_legacy_apps_root_from(legacy: &std::path::Path, dest: &std::path::Path) {
    if dest.exists() {
        return;
    }
    if !legacy.is_dir() {
        return;
    }
    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!(error = %e, "apps: could not create team dir for migration");
            return;
        }
    }
    match std::fs::rename(legacy, dest) {
        Ok(()) => {
            tracing::info!(from = %legacy.display(), to = %dest.display(), "apps: moved app root out of state/")
        }
        Err(e) => {
            tracing::warn!(error = %e, from = %legacy.display(), "apps: could not move app root; leaving it in place")
        }
    }
}

/// `teams/<teamId>/apps` — the app root for one specific team.
///
/// Falls back to the active team's root when the caller names no team, which
/// is what every pre-`teamId` client does.
fn apps_root_for_team(team_id: &str) -> PathBuf {
    let team_id = team_id.trim();
    if team_id.is_empty() {
        apps_data_root()
    } else {
        crate::config::layout::team_apps_dir(team_id)
    }
}

/// Resolve the checkout directory for an app.
///
/// If `workdir` is present and non-empty, use it verbatim (legacy explicit
/// path). Otherwise consult the per-machine override in
/// `teams/<teamId>/state/app-workdir-overrides.json`, then
/// `teams/<teamId>/apps/<appId>`, with one back-compat step: an app that
/// already has a checkout under the *active* team's root keeps it.
/// Before this, the root came from the active team alone, so an app created
/// while the daemon was claimed by another team is sitting there — and moving
/// it silently is how a user's work goes missing. Both answers are stable, so
/// the agent, the file browser and `deploy` all keep naming the same directory.
///
/// `app_id` must be non-empty in the default-workdir case (it names the subdir).
fn resolve_workdir(workdir: &str, app_id: &str, team_id: &str) -> Result<PathBuf, HttpError> {
    let workdir = workdir.trim();
    if !workdir.is_empty() {
        return Ok(PathBuf::from(workdir));
    }
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Err(HttpError::validation(
            "appId must not be empty when workdir is omitted",
        ));
    }
    if let Some(override_path) = crate::sync::app_workdir::read_override(team_id, app_id) {
        return Ok(override_path);
    }
    Ok(resolve_workdir_in(
        &apps_root_for_team(team_id),
        &apps_data_root(),
        app_id,
    ))
}

/// Derived checkout path without consulting overrides — for move/update logic.
fn derived_workdir(app_id: &str, team_id: &str) -> Result<PathBuf, HttpError> {
    let app_id = app_id.trim();
    if app_id.is_empty() {
        return Err(HttpError::validation(
            "appId must not be empty when workdir is omitted",
        ));
    }
    Ok(resolve_workdir_in(
        &apps_root_for_team(team_id),
        &apps_data_root(),
        app_id,
    ))
}

/// [`resolve_workdir`]'s rule with both roots given, so it is testable without
/// pointing the whole daemon at a temp home.
fn resolve_workdir_in(
    team_root: &std::path::Path,
    active_root: &std::path::Path,
    app_id: &str,
) -> PathBuf {
    let by_team = team_root.join(app_id);
    if by_team.exists() || team_root == active_root {
        return by_team;
    }
    let legacy = active_root.join(app_id);
    if legacy.exists() {
        return legacy;
    }
    by_team
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppBody {
    /// Cloud app id — names the per-app workdir when `workdir` is omitted, and
    /// is substituted into the template's `AGENTS.md`.
    #[serde(default)]
    pub app_id: String,
    /// App name, shown to the agent in `AGENTS.md`. Falls back to the app id.
    #[serde(default)]
    pub app_name: String,
    /// App type (`static_web` / `slides` / `data_app`) — selects the template.
    /// Unknown or empty resolves to `data_app`, which is what every app created
    /// before types existed actually is. Ignored when `gitRemoteUrl` is set:
    /// an imported repo gets no template.
    #[serde(default)]
    pub app_type: String,
    /// Optional repo to import (clone-only when no deploy key) or push target
    /// (with `deployKeyPem`).
    #[serde(default)]
    pub git_remote_url: Option<String>,
    /// Gitea deploy key PEM for seed push / deploy fetch. Required with
    /// `gitRemoteUrl` on the Gitea seed path; optional for import-only clone.
    #[serde(default)]
    pub deploy_key_pem: Option<String>,
    /// Team id — names the app's directory (`teams/<teamId>/apps/<appId>`).
    #[serde(default)]
    pub team_id: String,
    /// Workspace id — for caller correlation only; the target is `workdir`,
    /// not a registry-resolved path.
    #[serde(default)]
    pub workspace_id: String,
    /// Optional absolute path to seed into. When omitted/empty the daemon
    /// resolves `<amuxd home>/apps/<appId>`.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Git commit author name for repo-local `.git/config`. Falls back to the
    /// daemon default when omitted.
    #[serde(default)]
    pub git_user_name: Option<String>,
    /// Git commit author email for repo-local `.git/config`. Falls back to the
    /// daemon default when omitted.
    #[serde(default)]
    pub git_user_email: Option<String>,
    /// When true with `gitRemoteUrl` + `deployKeyPem`, clone the remote into an
    /// empty workdir instead of seeding a starter template and pushing.
    #[serde(default)]
    pub clone_only: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppResponse {
    pub status: &'static str,
    /// Where the app actually lives. Returned so the caller never has to
    /// compute it: the desktop used to derive `~/.amuxd/apps/<id>` by hand,
    /// which stopped matching this daemon's answer the moment the layout moved
    /// — the agent then edited one directory while deploys built another, and
    /// the deployed site silently stayed the seed template.
    pub workdir: String,
    /// HEAD on Gitea after a successful seed push.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_commit_sha: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWorkdirResponse {
    pub workdir: String,
    /// Human-friendly label for this machine (from daemon.toml `[actor].name`).
    pub device_name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWorkdirQuery {
    /// The app's team. Optional — omitted by clients older than the per-team
    /// app root, which then get the active team's answer.
    pub team_id: Option<String>,
}

/// `GET /v1/apps/:appId/workdir?teamId=…` — where this daemon keeps that app.
///
/// The single source of truth for the path, for callers that did not just seed
/// (opening the app's session, revealing it in Finder). Answers for an app that
/// has never been seeded too: the path is derived, not looked up. `teamId` is
/// optional and falls back to the active team, so an older desktop still gets
/// the answer it used to.
pub async fn app_workdir(
    principal: Principal,
    State(_state): State<HttpState>,
    axum::extract::Path(app_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<AppWorkdirQuery>,
) -> Result<Json<AppWorkdirResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let team_id = query.team_id.as_deref().unwrap_or("");
    let path = resolve_workdir("", &app_id, team_id)?;
    Ok(Json(AppWorkdirResponse {
        workdir: path.to_string_lossy().into_owned(),
        device_name: daemon_device_name(),
    }))
}

fn daemon_device_name() -> String {
    crate::config::daemon_host_label()
}

/// `POST /v1/apps/seed` — put the app's files in place.
///
/// See [`SeedAppBody`] for the three seed paths. Requires `workspace:write`.
/// Returns `{ "status": "ready" | "seeded", "workdir": …, "gitCommitSha"? }`.
/// The work runs on a blocking thread.
///
/// Re-seeding an existing template checkout is safe: the template is written
/// over the top, so a wrecked app can be repaired without losing the agent's
/// other files. Re-seeding a *cloned* app is refused rather than made safe —
/// `app_clone` will not clone over a non-empty directory, because the only
/// thing it could do there is destroy the user's repo.
pub async fn seed_app(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<SeedAppBody>,
) -> Result<Json<SeedAppResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let workdir_path = resolve_workdir(
        body.workdir.as_deref().unwrap_or(""),
        &body.app_id,
        &body.team_id,
    )?;
    if let Some(parent) = workdir_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let seeded_at = workdir_path.to_string_lossy().into_owned();

    let app_id = body.app_id.trim().to_string();
    let app_name = if body.app_name.trim().is_empty() {
        app_id.clone()
    } else {
        body.app_name.trim().to_string()
    };
    let app_type = crate::sync::app_templates::AppType::parse(&body.app_type);
    let git_remote_url = body
        .git_remote_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    let deploy_key_pem = body
        .deploy_key_pem
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    let git_user_name = body
        .git_user_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string);
    let git_user_email = body
        .git_user_email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);

    let seed_result = tokio::task::spawn_blocking(move || {
        let vars = crate::sync::app_templates::TemplateVars {
            app_id: &app_id,
            app_name: &app_name,
            app_type,
        };
        let clone_only = body.clone_only.unwrap_or(false);
        match (git_remote_url.as_deref(), deploy_key_pem.as_deref()) {
            (Some(url), Some(key)) if clone_only => {
                crate::sync::app_clone::clone_app_repo_with_deploy_key(
                    url,
                    &workdir_path,
                    key,
                    git_user_name.as_deref(),
                    git_user_email.as_deref(),
                )?;
                Ok(("ready", None))
            }
            (Some(url), Some(key)) => {
                let push = crate::sync::app_seed::SeedGitPush {
                    remote_url: url,
                    deploy_key_pem: key,
                    git_user_name: git_user_name.as_deref(),
                    git_user_email: git_user_email.as_deref(),
                };
                let out = crate::sync::app_seed::seed_app_repo(&workdir_path, &vars, Some(&push))?;
                Ok(("seeded", out.git_commit_sha))
            }
            (Some(url), None) => {
                crate::sync::app_clone::clone_app_repo(url, &workdir_path)?;
                Ok(("ready", None))
            }
            (None, Some(_)) => {
                anyhow::bail!("deployKeyPem requires gitRemoteUrl");
            }
            (None, None) => {
                crate::sync::app_seed::seed_app_repo(&workdir_path, &vars, None)?;
                Ok(("ready", None))
            }
        }
    })
    .await
    .map_err(|e| HttpError::internal(format!("seed task panicked: {e}")))?
    .map_err(map_seed_error)?;

    Ok(Json(SeedAppResponse {
        status: seed_result.0,
        workdir: seeded_at,
        git_commit_sha: seed_result.1,
    }))
}

fn map_seed_error(err: anyhow::Error) -> HttpError {
    let msg = format!("{err}");
    if msg.contains("deployKeyPem requires")
        || msg.contains("git repo URL")
        || msg.starts_with("git clone failed")
        || msg.contains("refusing to clone")
    {
        HttpError::validation(msg)
    } else {
        HttpError::internal(format!("app seed failed: {msg}"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAppBody {
    /// Cloud app id — names the per-app workdir when `workdir` is omitted.
    #[serde(default)]
    pub app_id: String,
    /// Team id — names the app's directory, exactly as in [`SeedAppBody`]. A
    /// build that resolved a different directory than the seed did would zip
    /// the starter template and deploy that.
    #[serde(default)]
    pub team_id: String,
    /// Workspace id — for caller correlation only.
    #[serde(default)]
    pub workspace_id: String,
    /// Optional explicit workdir path; defaults to
    /// `<amuxd home>/teams/<teamId>/apps/<appId>`.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Commit to build (must exist on the remote). Part of the git triple
    /// below — supplied for Gitea-managed apps, omitted for imported ones.
    #[serde(default)]
    pub git_commit_sha: String,
    /// Git remote for fetch/checkout. See `git_commit_sha`.
    #[serde(default)]
    pub git_remote_url: String,
    /// Deploy key PEM for SSH access during fetch. See `git_commit_sha`.
    #[serde(default)]
    pub deploy_key_pem: String,
    /// Presigned OSS PUT URL for the build artifact. Short-lived signed-URL
    /// secret — REQUIRED, and never logged.
    pub presigned_put: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAppResponse {
    pub status: &'static str,
}

/// `POST /v1/apps/build` — build the app (`pnpm build` + zip `.output`) and
/// upload the artifact to the provided presigned OSS URL.
///
/// Requires `workspace:write`. The workdir MUST already exist (it's the seeded
/// checkout). Returns `{ "status": "built" }`. The presigned URL is a
/// short-lived secret and is never logged.
///
/// `gitCommitSha` + `gitRemoteUrl` + `deployKeyPem` are an all-or-nothing
/// triple. With them the workdir is fetched and checked out at that commit
/// (the Gitea-managed path). Without them the workdir is built exactly as it
/// sits — which is how an app imported from someone else's repo deploys, since
/// this deployment holds no credential for that remote.
pub async fn build_app(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<BuildAppBody>,
) -> Result<Json<BuildAppResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let presigned_put = body.presigned_put.trim().to_string();
    if presigned_put.is_empty() {
        return Err(HttpError::validation("presignedPut must not be empty"));
    }

    let git_commit_sha = body.git_commit_sha.trim().to_string();
    let git_remote_url = body.git_remote_url.trim().to_string();
    let deploy_key_pem = body.deploy_key_pem.trim().to_string();
    let present = [
        !git_commit_sha.is_empty(),
        !git_remote_url.is_empty(),
        !deploy_key_pem.is_empty(),
    ];
    let use_git = present.iter().all(|p| *p);
    if !use_git && present.iter().any(|p| *p) {
        return Err(HttpError::validation(
            "gitCommitSha, gitRemoteUrl and deployKeyPem must be supplied together",
        ));
    }

    let workdir_path = resolve_workdir(
        body.workdir.as_deref().unwrap_or(""),
        &body.app_id,
        &body.team_id,
    )?;
    if !workdir_path.exists() {
        return Err(HttpError::validation(format!(
            "workdir does not exist: {}",
            workdir_path.display()
        )));
    }

    let bytes = tokio::task::spawn_blocking(move || {
        let git_ctx = use_git.then(|| crate::sync::app_build::BuildGitContext {
            commit_sha: &git_commit_sha,
            remote_url: &git_remote_url,
            deploy_key_pem: &deploy_key_pem,
        });
        crate::sync::app_build::build_artifact(&workdir_path, git_ctx.as_ref())
    })
    .await
    .map_err(|e| HttpError::internal(format!("build task panicked: {e}")))?
    .map_err(map_build_error)?;

    let resp = reqwest::Client::new()
        .put(&presigned_put)
        .body(bytes)
        .send()
        .await
        .map_err(|e| HttpError::internal(format!("upload PUT failed: {e}")))?;
    if resp.status() == axum::http::StatusCode::FORBIDDEN {
        return Err(HttpError::validation(
            "presigned upload URL expired; retry deploy",
        ));
    }
    if !resp.status().is_success() {
        return Err(HttpError::internal(format!(
            "upload PUT failed: HTTP {}",
            resp.status()
        )));
    }

    Ok(Json(BuildAppResponse { status: "built" }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAppWorkdirBody {
    /// The app's team — names the override file and derived root.
    #[serde(default)]
    pub team_id: String,
    /// Absolute destination path for the checkout.
    pub dest_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAppWorkdirResponse {
    pub workdir: String,
}

/// `POST /v1/apps/:appId/move-workdir` — relocate this app's checkout on disk.
///
/// Moves the entire directory (`.git`, `node_modules`, …). Same filesystem uses
/// `rename`; cross-filesystem uses copy + verify + delete. On failure the
/// original directory and override pointer are left unchanged.
pub async fn move_app_workdir(
    principal: Principal,
    State(_state): State<HttpState>,
    axum::extract::Path(app_id): axum::extract::Path<String>,
    Json(body): Json<MoveAppWorkdirBody>,
) -> Result<Json<MoveAppWorkdirResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;

    let dest = body.dest_path.trim();
    if dest.is_empty() {
        return Err(HttpError::validation("destPath must not be empty"));
    }
    let dest_path = PathBuf::from(dest);
    if !dest_path.is_absolute() {
        return Err(HttpError::validation("destPath must be an absolute path"));
    }

    let team_id = body.team_id.clone();
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() {
        return Err(HttpError::validation("appId must not be empty"));
    }

    let from_path = resolve_workdir("", &app_id, &team_id)?;
    if from_path == dest_path {
        return Ok(Json(MoveAppWorkdirResponse {
            workdir: dest_path.to_string_lossy().into_owned(),
        }));
    }

    let derived = derived_workdir(&app_id, &team_id)?;
    let moved_to = dest_path.to_string_lossy().into_owned();

    tokio::task::spawn_blocking(move || {
        // Pointer first, then the tree, and roll the pointer back if the move
        // fails. Moving first meant a failed override write left the tree at
        // the new path while `resolve_workdir` still answered the old one —
        // an empty directory — which is exactly what the handler's contract
        // promises cannot happen. The override file is a small tmp+rename
        // write, so it is both the cheaper and the reversible half.
        let previous = crate::sync::app_workdir::read_override(&team_id, &app_id);
        let point_at = |target: Option<&std::path::Path>| -> std::io::Result<()> {
            match target {
                Some(path) if path != derived => {
                    crate::sync::app_workdir::set_override(&team_id, &app_id, path)
                }
                _ => crate::sync::app_workdir::clear_override(&team_id, &app_id),
            }
        };

        point_at(Some(dest_path.as_path()))?;
        if let Err(e) = crate::sync::app_workdir::move_directory(&from_path, &dest_path) {
            if let Err(restore) = point_at(previous.as_deref()) {
                tracing::error!(
                    error = %restore,
                    app_id = %app_id,
                    "apps: could not restore the workdir override after a failed move"
                );
            }
            return Err(e);
        }
        Ok::<_, std::io::Error>(())
    })
    .await
    .map_err(|e| HttpError::internal(format!("move task panicked: {e}")))?
    .map_err(map_move_error)?;

    Ok(Json(MoveAppWorkdirResponse { workdir: moved_to }))
}

fn map_move_error(err: std::io::Error) -> HttpError {
    match err.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::AlreadyExists => {
            HttpError::validation(err.to_string())
        }
        std::io::ErrorKind::InvalidInput => HttpError::validation(err.to_string()),
        _ => HttpError::internal(format!("app workdir move failed: {err}")),
    }
}

fn map_build_error(err: anyhow::Error) -> HttpError {
    let msg = format!("{err}");
    let validation_markers = [
        crate::sync::app_git::ERR_DIRTY,
        crate::sync::app_git::ERR_SHA_NOT_ON_REMOTE,
        crate::sync::app_git::ERR_INVALID_SHA,
        crate::sync::app_build::ERR_OUTPUT_MISSING,
        crate::sync::app_build::ERR_ARTIFACT_TOO_LARGE,
        crate::sync::app_build::ERR_LOCKFILE_MISMATCH,
        crate::sync::app_build::ERR_INSTALL_TIMEOUT,
        crate::sync::app_build::ERR_BUILD_TIMEOUT,
        "git repo URL",
        "deploy key PEM",
    ];
    if validation_markers.iter().any(|m| msg.contains(m)) {
        HttpError::validation(msg)
    } else {
        HttpError::internal(format!("app build failed: {msg}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `super` here is this module, not `http` — `errors` only resolves from the
    // crate root.
    use crate::http::errors::ErrorCode;

    #[test]
    fn body_deserializes_camel_case() {
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "appName": "My App",
            "appType": "slides",
            "teamId": "team-1",
            "workspaceId": "ws-1",
            "workdir": "/tmp/work"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert_eq!(body.app_name, "My App");
        assert_eq!(body.app_type, "slides");
        assert_eq!(body.team_id, "team-1");
        assert_eq!(body.workspace_id, "ws-1");
        assert_eq!(body.workdir.as_deref(), Some("/tmp/work"));
    }

    #[test]
    fn body_needs_only_the_app_id() {
        // The desktop posts appId + appName + appType; everything else is
        // optional, and an older client that omits the type still seeds.
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert!(body.workdir.is_none());
        assert_eq!(body.app_type, "");
    }

    #[test]
    fn resolve_workdir_uses_explicit_path_when_present() {
        let p = resolve_workdir("/tmp/explicit", "app-1", "").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/explicit"));
        // Whitespace-only workdir is treated as omitted → default path used.
        let p = resolve_workdir("   ", "app-2", "").unwrap();
        assert_eq!(p, apps_data_root().join("app-2"));
    }

    #[test]
    fn resolve_workdir_defaults_to_apps_root_appid() {
        let p = resolve_workdir("", "app-xyz", "").unwrap();
        assert_eq!(p, apps_data_root().join("app-xyz"));
        assert!(p.ends_with("apps/app-xyz"));
    }

    #[test]
    fn workdir_follows_the_apps_own_team_not_the_active_one() {
        // The daemon serves one team at a time, but apps belong to the team
        // they were created in. Deriving from the active team put an app
        // created after a team switch under a different team's directory.
        let p = resolve_workdir("", "app-1", "team-b").unwrap();
        assert!(
            p.ends_with("teams/team-b/apps/app-1"),
            "got {}",
            p.display()
        );
    }

    #[test]
    fn an_existing_checkout_under_the_active_team_keeps_its_place() {
        // Apps seeded before the team id was honoured live under the active
        // team's root. Their path must not change underneath them — the agent
        // edits one directory and `deploy` builds whatever this function says.
        let tmp = tempfile::tempdir().unwrap();
        let team_root = tmp.path().join("teams/team-b/apps");
        let active_root = tmp.path().join("teams/team-a/apps");
        std::fs::create_dir_all(active_root.join("app-1")).unwrap();

        let p = resolve_workdir_in(&team_root, &active_root, "app-1");
        assert_eq!(p, active_root.join("app-1"));

        // An app with no checkout anywhere gets the new, team-correct path.
        let fresh = resolve_workdir_in(&team_root, &active_root, "app-2");
        assert_eq!(fresh, team_root.join("app-2"));
    }

    #[test]
    fn a_checkout_under_its_own_team_wins_over_a_stray_legacy_one() {
        let tmp = tempfile::tempdir().unwrap();
        let team_root = tmp.path().join("teams/team-b/apps");
        let active_root = tmp.path().join("teams/team-a/apps");
        std::fs::create_dir_all(team_root.join("app-1")).unwrap();
        std::fs::create_dir_all(active_root.join("app-1")).unwrap();

        assert_eq!(
            resolve_workdir_in(&team_root, &active_root, "app-1"),
            team_root.join("app-1"),
        );
    }

    #[test]
    fn seed_body_carries_git_user_identity() {
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "gitUserName": "Alice",
            "gitUserEmail": "alice@example.com"
        }))
        .unwrap();
        assert_eq!(body.git_user_name.as_deref(), Some("Alice"));
        assert_eq!(body.git_user_email.as_deref(), Some("alice@example.com"));
        let body: SeedAppBody =
            serde_json::from_value(serde_json::json!({"appId": "app-1"})).unwrap();
        assert!(body.git_user_name.is_none());
        assert!(body.git_user_email.is_none());
    }

    #[test]
    fn seed_body_carries_git_remote_and_deploy_key() {
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "gitRemoteUrl": "git@gitea.example.com:org/tc-app-app-1.git",
            "deployKeyPem": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
        }))
        .unwrap();
        assert_eq!(
            body.git_remote_url.as_deref(),
            Some("git@gitea.example.com:org/tc-app-app-1.git")
        );
        assert!(body.deploy_key_pem.as_deref().unwrap().contains("OPENSSH"));
        let body: SeedAppBody =
            serde_json::from_value(serde_json::json!({"appId": "app-1"})).unwrap();
        assert!(body.git_remote_url.is_none());
        assert!(body.deploy_key_pem.is_none());
    }

    #[test]
    fn seed_body_carries_an_optional_git_remote() {
        let body: SeedAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "gitRemoteUrl": "https://github.com/owner/repo.git"
        }))
        .unwrap();
        assert_eq!(
            body.git_remote_url.as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        let body: SeedAppBody =
            serde_json::from_value(serde_json::json!({"appId": "app-1"})).unwrap();
        assert!(body.git_remote_url.is_none());
    }

    #[test]
    fn apps_live_beside_state_not_inside_it() {
        // An app checkout is the user's own project, not daemon bookkeeping —
        // and the desktop opens it as an agent session's working directory.
        let root = apps_data_root();
        assert!(root.ends_with("apps"), "got {}", root.display());
        assert!(
            !root.to_string_lossy().contains("/state/"),
            "app root must not sit under state/: {}",
            root.display()
        );
    }

    #[test]
    fn legacy_state_apps_root_is_moved_not_copied() {
        // The deploy pipeline builds whatever is at the new path. Leaving the
        // old checkouts behind would ship the seed template forever, with the
        // user's real work sitting in a directory nothing reads.
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("state").join("apps");
        std::fs::create_dir_all(legacy.join("app-1")).unwrap();
        std::fs::write(legacy.join("app-1").join("index.html"), b"real work").unwrap();

        let dest = tmp.path().join("apps");
        migrate_legacy_apps_root_from(&legacy, &dest);

        assert!(!legacy.exists(), "legacy root must be gone, not duplicated");
        assert_eq!(
            std::fs::read_to_string(dest.join("app-1").join("index.html")).unwrap(),
            "real work",
        );
    }

    #[test]
    fn migration_leaves_both_alone_when_the_new_root_already_exists() {
        // Merging two app roots is not a decision this function can make, so
        // the legacy one stays put and stays recoverable.
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("state").join("apps");
        std::fs::create_dir_all(legacy.join("app-1")).unwrap();
        let dest = tmp.path().join("apps");
        std::fs::create_dir_all(dest.join("app-2")).unwrap();

        migrate_legacy_apps_root_from(&legacy, &dest);

        assert!(
            legacy.join("app-1").is_dir(),
            "legacy must survive untouched"
        );
        assert!(dest.join("app-2").is_dir());
        assert!(!dest.join("app-1").exists(), "nothing may be merged in");
    }

    #[test]
    fn build_body_deserializes_camel_case() {
        let body: BuildAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "teamId": "team-1",
            "gitCommitSha": "abc1234567890",
            "gitRemoteUrl": "git@gitea.example.com:org/repo.git",
            "deployKeyPem": "-----BEGIN OPENSSH PRIVATE KEY-----\n",
            "presignedPut": "https://oss/put?sig=x"
        }))
        .unwrap();
        assert_eq!(body.app_id, "app-1");
        assert_eq!(body.git_commit_sha, "abc1234567890");
        assert_eq!(body.presigned_put, "https://oss/put?sig=x");
        assert!(body.workdir.is_none());
    }

    #[test]
    fn build_body_may_omit_the_git_triple() {
        // An app imported from someone else's repo has no Gitea repo and no
        // deploy key; its build is of the workdir as it sits.
        let body: BuildAppBody = serde_json::from_value(serde_json::json!({
            "appId": "app-1",
            "teamId": "team-1",
            "presignedPut": "https://oss/put?sig=x"
        }))
        .unwrap();
        assert_eq!(body.git_commit_sha, "");
        assert_eq!(body.git_remote_url, "");
        assert_eq!(body.deploy_key_pem, "");
    }

    #[test]
    fn build_body_requires_presigned_put() {
        // missing presignedPut → deserialization fails (field is required, not #[serde(default)])
        let r: Result<BuildAppBody, _> = serde_json::from_value(serde_json::json!({
            "appId": "app-1"
        }));
        assert!(r.is_err());
    }

    #[test]
    fn map_build_error_marks_known_validation_failures() {
        let err = map_build_error(anyhow::anyhow!(crate::sync::app_git::ERR_DIRTY));
        assert!(matches!(err.code, ErrorCode::ValidationFailed));
        let err = map_build_error(anyhow::anyhow!("mystery failure"));
        assert!(matches!(err.code, ErrorCode::Internal));
    }

    #[test]
    fn map_seed_error_marks_clone_failures_as_validation() {
        let err = map_seed_error(anyhow::anyhow!("git clone failed: repo not found"));
        assert!(matches!(err.code, ErrorCode::ValidationFailed));
    }

    #[test]
    fn resolve_workdir_requires_app_id_when_workdir_omitted() {
        let err = resolve_workdir("", "  ", "").unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("appId"), "unexpected error: {msg}");
    }

    #[test]
    fn resolve_workdir_prefers_override_over_derived_path() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());

        let custom = home.path().join("custom").join("app-1");
        crate::sync::app_workdir::set_override("team-a", "app-1", &custom).unwrap();

        let p = resolve_workdir("", "app-1", "team-a").unwrap();
        assert_eq!(p, custom);
    }
}
