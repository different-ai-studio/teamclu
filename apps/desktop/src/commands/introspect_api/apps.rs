//! Apps — the app control panel, as an agent reaches it.
//!
//! The `teamclu-introspect` sidecar's `manage_app*` tools land here, one route
//! per tool, and together they cover what `components/apps/AppControlPanel.tsx`
//! and the tabs it opens let a person do:
//!
//! | tool                | route         | control panel                                         |
//! |---------------------|---------------|-------------------------------------------------------|
//! | `manage_app`        | `/app-manage` | 应用 (name, type, visibility, code version), 应用权限, deploy, 运行日志, 删除 |
//! | `manage_app_access` | `/app-access` | 协作权限                                               |
//! | `manage_app_data`   | `/app-data`   | 线上数据                                               |
//! | `manage_app_files`  | `/app-files`  | 应用附件                                               |
//! | `manage_app_env`    | `/app-env`    | 变量与密钥                                             |
//! | `manage_app_cron`   | `/app-cron`   | 定时任务                                               |
//! | `manage_app_domain` | `/app-domain` | 自定义域名                                             |
//!
//! Every call goes out on the signed-in user's bearer through
//! [`introspect_fc_client`], so the Cloud API enforces app permissions exactly
//! as it does for the desktop UI (`view` / `prompt` / `admin`) — nothing here
//! escalates past what the user may do themselves. The work lives in this
//! process because it is the only one holding both that bearer and a line to
//! the local daemon, which builds the artifact a deploy publishes.
//!
//! A capability added to the panel belongs here too: the panel and these tools
//! are two views of one control plane, and an agent that can do only half of
//! it stops and asks the user to click the other half.

mod data;
mod files;
mod settings;

pub(super) use data::handle_app_data;
pub(super) use files::handle_app_files;
pub(super) use settings::{handle_app_access, handle_app_cron, handle_app_domain, handle_app_env};

use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{introspect_current_team, introspect_fc_client, items_of, str_body_field};
use crate::commands::oss_sync::fc_client::FcClient;

// ─── Cloud API, with the server's own words ─────────────────────────────────

/// A Cloud API failure, with what the server actually said.
///
/// Not `FcClient`'s own error type: that one was written for team sync and
/// folds every 409 into a CAS conflict carrying no message. App routes answer
/// 409 for a dozen ordinary states — no database, not deployed, over quota,
/// domain taken, DNS not visible yet, a deploy already running — and an agent
/// told "conflict: remote_version=None" has nothing to act on.
#[derive(Debug)]
pub(super) struct CloudError {
    /// 0 when no response arrived at all.
    pub(super) status: u16,
    pub(super) code: String,
    pub(super) message: String,
}

fn cloud_error_from(status: u16, bytes: &[u8]) -> CloudError {
    let body: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let pick = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let code = pick(&body["error"]["code"])
        .or_else(|| pick(&body["code"]))
        .unwrap_or_default();
    let message = pick(&body["error"]["message"])
        .or_else(|| pick(&body["message"]))
        .or_else(|| pick(&body["error"]))
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).chars().take(300).collect());
    CloudError {
        status,
        code,
        message,
    }
}

/// What to do about a failure, when the status or code alone does not say.
fn cloud_error_hint(e: &CloudError) -> Option<&'static str> {
    match e.code.as_str() {
        "app_has_no_database" => Some(
            "only data_app apps have a database — manage_app action \"update\" can change the type, which takes effect on the next deploy",
        ),
        "app_not_deployed" => Some("deploy it first (manage_app action \"deploy\")"),
        "app_storage_quota_exceeded" => Some(
            "the app is over its storage quota — delete files, or raise it with manage_app_files action \"set_quota\"",
        ),
        "env_key_reserved" => Some("the platform sets this variable itself; use another name"),
        _ => match e.status {
            // Deliberately the same answer the API gives for both: telling "you
            // may not" apart from "it does not exist" would leak which apps
            // exist, so the agent is told it could be either.
            404 => Some(
                "the Cloud API answers 404 both when it does not exist and when the signed-in user lacks the permission this needs",
            ),
            401 => Some(
                "the desktop's sign-in has expired — ask the user to open TeamClu and sign in again",
            ),
            _ => None,
        },
    }
}

/// One sentence for a failed call: what was being done, and the server's reply.
pub(super) fn explain(what: &str, e: &CloudError) -> String {
    if e.status == 0 {
        return format!(
            "{what} failed: could not reach the Cloud API ({})",
            e.message
        );
    }
    let mut out = format!("{what} failed: HTTP {}", e.status);
    if !e.code.is_empty() {
        out.push(' ');
        out.push_str(&e.code);
    }
    if !e.message.is_empty() {
        out.push_str(": ");
        out.push_str(&e.message);
    }
    if let Some(hint) = cloud_error_hint(e) {
        out.push_str(" — ");
        out.push_str(hint);
    }
    out
}

/// The signed-in user's Cloud API, for app routes.
pub(super) struct AppApi {
    fc: FcClient,
}

impl AppApi {
    pub(super) async fn for_tool(app: &AppHandle, v: &Value, tool: &str) -> Result<Self, String> {
        Ok(Self {
            fc: introspect_fc_client(app, v, tool).await?,
        })
    }

    /// One request. `timeout` overrides the shared client's 30 s for the calls
    /// the server legitimately takes longer on (finalize, purge, run-now).
    pub(super) async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, CloudError> {
        let url = format!("{}{}", self.fc.base_url, path);
        let mut request = self
            .fc
            .client
            .request(method, &url)
            .bearer_auth(&self.fc.jwt);
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let network = |e: reqwest::Error| CloudError {
            status: 0,
            code: String::new(),
            message: e.to_string(),
        };
        let response = request.send().await.map_err(network)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(network)?;
        if !(200..300).contains(&status) {
            return Err(cloud_error_from(status, &bytes));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|e| CloudError {
            status,
            code: "unreadable_response".to_string(),
            message: e.to_string(),
        })
    }

