//! Apps — the app control panel, as an agent reaches it.
//!
//! The `teamclu-introspect` sidecar's `manage_app*` tools land here, one route
//! per tool, and together they cover what `components/apps/AppControlPanel.tsx`
//! and the tabs it opens let a person do:
//!
//! | tool                | route         | control panel                                         |
//! |---------------------|---------------|-------------------------------------------------------|
//! | `manage_app`        | `/app-manage` | 应用 (name, type, local path, code version, visibility, reseed), 应用权限, deploy, 运行日志, 删除 — plus create and download |
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
//! escalates past what the user may do themselves. On top of that, deploying,
//! deleting and changing who can reach an app wait for the user to approve a
//! native dialog (`../confirm.rs`).
//!
//! The work lives in this process because it is the only one holding both that
//! bearer and a line to the local daemon, which builds what a deploy publishes
//! and seeds, clones and moves checkouts.
//!
//! `list`, `status`, `create`, `reseed`, `download`, `update`, `deploy`,
//! `logs` and `delete` are the
//! `teamclu-apps` crate, which `amuxd app …` runs too on the daemon's own
//! account; this file supplies the user's bearer, the loopback daemon and the
//! approval dialog to it. The rest are still only here.
//!
//! A capability added to the panel belongs here too: the panel and these tools
//! are two views of one control plane, and an agent that can do only half of
//! it stops and asks the user to click the other half.

mod checkout;
mod data;
mod files;
mod settings;

pub(super) use data::handle_app_data;
pub(super) use files::handle_app_files;
pub(super) use settings::{handle_app_access, handle_app_cron, handle_app_domain, handle_app_env};

use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{introspect_current_team, introspect_fc_client, items_of, str_body_field};
use crate::commands::oss_sync::fc_client::FcClient;

// ─── The shared control plane ───────────────────────────────────────────────
//
// What list, status, create, reseed, deploy and logs *do* is `teamclu-apps`,
// shared with `amuxd app …`. This process supplies its three seams: the user's
// bearer ([`AppApi`] as `Cloud`), the local daemon over loopback
// ([`DesktopDaemon`]) and the approval dialog + window refresh
// ([`DesktopHost`]).

pub(super) use teamclu_apps::{app_brief, app_path, canonical_path, row_id, row_str, CloudError};
use teamclu_apps::{AppOps, AppSelector, Surface};

