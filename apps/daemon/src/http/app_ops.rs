//! `POST /v1/app-ops` — the app control plane, as `amuxd app …` drives it.
//!
//! The flows themselves are `teamclu-apps`, the same crate the desktop's
//! `manage_app` MCP tool runs. What this module adds is how amuxd plugs into
//! it:
//!
//! - **Cloud** — the daemon's own agent account ([`DaemonCloud`]). Apps it
//!   creates are created by that agent, which administers them. Anyone
//!   else's app it can at most read: per-app grants name members only, so a
//!   member's personal app stays invisible to it and a team app is read-only.
//! - **Daemon** — this process ([`InProcessDaemon`]): the `/v1/apps/*`
//!   handlers called directly, not over loopback.
//! - **Host** — no window and no approval dialog. Whoever can read the root
//!   token in `amuxd.http.token` can already drive this daemon outright, so a
//!   prompt here would guard nothing; deploy runs without one.
//!
//! The work runs here rather than in the CLI process because only this
//! process may refresh the agent's cloud session: the refresh token rotates on
//! use, and a second process refreshing it would sign the running daemon out.
//!
//! Every outcome a flow reaches — done, refused, failed — answers 200 with the
//! CLI contract's envelope (docs/specs/2026-11-24-amuxd-app-cli-design.md
//! §2.2): `{"v":1,"ok":true,"data":…}` or `{"v":1,"ok":false,"error":{code,
//! message,next,retryable,kind,exit}}`. HTTP errors are left to the layer
//! below the flows: a token without the scope.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::Value;
use teamclu_apps::{
    AppOps, AppSelector, Cloud, CloudError, CreateArgs, DaemonError, Host, LocalDaemon, LogsArgs,
    Method, OpError, Surface, UpdateArgs,
};

use super::apps;
use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;
use crate::backend::Backend;

/// Every request carries this bound unless the flow passes its own: the
/// shared client has no overall timeout, because `/v1/ai/*` streams.
const DEFAULT_CLOUD_TIMEOUT: Duration = Duration::from_secs(30);

// ─── Cloud: the daemon's agent account ──────────────────────────────────────

struct DaemonCloud {
    backend: Arc<dyn Backend>,
    base_url: String,
    http: reqwest::Client,
}

fn reqwest_method(method: Method) -> reqwest::Method {
    match method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
        Method::Put => reqwest::Method::PUT,
        Method::Patch => reqwest::Method::PATCH,
        Method::Delete => reqwest::Method::DELETE,
    }
}

#[async_trait]
impl Cloud for DaemonCloud {
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, CloudError> {
        // One retry after a 401 with a fresh token, as every other daemon
        // cloud call does: the cached token can be revoked before it expires.
        for is_retry in [false, true] {
            let token = self
                .backend
                .auth_token()
                .await
                .map_err(|e| CloudError::network(format!("no cloud session: {e}")))?;
            let mut request = self
                .http
                .request(reqwest_method(method), format!("{}{path}", self.base_url))
                .bearer_auth(token)
                .header("x-request-id", uuid::Uuid::new_v4().simple().to_string())
                .timeout(timeout.unwrap_or(DEFAULT_CLOUD_TIMEOUT));
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = request
                .send()
                .await
                .map_err(|e| CloudError::network(e.to_string()))?;
            let status = response.status().as_u16();
            let bytes = response
                .bytes()
                .await
                .map_err(|e| CloudError::network(e.to_string()))?;
            if status == 401 && !is_retry {
                self.backend.invalidate_cached_credential();
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(CloudError::from_response(status, &bytes));
            }
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(&bytes).map_err(|e| CloudError {
                status,
                code: "unreadable_response".to_string(),
                message: e.to_string(),
            });
        }
        unreachable!("app-ops cloud retry loop exhausted")
    }
}

// ─── Daemon: this process ───────────────────────────────────────────────────