    pub(super) async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
        what: &str,
    ) -> Result<Value, String> {
        self.send(method, path, body, timeout)
            .await
            .map_err(|e| explain(what, &e))
    }

    pub(super) async fn get(&self, path: &str, what: &str) -> Result<Value, String> {
        self.call(Method::GET, path, None, None, what).await
    }

    pub(super) async fn post(&self, path: &str, body: &Value, what: &str) -> Result<Value, String> {
        self.call(Method::POST, path, Some(body), None, what).await
    }

    pub(super) async fn put(&self, path: &str, body: &Value, what: &str) -> Result<Value, String> {
        self.call(Method::PUT, path, Some(body), None, what).await
    }

    pub(super) async fn patch(
        &self,
        path: &str,
        body: &Value,
        what: &str,
    ) -> Result<Value, String> {
        self.call(Method::PATCH, path, Some(body), None, what).await
    }

    pub(super) async fn delete(&self, path: &str, what: &str) -> Result<Value, String> {
        self.call(Method::DELETE, path, None, None, what).await
    }
}

// ─── Small shared pieces ────────────────────────────────────────────────────

/// `/v1/apps/<id><rest>`, with the id encoded.
pub(super) fn app_path(app_id: &str, rest: &str) -> String {
    format!("/v1/apps/{}{rest}", urlencoding::encode(app_id))
}

/// A non-empty string field of a Cloud API row.
pub(super) fn row_str<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub(super) fn row_id(row: &Value) -> Result<String, String> {
    row_str(row, "id")
        .map(str::to_string)
        .ok_or_else(|| "app row has no id".to_string())
}

/// Whether this deployment provisioned the app's repo on Gitea and holds a
/// deploy key for it. False for an app imported from someone else's remote:
/// `git-head` and `git-credential` both 404 on it, and its deploy builds the
/// checkout as it sits. Mirrors `isGiteaManaged` in `stores/apps-store.ts`.
fn is_gitea_managed(row: &Value) -> bool {
    row_str(row, "gitAuthKind") == Some("gitea_deploy_key")
}

pub(super) fn parse_body(body: &[u8]) -> Result<Value, String> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {e}"))
}

/// The action, checked against what this route handles — before any request,
/// so a typo is not answered as "the app is missing".
pub(super) fn require_action(v: &Value, allowed: &[&str]) -> Result<String, String> {
    let action = str_body_field(v, "action", "action").unwrap_or_default();
    if allowed.contains(&action.as_str()) {
        return Ok(action);
    }
    Err(format!(
        "Unknown action: {} (expected {})",
        if action.is_empty() {
            "(missing)"
        } else {
            &action
        },
        allowed.join(", ")
    ))
}

pub(super) fn u64_body_field(v: &Value, snake: &str, camel: &str) -> Option<u64> {
    v.get(snake)
        .or_else(|| v.get(camel))
        .and_then(|x| x.as_u64().or_else(|| x.as_str()?.trim().parse().ok()))
}

/// Irreversible actions name their app.
///
/// "The app this workspace is" is the right default for deploying or reading
/// logs, and the wrong one for deleting an app or emptying its storage: an
/// agent that has lost track of which checkout it is in should not be able to
/// destroy the one it happens to be standing in.
pub(super) fn require_named_app(v: &Value, action: &str) -> Result<(), String> {
    if str_body_field(v, "app_id", "appId").is_some()
        || str_body_field(v, "app_name", "appName").is_some()
    {
        return Ok(());
    }
    Err(format!(
        "{action} cannot be undone, so it needs an explicit app_id or app_name — it does not act on the app inferred from the workspace"
    ))
}

/// Event the web app listens for to re-read apps an agent changed. Must match
/// `AGENT_APP_CHANGED_EVENT` in `packages/app/src/hooks/use-agent-app-changes.ts`.
const AGENT_APP_CHANGED_EVENT: &str = "apps:changed-by-agent";

/// Tell the open window an agent changed this app.
///
/// The control panel loads its counts once per selection and the app list once
/// per team, so without this an agent that created a cron job, renamed the app
/// or deleted it left the panel describing the app as it was. Best-effort: a
/// window that is not listening misses nothing it would not re-read on its own.
pub(super) fn notify_app_changed(app: &AppHandle, row: &Value) {
    let _ = app.emit(
        AGENT_APP_CHANGED_EVENT,
        json!({
            "teamId": row_str(row, "teamId"),
            "appId": row_str(row, "id"),
        }),
    );
}

/// The app-row fields worth an agent's context window.
///
/// `publicUrl` is the address the product hands out; `fcEndpoint` is the raw FC
/// hostname and is only the app's address on a deployment with no apps domain.
/// One `url` rather than both, so the agent cannot quote the wrong one.
pub(super) fn app_brief(row: &Value) -> Value {
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
        "auth_mode": f("authMode"),
        "auth_mode_pending_redeploy": f("authModePendingRedeploy"),
        "git_commit_sha": f("gitCommitSha"),
    })
}

