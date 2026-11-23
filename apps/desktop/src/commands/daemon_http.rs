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

use std::time::Duration;

use serde::Serialize;

use crate::daemon_client::{self as daemon, wire, RequestSpec, NO_BODY};

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
