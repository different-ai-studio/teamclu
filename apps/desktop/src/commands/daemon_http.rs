//! Tauri commands that let the frontend discover the daemon's local HTTP
//! server, plus the desktop-side helpers over its `/v1/workspaces*`,
//! `/v1/agent/*` and `/v1/rpc` routes.
//!
//! The daemon writes two runtime files when it starts its HTTP listener:
//! - `<amuxd-home>/run/amuxd.http.port`  — the bound TCP port (decimal)
//! - `<amuxd-home>/run/amuxd.http.token` — the root bearer token
//!
//! Official brands use `~/.amuxd`; white-label uses `~/.amuxd-<brand>`.
//!
//! Discovery, the shared HTTP client and scoped-token exchange all live in
//! [`crate::daemon_client`]; this file only knows the endpoints.

use std::collections::HashSet;
use std::time::Duration;

use serde::Serialize;

use crate::daemon_client::{self as daemon, wire, DaemonError, RequestSpec, NO_BODY};

pub use wire::MaterializeTeamMcpResponse;

const WORKSPACE_READ: &[&str] = &["workspace:read"];
const WORKSPACE_WRITE: &[&str] = &["workspace:write"];
const WORKSPACE_READ_WRITE: &[&str] = &["workspace:read", "workspace:write"];

fn amuxd_dir() -> std::path::PathBuf {
    super::amuxd_home_dir()
}