/// The `/v1/apps/*` handlers, called in-process with the caller's principal —
/// so each one still checks the scope it always checks.
struct InProcessDaemon {
    state: HttpState,
    principal: Principal,
}

fn daemon_error(e: HttpError) -> DaemonError {
    DaemonError::failed(e.detail)
}

fn to_value<T: serde::Serialize>(Json(out): Json<T>) -> Result<Value, DaemonError> {
    serde_json::to_value(out).map_err(|e| DaemonError::failed(e.to_string()))
}

fn from_value<T: serde::de::DeserializeOwned>(body: &Value) -> Result<T, DaemonError> {
    serde_json::from_value(body.clone())
        .map_err(|e| DaemonError::failed(format!("invalid request: {e}")))
}

/// A handler bounded the way the loopback caller bounds it. Over HTTP the
/// client's timeout is what stops a wedged clone; in-process nothing would.
async fn bounded<T>(
    timeout: Duration,
    work: impl std::future::Future<Output = Result<Json<T>, HttpError>>,
) -> Result<Json<T>, DaemonError> {
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result.map_err(daemon_error),
        Err(_) => Err(DaemonError::failed(format!(
            "timed out after {} s",
            timeout.as_secs()
        ))),
    }
}

#[async_trait]
impl LocalDaemon for InProcessDaemon {
    async fn local_apps(&self, team_id: &str) -> Result<Vec<(String, String)>, DaemonError> {
        let out = apps::list_local_apps(
            self.principal.clone(),
            State(self.state.clone()),
            axum::extract::Query(apps::LocalAppsQuery {
                team_id: team_id.to_string(),
            }),
        )
        .await
        .map_err(daemon_error)?;
        Ok(out
            .0
            .apps
            .into_iter()
            .map(|entry| (entry.app_id, entry.workdir))
            .collect())
    }

    async fn workdir(&self, app_id: &str, team_id: &str) -> Result<Value, DaemonError> {
        to_value(
            apps::app_workdir(
                self.principal.clone(),
                State(self.state.clone()),
                axum::extract::Path(app_id.to_string()),
                axum::extract::Query(apps::AppWorkdirQuery {
                    team_id: Some(team_id.to_string()),
                }),
            )
            .await
            .map_err(daemon_error)?,
        )
    }

    async fn manifest(&self, app_id: &str, team_id: &str) -> Result<Value, DaemonError> {
        to_value(
            apps::app_manifest(
                self.principal.clone(),
                State(self.state.clone()),
                axum::extract::Path(app_id.to_string()),
                axum::extract::Query(apps::AppWorkdirQuery {
                    team_id: Some(team_id.to_string()),
                }),
            )
            .await
            .map_err(daemon_error)?,
        )
    }

    async fn seed(&self, body: &Value, timeout: Duration) -> Result<Value, DaemonError> {
        let body = from_value(body)?;
        to_value(
            bounded(
                timeout,
                apps::seed_app(
                    self.principal.clone(),
                    State(self.state.clone()),
                    Json(body),
                ),
            )
            .await?,
        )
    }

    async fn build(&self, body: &Value, timeout: Duration) -> Result<Value, DaemonError> {
        let body = from_value(body)?;
        to_value(
            bounded(
                timeout,
                apps::build_app(
                    self.principal.clone(),
                    State(self.state.clone()),
                    Json(body),
                ),
            )
            .await?,
        )
    }

    async fn inspect_dir(&self, path: &str) -> Result<Value, DaemonError> {
        to_value(
            apps::inspect_dir(
                self.principal.clone(),
                State(self.state.clone()),
                Json(apps::InspectDirBody {
                    path: path.to_string(),
                }),
            )
            .await
            .map_err(daemon_error)?,
        )
    }