/// Everything an operator sets on the app row, in the names `update` takes.
///
/// The three `*_pending_redeploy` flags are the server's own derivation, read
/// straight off the row: each says the running function still lags a setting,
/// and only the server knows what the function was built with.
fn app_settings(row: &Value) -> Value {
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

// ─── Which app ──────────────────────────────────────────────────────────────

async fn list_team_apps(api: &AppApi, team_id: &str) -> Result<Vec<Value>, String> {
    let listing = api
        .get(
            &format!("/v1/apps?teamId={}&limit=200", urlencoding::encode(team_id)),
            "Listing this team's apps",
        )
        .await?;
    Ok(items_of(&listing))
}

/// Every app this machine holds a checkout for, as `(app_id, workdir)`.
///
/// Best-effort, like [`app_workdir_on_this_machine`]: a daemon that is down
/// means "no local checkouts", which leaves the caller asking for an explicit
/// app rather than failing on an unrelated error.
async fn local_app_workdirs(team_id: &str) -> Vec<(String, String)> {
    use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};
    let query = format!("?teamId={}", urlencoding::encode(team_id));
    let out: Value = match daemon::call_discovered(
        RequestSpec::get("/v1/apps/local", &["workspace:read"])
            .query(&query)
            .timeout(Duration::from_secs(10)),
        NO_BODY,
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    out.get("apps")
        .and_then(|x| x.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("appId")?.as_str()?.trim();
                    let dir = row.get("workdir")?.as_str()?.trim();
                    (!id.is_empty() && !dir.is_empty()).then(|| (id.to_string(), dir.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve symlinks so two spellings of one directory compare equal.
///
/// macOS reaches the same tree as `/tmp/x` and `/private/tmp/x`, and a
/// workspace under a symlinked mount is routinely handed to the agent by one
/// spelling while the daemon reports the other. A path that cannot be
/// canonicalized (it no longer exists) is left as it was, which still matches
/// an identical string.
fn canonical_path(path: &str) -> std::path::PathBuf {
    let raw = std::path::PathBuf::from(path);
    std::fs::canonicalize(&raw).unwrap_or(raw)
}

/// The app whose checkout is, or contains, `workspace`.
///
/// Component-wise so a sibling directory cannot match on a shared prefix
/// (`…/apps/foo-2` is not inside `…/apps/foo`), and longest match first so a
/// checkout nested inside another checkout resolves to the inner one.
fn app_owning_path(
    workspace: &std::path::Path,
    apps: &[(String, std::path::PathBuf)],
) -> Option<String> {
    apps.iter()
        .filter(|(_, dir)| workspace.starts_with(dir))
        .max_by_key(|(_, dir)| dir.components().count())
        .map(|(id, _)| id.clone())
}

/// The workspace the calling agent is running in.
///
/// The sidecar passes its own `--workspace`, which is the agent's checkout —
/// not necessarily the one the desktop window happens to be showing. The
/// registry is the fallback for a sidecar older than this field.
fn introspect_caller_workspace(app: &AppHandle, v: &Value) -> Option<String> {
    if let Some(path) = str_body_field(v, "workspace_path", "workspacePath") {
        return Some(path);
    }
    let registry = app.state::<crate::commands::window::WindowRegistry>();
    let path = registry.current_workspace.lock().ok()?.clone()?;
    (!path.trim().is_empty()).then_some(path)
}

/// Resolve the `app_id` / `app_name` argument to exactly one app row.
///
/// A name is accepted only when it names one app in the current team. Deploying
/// publishes to the internet and `update_row` writes production data, so a
/// fuzzy match is not worth the effect: zero or several matches come back as
/// the candidate list with nothing done.
///
/// With neither given, the app is the one whose checkout the caller is working
/// in. That is not a guess in the way a fuzzy name is — the directory either is
/// that app's checkout or it is not — and it is the common case the tool used
/// to fail on: an agent editing an app has no way to learn its own app id, so
/// it stopped and asked the user for one it could not see either.
pub(super) async fn resolve_app_row(
    app: &AppHandle,
    api: &AppApi,
    v: &Value,
) -> Result<Value, String> {
    if let Some(id) = str_body_field(v, "app_id", "appId") {
        return api.get(&app_path(&id, ""), "Reading the app").await;
    }
    let Some(name) = str_body_field(v, "app_name", "appName") else {
        let id = resolve_app_id_from_workspace(app, v).await?;
        return api.get(&app_path(&id, ""), "Reading the app").await;
    };
    let team_id = introspect_current_team(app).await?;
    let apps = list_team_apps(api, &team_id).await?;
    let wanted = name.to_lowercase();
    let matches: Vec<&Value> = apps
        .iter()
        .filter(|a| {
            ["name", "slug"].iter().any(|k| {
                a.get(*k)
                    .and_then(|x| x.as_str())
                    .map(|n| n.trim().to_lowercase() == wanted)
                    .unwrap_or(false)
            })
        })
        .collect();
    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => Err(format!(
            "No app named {:?} in this team. Apps: {}",
            name,
            Value::Array(apps.iter().map(app_brief).collect())
        )),
        n => Err(format!(
            "{:?} matches {} apps — pass app_id instead. Matches: {}",
            name,
            n,
            Value::Array(matches.iter().map(|a| app_brief(a)).collect())
        )),
    }
}

/// The app the caller is inside, for a call that named none.
///
/// Both failure modes say what to do next rather than what went wrong: an agent
/// that lands here has already decided it wants "this app", and the useful
/// reply is the way to name one.
async fn resolve_app_id_from_workspace(app: &AppHandle, v: &Value) -> Result<String, String> {
    const ASK: &str =
        "pass app_id or app_name, or run manage_app with action \"list\" to see this team's apps";
    let workspace = introspect_caller_workspace(app, v).ok_or_else(|| {
        format!("No app_id or app_name, and no workspace to resolve one from — {ASK}")
    })?;
    let team_id = introspect_current_team(app).await?;
    let apps: Vec<(String, std::path::PathBuf)> = local_app_workdirs(&team_id)
        .await
        .into_iter()
        .map(|(id, dir)| (id, canonical_path(&dir)))
        .collect();
    app_owning_path(&canonical_path(&workspace), &apps)
        .ok_or_else(|| format!("{workspace} is not the checkout of any app in this team — {ASK}"))
}

/// Where this machine keeps the app's checkout, and this machine's name.
///
/// The daemon answers for an app it has never seeded too — the path is
/// derived, not looked up — so this is where the checkout goes, not proof that
/// one exists. Best-effort: a daemon that is down means "not here", which is
/// what an agent needs to know either way.
async fn app_workdir_on_this_machine(row: &Value) -> Option<(String, Option<String>)> {
    use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};
    let app_id = row_str(row, "id")?;
    let team_id = row_str(row, "teamId").unwrap_or("");
    let path = format!("/v1/apps/{}/workdir", urlencoding::encode(app_id));
    let query = format!("?teamId={}", urlencoding::encode(team_id));
    let out: Value = daemon::call_discovered(
        RequestSpec::get(&path, &["workspace:read"])
            .query(&query)
            .timeout(Duration::from_secs(10)),
        NO_BODY,
    )
    .await
    .ok()?;
    let workdir = row_str(&out, "workdir")?.to_string();
    Some((workdir, row_str(&out, "deviceName").map(str::to_string)))
}

// ─── manage_app ─────────────────────────────────────────────────────────────

const MANAGE_ACTIONS: [&str; 7] = [
    "list", "status", "sessions", "update", "deploy", "logs", "delete",
];

/// `manage_app` — the app itself: find it, read its settings, change them,
/// publish it, read its logs, delete it.
pub(super) async fn handle_app_manage(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &MANAGE_ACTIONS)?;
    match action.as_str() {
        "delete" => require_named_app(&v, "delete")?,
        // Checked before anything is resolved, so a call with nothing to change
        // costs no round trip and reads as the argument mistake it is.
        "update" => {
            update_patch(&v)?;
        }
        _ => {}
    }
    let api = AppApi::for_tool(app, &v, "manage_app").await?;

    if action == "list" {
        return Ok(list_apps(app, &api).await?.to_string());
    }
    let row = resolve_app_row(app, &api, &v).await?;
    let out = match action.as_str() {
        "status" => json!({ "action": "status", "app": app_status(&api, &row).await }),
        "sessions" => app_sessions(&api, &row).await?,
        "update" => update_app(app, &api, &row, &v).await?,
        "deploy" => {
            let deployed = run_app_deploy(&api, &row).await;
            // Either way the row moved — to live, or to deploy_error.
            notify_app_changed(app, &row);
            json!({ "ok": true, "action": "deploy", "app": app_brief(&deployed?) })
        }
        "logs" => read_app_logs(&api, &row, &v).await?,
        "delete" => delete_app(app, &api, &row).await?,
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

async fn list_apps(app: &AppHandle, api: &AppApi) -> Result<Value, String> {
    let team_id = introspect_current_team(app).await?;
    let apps = list_team_apps(api, &team_id).await?;
    // One daemon call for every app's checkout, not one per app: the path is
    // how an agent tells the app it is working in from the rest of the team's,
    // and it used to take a `status` round trip each to find out.
    let local = local_app_workdirs(&team_id).await;
    let briefs: Vec<Value> = apps
        .iter()
        .map(|row| {
            let mut brief = app_brief(row);
            let id = row_str(row, "id").unwrap_or_default();
            if let Some((_, dir)) = local.iter().find(|(app_id, _)| app_id == id) {
                brief["workdir"] = json!(dir);
            }
            brief
        })
        .collect();
    Ok(json!({
        "action": "list",
        "team_id": team_id,
        "apps": briefs,
    }))
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
fn describe_code_version(row: &Value, head: Option<&Value>) -> String {
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

/// `status` — every setting on the row, plus what the control panel's 应用
/// group shows that the row does not carry: where the checkout is, what it
/// declares about how it runs, and how far the branch is ahead of what is live.
async fn app_status(api: &AppApi, row: &Value) -> Value {
    let mut out = app_settings(row);
    let f = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    out["slug"] = f("slug");
    out["created_by_actor_id"] = f("createdByActorId");
    out["git_remote_url"] = f("gitRemoteUrl");
    out["git_managed"] = json!(is_gitea_managed(row));
    out["custom_domain"] = f("customDomain");
    out["custom_domain_verified"] = json!(row_str(row, "customDomainVerifiedAt").is_some());
    // What the last deploy recorded, next to what the checkout says now: the
    // row's `runtime` is written by deploy from the declaration, so the two
    // disagree exactly when the declaration changed since.
    out["deployed_runtime"] = f("runtime");

    let app_id = row_str(row, "id").unwrap_or_default().to_string();
    let team_id = row_str(row, "teamId").unwrap_or_default().to_string();
    if let Some((workdir, device)) = app_workdir_on_this_machine(row).await {
        out["checkout_present"] = json!(std::fs::read_dir(&workdir)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false));
        out["workdir"] = json!(workdir);
        out["device_name"] = json!(device);
    }
    if let Some(manifest) = daemon_app_manifest(&app_id, &team_id).await {
        out["declared_runtime"] = json!({
            "manifest": manifest,
            "note": "Read from teamclu.app.json in the checkout (or inferred from it). It is not a setting: edit that file and deploy to change how the app is built and started.",
        });
    }

    let head = if is_gitea_managed(row) && !app_id.is_empty() {
        api.send(
            Method::GET,
            &app_path(&app_id, "/git-head?compare=1"),
            None,
            None,
        )
        .await
        .ok()
    } else {
        None
    };
    out["code_version"] = json!({
        "summary": describe_code_version(row, head.as_ref()),
        "branch": head.as_ref().and_then(|h| h.get("branch")).cloned(),
        "head_sha": head.as_ref().and_then(|h| h.get("sha")).cloned(),
        "deployed_sha": head.as_ref().and_then(|h| h.get("deployedSha")).cloned(),
        "undeployed_commits": head.as_ref().and_then(|h| h.get("undeployedCommits")).cloned(),
    });
    out
}

async fn app_sessions(api: &AppApi, row: &Value) -> Result<Value, String> {
    let app_id = row_id(row)?;
    let page = api
        .get(
            &app_path(&app_id, "/sessions"),
            "Listing the app's sessions",
        )
        .await?;
    let sessions: Vec<Value> = items_of(&page)
        .iter()
        .map(|s| {
            json!({
                "id": s.get("id"),
                "title": s.get("title"),
                "last_message_at": s.get("lastMessageAt"),
                "created_at": s.get("createdAt"),
            })
        })
        .collect();
    Ok(json!({ "action": "sessions", "app_id": app_id, "sessions": sessions }))
}

/// The types `update` may set. The legacy stored id is readable, never written.
const APP_TYPES: [&str; 4] = ["static_web", "slides", "data_app", "imported"];

/// Whether an app of this type gets a Postgres schema on deploy. Mirrors
/// `needsDatabase` in `services/fc/src/lib/provisioning/app-deploy.ts`, where
/// anything unrecognised — the legacy stored value included — is a data app.
fn needs_database(app_type: &str) -> bool {
    !matches!(app_type.trim(), "static_web" | "slides" | "imported")
}

fn enum_field(
    v: &Value,
    snake: &str,
    camel: &str,
    allowed: &[&str],
) -> Result<Option<String>, String> {
    match str_body_field(v, snake, camel) {
        None => Ok(None),
        Some(value) if allowed.contains(&value.as_str()) => Ok(Some(value)),
        Some(value) => Err(format!(
            "{snake} must be one of: {} (got {value:?})",
            allowed.join(", ")
        )),
    }
}

/// The `PATCH /v1/apps/:id` body an `update` call asks for.
///
/// Every field the row lets an operator set, and only those: status fields are
/// the deploy's to write, and `runtime` is derived from the checkout on every
/// deploy, so a setter for it would be overwritten by the next one. Values are
/// checked here for the errors that need no round trip; the server validates
/// again (rules as a set, the scope/rules pair) and its message is passed on.
fn update_patch(v: &Value) -> Result<Value, String> {
    let mut patch = Map::new();
    if let Some(name) = str_body_field(v, "name", "name") {
        patch.insert("name".into(), json!(name));
    }
    if let Some(app_type) = enum_field(v, "type", "type", &APP_TYPES)? {
        patch.insert("type".into(), json!(app_type));
    }
    if let Some(visibility) = enum_field(v, "visibility", "visibility", &["personal", "team"])? {
        patch.insert("visibility".into(), json!(visibility));
    }
    // `third` exists in the schema and is disabled in the UI: it cannot be
    // deployed, so offering it here would only produce apps that fail to.
    if let Some(mode) = enum_field(v, "auth_mode", "authMode", &["none", "platform"])? {
        patch.insert("authMode".into(), json!(mode));
    }
    if let Some(audience) = enum_field(v, "auth_audience", "authAudience", &["any", "org"])? {
        patch.insert("authAudience".into(), json!(audience));
    }
    if let Some(scope) = enum_field(v, "auth_scope", "authScope", &["all", "paths"])? {
        patch.insert("authScope".into(), json!(scope));
    }
    if let Some(rules) = v.get("auth_rules").or_else(|| v.get("authRules")) {
        let list = rules
            .as_array()
            .ok_or("auth_rules must be an array of {path, auth, audience?}")?;
        for rule in list {
            let path = rule.get("path").and_then(Value::as_str).unwrap_or("");
            let auth = rule.get("auth").and_then(Value::as_str).unwrap_or("");
            if !path.starts_with('/') || !matches!(auth, "required" | "public") {
                return Err(format!(
                    "each auth rule needs a path starting with \"/\" and auth \"required\" or \"public\" (got {rule})"
                ));
            }
        }
        patch.insert("authRules".into(), rules.clone());
    }
    if patch.is_empty() {
        return Err(
            "update needs at least one of: name, type, visibility, auth_mode, auth_audience, auth_scope, auth_rules"
                .to_string(),
        );
    }
    Ok(Value::Object(patch))
}

/// What an operator needs to hear about the change they just made — the
/// consequences that are not visible on the row itself.
fn update_notes(before: &Value, patch: &Value, after: &Value) -> Vec<String> {
    let mut notes = Vec::new();

    if patch.get("name").is_some() {
        notes.push("The public URL does not change when an app is renamed.".to_string());
    }

    if let Some(next) = patch
        .get("type")
        .and_then(Value::as_str)
        .filter(|next| Some(*next) != row_str(before, "type"))
    {
        let prev = row_str(before, "type").unwrap_or("data_app");
        if needs_database(prev) && !needs_database(next) {
            notes.push(format!(
                "WARNING: from the next deploy on this app has no database — DATABASE_URL disappears from it, and code that uses the database will fail. The data is kept, and comes back if the type is set to data_app again. manage_app_data already reports no database. Type was {prev}."
            ));
        } else if !needs_database(prev) && needs_database(next) {
            notes.push(
                "The next deploy creates this app's database and gives the app DATABASE_URL. The code is not changed — the app has to use the database itself."
                    .to_string(),
            );
        } else if !needs_database(next) {
            notes.push(
                "static_web, slides and imported deploy the same way: this changes the app's label and the starter template a reseed would write, not the running site."
                    .to_string(),
            );
        }
        if after.get("typePendingRedeploy").and_then(Value::as_bool) == Some(true) {
            notes.push(
                "The running app still has the old type; deploy (manage_app action \"deploy\") for it to take effect."
                    .to_string(),
            );
        }
    }

    if let Some(visibility) = patch.get("visibility").and_then(Value::as_str) {
        // The two consequences people get backwards, named (design §10):
        // granted members keep seeing a personal app, and the daemon does not —
        // it holds no member grant it could be given.
        notes.push(if visibility == "personal" {
            "Only the creator and members granted access (manage_app_access) see this app now. The local daemon cannot see it either, so agents it runs lose sight of it.".to_string()
        } else {
            "Everyone on the team can see this app now.".to_string()
        });
    }

    let auth_changed = ["authMode", "authAudience", "authScope", "authRules"]
        .iter()
        .any(|k| patch.get(*k).is_some());
    if auth_changed {
        notes.push(
            "The login wall is enforced by the gateway, so this applies from the next request — no deploy needed."
                .to_string(),
        );
        if row_str(after, "authMode") == Some("none") {
            notes.push("auth_mode is none: anyone with the URL can open the site.".to_string());
        }
        if after
            .get("authModePendingRedeploy")
            .and_then(Value::as_bool)
            == Some(true)
        {
            notes.push(
                "auth_mode_pending_redeploy only means the app's own login variables update on the next deploy; the wall itself is already in force."
                    .to_string(),
            );
        }
    }
    notes
}

/// `update` — every setting on the row in one PATCH, the way the control panel
/// saves a field: name, type, visibility and the login wall.
async fn update_app(
    app: &AppHandle,
    api: &AppApi,
    row: &Value,
    v: &Value,
) -> Result<Value, String> {
    let patch = update_patch(v)?;
    let app_id = row_id(row)?;
    let updated = api
        .patch(
            &app_path(&app_id, ""),
            &patch,
            "Updating the app (needs admin on it)",
        )
        .await?;
    notify_app_changed(app, &updated);
    Ok(json!({
        "ok": true,
        "action": "update",
        "app": app_settings(&updated),
        "notes": update_notes(row, &patch, &updated),
    }))
}

async fn delete_app(app: &AppHandle, api: &AppApi, row: &Value) -> Result<Value, String> {
    let app_id = row_id(row)?;
    // Tears down the function, its trigger, the artifact and the login client,
    // and archives the repo — well past the default 30 s on a slow region.
    api.call(
        Method::DELETE,
        &app_path(&app_id, ""),
        None,
        Some(Duration::from_secs(120)),
        "Deleting the app (needs admin on it)",
    )
    .await?;
    notify_app_changed(app, row);
    Ok(json!({
        "ok": true,
        "action": "delete",
        "app_id": app_id,
        "name": row.get("name"),
        "note": "The deployed site is offline. Its database, stored files and local checkouts were kept; its repository was archived and only an administrator can recover it.",
    }))
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

/// Strip presigned-URL query strings out of anything on its way into a stored
/// field or a tool reply.
///
/// The upload handle minted by `/deploy` is a bearer credential for the app's
/// OSS object, and the daemon's build errors quote the URL they failed on. That
/// text ends up in `deployError`, which every reader of the app row can see.
fn redact_deploy_secrets(reason: &str) -> String {
    let mut out = String::with_capacity(reason.len());
    for (i, chunk) in reason.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let looks_presigned = chunk.contains("Signature=")
            || chunk.contains("OSSAccessKeyId=")
            || chunk.contains("x-oss-signature");
        if looks_presigned {
            // Keep the scheme+host so the message still says where it failed.
            let head = chunk.split('?').next().unwrap_or("");
            out.push_str(head);
            out.push_str("?<redacted>");
        } else {
            out.push_str(chunk);
        }
    }
    const MAX: usize = 800;
    if out.chars().count() > MAX {
        out = out.chars().take(MAX).collect::<String>() + "…";
    }
    out
}

/// What the app's checkout declares about how it is built.
///
/// Best-effort: a daemon that cannot answer leaves the deploy on the contract
/// every app had before declarations existed, which is what an older daemon
/// would have done anyway.
async fn daemon_app_manifest(app_id: &str, team_id: &str) -> Option<Value> {
    use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};
    let path = format!("/v1/apps/{}/manifest", urlencoding::encode(app_id));
    let query = format!("?teamId={}", urlencoding::encode(team_id));
    let out: Value = daemon::call_discovered(
        RequestSpec::get(&path, &["workspace:read"])
            .query(&query)
            .timeout(Duration::from_secs(10)),
        NO_BODY,
    )
    .await
    .ok()?;
    out.get("manifest").cloned()
}

fn manifest_runtime(manifest: Option<&Value>) -> String {
    manifest
        .and_then(|m| m.get("runtime"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("node")
        .to_string()
}

/// Kick the local daemon's build-and-upload leg.
async fn daemon_build_app(body: &Value, timeout: Duration) -> Result<Value, String> {
    use crate::daemon_client::{self as daemon, RequestSpec};
    daemon::call_discovered::<_, Value>(
        RequestSpec::post("/v1/apps/build", &["workspace:write"]).timeout(timeout),
        Some(body),
    )
    .await
    .map_err(|e| {
        if e.is_unavailable() {
            "The local amuxd is not connected, so nothing can build this app.".to_string()
        } else {
            redact_deploy_secrets(&format!("Daemon build failed: {e}"))
        }
    })
}

/// Where this deploy's build output goes, as the control plane minted it.
enum DeployHandle {
    /// Presigned OSS PUT for a code archive.
    Upload(String),
    /// Registry handle for an image, passed to the daemon verbatim.
    Push(Value),
}

/// Everything after `/deploy` has minted the upload handle: credential the
/// build, run it, hand the credential back, publish.
#[allow(clippy::too_many_arguments)]
async fn finish_app_deploy(
    api: &AppApi,
    app_id: &str,
    team_id: &str,
    via_gitea: bool,
    git_commit_sha: Option<String>,
    deploy_token: &str,
    handle: &DeployHandle,
    manifest: Option<&Value>,
) -> Result<Value, String> {
    let mut git_remote_url = String::new();
    let mut deploy_key_pem = String::new();
    let mut deploy_key_id: Option<i64> = None;
    if via_gitea {
        let cred = api
            .get(
                &app_path(app_id, "/git-credential"),
                "Minting a deploy key for the app's repository",
            )
            .await?;
        git_remote_url = row_str(&cred, "remoteUrl").unwrap_or_default().to_string();
        deploy_key_pem = cred
            .get("privateKeyPem")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        deploy_key_id = cred.get("deployKeyId").and_then(|x| x.as_i64());
        if git_remote_url.is_empty() || deploy_key_pem.is_empty() {
            return Err("Could not mint a Gitea deploy credential for this app.".to_string());
        }
    }

    let mut build_body = json!({
        "appId": app_id,
        "teamId": team_id,
    });
    match handle {
        DeployHandle::Upload(url) => build_body["presignedPut"] = json!(url),
        DeployHandle::Push(image) => build_body["image"] = image.clone(),
    }
    if via_gitea {
        build_body["gitRemoteUrl"] = json!(git_remote_url);
        build_body["deployKeyPem"] = json!(deploy_key_pem);
        if let Some(sha) = &git_commit_sha {
            build_body["gitCommitSha"] = json!(sha);
        }
    }

    // 20 minutes for an archive: the daemon allows a `pnpm install` plus a
    // 10-minute `pnpm build`, and a client timeout shorter than the work it
    // waits on turns a slow build into a phantom failure — one that has already
    // uploaded the artifact. A container build cross-compiles for linux/amd64
    // through emulation and then pushes an image; a cap that fits `pnpm build`
    // cuts it off mid-push, and the daemon's own bounds (30 + 15) are what
    // should decide.
    let build_timeout = match handle {
        DeployHandle::Upload(_) => Duration::from_secs(20 * 60),
        DeployHandle::Push(_) => Duration::from_secs(50 * 60),
    };
    let build = daemon_build_app(&build_body, build_timeout).await;

    // The daemon only needs the key for the fetch inside the build; hand it back
    // whether that succeeded or not, exactly as the desktop's `finally` does.
    if let Some(key_id) = deploy_key_id {
        let _ = api
            .send(
                Method::DELETE,
                &app_path(app_id, &format!("/git-credential/{key_id}")),
                None,
                None,
            )
            .await;
    }
    let build = build?;

    // What the daemon built, not what we asked for: a deploy publishes work the
    // agent left uncommitted, so HEAD can sit past the sha read off Gitea before
    // any of this started.
    let built_sha = row_str(&build, "gitCommitSha")
        .map(str::to_string)
        .or(git_commit_sha);

    let mut finalize_body = json!({ "deployToken": deploy_token });
    if let Some(sha) = built_sha {
        finalize_body["gitCommitSha"] = json!(sha);
    }
    // What the app declared, and — for a container app — the image that build
    // actually pushed. This path used to send neither, so an agent-driven
    // deploy of an app with its own declaration silently finalized on the
    // built-in contract while the same deploy from the UI honoured it.
    if let Some(manifest) = manifest {
        finalize_body["runtime"] = manifest.clone();
    }
    if let Some(image) = row_str(&build, "image") {
        finalize_body["image"] = json!(image);
    }
    // Finalize provisions the schema and points the function at the artifact.
    // The UI waits for it with no timeout at all; giving up at the shared
    // client's 30 s reported a deploy the server went on to finish as a
    // failure, and wrote `deploy_error` over it.
    api.call(
        Method::POST,
        &app_path(app_id, "/deploy/finalize"),
        Some(&finalize_body),
        Some(Duration::from_secs(5 * 60)),
        "Publishing the build (deploy finalize)",
    )
    .await
}

/// The whole deploy, the same three legs the desktop UI runs: mint the upload
/// handle, have the local daemon build and upload the artifact, publish it.
///
/// It lives in this process because the middle leg needs the local daemon and
/// the outer two need the user's cloud bearer, and this is the only process
/// holding both. A failure after `/deploy` must report `deploy_error` back:
/// nothing server-side can observe that the local build never finished, and a
/// row left at `awaiting_build` blocks every later deploy for 30 minutes.
async fn run_app_deploy(api: &AppApi, row: &Value) -> Result<Value, String> {
    let app_id = row_id(row)?;
    let team_id = row_str(row, "teamId").unwrap_or_default().to_string();
    let provision = row_str(row, "provisionStatus").unwrap_or_default();
    if provision != "ready" {
        return Err(format!(
            "This app is not ready to deploy (provisionStatus={provision}). Its checkout has to be seeded first."
        ));
    }
    let via_gitea = is_gitea_managed(row);

    // Only a Gitea-managed app deploys a commit off the forge. An app imported
    // from someone else's repo has no repo of ours and no credential for the one
    // it came from, so it deploys its checkout as it sits.
    let mut git_commit_sha: Option<String> = None;
    if via_gitea {
        let head = api
            .get(
                &app_path(&app_id, "/git-head"),
                "Reading the repository HEAD",
            )
            .await?;
        let sha = row_str(&head, "sha")
            .ok_or("The app's Gitea repo has no HEAD — commit and push before deploying.")?;
        git_commit_sha = Some(sha.to_string());
    }

    // Read before the deploy is minted, not after: a container app is handed a
    // registry to push to and every other app a presigned URL to upload to, and
    // only the machine holding the checkout can say which this is.
    let manifest = daemon_app_manifest(&app_id, &team_id).await;
    let mut start_body = json!({ "runtime": manifest_runtime(manifest.as_ref()) });
    if let Some(sha) = &git_commit_sha {
        start_body["gitCommitSha"] = json!(sha);
    }
    let started = api
        .call(
            Method::POST,
            &app_path(&app_id, "/deploy"),
            Some(&start_body),
            Some(Duration::from_secs(60)),
            "Starting the deploy (needs admin on the app)",
        )
        .await?;
    let deploy_token = row_str(&started, "deployToken")
        .unwrap_or_default()
        .to_string();
    let handle = match started.get("image").filter(|v| v.is_object()) {
        Some(image) => DeployHandle::Push(image.clone()),
        None => {
            let url = row_str(&started, "presignedPut").unwrap_or_default();
            if url.is_empty() {
                return Err("deploy start returned no upload handle".to_string());
            }
            DeployHandle::Upload(url.to_string())
        }
    };
    if deploy_token.is_empty() {
        return Err("deploy start returned no deploy token".to_string());
    }

    // From here the server has written `awaiting_build` and this call owns it.
    match finish_app_deploy(
        api,
        &app_id,
        &team_id,
        via_gitea,
        git_commit_sha,
        &deploy_token,
        &handle,
        manifest.as_ref(),
    )
    .await
    {
        Ok(finished) => Ok(finished),
        Err(reason) => {
            let reason = redact_deploy_secrets(&reason);
            let _ = api
                .send(
                    Method::PATCH,
                    &app_path(&app_id, ""),
                    Some(&json!({
                        "fcStatus": "deploy_error",
                        "deployError": reason,
                    })),
                    None,
                )
                .await;
            Err(reason)
        }
    }
}

// ─── Logs ───────────────────────────────────────────────────────────────────

/// `manage_app` action `logs` — the deployed function's own output.
///
/// The window and the row cap are bounded here as well as server-side: an app
/// under load writes more in ten minutes than a turn can hold, and a tool result
/// large enough to blow the context is worse than no logs at all.
async fn read_app_logs(api: &AppApi, row: &Value, v: &Value) -> Result<Value, String> {
    let app_id = row_id(row)?;
    let fc_status = row_str(row, "fcStatus").unwrap_or("");
    if fc_status.is_empty() || fc_status == "not_deployed" {
        return Err(
            "This app has never been deployed, so it has no logs yet. Deploy it first.".to_string(),
        );
    }

    let since_minutes = u64_body_field(v, "since_minutes", "sinceMinutes")
        .unwrap_or(30)
        .clamp(1, 7 * 24 * 60);
    let limit = u64_body_field(v, "limit", "limit")
        .unwrap_or(100)
        .clamp(1, 200);
    let kind = str_body_field(v, "kind", "kind").unwrap_or_else(|| "app".to_string());
    if !matches!(kind.as_str(), "app" | "request" | "all") {
        return Err(format!(
            "Unknown kind: {kind} (expected app, request or all)"
        ));
    }

    let mut query = format!("?sinceMinutes={since_minutes}&limit={limit}&kind={kind}");
    if let Some(contains) = str_body_field(v, "contains", "contains") {
        query.push_str(&format!("&contains={}", urlencoding::encode(&contains)));
    }
    if let Some(request_id) = str_body_field(v, "request_id", "requestId") {
        query.push_str(&format!("&requestId={}", urlencoding::encode(&request_id)));
    }

    let out = api
        .get(
            &app_path(&app_id, &format!("/logs{query}")),
            "Reading the app's logs (needs prompt on it)",
        )
        .await?;

    Ok(json!({
        "action": "logs",
        "app_id": app_id,
        "since_minutes": since_minutes,
        "kind": kind,
        "entries": out.get("items").cloned().unwrap_or(json!([])),
        "truncated": out.get("truncated").cloned().unwrap_or(json!(false)),
    }))
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

    fn checkouts(pairs: &[(&str, &str)]) -> Vec<(String, std::path::PathBuf)> {
        pairs
            .iter()
            .map(|(id, dir)| (id.to_string(), std::path::PathBuf::from(dir)))
            .collect()
    }

    #[test]
    fn the_workspace_resolves_to_the_app_whose_checkout_it_is() {
        let apps = checkouts(&[("app-1", "/home/u/apps/notes"), ("app-2", "/work/py")]);
        // The checkout root itself, and a file the agent happens to be editing
        // deeper inside it, are the same app.
        assert_eq!(
            app_owning_path(std::path::Path::new("/work/py"), &apps).as_deref(),
            Some("app-2")
        );
        assert_eq!(
            app_owning_path(std::path::Path::new("/work/py/backend/src"), &apps).as_deref(),
            Some("app-2")
        );
    }

    #[test]
    fn a_shared_prefix_is_not_a_match() {
        // String prefixes would make `/work/py-2` part of `/work/py`, and a
        // deploy would publish the wrong app. Matching is component-wise.
        let apps = checkouts(&[("app-2", "/work/py")]);
        assert!(app_owning_path(std::path::Path::new("/work/py-2"), &apps).is_none());
        assert!(app_owning_path(std::path::Path::new("/work"), &apps).is_none());
    }

    #[test]
    fn a_checkout_inside_a_checkout_resolves_to_the_inner_one() {
        let apps = checkouts(&[("outer", "/work"), ("inner", "/work/apps/site")]);
        assert_eq!(
            app_owning_path(std::path::Path::new("/work/apps/site/public"), &apps).as_deref(),
            Some("inner")
        );
    }

    #[test]
    fn deploy_errors_do_not_carry_the_upload_credential() {
        // The presigned PUT is a bearer for the app's OSS object, the daemon
        // quotes the URL it failed on, and `deployError` is readable by anyone
        // who can see the app row.
        let leaked = "Daemon build failed: PUT https://bucket.oss-cn-shenzhen.aliyuncs.com/apps/1/code.zip?OSSAccessKeyId=LTAI5t&Signature=abc%3D&Expires=1788 returned 403";
        let safe = redact_deploy_secrets(leaked);
        assert!(!safe.contains("Signature="), "{safe}");
        assert!(!safe.contains("OSSAccessKeyId="), "{safe}");
        // Still says where it failed, or the message is useless.
        assert!(
            safe.contains("bucket.oss-cn-shenzhen.aliyuncs.com/apps/1/code.zip"),
            "{safe}"
        );
        assert!(safe.contains("403"), "{safe}");
    }

    #[test]
    fn redaction_leaves_an_ordinary_message_alone_and_bounds_it() {
        let plain = "pnpm build timed out after 10 minutes";
        assert_eq!(redact_deploy_secrets(plain), plain);
        let huge = "x".repeat(5000);
        assert!(redact_deploy_secrets(&huge).chars().count() <= 801);
    }

    #[test]
    fn a_409_keeps_the_server_s_code_and_message() {
        // The reason this module does not use FcClient's error: it turns this
        // exact body into "conflict: remote_version=None".
        let e = cloud_error_from(
            409,
            br#"{"error":{"code":"app_has_no_database","message":"this app type has no database"}}"#,
        );
        assert_eq!(e.code, "app_has_no_database");
        let text = explain("Listing tables", &e);
        assert!(
            text.contains("409 app_has_no_database: this app type has no database"),
            "{text}"
        );
        assert!(
            text.contains("only data_app apps have a database"),
            "{text}"
        );
    }

    #[test]
    fn a_404_says_it_may_be_a_permission_rather_than_a_missing_app() {
        let e = cloud_error_from(
            404,
            br#"{"error":{"code":"not_found","message":"app not found"}}"#,
        );
        assert!(explain("Deleting the app", &e).contains("lacks the permission"));
    }

    #[test]
    fn an_error_body_that_is_not_json_is_still_reported() {
        let e = cloud_error_from(502, b"<html>Bad Gateway</html>");
        assert_eq!(e.status, 502);
        assert!(e.message.contains("Bad Gateway"), "{}", e.message);
    }

    #[test]
    fn unknown_actions_are_refused_before_anything_is_resolved() {
        let err = require_action(&json!({ "action": "publish" }), &MANAGE_ACTIONS).unwrap_err();
        assert!(err.contains("publish") && err.contains("deploy"), "{err}");
        assert!(require_action(&json!({}), &MANAGE_ACTIONS)
            .unwrap_err()
            .contains("(missing)"));
    }

    #[test]
    fn irreversible_actions_do_not_fall_back_to_the_workspace() {
        let err =
            require_named_app(&json!({ "workspace_path": "/work/site" }), "delete").unwrap_err();
        assert!(err.contains("app_id or app_name"), "{err}");
        assert!(require_named_app(&json!({ "app_name": "记账" }), "delete").is_ok());
    }

    #[test]
    fn update_maps_every_setting_to_the_row_s_own_field_names() {
        let patch = update_patch(&json!({
            "name": "记账",
            "type": "data_app",
            "visibility": "team",
            "auth_mode": "platform",
            "auth_audience": "org",
            "auth_scope": "paths",
            "auth_rules": [{ "path": "/admin", "auth": "required", "audience": "org" }],
        }))
        .unwrap();
        assert_eq!(
            patch,
            json!({
                "name": "记账",
                "type": "data_app",
                "visibility": "team",
                "authMode": "platform",
                "authAudience": "org",
                "authScope": "paths",
                "authRules": [{ "path": "/admin", "auth": "required", "audience": "org" }],
            })
        );
    }

    #[test]
    fn update_refuses_values_the_row_does_not_take() {
        assert!(
            update_patch(&json!({ "type": "fullstack_tanstack_postgres" }))
                .unwrap_err()
                .contains("static_web")
        );
        // Disabled in the UI because it cannot be deployed.
        assert!(update_patch(&json!({ "auth_mode": "third" }))
            .unwrap_err()
            .contains("none, platform"));
        assert!(
            update_patch(&json!({ "auth_rules": [{ "path": "admin", "auth": "required" }] }))
                .unwrap_err()
                .contains("starting with")
        );
        assert!(update_patch(&json!({ "auth_rules": "/admin" }))
            .unwrap_err()
            .contains("array"));
        // A status field is not a setting, and nothing to change is a mistake.
        assert!(update_patch(&json!({ "fcStatus": "live" }))
            .unwrap_err()
            .contains("at least one"));
    }

    #[test]
    fn leaving_data_app_warns_that_the_database_goes_away_on_deploy() {
        let before = json!({ "type": "data_app" });
        let after = json!({ "type": "static_web", "typePendingRedeploy": true });
        let notes = update_notes(&before, &json!({ "type": "static_web" }), &after).join("\n");
        assert!(
            notes.contains("WARNING") && notes.contains("DATABASE_URL"),
            "{notes}"
        );
        assert!(notes.contains("data is kept"), "{notes}");
        assert!(notes.contains("deploy"), "{notes}");

        // Legacy rows store an unrecognised type, which IS a data app.
        let legacy = json!({ "type": "fullstack_tanstack_postgres" });
        let notes = update_notes(&legacy, &json!({ "type": "slides" }), &after).join("\n");
        assert!(notes.contains("WARNING"), "{notes}");

        let notes = update_notes(
            &json!({ "type": "static_web" }),
            &json!({ "type": "data_app" }),
            &json!({ "type": "data_app" }),
        )
        .join("\n");
        assert!(notes.contains("creates this app's database"), "{notes}");
        assert!(!notes.contains("WARNING"), "{notes}");
    }

    #[test]
    fn a_login_change_says_it_is_live_without_a_deploy() {
        let notes = update_notes(
            &json!({ "authMode": "platform" }),
            &json!({ "authMode": "none" }),
            &json!({ "authMode": "none" }),
        )
        .join("\n");
        assert!(notes.contains("no deploy needed"), "{notes}");
        assert!(notes.contains("anyone with the URL"), "{notes}");
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