/// Connection information for the daemon's local HTTP server.
#[derive(Debug, Serialize)]
pub struct DaemonHttpInfo {
    /// e.g. `"http://127.0.0.1:52341"`
    pub base_url: String,
    /// Root bearer token. The frontend should exchange this immediately via
    /// `POST /v1/auth/exchange` to obtain a scoped session token.
    pub root_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonWorkspace {
    pub workspace_id: String,
    pub path: String,
    pub display_name: String,
    pub is_default: bool,
}

/// Return the daemon HTTP base URL and root token, or `None` if the daemon is
/// not running or has not started its HTTP listener yet.
#[tauri::command]
pub async fn get_daemon_http_info() -> Result<Option<DaemonHttpInfo>, String> {
    // `discover` only fails when there is no usable listener published, which
    // is exactly the `None` this command promises.
    Ok(daemon::discover().ok().map(|ep| DaemonHttpInfo {
        base_url: ep.base_url,
        root_token: ep.root_token,
    }))
}

/// The team this machine's daemon is onboarded to, read from
/// `~/.amuxd/daemon.toml`. `None` when the daemon hasn't been onboarded (no
/// config / no team_id) or the file can't be read.
///
/// The daemon is single-team: its `team_id` is set once at `amuxd init` and is
/// independent of whichever team the app currently has selected. The settings
/// UI compares the two and warns the user when they diverge, since team-share
/// content is synced/linked under the daemon's team, not the app's.
#[tauri::command]
pub async fn get_daemon_team_id() -> Result<Option<String>, String> {
    Ok(crate::commands::amuxd_active_team())
}

/// The daemon's actor_id, or an empty string while the daemon is not onboarded
/// or not ready — callers treat empty as "not ready".
///
/// Steady state this is what `GET /v1/setup/status` last answered: `daemon_live`
/// refreshes it every time the daemon (re)connects and onboarding records it on
/// claim, so the desktop no longer opens the daemon's private `backend.toml`
/// (which also carries a refresh token) to learn its own daemon's identity.
///
/// Sync because its caller, `register_window_workspace`, is a sync command. On a
/// cold cache — a window bound before the daemon's first connect — it falls back
/// to the file read one more time and kicks a background refresh so the next
/// call is answered by the endpoint.
pub(crate) fn read_daemon_actor_id() -> String {
    if let Some(actor_id) = daemon::cached_actor_id() {
        return actor_id;
    }
    daemon::refresh_actor_id_in_background();
    read_backend_toml_actor_id()
}

/// Minimal view of `teams/<id>/state/backend.toml` — just the actor_id field.
#[derive(Debug, serde::Deserialize)]
struct BackendCloudApi {
    #[serde(default)]
    actor_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BackendConfig {
    #[serde(default)]
    cloud_api: Option<BackendCloudApi>,
}

/// Cold-cache fallback for [`read_daemon_actor_id`]: the active team's
/// `state/backend.toml` (`[cloud_api] actor_id`), followed through the
/// `active_team` pointer in `daemon.toml`. Goes away once the one sync caller
/// can await [`daemon::refresh_actor_id`] instead.
fn read_backend_toml_actor_id() -> String {
    let Some(team) = crate::commands::amuxd_active_team() else {
        return String::new();
    };
    let config_path = crate::commands::amuxd_team_state_dir(&team).join("backend.toml");

    let body = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let parsed: BackendConfig = match toml::from_str(&body) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    parsed
        .cloud_api
        .and_then(|c| c.actor_id)
        .map(|a| a.trim().to_owned())
        .unwrap_or_default()
}

/// Return this daemon's team's on-disk workspaces via the daemon's loopback
/// `GET /v1/workspaces`, which sources from the cloud `amux.workspaces` table
/// (the sole source of truth) filtered to paths that exist on this machine.
///
/// Returns an empty list (not an error) when the daemon HTTP listener isn't
/// up yet (port/token files missing) so callers can treat it as a soft no-op.
/// A daemon that is up but answers badly — non-2xx, or a body that does not
/// decode — is an error: the caller (`local-daemon-workspaces.ts`) catches it,
/// and an empty picker with a logged cause beats one with no cause.
#[tauri::command]
pub async fn list_local_daemon_workspaces() -> Result<Vec<LocalDaemonWorkspace>, String> {
    let Ok(endpoint) = daemon::discover() else {
        return Ok(vec![]);
    };
    let listed: wire::ListWorkspacesResponse = daemon::call(
        &endpoint,
        RequestSpec::get("/v1/workspaces", WORKSPACE_READ),
        NO_BODY,
    )
    .await?;
    Ok(listed
        .workspaces
        .into_iter()
        .map(|w| LocalDaemonWorkspace {
            workspace_id: w.workspace_id,
            path: w.path,
            display_name: w.display_name,
            is_default: w.is_default,
        })
        .collect())
}

fn encode_workspace_id(workspace_path: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(workspace_path.as_bytes())
}

/// Ask the local daemon to materialize team MCP definitions into `opencode.json`.
///
/// Best-effort from team-git join: returns `Err` when the daemon HTTP listener
/// is unavailable; callers should log and continue (materialization also happens
/// lazily on `GET /v1/workspaces/:id/mcp`).
pub async fn materialize_team_mcp_via_daemon(
    workspace_path: &str,
) -> Result<MaterializeTeamMcpResponse, String> {
    let ws_id = encode_workspace_id(workspace_path);
    let path = format!("/v1/workspaces/{ws_id}/mcp/materialize-team");
    Ok(daemon::call_discovered(RequestSpec::post(&path, WORKSPACE_WRITE), NO_BODY).await?)
}

/// `GET /v1/workspaces/:id/mcp` — merged MCP map for the workspace.
pub async fn get_mcp_via_daemon(workspace_path: &str) -> Result<serde_json::Value, String> {
    let ws_id = encode_workspace_id(workspace_path);
    let path = format!("/v1/workspaces/{ws_id}/mcp");
    Ok(daemon::call_discovered(RequestSpec::get(&path, WORKSPACE_READ_WRITE), NO_BODY).await?)
}

/// `PUT /v1/workspaces/:id/mcp` — replace workspace MCP map. Returns `{ outcome }`.
pub async fn put_mcp_via_daemon(
    workspace_path: &str,
    servers: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let ws_id = encode_workspace_id(workspace_path);
    let path = format!("/v1/workspaces/{ws_id}/mcp");
    Ok(
        daemon::call_discovered(RequestSpec::put(&path, WORKSPACE_READ_WRITE), Some(servers))
            .await?,
    )
}

/// Local fast-path RPC: POST the given `teamclu.RpcRequest` protobuf bytes
/// (base64) to the daemon's loopback `POST /v1/rpc` and return the
/// `teamclu.RpcResponse` protobuf bytes (base64).
///
/// The webview calls this only when the target actor is this machine's
/// daemon; any error here makes the frontend fall back to the MQTT RPC path
/// transparently, so failures are returned as plain strings, never panics.
/// The `sessions:write` token is cached by the client and re-exchanged once on
/// a `401` (daemon restarted on a reused port).
#[tauri::command]
pub async fn daemon_rpc(payload_b64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let payload = STANDARD
        .decode(payload_b64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    let endpoint = daemon::discover()?;
    let spec = RequestSpec::post("/v1/rpc", &["sessions:write"]).timeout(Duration::from_secs(10));
    let resp = daemon::send_bytes(&endpoint, spec, "application/x-protobuf", &payload).await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("rpc status: {status}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("rpc body: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

/// The `fetch_*` helpers below answer `None` on any failure because their
/// callers (cron) treat "unknown" as "skip validation". The failure still gets
/// logged, at debug level when the daemon is simply not running and as a
/// warning for anything the daemon actually answered.
fn log_soft_failure(what: &str, err: &DaemonError) {
    if err.is_unavailable() {
        tracing::debug!("[daemon-http] {what}: {err}");
    } else {
        tracing::warn!("[daemon-http] {what}: {err}");
    }
}

/// `GET /v1/workspaces/:id/providers` — canonical LLM provider list for a workspace.
pub async fn fetch_workspace_provider_model_keys(workspace_path: &str) -> Option<HashSet<String>> {
    let ws_id = encode_workspace_id(workspace_path);
    let path = format!("/v1/workspaces/{ws_id}/providers");
    let providers: Vec<wire::ProviderInfo> =
        match daemon::call_discovered(RequestSpec::get(&path, WORKSPACE_READ), NO_BODY).await {
            Ok(v) => v,
            Err(err) => {
                log_soft_failure("workspace providers", &err);
                return None;
            }
        };

    let mut keys = HashSet::new();
    for provider in providers {
        for model_id in provider.models {
            keys.insert(format!(
                "{}/{}",
                provider.id.to_lowercase(),
                model_id.to_lowercase()
            ));
        }
    }
    Some(keys)
}

/// `GET /v1/workspaces/:id/model-catalog` — model refs across every configured
/// backend (OpenCode, Claude Code, Codex), lowercased for case-insensitive
/// validation. Unlike `fetch_workspace_provider_model_keys` (OpenCode only)
/// this is the source of truth for cron model validation, since a cron job may
/// pin a Claude or Codex model that the OpenCode provider list never reports.
pub async fn fetch_workspace_model_catalog_keys(workspace_path: &str) -> Option<HashSet<String>> {
    let ws_id = encode_workspace_id(workspace_path);
    let path = format!("/v1/workspaces/{ws_id}/model-catalog");
    let catalog: wire::ModelCatalog =
        match daemon::call_discovered(RequestSpec::get(&path, WORKSPACE_READ), NO_BODY).await {
            Ok(v) => v,
            Err(err) => {
                log_soft_failure("workspace model catalog", &err);
                return None;
            }
        };

    let mut keys = HashSet::new();
    for backend in catalog.backends {
        for model in backend.models {
            keys.insert(model.model_ref.to_lowercase());
        }
    }
    Some(keys)
}

/// `GET /v1/agent/default-workspace` — the daemon's own agent's default
/// working directory, resolved cloud-side from `agents.default_workspace_id`
/// (falling back to the team's first on-disk workspace). Replaces reading
/// `~/.amuxd/workspaces.toml`'s `default_workspace_id` directly: that local
/// file only tracks per-device workspace registrations, not the cloud
/// `agents` row that is now the source of truth for "which workspace does
/// this agent's cron/global work run in".
///
/// Returns `None` when the daemon HTTP listener isn't up yet, the daemon
/// isn't onboarded, or the daemon has no resolvable default (no agent
/// default configured and no on-disk team workspace either).
pub async fn fetch_daemon_default_workspace_path() -> Option<String> {
    let resp: wire::DefaultWorkspaceResponse = match daemon::call_discovered(
        RequestSpec::get("/v1/agent/default-workspace", WORKSPACE_READ),
        NO_BODY,
    )
    .await
    {
        Ok(v) => v,
        Err(err) => {
            log_soft_failure("agent default workspace", &err);
            return None;
        }
    };
    resp.path.filter(|p| !p.trim().is_empty())
}

/// Workspace record returned by the daemon's `POST /v1/workspaces` endpoint.
/// Fields mirror the daemon's snake_case JSON (`RegisterWorkspaceResponseBody`).
pub type RegisteredDaemonWorkspace = wire::RegisterWorkspaceResponse;

/// Register `workspace_path` into the cloud `amux.workspaces` table (the
/// sole source of truth) by calling the daemon's loopback
/// `POST /v1/workspaces`. Idempotent — safe to call on every launch. The
/// desktop registers the user's chosen project workspace, not the daemon's
/// internal `~/.amuxd/teams/<id>` global sync store (that path is rejected).
///
/// Returns `Ok(None)` when the daemon HTTP listener isn't up yet (port/token
/// files missing) so the caller can treat it as a soft no-op and retry later.
#[tauri::command]
pub async fn register_daemon_workspace(
    workspace_path: String,
) -> Result<Option<RegisteredDaemonWorkspace>, String> {
    let path = workspace_path.trim().to_string();
    if path.is_empty() {
        return Err("workspace_path must not be empty".into());
    }

    let amuxd_dir = amuxd_dir();
    if std::path::Path::new(&path).starts_with(&amuxd_dir) {
        return Err(format!(
            "workspace path must not be inside the daemon config directory ({}): {path}",
            amuxd_dir.display()
        ));
    }

    // `apply_add_workspace` requires the path to already exist (it
    // canonicalizes + checks `is_dir`). For a freshly-onboarded team the global
    // dir under the brand amuxd home may not exist yet — the daemon only
    // scaffolds `teamclu-team/` inside it once a workspace is linked. Create it
    // up front so registration succeeds; the daemon then fills in the synced
    // `teamclu-team/` via ensure_team_link.
    if let Err(e) = std::fs::create_dir_all(&path) {
        return Err(format!("create workspace dir {path}: {e}"));
    }
    let Ok(endpoint) = daemon::discover() else {
        return Ok(None);
    };
    let registered: RegisteredDaemonWorkspace = daemon::call(
        &endpoint,
        RequestSpec::post("/v1/workspaces", WORKSPACE_WRITE),
        Some(&wire::RegisterWorkspaceRequest { path }),
    )
    .await?;
    Ok(Some(registered))
}