    async fn bind_workdir(
        &self,
        app_id: &str,
        team_id: &str,
        dir: &str,
    ) -> Result<Value, DaemonError> {
        to_value(
            apps::bind_app_workdir(
                self.principal.clone(),
                State(self.state.clone()),
                axum::extract::Path(app_id.to_string()),
                Json(apps::BindAppWorkdirBody {
                    team_id: team_id.to_string(),
                    workdir: dir.to_string(),
                }),
            )
            .await
            .map_err(daemon_error)?,
        )
    }

    async fn actor_id(&self) -> Option<String> {
        let id = self.state.backend.as_ref()?.actor_id().to_string();
        (!id.is_empty()).then_some(id)
    }
}

// ─── Host: a command line ───────────────────────────────────────────────────

struct CliHost;

impl Host for CliHost {
    fn surface(&self) -> Surface {
        Surface::Cli
    }
}

// ─── The route ──────────────────────────────────────────────────────────────

/// One call. `action` picks the flow; the rest are its arguments, all
/// optional at this layer so the flow's own validation is the one answer.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppOpsBody {
    pub action: String,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub app_name: Option<String>,
    /// The CLI's current directory: with no id or name, the app is the one
    /// whose checkout this is.
    #[serde(default)]
    pub workspace_path: Option<String>,
    // create, update
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default, rename = "type")]
    pub app_type: Option<String>,
    #[serde(default)]
    pub git_remote_url: Option<String>,
    #[serde(default)]
    pub local_dir: Option<String>,
    // update
    #[serde(default)]
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub auth_audience: Option<String>,
    #[serde(default)]
    pub auth_scope: Option<String>,
    #[serde(default)]
    pub auth_rules: Option<Value>,
    // delete
    /// The caller's explicit go-ahead. Delete has no undo, and this surface
    /// has no dialog to ask in, so the request itself must say yes.
    #[serde(default)]
    pub confirm: bool,
    // deploy
    #[serde(default)]
    pub migration_intent: bool,
    #[serde(default)]
    pub use_app_code_domain: bool,
    // logs
    #[serde(default)]
    pub since_minutes: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub contains: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

const READ_ACTIONS: [&str; 4] = ["whoami", "list", "status", "logs"];
const WRITE_ACTIONS: [&str; 7] = [
    "create", "reseed", "download", "update", "deploy", "undeploy", "delete",
];