/// One sentence for a failed call: what was being done, and the server's reply.
pub(super) fn explain(what: &str, e: &CloudError) -> String {
    teamclu_apps::explain(Surface::Mcp, what, e)
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

    /// The bearer itself — read for its claims (who is committing a seeded
    /// repo), never sent anywhere but the Cloud API.
    fn bearer(&self) -> &str {
        &self.fc.jwt
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
        let network = |e: reqwest::Error| CloudError::network(e.to_string());
        let response = request.send().await.map_err(network)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(network)?;
        if !(200..300).contains(&status) {
            return Err(CloudError::from_response(status, &bytes));
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

#[async_trait::async_trait]
impl teamclu_apps::Cloud for AppApi {
    async fn send(
        &self,
        method: teamclu_apps::Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, CloudError> {
        let method = match method {
            teamclu_apps::Method::Get => Method::GET,
            teamclu_apps::Method::Post => Method::POST,
            teamclu_apps::Method::Put => Method::PUT,
            teamclu_apps::Method::Patch => Method::PATCH,
            teamclu_apps::Method::Delete => Method::DELETE,
        };
        AppApi::send(self, method, path, body, timeout).await
    }
}

/// The local amuxd, over its loopback API.
pub(super) struct DesktopDaemon;

/// A daemon client failure, as the shared flows read it: down, or there and
/// refusing — with the `detail` of its problem body when it sent one.
pub(super) fn daemon_failure(e: &crate::daemon_client::DaemonError) -> teamclu_apps::DaemonError {
    use crate::daemon_client::DaemonError as E;
    let unreachable = match e {
        E::NotRunning | E::InvalidPort(_) => true,
        E::ExchangeTransport(source) => source.is_connect(),
        E::Transport { source, .. } => source.is_connect(),
        _ => false,
    };
    let message = match e {
        E::Status { status, body, .. } => serde_json::from_str::<Value>(body)
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
    teamclu_apps::DaemonError {
        unreachable,
        message,
    }
}

impl DesktopDaemon {
    async fn get(&self, path: &str, query: &str) -> Result<Value, teamclu_apps::DaemonError> {
        use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};
        daemon::call_discovered(
            RequestSpec::get(path, &["workspace:read"])
                .query(query)
                .timeout(Duration::from_secs(10)),
            NO_BODY,
        )
        .await
        .map_err(|e| daemon_failure(&e))
    }

    pub(super) async fn post(
        &self,
        path: &str,
        scope: &'static str,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, teamclu_apps::DaemonError> {
        use crate::daemon_client::{self as daemon, RequestSpec};
        daemon::call_discovered::<_, Value>(
            RequestSpec::post(path, &[scope]).timeout(timeout),
            Some(body),
        )
        .await
        .map_err(|e| daemon_failure(&e))
    }
}

fn team_query(team_id: &str) -> String {
    format!("?teamId={}", urlencoding::encode(team_id))
}

#[async_trait::async_trait]
impl teamclu_apps::LocalDaemon for DesktopDaemon {
    async fn local_apps(
        &self,
        team_id: &str,
    ) -> Result<Vec<(String, String)>, teamclu_apps::DaemonError> {
        let out = self.get("/v1/apps/local", &team_query(team_id)).await?;
        Ok(out
            .get("apps")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let id = row_str(row, "appId")?;
                        let dir = row_str(row, "workdir")?;
                        Some((id.to_string(), dir.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn workdir(
        &self,
        app_id: &str,
        team_id: &str,
    ) -> Result<Value, teamclu_apps::DaemonError> {
        self.get(
            &format!("/v1/apps/{}/workdir", urlencoding::encode(app_id)),
            &team_query(team_id),
        )
        .await
    }

    async fn manifest(
        &self,
        app_id: &str,
        team_id: &str,
    ) -> Result<Value, teamclu_apps::DaemonError> {
        self.get(
            &format!("/v1/apps/{}/manifest", urlencoding::encode(app_id)),
            &team_query(team_id),
        )
        .await
    }

    async fn seed(
        &self,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, teamclu_apps::DaemonError> {
        self.post("/v1/apps/seed", "workspace:write", body, timeout)
            .await
    }

    async fn build(
        &self,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, teamclu_apps::DaemonError> {
        self.post("/v1/apps/build", "workspace:write", body, timeout)
            .await
    }

    async fn inspect_dir(&self, path: &str) -> Result<Value, teamclu_apps::DaemonError> {
        self.post(
            "/v1/apps/inspect-dir",
            "workspace:read",
            &json!({ "path": path }),
            Duration::from_secs(30),
        )
        .await
    }

    async fn bind_workdir(
        &self,
        app_id: &str,
        team_id: &str,
        dir: &str,
    ) -> Result<Value, teamclu_apps::DaemonError> {
        self.post(
            &format!("/v1/apps/{}/bind-workdir", urlencoding::encode(app_id)),
            "workspace:write",
            &json!({ "teamId": team_id, "workdir": dir }),
            Duration::from_secs(30),
        )
        .await
    }

    async fn actor_id(&self) -> Option<String> {
        use crate::daemon_client as daemon;
        if let Some(id) = daemon::cached_actor_id() {
            return Some(id);
        }
        let endpoint = daemon::discover().ok()?;
        daemon::refresh_actor_id(&endpoint).await.ok().flatten()
    }
}

/// What this process adds to a flow: the user approves a deploy in a native
/// dialog, the open window is told an app changed, and a seed commits as the
/// signed-in user.
pub(super) struct DesktopHost<'a> {
    app: &'a AppHandle,
    zh: bool,
    bearer: String,
}

impl<'a> DesktopHost<'a> {
    pub(super) fn new(app: &'a AppHandle, api: &AppApi) -> Self {
        Self {
            app,
            zh: crate::commands::prefers_zh_locale(),
            bearer: api.bearer().to_string(),
        }
    }
}

#[async_trait::async_trait]
impl teamclu_apps::Host for DesktopHost<'_> {
    fn surface(&self) -> Surface {
        Surface::Mcp
    }

    /// Follows the server preflight, so the dialog names the exact revision's
    /// runtime changes before any upload. An app still on its old domain is
    /// offered a checkbox to switch to its app-code domain on success.
    async fn approve_deploy(&self, row: &Value, preview: &Value) -> Result<bool, String> {
        super::confirm::confirm_app_deploy_domain(
            self.app,
            self.zh,
            row,
            super::confirm::app_deploy_with_preview(self.zh, row, preview),
        )
        .await
    }

    fn app_changed(&self, row: &Value) {
        notify_app_changed(self.app, row);
    }

    fn git_identity(&self) -> (Option<String>, Option<String>) {
        checkout::seed_git_identity(&self.bearer)
    }
}

/// The three seams, borrowed for one tool call.
pub(super) fn app_ops<'a>(api: &'a AppApi, host: &'a DesktopHost<'a>) -> AppOps<'a> {
    AppOps::new(api, &DesktopDaemon, host)
}

// ─── Small shared pieces ────────────────────────────────────────────────────

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

/// Keep the selected daemon's facts intact, rather than substituting the
/// desktop process's OS or the Cloud API's target runtime.
fn selected_host_facts(response: &Value) -> Result<Value, String> {
    let facts = response.get("hostFacts").filter(|facts| {
        ["os", "arch", "buildShell"].iter().all(|key| {
            facts[*key]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
        }) && facts["docker"].is_boolean()
            && ["pnpm", "python3", "go", "java", "docker"]
                .iter()
                .all(|key| facts["buildTools"][*key].is_boolean())
            && facts["buildTools"]["docker"] == facts["docker"]
    });
    facts
        .cloned()
        .ok_or_else(|| "The selected daemon returned no usable host facts.".to_string())
}

// ─── Which app ──────────────────────────────────────────────────────────────

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

/// Resolve the `app_id` / `app_name` argument to exactly one app row — or,
/// with neither, the app whose checkout the caller is working in
/// ([`AppOps::resolve_app`] has the rules).
pub(super) async fn resolve_app_row(
    app: &AppHandle,
    api: &AppApi,
    v: &Value,
) -> Result<Value, String> {
    let selector = AppSelector {
        app_id: str_body_field(v, "app_id", "appId"),
        app_name: str_body_field(v, "app_name", "appName"),
        workspace_path: introspect_caller_workspace(app, v),
    };
    // The current team is only needed to look a name or a directory up; a
    // call naming its app by id works with no team selected.
    let team_id = if selector.app_id.is_some() {
        String::new()
    } else {
        introspect_current_team(app).await?
    };
    let host = DesktopHost::new(app, api);
    app_ops(api, &host).resolve_app(&team_id, &selector).await
}

async fn daemon_selected_host_facts(row: &Value) -> Result<Value, String> {
    use teamclu_apps::LocalDaemon as _;
    let app_id = row_str(row, "id").ok_or("App ID is missing.")?;
    let team_id = row_str(row, "teamId").unwrap_or("");
    let response = DesktopDaemon.workdir(app_id, team_id).await.map_err(|e| {
        format!(
            "Could not read the selected daemon's host facts: {}",
            e.message
        )
    })?;
    selected_host_facts(&response)
}

// ─── manage_app ─────────────────────────────────────────────────────────────

const MANAGE_ACTIONS: [&str; 14] = [
    "list",
    "status",
    "auth_info",
    "runtime_info",
    "sessions",
    "create",
    "update",
    "reseed",
    "download",
    "move_workdir",
    "deploy",
    "undeploy",
    "logs",
    "delete",
];

/// A `create` call's arguments, in the crate's shape.
fn create_args(v: &Value) -> teamclu_apps::CreateArgs {
    teamclu_apps::CreateArgs {
        name: str_body_field(v, "name", "name"),
        visibility: str_body_field(v, "visibility", "visibility"),
        app_type: str_body_field(v, "type", "type"),
        git_remote_url: str_body_field(v, "git_remote_url", "gitRemoteUrl"),
        local_dir: str_body_field(v, "local_dir", "localDir"),
    }
}

/// An `update` call's arguments, in the crate's shape.
fn update_args(v: &Value) -> teamclu_apps::UpdateArgs {
    teamclu_apps::UpdateArgs {
        name: str_body_field(v, "name", "name"),
        app_type: str_body_field(v, "type", "type"),
        visibility: str_body_field(v, "visibility", "visibility"),
        auth_mode: str_body_field(v, "auth_mode", "authMode"),
        auth_audience: str_body_field(v, "auth_audience", "authAudience"),
        auth_scope: str_body_field(v, "auth_scope", "authScope"),
        auth_rules: v.get("auth_rules").or_else(|| v.get("authRules")).cloned(),
    }
}

/// A `logs` call's arguments, in the crate's shape.
fn logs_args(v: &Value) -> teamclu_apps::LogsArgs {
    teamclu_apps::LogsArgs {
        since_minutes: u64_body_field(v, "since_minutes", "sinceMinutes"),
        limit: u64_body_field(v, "limit", "limit"),
        kind: str_body_field(v, "kind", "kind"),
        contains: str_body_field(v, "contains", "contains"),
        request_id: str_body_field(v, "request_id", "requestId"),
    }
}

/// `manage_app` — the app itself: find it, create it, read its settings,
/// change them, put its code on this machine, publish it, read its logs,
/// delete it.
pub(super) async fn handle_app_manage(
    app: &AppHandle,
    _caller: Option<&super::caller::AgentCaller>,
    body: &[u8],
) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &MANAGE_ACTIONS)?;
    // Argument mistakes are refused before anything is resolved, so they cost
    // no round trip and read as the mistakes they are.
    match action.as_str() {
        "delete" | "undeploy" => require_named_app(&v, &action)?,
        "update" => {
            update_args(&v).patch()?;
        }
        "create" => {
            create_args(&v).source()?;
        }
        "move_workdir" => {
            checkout::move_destination(&v)?;
        }
        _ => {}
    }
    let api = AppApi::for_tool(app, &v, "manage_app").await?;
    let host = DesktopHost::new(app, &api);
    let ops = app_ops(&api, &host);

    match action.as_str() {
        "list" => {
            let team_id = introspect_current_team(app).await?;
            return Ok(ops.list(&team_id).await?.to_string());
        }
        "create" => {
            let team_id = introspect_current_team(app).await?;
            return Ok(ops.create(&team_id, &create_args(&v)).await?.to_string());
        }
        _ => {}
    }
    let row = resolve_app_row(app, &api, &v).await?;
    let zh = crate::commands::prefers_zh_locale();

    // Deploy approval follows the server preflight (`DesktopHost`), so the
    // dialog names the exact revision's runtime changes before any upload.
    let confirmation = match action.as_str() {
        "deploy" => None,
        "delete" => Some(super::confirm::app_delete(zh, &row)),
        "undeploy" => Some(super::confirm::app_undeploy(zh, &row)),
        "update" => super::confirm::app_exposure_change(zh, &row, &update_args(&v).patch()?),
        _ => None,
    };
    if let Some(confirmation) = confirmation {
        super::confirm::confirm_with_user(app, confirmation).await?;
    }
    let out = match action.as_str() {
        "auth_info" => read_app_auth_info(&api, &row).await?,
        "status" => json!({ "action": "status", "app": ops.status(&row).await }),
        "runtime_info" => json!({
            "action": "runtime_info",
            "runtime": api
                .get(
                    &runtime_info_path(&row, &v)?,
                    "read the runtime facts",
                )
                .await?,
            "this_machine": daemon_selected_host_facts(&row).await?,
        }),
        "sessions" => app_sessions(&api, &row).await?,
        "update" => ops.update(&row, &update_args(&v)).await?,
        "reseed" => ops.reseed(&row).await?,
        "download" => ops.download(&row).await?,
        "move_workdir" => checkout::move_app_workdir(app, &ops, &row, &v).await?,
        "deploy" => {
            let args = teamclu_apps::DeployArgs {
                migration_intent: v["migrationIntent"].as_bool() == Some(true),
                // The approval dialog asks; nothing is switched unasked.
                use_app_code_domain: false,
            };
            ops.deploy(&row, args).await?
        }
        "logs" => ops.logs(&row, &logs_args(&v)).await?,
        "delete" => ops.delete(&row).await?,
        "undeploy" => undeploy_app(app, &api, &row).await?,
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

fn runtime_info_path(row: &Value, request: &Value) -> Result<String, String> {
    let mut path = app_path(row_str(row, "id").unwrap_or_default(), "/runtime-info");
    if let Some(language) = str_body_field(request, "language", "language") {
        if !matches!(language.as_str(), "node" | "python" | "go" | "php" | "java") {
            return Err("language must be node, python, go, php, or java".to_string());
        }
        path.push_str(&format!("?language={language}"));
    }
    Ok(path)
}

/// The Cloud API owns policy resolution. Preserve raw rules, and expose only
/// the discovery contract (never spread an app row or arbitrary response).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppAuthInfo {
    app_id: String,
    team_id: String,
    organization: Option<AuthOrganization>,
    role_scope: String,
    roles: Vec<AuthRole>,
    auth_mode: String,
    auth_scope: String,
    auth_audience: String,
    auth_rules: Vec<Value>,
    effective_policies: Vec<EffectiveAuthPolicy>,
    organization_status: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct AuthOrganization {
    id: String,
    name: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct AuthRole {
    id: String,
    code: String,
    name: String,
    status: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectiveAuthPolicy {
    path: String,
    kind: String,
    role_codes: Option<Vec<String>>,
    inherited: bool,
    source: String,
}

/// Uses the selected row from the common status selector and authenticated API.
async fn read_app_auth_info(api: &AppApi, row: &Value) -> Result<Value, String> {
    let response = api
        .get(
            &app_path(&row_id(row)?, "/auth-info"),
            "Reading app organization roles and auth policies",
        )
        .await?;
    let info: AppAuthInfo = serde_json::from_value(response)
        .map_err(|_| "App auth discovery unavailable: unreadable Cloud API response".to_string())?;
    let policies: Vec<Value> = info
        .effective_policies
        .into_iter()
        .map(|policy| {
            json!({
                "path": policy.path,
                "kind": policy.kind,
                "role_codes": policy.role_codes,
                "inherited": policy.inherited,
                "source": policy.source,
            })
        })
        .collect();
    Ok(json!({
        "action": "auth_info",
        "app_id": info.app_id,
        "team_id": info.team_id,
        "organization": info.organization,
        "role_scope": info.role_scope,
        "roles": info.roles,
        "auth_mode": info.auth_mode,
        "auth_scope": info.auth_scope,
        "auth_audience": info.auth_audience,
        "auth_rules": info.auth_rules,
        "effective_policies": policies,
        "organization_status": info.organization_status,
    }))
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

async fn undeploy_app(app: &AppHandle, api: &AppApi, row: &Value) -> Result<Value, String> {
    let app_id = row_id(row)?;
    let result = api
        .call(
            Method::POST,
            &app_path(&app_id, "/undeploy"),
            Some(&json!({})),
            None,
            "Uninstalling the deployment (needs admin on it)",
        )
        .await?;
    notify_app_changed(app, &result["app"]);
    let complete = result["operation"]["status"].as_str() == Some("succeeded");
    Ok(
        json!({"ok": true, "action": "undeploy", "app": app_brief(&result["app"]), "operation": result["operation"],
        "complete": complete, "note": if complete {"Deployment uninstalled. App, code, sessions and user data were retained."} else {"Uninstall accepted, not yet complete. Read manage_app status to verify cleanup progress; do not claim success until the operation succeeds."}}),
    )
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn auth_info_maps_cloud_facts_and_reports_unconfigured_or_forbidden() {
        use axum::{
            http::{HeaderMap, StatusCode},
            routing::get,
            Json, Router,
        };
        let rules = json!([
            {"path":"/any", "auth":"required", "roles":[], "audience":"org"},
            {"path":"/staff", "auth":"required", "roles":["custom"]},
            {"path":"/org", "auth":"required", "audience":"org"}
        ]);
        let info = json!({
            "appId":"app-1", "teamId":"team-1", "organization":{"id":"org-1", "name":"Organization"},
            "roleScope":"organization", "roles":[{"id":"role-1", "code":"custom", "name":"Custom", "status":"active"}],
            "authMode":"platform", "authScope":"paths", "authAudience":"org", "authRules":rules,
            "effectivePolicies":[{"path":"/staff", "kind":"org_roles", "roleCodes":["custom"], "inherited":false, "source":"roles"}],
            "organizationStatus":"configured"
        });
        let mut unconfigured = info.clone();
        unconfigured["organization"] = Value::Null;
        unconfigured["organizationStatus"] = json!("unconfigured");
        unconfigured["roles"] = json!([]);
        let router = Router::new()
            .route("/v1/apps/app-1/auth-info", get({let info = info.clone(); move |headers: HeaderMap| {let info = info.clone(); async move {
                assert_eq!(headers["authorization"], "Bearer test-token");
                Json(info)
            }}}))
            .route("/v1/apps/unconfigured/auth-info", get(move || {let info = unconfigured.clone(); async move {Json(info)}}))
            .route("/v1/apps/malformed/auth-info", get(|| async {
                Json(json!({"appId":"malformed", "roles":[]}))
            }))
            .route("/v1/apps/forbidden/auth-info", get(|| async {
                (StatusCode::FORBIDDEN, Json(json!({"error":{"code":"org_roles_forbidden", "message":"organization role directory is not visible"}})))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let api = AppApi {
            fc: crate::commands::oss_sync::fc_client::FcClient {
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
                base_url: format!("http://{addr}"),
                jwt: "test-token".into(),
            },
        };
        let result = read_app_auth_info(&api, &json!({"id":"app-1"}))
            .await
            .unwrap();
        let missing = read_app_auth_info(&api, &json!({"id":"unconfigured"}))
            .await
            .unwrap();
        let error = read_app_auth_info(&api, &json!({"id":"forbidden"}))
            .await
            .unwrap_err();
        let malformed = read_app_auth_info(&api, &json!({"id":"malformed"}))
            .await
            .unwrap_err();
        assert_eq!(
            malformed,
            "App auth discovery unavailable: unreadable Cloud API response"
        );
        assert!(!malformed.contains("test-token"));
        server.abort();
        assert_eq!(
            result,
            json!({
                "action":"auth_info", "app_id":"app-1", "team_id":"team-1", "organization":{"id":"org-1", "name":"Organization"},
                "role_scope":"organization", "roles":[{"id":"role-1", "code":"custom", "name":"Custom", "status":"active"}],
                "auth_mode":"platform", "auth_scope":"paths", "auth_audience":"org", "auth_rules":rules,
                "effective_policies":[{"path":"/staff", "kind":"org_roles", "role_codes":["custom"], "inherited":false, "source":"roles"}],
                "organization_status":"configured"
            })
        );
        assert_eq!(missing["organization_status"], "unconfigured");
        assert!(missing["organization"].is_null());
        assert!(
            error.contains("403") && error.contains("organization role directory"),
            "{error}"
        );
        assert!(!error.contains("test-token"));
    }

    #[test]
    fn auth_info_action_is_supported() {
        assert!(super::require_action(
            &serde_json::json!({"action":"auth_info"}),
            &super::MANAGE_ACTIONS
        )
        .is_ok());
    }

    #[test]
    fn runtime_info_uses_selected_daemon_host_shape() {
        let response = serde_json::json!({"hostFacts": {
            "os":"windows", "arch":"x86_64", "docker":true, "buildShell":"sh -c",
            "buildTools":{"pnpm":true,"python3":false,"go":false,"java":true,"docker":true}
        }});
        assert_eq!(
            super::selected_host_facts(&response).unwrap(),
            response["hostFacts"]
        );
        assert!(super::selected_host_facts(&serde_json::json!({})).is_err());
    }
    #[test]
    fn runtime_info_rejects_malformed_selected_daemon_host_facts() {
        let valid = serde_json::json!({"hostFacts": {
            "os":"windows", "arch":"x86_64", "docker":true, "buildShell":"sh -c",
            "buildTools":{"pnpm":true,"python3":false,"go":false,"java":true,"docker":true}
        }});
        for (pointer, replacement) in [
            ("/hostFacts/os", serde_json::json!("")),
            ("/hostFacts/arch", serde_json::json!(" ")),
            ("/hostFacts/buildShell", serde_json::json!("")),
            ("/hostFacts/buildTools", serde_json::json!({})),
            ("/hostFacts/buildTools/pnpm", serde_json::json!("yes")),
            ("/hostFacts/buildTools/docker", serde_json::json!(false)),
            ("/hostFacts/docker", serde_json::json!("yes")),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert!(super::selected_host_facts(&invalid).is_err(), "{pointer}");
        }
    }
    #[test]
    fn runtime_info_path_forwards_language_and_rejects_unknown() {
        let row = serde_json::json!({"id": "app-1"});
        assert_eq!(
            super::runtime_info_path(&row, &serde_json::json!({"language": "java"})).unwrap(),
            "/v1/apps/app-1/runtime-info?language=java"
        );
        assert_eq!(
            super::runtime_info_path(&row, &serde_json::json!({})).unwrap(),
            "/v1/apps/app-1/runtime-info"
        );
        assert!(super::runtime_info_path(&row, &serde_json::json!({"language": "ruby"})).is_err());
    }
    #[tokio::test]
    async fn app_listing_respects_cloud_api_limit() {
        use axum::{extract::Query, http::StatusCode, routing::get, Json, Router};
        use std::collections::HashMap;

        let router = Router::new().route("/v1/apps", get(|Query(query): Query<HashMap<String, String>>| async move {
            assert_eq!(query.get("teamId").map(String::as_str), Some("team/one"));
            let limit = query.get("limit").and_then(|v| v.parse::<u32>().ok()).unwrap_or(50);
            if !(1..=100).contains(&limit) {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": {"code": "validation_failed", "message": "limit must be an integer from 1 to 100"}})));
            }
            (StatusCode::OK, Json(serde_json::json!({"items": [{"id": "app-1"}]})))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let api = super::AppApi {
            fc: crate::commands::oss_sync::fc_client::FcClient {
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
                base_url: format!("http://{addr}"),
                jwt: "test-token".into(),
            },
        };
        struct NoWindow;
        impl teamclu_apps::Host for NoWindow {
            fn surface(&self) -> teamclu_apps::Surface {
                teamclu_apps::Surface::Mcp
            }
        }
        // The listing is the crate's; what this checks is that it goes out on
        // this process's client with the query the server accepts.
        let result = teamclu_apps::AppOps::new(&api, &super::DesktopDaemon, &NoWindow)
            .list_team_apps("team/one")
            .await;
        server.abort();
        assert_eq!(result.unwrap(), vec![serde_json::json!({"id": "app-1"})]);
    }

    use super::*;

    // These tests fake only OS widget presentation/closure. The decision,
    // timeout and global approval mutex are the same code used in production.
    #[tokio::test(start_paused = true)]
    async fn app_domain_native_choices_serialize_and_timeout_cannot_approve_a_retry() {
        use super::super::confirm::app_domain::{
            run_checkbox, CheckboxApproval, DialogState, NativeClose,
        };
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        use std::time::Duration;
        fn request() -> CheckboxApproval {
            CheckboxApproval {
                title: "Publish?".into(),
                message: "old → candidate".into(),
                accept: "Publish".into(),
                decline: "Decline".into(),
                checkbox_label: "Switch on success".into(),
            }
        }
        for outcome in [
            Ok(false),
            Ok(true),
            Err("declined".into()),
            Err("dismissed".into()),
            Err("parent closed".into()),
        ] {
            let expected = outcome.clone();
            let result = run_checkbox(request(), Duration::from_secs(120), move |_, state| {
                assert!(state.is_pending());
                state.finish(outcome);
                Ok(Box::new(|| {}) as NativeClose)
            })
            .await;
            assert_eq!(result, expected);
        }
        assert!(
            run_checkbox(request(), Duration::from_secs(120), |_, _| Err(
                "widget failed".into()
            ))
            .await
            .is_err()
        );

        let (first_tx, first_rx) = tokio::sync::oneshot::channel::<Arc<DialogState>>();
        let closed = Arc::new(AtomicBool::new(false));
        let close_called = closed.clone();
        let first = tokio::spawn(run_checkbox(
            request(),
            Duration::from_secs(120),
            move |_, state| {
                first_tx.send(state).unwrap();
                // Native teardown acknowledgement is deliberately delayed below.
                Ok(Box::new(move || {
                    close_called.store(true, Ordering::SeqCst);
                }) as NativeClose)
            },
        ));
        let old_dialog = first_rx.await.unwrap();
        let (second_tx, mut second_rx) = tokio::sync::oneshot::channel::<Arc<DialogState>>();
        let second = tokio::spawn(run_checkbox(
            request(),
            Duration::from_secs(120),
            move |_, state| {
                second_tx.send(state).unwrap();
                Ok(Box::new(|| {}) as NativeClose)
            },
        ));
        tokio::task::yield_now().await;
        assert!(
            second_rx.try_recv().is_err(),
            "two requests must not show together"
        );
        tokio::time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert!(
            closed.load(Ordering::SeqCst),
            "timeout must request native closure"
        );
        assert!(
            !old_dialog.is_pending(),
            "timeout owns the terminal rejection"
        );
        assert!(
            second_rx.try_recv().is_err(),
            "hold mutex until native teardown finishes"
        );
        old_dialog.finish(Ok(true)); // Late native acceptance cannot win the timeout.
        assert!(first.await.unwrap().is_err());
        let next_dialog = second_rx.await.unwrap();
        old_dialog.finish(Ok(true)); // Nor can it complete a later attempt.
        assert!(next_dialog.is_pending());
        next_dialog.finish(Ok(false));
        assert_eq!(second.await.unwrap(), Ok(false));

        let (aborted_tx, aborted_rx) = tokio::sync::oneshot::channel::<Arc<DialogState>>();
        let aborted = tokio::spawn(run_checkbox(
            request(),
            Duration::from_secs(120),
            move |_, state| {
                aborted_tx.send(state).unwrap();
                Ok(Box::new(|| {}) as NativeClose)
            },
        ));
        let orphaned_dialog = aborted_rx.await.unwrap();
        aborted.abort(); // A disconnected HTTP requester must not unlock a visible dialog.
        let _ = aborted.await;
        let (later_tx, mut later_rx) = tokio::sync::oneshot::channel::<Arc<DialogState>>();
        let later = tokio::spawn(run_checkbox(
            request(),
            Duration::from_secs(120),
            move |_, state| {
                later_tx.send(state).unwrap();
                Ok(Box::new(|| {}) as NativeClose)
            },
        ));
        tokio::task::yield_now().await;
        assert!(
            later_rx.try_recv().is_err(),
            "request cancellation must not release a visible approval"
        );
        orphaned_dialog.finish(Err("dismissed".into()));
        let later_dialog = later_rx.await.unwrap();
        later_dialog.finish(Ok(false));
        assert_eq!(later.await.unwrap(), Ok(false));
    }

    #[test]
    fn only_an_old_live_domain_is_offered_the_deploy_checkbox() {
        use super::super::confirm::app_domain::legacy_app_domain_choice;
        let legacy = json!({ "usesAppCodeDomain": false, "fcStatus": "live", "fcEndpoint": "https://origin.example", "publicUrl": "https://old.example", "appCodeUrl": "https://a-k7m2q9vx4n8p.example" });
        assert!(legacy_app_domain_choice(&legacy).is_some());
        let mut undeployed = legacy.clone();
        undeployed["fcStatus"] = serde_json::json!("not_deployed");
        assert_eq!(legacy_app_domain_choice(&undeployed), None);
        for field in ["fcEndpoint", "publicUrl", "appCodeUrl"] {
            for value in [json!(""), json!("  "), Value::Null, json!(42)] {
                let mut invalid = legacy.clone();
                invalid[field] = value;
                assert_eq!(
                    legacy_app_domain_choice(&invalid),
                    None,
                    "{field}: {invalid}"
                );
            }
            let mut missing = legacy.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert_eq!(legacy_app_domain_choice(&missing), None);
        }
        assert_eq!(
            legacy_app_domain_choice(&legacy),
            Some((
                "https://old.example".to_string(),
                "https://a-k7m2q9vx4n8p.example".to_string()
            ))
        );
        for (key, value) in [
            ("usesAppCodeDomain", json!(true)),
            ("fcStatus", json!("not_deployed")),
            ("fcEndpoint", Value::Null),
            ("appCodeUrl", Value::Null),
            ("publicUrl", legacy["appCodeUrl"].clone()),
        ] {
            let mut row = legacy.clone();
            row[key] = value;
            assert_eq!(legacy_app_domain_choice(&row), None);
        }
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
}