/// A non-empty, trimmed string.
fn present(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The contract's envelope (cli-design §2.2).
pub fn envelope(out: Result<Value, OpError>) -> Value {
    match out {
        Ok(data) => serde_json::json!({ "v": 1, "ok": true, "data": data }),
        Err(e) => serde_json::json!({ "v": 1, "ok": false, "error": e.to_json() }),
    }
}

pub async fn app_ops(
    principal: Principal,
    State(state): State<HttpState>,
    Json(body): Json<AppOpsBody>,
) -> Result<Json<Value>, HttpError> {
    let action = body.action.trim().to_string();
    if WRITE_ACTIONS.contains(&action.as_str()) {
        require_scope(&principal, "workspace:write")?;
    } else if READ_ACTIONS.contains(&action.as_str()) {
        require_scope(&principal, "workspace:read")?;
    } else {
        return Ok(Json(envelope(Err(OpError::invalid(
            "unknown_action",
            format!(
                "unknown action {action:?} (expected one of: {}, {})",
                READ_ACTIONS.join(", "),
                WRITE_ACTIONS.join(", ")
            ),
        )
        .with_next("amuxd app --help")))));
    }
    Ok(Json(envelope(run(principal, state, &action, &body).await)))
}

async fn run(
    principal: Principal,
    state: HttpState,
    action: &str,
    body: &AppOpsBody,
) -> Result<Value, OpError> {
    let Some(backend) = state.backend.clone() else {
        return Err(OpError::upstream("daemon_not_onboarded", "this daemon has no cloud backend")
            .with_next("amuxd init"));
    };
    let team_id = backend.team_id().to_string();
    let base_url = backend.cloud_base_url().unwrap_or_default();
    if team_id.is_empty() || base_url.is_empty() {
        return Err(OpError::upstream(
            "daemon_not_onboarded",
            "this daemon is not onboarded to a team yet — run `amuxd init` first",
        )
        .with_next("amuxd init"));
    }
    if action == "whoami" {
        // CLI design §2.5, without the agent / person split (P2.5 decision):
        // every command acts as this daemon's agent account, and the platform
        // decides what that account may do.
        return Ok(serde_json::json!({
            "principal": "daemon_agent",
            "actorId": backend.actor_id(),
            "teamId": team_id,
            "cloud": base_url,
            "note": "Every `amuxd app` command acts as this daemon's agent account. What it may do is that account's grants on each app, including what its owner delegates to it (up to deploy; never delete or managing access).",
        }));
    }

    let cloud = DaemonCloud {
        backend,
        base_url,
        http: state.http_client.clone(),
    };
    let daemon = InProcessDaemon {
        state: state.clone(),
        principal,
    };
    let ops = AppOps::new(&cloud, &daemon, &CliHost);
    let selector = AppSelector {
        app_id: present(&body.app_id),
        app_name: present(&body.app_name),
        workspace_path: present(&body.workspace_path),
    };
    let update = UpdateArgs {
        name: present(&body.name),
        app_type: present(&body.app_type),
        visibility: present(&body.visibility),
        auth_mode: present(&body.auth_mode),
        auth_audience: present(&body.auth_audience),
        auth_scope: present(&body.auth_scope),
        auth_rules: body.auth_rules.clone(),
    };
    // Argument mistakes are refused before anything is resolved, so they cost
    // no round trip and read as the mistakes they are.
    match action {
        "update" => {
            update.patch()?;
        }
        // The app a directory happens to be is the right default for
        // deploying, and the wrong one for deleting: an agent that lost track
        // of which checkout it is in must not destroy the one it stands in.
        "undeploy" if !selector.is_explicit() => {
            return Err(OpError::invalid(
                "explicit_app_required",
                "undeploy takes the app's site offline, so it needs an explicit --id or --app — it does not act on the app inferred from the current directory",
            ))
        }
        "delete" if !selector.is_explicit() => {
            return Err(OpError::invalid(
                "explicit_app_required",
                "delete cannot be undone, so it needs an explicit --id or --app — it does not act on the app inferred from the current directory",
            ))
        }
        "delete" if !body.confirm => {
            return Err(OpError::invalid(
                "confirmation_required",
                "delete cannot be undone: the app's site goes offline and its repository is archived. Pass --yes to delete it.",
            ))
        }
        _ => {}
    }

    match action {
        "list" => ops.list(&team_id).await,
        "create" => {
            let args = CreateArgs {
                name: present(&body.name),
                visibility: present(&body.visibility),
                app_type: present(&body.app_type),
                git_remote_url: present(&body.git_remote_url),
                local_dir: present(&body.local_dir),
            };
            ops.create(&team_id, &args).await
        }
        _ => {
            let row = ops.resolve_app(&team_id, &selector).await?;
            match action {
                "status" => {
                    Ok(serde_json::json!({ "action": "status", "app": ops.status(&row).await }))
                }
                "reseed" => ops.reseed(&row).await,
                "download" => ops.download(&row).await,
                "update" => ops.update(&row, &update).await,
                "undeploy" => ops.undeploy(&row).await,
                "delete" => ops.delete(&row).await,
                "deploy" => {
                    let args = teamclu_apps::DeployArgs {
                        migration_intent: body.migration_intent,
                        use_app_code_domain: body.use_app_code_domain,
                    };
                    ops.deploy(&row, args).await
                }
                "logs" => {
                    let args = LogsArgs {
                        since_minutes: body.since_minutes,
                        limit: body.limit,
                        kind: present(&body.kind),
                        contains: present(&body.contains),
                        request_id: present(&body.request_id),
                    };
                    ops.logs(&row, &args).await
                }
                other => unreachable!("action {other} passed the allow-list"),
            }
        }
    }
}
