// Internal HTTP API server for the teamclu-introspect MCP binary.
//
// Listens on 127.0.0.1:13144 and handles:
//   POST /send-wecom        — send a proactive WeCom message
//   POST /cron-run          — manually trigger a cron job
//   POST /cron-manage       — create/list/pause/resume/delete/run/get_runs (MCP)
//   POST /team-sync-all     — trigger team sync
//   POST /env-var-set       — create or update an env var (`scope`: personal | team)
//   POST /env-var-delete    — delete an env var (`scope`: personal | team)
//   POST /mcp-get           — fetch merged workspace MCP map (daemon)
//   POST /mcp-put           — replace workspace MCP map (daemon)
//   POST /session-archive   — archive a cloud session (PATCH archivedAt)
//   POST /session-participants — list/add/remove a session's participants
//   POST /app-manage        — list/status/deploy an app, or read its logs
//   POST /app-data          — browse and edit a deployed app's own database
//
// Served by axum. STR-10: this used to be a raw `TcpStream` with hand-rolled
// request parsing — a fixed 64 KiB header read, a `\r\n\r\n` scan, a
// `splitn(3, ' ')` request line and a hand-parsed Content-Length. It handled
// no chunked encoding, no header continuation, no pipelining, and answered a
// request whose headers straddled the first read with 400. axum is already a
// dependency of this crate (and already compiled into release), so the
// transport is now hyper's and what is left here is routing and policy.
//
// Access control (SEC-1). Every route here has side effects an agent runtime
// must not be able to trigger by accident, and `/mcp-put` is local code
// execution — so binding to loopback is not enough: any process on the machine,
// and any web page via a `no-cors` fetch, can reach 127.0.0.1. Three checks
// gate every request, before the route is even looked at:
//
//   1. `Authorization: Bearer <token>` must match the per-launch token this
//      process generated and wrote 0600 to `<amuxd home>/run/introspect.http.token`
//      (the same directory and convention as the daemon's `amuxd.http.token`).
//      The sidecar reads that file; nothing else is meant to.
//   2. Any `Origin` header is refused. Browsers always attach one to a
//      cross-origin POST; the sidecar never does.
//   3. `Host` must be a loopback name, closing the DNS-rebinding hole where a
//      page on `evil.example` resolving to 127.0.0.1 would otherwise pass.

pub const INTROSPECT_API_PORT: u16 = 13144;

/// File name of the per-launch bearer, under `<amuxd home>/run/`. Must match
/// `desktop_api::TOKEN_FILE` in the `teamclu-introspect` sidecar crate.
pub const INTROSPECT_TOKEN_FILE: &str = "introspect.http.token";

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;

/// Where this process publishes the bearer the sidecar has to present.
pub fn introspect_token_path() -> PathBuf {
    super::amuxd_run_dir().join(INTROSPECT_TOKEN_FILE)
}

/// 256-bit random token, base64url without padding (43 chars) — the daemon's
/// root-token shape, so anyone reading the run dir sees one convention.
fn generate_token() -> String {
    use base64::Engine as _;
    use rand::RngCore as _;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Write the token owner-readable only. Truncates a stale file from a previous
/// launch; a leftover token would otherwise keep authorising after the process
/// that minted it is gone.
fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    use std::io::Write as _;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        // `mode` only applies when the file is created; an existing file keeps
        // whatever it had, so pin it down explicitly.
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Why a request was turned away before dispatch. The status is what the
/// client sees; the message is what gets logged.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    /// 401 — no usable bearer, or the wrong one.
    Unauthorized(&'static str),
    /// 403 — a browser-shaped request (has `Origin`) or a non-loopback `Host`.
    Forbidden(&'static str),
}

impl Rejection {
    fn status(&self) -> u16 {
        match self {
            Rejection::Unauthorized(_) => 401,
            Rejection::Forbidden(_) => 403,
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Rejection::Unauthorized(m) | Rejection::Forbidden(m) => m,
        }
    }
}

/// Constant-time byte comparison, so the bearer check does not leak how many
/// leading bytes matched. Unequal lengths short-circuit — length is not secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Value of the first header named `name`, trimmed, or None when it is absent
/// or not valid UTF-8. `HeaderMap` lookup is already case-insensitive.
fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

/// `127.0.0.1`, `localhost`, `::1` — with or without a port. Anything else
/// means the request was addressed to some other name that happened to
/// resolve here.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        // `[::1]` or `[::1]:13144`
        match rest.split_once(']') {
            Some((inner, tail)) if tail.is_empty() || tail.starts_with(':') => inner,
            _ => return false,
        }
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1" || name == "::1"
}

/// Gate one request on its headers. Pure: nothing here touches the body, and
/// nothing here looks at the route — a rejected caller must not learn which
/// paths exist.
pub(crate) fn authorize_request(
    headers: &HeaderMap,
    expected_token: &str,
) -> Result<(), Rejection> {
    if headers.contains_key("origin") {
        return Err(Rejection::Forbidden(
            "Forbidden: browser-originated requests are not accepted",
        ));
    }
    match header_value(headers, "host") {
        Some(host) if is_loopback_host(host) => {}
        _ => {
            return Err(Rejection::Forbidden(
                "Forbidden: Host must be a loopback address",
            ))
        }
    }
    let presented = header_value(headers, "authorization")
        .and_then(|value| {
            let (scheme, token) = value.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("bearer")
                .then_some(token.trim())
        })
        .filter(|token| !token.is_empty())
        .ok_or(Rejection::Unauthorized(
            "Unauthorized: missing bearer token (read it from introspect.http.token)",
        ))?;
    if !constant_time_eq(presented.as_bytes(), expected_token.as_bytes()) {
        return Err(Rejection::Unauthorized(
            "Unauthorized: bearer token does not match this app instance",
        ));
    }
    Ok(())
}

impl IntoResponse for Rejection {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status()).unwrap_or(StatusCode::FORBIDDEN);
        let mut response = (status, self.message().to_string()).into_response();
        if status == StatusCode::UNAUTHORIZED {
            // So a client can tell "present a bearer" apart from "your bearer
            // is wrong" without parsing the body.
            response.headers_mut().insert(
                axum::http::header::WWW_AUTHENTICATE,
                "Bearer".parse().unwrap(),
            );
        }
        response
    }
}

/// Turn a handler's `Result<String, String>` into the response the
/// `teamclu-introspect` sidecar expects: `desktop_api::post` reads a 2xx body
/// with `resp.json()` and an error body with `resp.text()`, so success is
/// labelled `application/json` (the raw server this replaced labelled
/// everything that way) and failure is left as the plain sentence it is.
fn handler_response(result: Result<String, String>) -> Response {
    match result {
        Ok(msg) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            msg,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Wrap one `async fn(&AppHandle, &[u8]) -> Result<String, String>` handler as
/// a POST route.
macro_rules! post_route {
    ($handler:path) => {
        axum::routing::post(|State(app): State<AppHandle>, body: Bytes| async move {
            handler_response($handler(&app, &body).await)
        })
    };
}

/// Reject anything that is not this launch's sidecar, before the router looks
/// at the path.
async fn gate(
    State(token): State<Arc<str>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if let Err(rejection) = authorize_request(request.headers(), &token) {
        log::warn!(
            "[IntrospectAPI] rejected {} {}: {}",
            request.method(),
            request.uri().path(),
            rejection.message()
        );
        return rejection.into_response();
    }
    next.run(request).await
}

/// 404 for an unknown path. Wrapped by the same gate as every real route, so
/// an unauthorised caller cannot use the difference between 404 and 401 to map
/// which endpoints exist.
async fn not_found(method: axum::http::Method, uri: axum::http::Uri) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        format!("Not found: {} {}", method, uri.path()),
    )
}

fn router(app: AppHandle, token: Arc<str>) -> Router {
    Router::new()
        .route("/send-wecom", post_route!(handle_send_wecom))
        .route("/cron-run", post_route!(handle_cron_run))
        .route("/cron-manage", post_route!(handle_cron_manage))
        .route("/team-sync-all", post_route!(handle_team_sync_all))
        .route("/env-var-set", post_route!(handle_env_var_set))
        .route("/env-var-delete", post_route!(handle_env_var_delete))
        .route("/channel-set", post_route!(handle_channel_set))
        .route("/mcp-get", post_route!(handle_mcp_get))
        .route("/mcp-put", post_route!(handle_mcp_put))
        .route(
            "/session-participants",
            post_route!(handle_session_participants),
        )
        .route("/session-archive", post_route!(handle_session_archive))
        .route("/app-manage", post_route!(handle_app_manage))
        .route("/app-data", post_route!(handle_app_data))
        .fallback(not_found)
        .with_state(app)
        // `layer`, not `route_layer`: this has to wrap the fallback too, or an
        // unauthorised caller learns which paths exist from the 404.
        .layer(axum::middleware::from_fn_with_state(token, gate))
}

pub async fn start_introspect_api(app: AppHandle) -> anyhow::Result<()> {
    // Mint and publish the bearer before accepting anything, so there is no
    // window where the listener is up and unauthenticated.
    let token: Arc<str> = Arc::from(generate_token());
    let token_path = introspect_token_path();
    write_token_file(&token_path, &token).map_err(|e| {
        anyhow::anyhow!(
            "cannot write introspect token to {}: {e}",
            token_path.display()
        )
    })?;

    let listener = TcpListener::bind(format!("127.0.0.1:{}", INTROSPECT_API_PORT)).await?;
    log::info!(
        "[IntrospectAPI] Listening on 127.0.0.1:{} (bearer in {})",
        INTROSPECT_API_PORT,
        token_path.display()
    );

    axum::serve(listener, router(app, token))
        .await
        .map_err(Into::into)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// Proactive WeCom send from the agent's `introspect` tool.
///
/// Forwards to amuxd rather than calling `teamclu_gateway::wecom::*` here
/// (#933). This used to be the third way a message could reach a chat —
/// alongside the gateway and the MCP `send` tool — and the only one the daemon
/// never saw: it read WeCom credentials out of the workspace `teamclu.json`,
/// pushed over its own HTTP client, and left no trace anywhere a user could
/// look. Now channel I/O happens in one process, with one set of credentials
/// and one placeholder-target guard.
///
/// Still does not produce a session row: `channel-send` carries no reply token
/// and this caller has no session to attach to. That half of #933 stays open.
async fn handle_send_wecom(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    use base64::Engine as _;

    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let target = v.get("target").and_then(|v| v.as_str()).unwrap_or("");
    let message = v.get("message").and_then(|v| v.as_str()).unwrap_or("");

    // If target is empty, fallback to ownerId from config
    let resolved_target: String;
    let target = if target.is_empty() {
        resolved_target = resolve_wecom_owner_id(app)?;
        &resolved_target
    } else {
        target
    };

    // This API's shape is `single:`/`group:`/bare; amuxd dispatch speaks
    // `user:`/`chat:`. Translate here rather than teaching the daemon a second
    // target vocabulary.
    let dispatch_target = if let Some(userid) = target.strip_prefix("single:") {
        format!("user:{userid}")
    } else if let Some(chatid) = target.strip_prefix("group:") {
        format!("chat:{chatid}")
    } else {
        format!("user:{target}")
    };

    let media_bytes = match v.get("media_base64").and_then(|v| v.as_str()) {
        Some(b64) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("Invalid media base64: {}", e))?,
        ),
        None => None,
    };
    let media_filename = v
        .get("media_filename")
        .and_then(|v| v.as_str())
        .unwrap_or("file");

    if message.is_empty() && media_bytes.is_none() {
        return Err("send-wecom: 'message' or 'media_base64' is required".to_string());
    }

    let media = media_bytes
        .as_ref()
        .map(|bytes| super::cron::amuxd_client::ChannelSendMedia {
            bytes,
            filename: media_filename,
        });

    super::cron::amuxd_client::channel_send_media_at(
        &super::amuxd_control::endpoint(),
        "wecom",
        &dispatch_target,
        message,
        media,
    )
    .await?;

    Ok(format!(
        r#"{{"ok":true,"target":"{}","media_sent":{}}}"#,
        dispatch_target,
        media_bytes.is_some()
    ))
}

async fn handle_team_sync_all(app: &AppHandle, _body: &[u8]) -> Result<String, String> {
    // introspect_api has no calling-window context (HTTP server), so it reads
    // current_workspace from the WindowRegistry — and takes `None` for an
    // answer. Team sync is per team, not per workspace; a workspace only asks
    // the daemon to repair that workspace's team links on the way through.
    // Refusing without one made this endpoint unusable on a client with no
    // folder open, for an operation that never needed it.
    let registry = app.state::<super::window::WindowRegistry>();
    let workspace = registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone());
    let result =
        super::team_sync_proxy::daemon_team_sync(workspace.as_deref(), true, false).await?;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

async fn handle_cron_run(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let job_id = v
        .get("job_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: job_id")?;

    // introspect_api has no calling-window context (it's an HTTP server).
    // The request payload may carry an explicit workspace_path; otherwise we
    // fall back to single-instance inference (which errors in multi-window).
    let workspace_path = match v.get("workspace_path").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            let registry = app.state::<super::window::WindowRegistry>();
            registry
                .current_workspace
                .lock()
                .ok()
                .and_then(|cw| cw.clone())
                .ok_or_else(|| {
                    "No workspace path set. Please select a workspace first.".to_string()
                })?
        }
    };

    let cron_state = app.state::<super::cron::CronState>();
    let instance = cron_state
        .try_instance_for(&workspace_path)
        .await
        .ok_or_else(|| format!("Cron not initialized for workspace: {}", workspace_path))?;

    let job = instance
        .storage
        .get_job(job_id)
        .await
        .ok_or_else(|| format!("Job not found: {}", job_id))?;

    let scheduler = instance.scheduler.clone();
    tokio::spawn(async move {
        scheduler.execute_job(job).await;
    });

    Ok(format!(r#"{{"ok":true,"job_id":"{}"}}"#, job_id))
}

async fn handle_cron_manage(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {e}"))?;
    let cron_state = app.state::<super::cron::CronState>();
    let result = super::cron::mcp_manage(app, &cron_state, &v).await?;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Read the WeCom ownerId from the config file.
/// Returns the ownerId or an error if not configured.
fn resolve_wecom_owner_id(app: &AppHandle) -> Result<String, String> {
    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let config = teamclu_gateway::read_config(&workspace_path)?;
    let owner_id = config
        .channels
        .as_ref()
        .and_then(|ch| ch.wecom.as_ref())
        .and_then(|w| w.owner_id.as_ref())
        .filter(|s| !s.is_empty())
        .cloned()
        .ok_or(
            "No WeCom target specified and ownerId is not set. \
             Send a DM to the bot first so ownerId is auto-recorded, \
             or pass an explicit target."
                .to_string(),
        )?;

    Ok(owner_id)
}

// ─── Env Var Handlers ────────────────────────────────────────────────────────

async fn handle_env_var_set(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let scope = v
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("personal")
        .to_string();
    let key = v
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: key")?
        .to_string();
    let value = v
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: value")?
        .to_string();
    let description = v
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let category = v
        .get("category")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let node_id = v
        .get("nodeId")
        .or_else(|| v.get("node_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let team_id = v
        .get("teamId")
        .or_else(|| v.get("team_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Team-scope values live in the Cloud API, so a bearer has to come in with
    // the request. Personal-scope writes stay local and ignore it.
    let access_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Paired with the token on purpose: it was minted by whichever server the
    // caller is pointed at, so the endpoint has to come from the same place.
    let cloud_api_url = v
        .get("cloudApiUrl")
        .or_else(|| v.get("cloud_api_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };
    let shared_secrets = app.state::<super::shared_secrets::SharedSecretsState>();
    super::env_vars::env_catalog_set_for_workspace(
        app,
        &shared_secrets,
        &workspace_path,
        &scope,
        key.clone(),
        value,
        description,
        category,
        node_id,
        team_id,
        access_token,
        cloud_api_url,
    )
    .await?;

    Ok(format!(r#"{{"ok":true,"key":"{}"}}"#, key))
}

async fn handle_env_var_delete(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let scope = v
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("personal")
        .to_string();
    let key = v
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: key")?
        .to_string();
    let node_id = v
        .get("nodeId")
        .or_else(|| v.get("node_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let role = v
        .get("role")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let team_id = v
        .get("teamId")
        .or_else(|| v.get("team_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let access_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Paired with the token on purpose: it was minted by whichever server the
    // caller is pointed at, so the endpoint has to come from the same place.
    let cloud_api_url = v
        .get("cloudApiUrl")
        .or_else(|| v.get("cloud_api_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };
    let shared_secrets = app.state::<super::shared_secrets::SharedSecretsState>();
    super::env_vars::env_catalog_delete_for_workspace(
        app,
        &shared_secrets,
        &workspace_path,
        &scope,
        key.clone(),
        node_id,
        role,
        team_id,
        access_token,
        cloud_api_url,
    )
    .await?;

    Ok(format!(r#"{{"ok":true,"key":"{}"}}"#, key))
}

// ─── Channel Handler ─────────────────────────────────────────────────────────

async fn handle_channel_set(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let channel = v
        .get("channel")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: channel")?;
    let patch = v.get("config").ok_or("Missing field: config")?;

    let valid_channels = [
        "wecom", "discord", "feishu", "email", "kook", "wechat", "seatalk",
    ];
    if !valid_channels.contains(&channel) {
        return Err(format!(
            "Unknown channel: '{}'. Valid: {}",
            channel,
            valid_channels.join(", ")
        ));
    }

    let workspace = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let mut json = super::env_vars::read_teamclu_json(&workspace)?;

    // Ensure channels object exists
    if json.get("channels").is_none() {
        json["channels"] = serde_json::json!({});
    }

    let channels = json["channels"]
        .as_object_mut()
        .ok_or("channels is not an object")?;

    // Merge patch fields into channel config (shallow merge)
    let ch_entry = channels
        .entry(channel.to_string())
        .or_insert_with(|| serde_json::json!({}));

    if let (Some(obj), Some(patch_obj)) = (ch_entry.as_object_mut(), patch.as_object()) {
        for (k, val) in patch_obj {
            obj.insert(k.clone(), val.clone());
        }
    } else {
        return Err("config must be a JSON object".to_string());
    }

    super::env_vars::write_teamclu_json(&workspace, &json)?;

    Ok(format!(r#"{{"ok":true,"channel":"{}"}}"#, channel))
}

fn resolve_workspace_path(app: &AppHandle, body: &serde_json::Value) -> Result<String, String> {
    if let Some(ws) = body
        .get("workspace")
        .or_else(|| body.get("workspace_path"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(ws.to_string());
    }
    let registry = app.state::<super::window::WindowRegistry>();
    registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())
}

/// Body: `{ "workspace"?: string }`. Returns the merged MCP server map from amuxd.
async fn handle_mcp_get(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value = if body.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?
    };
    let workspace = resolve_workspace_path(app, &v)?;
    let servers = super::daemon_http::get_mcp_via_daemon(&workspace).await?;
    serde_json::to_string(&servers).map_err(|e| format!("Serialization error: {e}"))
}

/// Body: `{ "workspace"?: string, "servers": { ... } }`. Replaces workspace MCP map.
async fn handle_mcp_put(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let workspace = resolve_workspace_path(app, &v)?;
    let servers = v.get("servers").ok_or("Missing field: servers")?;
    if !servers.is_object() {
        return Err("servers must be a JSON object".to_string());
    }
    let result = super::daemon_http::put_mcp_via_daemon(&workspace, servers).await?;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

/// Archive a cloud session via `PATCH /v1/sessions/:id` with `{ archivedAt }`.
///
/// Body: `{ "session_id": "...", "archivedAt"?: ISO, "accessToken"?: "...", "cloudApiUrl"?: "..." }`.
/// Credentials fall back to the in-memory introspect auth bridge (pushed by the
/// frontend on sign-in / token refresh).
async fn handle_session_archive(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let session_id = v
        .get("session_id")
        .or_else(|| v.get("sessionId"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("Missing field: session_id")?;

    let archived_at = v
        .get("archivedAt")
        .or_else(|| v.get("archived_at"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let fc = introspect_fc_client(app, &v, "archive_session").await?;
    let path = format!("/v1/sessions/{}", session_id);
    let patch = serde_json::json!({ "archivedAt": archived_at });
    fc.patch_json(&path, &patch)
        .await
        .map_err(|e| format!("Cloud API archive failed: {e}"))?;

    // Best-effort local cache cleanup so the desktop list doesn't resurrect the row.
    let cache = app.state::<crate::local_cache::commands::LocalCacheState>();
    if let Err(e) = crate::local_cache::commands::soft_delete_session_best_effort(
        &cache,
        session_id,
        &archived_at,
    )
    .await
    {
        log::error!("[IntrospectAPI] local cache soft-delete after archive failed: {e}");
    }

    let payload = serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "archivedAt": archived_at,
    });
    serde_json::to_string(&payload).map_err(|e| format!("Serialization error: {e}"))
}

/// Find the position of `\r\n\r\n` in `data`, returning the index of the first `\r`.
/// Cloud API client for an introspect tool call, on behalf of the signed-in user.
///
/// Body-supplied credentials win: the caller may be pointed at a different
/// server than this desktop is. Otherwise the in-memory bridge the frontend
/// pushes on sign-in — nothing is read from disk, and nothing here escalates
/// past what the user themselves may do (RLS still decides).
async fn introspect_fc_client(
    app: &AppHandle,
    v: &serde_json::Value,
    tool: &str,
) -> Result<super::oss_sync::fc_client::FcClient, String> {
    let body_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let body_url = v
        .get("cloudApiUrl")
        .or_else(|| v.get("cloud_api_url"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string());

    let (access_token, cloud_api_url) = match (body_token, body_url) {
        (Some(token), Some(url)) => (token, url),
        (Some(token), None) => {
            let url = super::oss_sync::get_fc_endpoint("");
            (token, url)
        }
        (None, url_opt) => {
            let bridge = app.state::<super::introspect_auth::IntrospectAuthState>();
            let (token, bridged_url) = bridge.get().ok_or_else(|| {
                format!("Not signed in: open TeamClu and sign in so {tool} can call the Cloud API.")
            })?;
            (token, url_opt.unwrap_or(bridged_url))
        }
    };

    let endpoint = super::oss_sync::resolve_runtime_fc_endpoint(&cloud_api_url)?;
    Ok(super::oss_sync::fc_client::FcClient::new(
        endpoint,
        access_token,
    ))
}

fn str_body_field(v: &serde_json::Value, snake: &str, camel: &str) -> Option<String> {
    v.get(snake)
        .or_else(|| v.get(camel))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// One roster row, flattened for an agent to read.
fn participant_brief(row: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "actor_id": row.get("actorId").and_then(|x| x.as_str()).unwrap_or_default(),
        "name": row.get("displayName").and_then(|x| x.as_str()),
        "actor_type": row.get("actorType").and_then(|x| x.as_str()),
        "role": row.get("role").and_then(|x| x.as_str()),
    })
}

fn actor_brief(row: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "actor_id": row.get("id").and_then(|x| x.as_str()).unwrap_or_default(),
        "name": row.get("displayName").and_then(|x| x.as_str()),
        "actor_type": row.get("kind").and_then(|x| x.as_str()),
    })
}

/// Actors that can take part in a session at all — the filter the desktop's own
/// member sheet applies before showing candidates.
fn actor_is_participant_kind(row: &serde_json::Value) -> bool {
    matches!(
        row.get("kind").and_then(|x| x.as_str()),
        Some("member") | Some("agent")
    )
}

/// Actors this tool will add or remove: human members only.
///
/// Agents are deliberately out of scope. Adding one is only half of what the
/// app's member sheet does — it goes on to resolve the agent's workspace, pick
/// its backend and start a runtime (`SessionActorSheet.tsx`). Writing the
/// participant row alone leaves the agent in the roster and mute, which reads
/// as a broken agent rather than an unfinished step.
fn actor_is_human_member(row: &serde_json::Value) -> bool {
    row.get("kind").and_then(|x| x.as_str()) == Some("member")
}

/// Fail unless `actor_id` is a human member. Checked BEFORE any write, so a
/// refusal never leaves a half-added agent behind.
async fn ensure_human_member(
    fc: &super::oss_sync::fc_client::FcClient,
    actor_id: &str,
    verb: &str,
) -> Result<(), String> {
    let actor = fc
        .get_json(&format!("/v1/actors/{}", urlencoding::encode(actor_id)))
        .await
        .map_err(|e| format!("Cloud API actor lookup failed: {e}"))?;
    if actor_is_human_member(&actor) {
        return Ok(());
    }
    let kind = actor
        .get("kind")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown");
    let name = actor
        .get("displayName")
        .and_then(|x| x.as_str())
        .unwrap_or(actor_id);
    Err(format!(
        "{name} is a {kind}, not a human member — this tool only {verb}s people. Agents are added from the app's session member sheet, which also starts their runtime."
    ))
}

fn items_of(v: &serde_json::Value) -> Vec<serde_json::Value> {
    v.get("items")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
}

/// The team the desktop is currently in — kept by the team-switch flow.
///
/// Not derived from the session: `GET /v1/sessions/{id}` is itself team-scoped
/// (teamId is a required query param), so there is no team-free way to ask
/// which team a session belongs to.
async fn introspect_current_team(app: &AppHandle) -> Result<String, String> {
    let cache = app.state::<crate::local_cache::commands::LocalCacheState>();
    let team = cache.current_team_id.read().await.clone();
    team.filter(|t| !t.is_empty())
        .ok_or_else(|| "No current team: open TeamClu and select a team first.".to_string())
}

/// Resolve the `actor_id` / `name` argument to exactly one actor id.
///
/// A name is only accepted when it identifies one actor. Adding the wrong
/// person hands them the session and its history — an effect no fuzzy match is
/// worth — so zero or several matches come back as the candidate list and
/// nothing is written.
async fn resolve_participant_actor_id(
    app: &AppHandle,
    fc: &super::oss_sync::fc_client::FcClient,
    v: &serde_json::Value,
) -> Result<String, String> {
    if let Some(id) = str_body_field(v, "actor_id", "actorId") {
        return Ok(id);
    }
    let name = str_body_field(v, "name", "displayName")
        .ok_or("Missing field: actor_id or name is required")?;
    let team_id = introspect_current_team(app).await?;
    let listing = fc
        .get_json(&format!(
            "/v1/teams/{}/actors?limit=500",
            urlencoding::encode(&team_id)
        ))
        .await
        .map_err(|e| format!("Cloud API actor list failed: {e}"))?;

    let wanted = name.to_lowercase();
    let addable: Vec<serde_json::Value> = items_of(&listing)
        .into_iter()
        .filter(actor_is_participant_kind)
        .collect();
    let matches: Vec<&serde_json::Value> = addable
        .iter()
        .filter(|a| {
            a.get("displayName")
                .and_then(|x| x.as_str())
                .map(|n| n.trim().to_lowercase() == wanted)
                .unwrap_or(false)
        })
        .collect();

    match matches.len() {
        1 => Ok(matches[0]
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string()),
        0 => Err(format!(
            "No actor named {:?} in this team. Candidates: {}",
            name,
            serde_json::Value::Array(addable.iter().map(actor_brief).collect())
        )),
        n => Err(format!(
            "{:?} matches {} actors — pass actor_id instead. Matches: {}",
            name,
            n,
            serde_json::Value::Array(matches.iter().map(|a| actor_brief(a)).collect())
        )),
    }
}

/// `manage_participants` — read or change a session's roster.
///
/// Every call runs with the signed-in user's bearer, so RLS is what decides
/// whether an agent may pull someone in; this handler never escalates.
async fn handle_session_participants(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let action = str_body_field(&v, "action", "action").ok_or("Missing field: action")?;
    let session_id =
        str_body_field(&v, "session_id", "sessionId").ok_or("Missing field: session_id")?;
    let fc = introspect_fc_client(app, &v, "manage_participants").await?;
    let roster_path = format!(
        "/v1/sessions/{}/participants",
        urlencoding::encode(&session_id)
    );

    match action.as_str() {
        "list" => {
            let out = fc
                .get_json(&roster_path)
                .await
                .map_err(|e| format!("Cloud API participant list failed: {e}"))?;
            Ok(serde_json::json!({
                "action": "list",
                "session_id": session_id,
                "participants": items_of(&out).iter().map(participant_brief).collect::<Vec<_>>(),
            })
            .to_string())
        }
        "list_candidates" => {
            let team_id = introspect_current_team(app).await?;
            let present = fc
                .get_json(&roster_path)
                .await
                .map_err(|e| format!("Cloud API participant list failed: {e}"))?;
            let present_ids: std::collections::HashSet<String> = items_of(&present)
                .iter()
                .filter_map(|r| {
                    r.get("actorId")
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                })
                .collect();
            let listing = fc
                .get_json(&format!(
                    "/v1/teams/{}/actors?limit=500",
                    urlencoding::encode(&team_id)
                ))
                .await
                .map_err(|e| format!("Cloud API actor list failed: {e}"))?;
            let candidates: Vec<serde_json::Value> = items_of(&listing)
                .iter()
                .filter(|a| actor_is_human_member(a))
                .filter(|a| {
                    !a.get("id")
                        .and_then(|x| x.as_str())
                        .map(|id| present_ids.contains(id))
                        .unwrap_or(false)
                })
                .map(actor_brief)
                .collect();
            Ok(serde_json::json!({
                "action": "list_candidates",
                "session_id": session_id,
                "team_id": team_id,
                "candidates": candidates,
            })
            .to_string())
        }
        "add" => {
            let actor_id = resolve_participant_actor_id(app, &fc, &v).await?;
            ensure_human_member(&fc, &actor_id, "add").await?;
            fc.post_json(
                &roster_path,
                &serde_json::json!({ "actorId": actor_id, "role": "member" }),
            )
            .await
            .map_err(|e| format!("Cloud API add participant failed: {e}"))?;
            Ok(serde_json::json!({
                "ok": true, "action": "add",
                "session_id": session_id, "actor_id": actor_id,
            })
            .to_string())
        }
        "remove" => {
            let actor_id = resolve_participant_actor_id(app, &fc, &v).await?;
            // Same restriction as `add`, deliberately: a tool that can drop an
            // agent it cannot put back is a trap, not a capability.
            ensure_human_member(&fc, &actor_id, "remove").await?;
            fc.delete_json(&format!(
                "{}/{}",
                roster_path,
                urlencoding::encode(&actor_id)
            ))
            .await
            .map_err(|e| format!("Cloud API remove participant failed: {e}"))?;
            Ok(serde_json::json!({
                "ok": true, "action": "remove",
                "session_id": session_id, "actor_id": actor_id,
            })
            .to_string())
        }
        other => Err(format!(
            "Unknown action: {other} (expected list, list_candidates, add or remove)"
        )),
    }
}

// ─── Apps: deploy, logs, and the app's own database ──────────────────────────
//
// `manage_app` and `manage_app_data` hand an agent the three things it needs to
// own an app it is writing: publish it, read why it broke, and look at what it
// stored. Every call goes out on the signed-in user's bearer through
// [`introspect_fc_client`], so the Cloud API enforces app permissions exactly
// as it does for the desktop UI (`admin` to deploy or write a row, `prompt` to
// read one) — nothing here escalates past what the user may do themselves.

/// The app-row fields worth an agent's context window.
///
/// `publicUrl` is the address the product hands out; `fcEndpoint` is the raw FC
/// hostname and is only the app's address on a deployment with no apps domain.
/// One `url` rather than both, so the agent cannot quote the wrong one.
fn app_brief(row: &serde_json::Value) -> serde_json::Value {
    let f = |k: &str| row.get(k).cloned().unwrap_or(serde_json::Value::Null);
    let url = row
        .get("publicUrl")
        .filter(|v| v.is_string())
        .or_else(|| row.get("fcEndpoint"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "id": f("id"),
        "name": f("name"),
        "type": f("type"),
        "url": url,
        "provision_status": f("provisionStatus"),
        "fc_status": f("fcStatus"),
        "auth_mode": f("authMode"),
        "auth_mode_pending_redeploy": f("authModePendingRedeploy"),
        "git_commit_sha": f("gitCommitSha"),
    })
}

async fn list_team_apps(
    fc: &super::oss_sync::fc_client::FcClient,
    team_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let listing = fc
        .get_json(&format!(
            "/v1/apps?teamId={}&limit=200",
            urlencoding::encode(team_id)
        ))
        .await
        .map_err(|e| format!("Cloud API app list failed: {e}"))?;
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
    let out: serde_json::Value = match daemon::call_discovered(
        RequestSpec::get("/v1/apps/local", &["workspace:read"])
            .query(&query)
            .timeout(std::time::Duration::from_secs(10)),
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
fn introspect_caller_workspace(app: &AppHandle, v: &serde_json::Value) -> Option<String> {
    if let Some(path) = str_body_field(v, "workspace_path", "workspacePath") {
        return Some(path);
    }
    let registry = app.state::<super::window::WindowRegistry>();
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
async fn resolve_app_row(
    app: &AppHandle,
    fc: &super::oss_sync::fc_client::FcClient,
    v: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(id) = str_body_field(v, "app_id", "appId") {
        return fc
            .get_json(&format!("/v1/apps/{}", urlencoding::encode(&id)))
            .await
            .map_err(|e| format!("Cloud API app read failed: {e}"));
    }
    let Some(name) = str_body_field(v, "app_name", "appName") else {
        let id = resolve_app_id_from_workspace(app, v).await?;
        return fc
            .get_json(&format!("/v1/apps/{}", urlencoding::encode(&id)))
            .await
            .map_err(|e| format!("Cloud API app read failed: {e}"));
    };
    let team_id = introspect_current_team(app).await?;
    let apps = list_team_apps(fc, &team_id).await?;
    let wanted = name.to_lowercase();
    let matches: Vec<&serde_json::Value> = apps
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
            serde_json::Value::Array(apps.iter().map(app_brief).collect())
        )),
        n => Err(format!(
            "{:?} matches {} apps — pass app_id instead. Matches: {}",
            name,
            n,
            serde_json::Value::Array(matches.iter().map(|a| app_brief(a)).collect())
        )),
    }
}

/// The app the caller is inside, for a call that named none.
///
/// Both failure modes say what to do next rather than what went wrong: an agent
/// that lands here has already decided it wants "this app", and the useful
/// reply is the way to name one.
async fn resolve_app_id_from_workspace(
    app: &AppHandle,
    v: &serde_json::Value,
) -> Result<String, String> {
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

/// Kick the local daemon's build-and-upload leg.
///
/// 20 minutes: the daemon allows a `pnpm install` plus a 10-minute `pnpm build`,
/// and a client timeout shorter than the work it waits on turns a slow build
/// into a phantom failure — one that has already uploaded the artifact.
/// What the app's checkout declares about how it is built.
///
/// Best-effort: a daemon that cannot answer leaves the deploy on the contract
/// every app had before declarations existed, which is what an older daemon
/// would have done anyway.
async fn daemon_app_manifest(app_id: &str, team_id: &str) -> Option<serde_json::Value> {
    use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};
    let path = format!("/v1/apps/{}/manifest", urlencoding::encode(app_id));
    let query = format!("?teamId={}", urlencoding::encode(team_id));
    let out: serde_json::Value = daemon::call_discovered(
        RequestSpec::get(&path, &["workspace:read"])
            .query(&query)
            .timeout(std::time::Duration::from_secs(10)),
        NO_BODY,
    )
    .await
    .ok()?;
    out.get("manifest").cloned()
}

fn manifest_runtime(manifest: Option<&serde_json::Value>) -> String {
    manifest
        .and_then(|m| m.get("runtime"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("node")
        .to_string()
}

async fn daemon_build_app(
    body: &serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    use crate::daemon_client::{self as daemon, RequestSpec};
    daemon::call_discovered::<_, serde_json::Value>(
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

/// Everything after `/deploy` has minted the upload handle: credential the
/// build, run it, hand the credential back, publish.
#[allow(clippy::too_many_arguments)]
/// Where this deploy's build output goes, as the control plane minted it.
enum DeployHandle {
    /// Presigned OSS PUT for a code archive.
    Upload(String),
    /// Registry handle for an image, passed to the daemon verbatim.
    Push(serde_json::Value),
}

async fn finish_app_deploy(
    fc: &super::oss_sync::fc_client::FcClient,
    enc_id: &str,
    app_id: &str,
    team_id: &str,
    via_gitea: bool,
    git_commit_sha: Option<String>,
    deploy_token: &str,
    handle: &DeployHandle,
    manifest: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut git_remote_url = String::new();
    let mut deploy_key_pem = String::new();
    let mut deploy_key_id: Option<i64> = None;
    if via_gitea {
        let cred = fc
            .get_json(&format!("/v1/apps/{enc_id}/git-credential"))
            .await
            .map_err(|e| format!("Cloud API deploy credential failed: {e}"))?;
        git_remote_url = cred
            .get("remoteUrl")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
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

    let mut build_body = serde_json::json!({
        "appId": app_id,
        "teamId": team_id,
    });
    match handle {
        DeployHandle::Upload(url) => build_body["presignedPut"] = serde_json::json!(url),
        DeployHandle::Push(image) => build_body["image"] = image.clone(),
    }
    if via_gitea {
        build_body["gitRemoteUrl"] = serde_json::json!(git_remote_url);
        build_body["deployKeyPem"] = serde_json::json!(deploy_key_pem);
        if let Some(sha) = &git_commit_sha {
            build_body["gitCommitSha"] = serde_json::json!(sha);
        }
    }

    // A container build cross-compiles for linux/amd64 through emulation and
    // then pushes an image; a 20-minute cap that fits `pnpm build` cuts it off
    // mid-push, and the daemon's own bounds (30 + 15) are what should decide.
    let build_timeout = match handle {
        DeployHandle::Upload(_) => std::time::Duration::from_secs(20 * 60),
        DeployHandle::Push(_) => std::time::Duration::from_secs(50 * 60),
    };
    let build = daemon_build_app(&build_body, build_timeout).await;

    // The daemon only needs the key for the fetch inside the build; hand it back
    // whether that succeeded or not, exactly as the desktop's `finally` does.
    if let Some(key_id) = deploy_key_id {
        let _ = fc
            .delete_json(&format!("/v1/apps/{enc_id}/git-credential/{key_id}"))
            .await;
    }
    let build = build?;

    // What the daemon built, not what we asked for: a deploy publishes work the
    // agent left uncommitted, so HEAD can sit past the sha read off Gitea before
    // any of this started.
    let built_sha = build
        .get("gitCommitSha")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or(git_commit_sha);

    let mut finalize_body = serde_json::json!({ "deployToken": deploy_token });
    if let Some(sha) = built_sha {
        finalize_body["gitCommitSha"] = serde_json::json!(sha);
    }
    // What the app declared, and — for a container app — the image that build
    // actually pushed. This path used to send neither, so an agent-driven
    // deploy of an app with its own declaration silently finalized on the
    // built-in contract while the same deploy from the UI honoured it.
    if let Some(manifest) = manifest {
        finalize_body["runtime"] = manifest.clone();
    }
    if let Some(image) = build
        .get("image")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        finalize_body["image"] = serde_json::json!(image);
    }
    fc.post_json(
        &format!("/v1/apps/{enc_id}/deploy/finalize"),
        &finalize_body,
    )
    .await
    .map_err(|e| format!("Cloud API deploy finalize failed: {e}"))
}

/// The whole deploy, the same three legs the desktop UI runs: mint the upload
/// handle, have the local daemon build and upload the artifact, publish it.
///
/// It lives in this process because the middle leg needs the local daemon and
/// the outer two need the user's cloud bearer, and this is the only process
/// holding both. A failure after `/deploy` must report `deploy_error` back:
/// nothing server-side can observe that the local build never finished, and a
/// row left at `awaiting_build` blocks every later deploy for 30 minutes.
async fn run_app_deploy(
    fc: &super::oss_sync::fc_client::FcClient,
    row: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let app_id = row
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    if app_id.is_empty() {
        return Err("app row has no id".to_string());
    }
    let team_id = row
        .get("teamId")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    let provision = row
        .get("provisionStatus")
        .and_then(|x| x.as_str())
        .unwrap_or_default();
    if provision != "ready" {
        return Err(format!(
            "This app is not ready to deploy (provisionStatus={provision}). Its checkout has to be seeded first."
        ));
    }
    let via_gitea = row.get("gitAuthKind").and_then(|x| x.as_str()) == Some("gitea_deploy_key");
    let enc_id = urlencoding::encode(&app_id).into_owned();

    // Only a Gitea-managed app deploys a commit off the forge. An app imported
    // from someone else's repo has no repo of ours and no credential for the one
    // it came from, so it deploys its checkout as it sits.
    let mut git_commit_sha: Option<String> = None;
    if via_gitea {
        let head = fc
            .get_json(&format!("/v1/apps/{enc_id}/git-head"))
            .await
            .map_err(|e| format!("Cloud API git-head read failed: {e}"))?;
        let sha = head
            .get("sha")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("The app's Gitea repo has no HEAD — commit and push before deploying.")?;
        git_commit_sha = Some(sha.to_string());
    }

    // Read before the deploy is minted, not after: a container app is handed a
    // registry to push to and every other app a presigned URL to upload to, and
    // only the machine holding the checkout can say which this is.
    let manifest = daemon_app_manifest(&app_id, &team_id).await;
    let mut start_body = serde_json::json!({ "runtime": manifest_runtime(manifest.as_ref()) });
    if let Some(sha) = &git_commit_sha {
        start_body["gitCommitSha"] = serde_json::json!(sha);
    }
    let started = fc
        .post_json(&format!("/v1/apps/{enc_id}/deploy"), &start_body)
        .await
        .map_err(|e| format!("Cloud API deploy start failed: {e}"))?;
    let deploy_token = started
        .get("deployToken")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    let handle = match started.get("image").filter(|v| v.is_object()) {
        Some(image) => DeployHandle::Push(image.clone()),
        None => {
            let url = started
                .get("presignedPut")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            if url.is_empty() {
                return Err("deploy start returned no upload handle".to_string());
            }
            DeployHandle::Upload(url)
        }
    };
    if deploy_token.is_empty() {
        return Err("deploy start returned no deploy token".to_string());
    }

    // From here the server has written `awaiting_build` and this call owns it.
    match finish_app_deploy(
        fc,
        &enc_id,
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
            let _ = fc
                .patch_json(
                    &format!("/v1/apps/{enc_id}"),
                    &serde_json::json!({
                        "fcStatus": "deploy_error",
                        "deployError": reason,
                    }),
                )
                .await;
            Err(reason)
        }
    }
}

/// `manage_app` — list the team's apps, read one, deploy it, or read its logs.
async fn handle_app_manage(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let action = str_body_field(&v, "action", "action").ok_or("Missing field: action")?;
    let fc = introspect_fc_client(app, &v, "manage_app").await?;

    match action.as_str() {
        "list" => {
            let team_id = introspect_current_team(app).await?;
            let apps = list_team_apps(&fc, &team_id).await?;
            // One daemon call for every app's checkout, not one per app: the
            // path is how an agent tells the app it is working in from the rest
            // of the team's, and it used to take a `status` round trip each to
            // find out.
            let local = local_app_workdirs(&team_id).await;
            let briefs: Vec<serde_json::Value> = apps
                .iter()
                .map(|row| {
                    let mut brief = app_brief(row);
                    let id = row.get("id").and_then(|x| x.as_str()).unwrap_or_default();
                    if let Some((_, dir)) = local.iter().find(|(app_id, _)| app_id == id) {
                        brief["workdir"] = serde_json::json!(dir);
                    }
                    brief
                })
                .collect();
            Ok(serde_json::json!({
                "action": "list",
                "team_id": team_id,
                "apps": briefs,
            })
            .to_string())
        }
        "status" => {
            let row = resolve_app_row(app, &fc, &v).await?;
            let mut out = app_brief(&row);
            if let Some(workdir) = app_workdir_on_this_machine(&row).await {
                out["workdir"] = serde_json::json!(workdir);
            }
            Ok(serde_json::json!({ "action": "status", "app": out }).to_string())
        }
        "deploy" => {
            let row = resolve_app_row(app, &fc, &v).await?;
            let finished = run_app_deploy(&fc, &row).await?;
            Ok(serde_json::json!({
                "ok": true,
                "action": "deploy",
                "app": app_brief(&finished),
            })
            .to_string())
        }
        "logs" => {
            let row = resolve_app_row(app, &fc, &v).await?;
            let out = read_app_logs(&fc, &row, &v).await?;
            Ok(out.to_string())
        }
        other => Err(format!(
            "Unknown action: {other} (expected list, status, deploy or logs)"
        )),
    }
}

/// Where this machine keeps the app's checkout, or `None` when it holds none.
/// Best-effort: a daemon that is down means "not here", which is what an agent
/// needs to know either way.
async fn app_workdir_on_this_machine(row: &serde_json::Value) -> Option<String> {
    use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};
    let app_id = row.get("id").and_then(|x| x.as_str())?;
    let team_id = row.get("teamId").and_then(|x| x.as_str()).unwrap_or("");
    let path = format!("/v1/apps/{}/workdir", urlencoding::encode(app_id));
    let query = format!("?teamId={}", urlencoding::encode(team_id));
    let out: serde_json::Value = daemon::call_discovered(
        RequestSpec::get(&path, &["workspace:read"])
            .query(&query)
            .timeout(std::time::Duration::from_secs(10)),
        NO_BODY,
    )
    .await
    .ok()?;
    out.get("workdir")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn u64_body_field(v: &serde_json::Value, snake: &str, camel: &str) -> Option<u64> {
    v.get(snake)
        .or_else(|| v.get(camel))
        .and_then(|x| x.as_u64().or_else(|| x.as_str()?.trim().parse().ok()))
}

/// `manage_app` action `logs` — the deployed function's own output.
///
/// The window and the row cap are bounded here as well as server-side: an app
/// under load writes more in ten minutes than a turn can hold, and a tool result
/// large enough to blow the context is worse than no logs at all.
async fn read_app_logs(
    fc: &super::oss_sync::fc_client::FcClient,
    row: &serde_json::Value,
    v: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let app_id = row
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or("app row has no id")?;
    let fc_status = row.get("fcStatus").and_then(|x| x.as_str()).unwrap_or("");
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

    let out = fc
        .get_json(&format!(
            "/v1/apps/{}/logs{query}",
            urlencoding::encode(app_id)
        ))
        .await
        .map_err(|e| format!("Cloud API app logs failed: {e}"))?;

    Ok(serde_json::json!({
        "action": "logs",
        "app_id": app_id,
        "since_minutes": since_minutes,
        "kind": kind,
        "entries": out.get("items").cloned().unwrap_or(serde_json::json!([])),
        "truncated": out.get("truncated").cloned().unwrap_or(serde_json::json!(false)),
    }))
}

/// Opaque row key: unpadded base64url of the JSON array of primary-key values,
/// in the order the table's catalog reports them.
///
/// Mirrors `appDataRowKey` in the frontend and `decodeRowKey` on the server. The
/// agent passes a column → value map and this orders it, because a composite key
/// silently ordered wrong addresses a different row, not an error.
fn encode_app_data_row_key(
    primary_key: &[String],
    key: &serde_json::Value,
) -> Result<String, String> {
    use base64::Engine as _;
    let values: Vec<serde_json::Value> = match key {
        serde_json::Value::Array(a) => {
            if a.len() != primary_key.len() {
                return Err(format!(
                    "key must have {} value(s), in this order: {}",
                    primary_key.len(),
                    primary_key.join(", ")
                ));
            }
            a.clone()
        }
        serde_json::Value::Object(map) => {
            let mut out = Vec::with_capacity(primary_key.len());
            for column in primary_key {
                let value = map.get(column).ok_or_else(|| {
                    format!(
                        "key is missing primary-key column {column:?} (needs: {})",
                        primary_key.join(", ")
                    )
                })?;
                out.push(value.clone());
            }
            out
        }
        _ => return Err("key must be an object of primary-key columns, or an array".to_string()),
    };
    let json = serde_json::to_string(&values).map_err(|e| format!("cannot encode key: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

/// The table's primary key, read from the app's own catalog rather than guessed.
async fn app_data_primary_key(
    fc: &super::oss_sync::fc_client::FcClient,
    enc_id: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let tables = fc
        .get_json(&format!("/v1/apps/{enc_id}/data/tables"))
        .await
        .map_err(|e| format!("Cloud API app tables failed: {e}"))?;
    let entry = items_of(&tables)
        .into_iter()
        .find(|t| t.get("name").and_then(|x| x.as_str()) == Some(table))
        .ok_or_else(|| format!("No table named {table:?} in this app's database."))?;
    let pk: Vec<String> = entry
        .get("primaryKey")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if pk.is_empty() {
        return Err(format!(
            "Table {table:?} has no primary key, so a single row cannot be addressed."
        ));
    }
    Ok(pk)
}

/// `manage_app_data` — read and edit the rows in a deployed app's own database.
///
/// Reads need `prompt` on the app and writes need `admin`; both are the Cloud
/// API's call, not this handler's. Writes address exactly one row by primary
/// key — there is no bulk path on purpose, this is production data.
async fn handle_app_data(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let action = str_body_field(&v, "action", "action").ok_or("Missing field: action")?;
    let fc = introspect_fc_client(app, &v, "manage_app_data").await?;
    let row = resolve_app_row(app, &fc, &v).await?;
    let app_id = row
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or("app row has no id")?
        .to_string();
    let enc_id = urlencoding::encode(&app_id).into_owned();

    if action == "tables" {
        let out = fc
            .get_json(&format!("/v1/apps/{enc_id}/data/tables"))
            .await
            .map_err(|e| format!("Cloud API app tables failed: {e}"))?;
        return Ok(serde_json::json!({
            "action": "tables",
            "app_id": app_id,
            "tables": out.get("items").cloned().unwrap_or(serde_json::json!([])),
        })
        .to_string());
    }

    let table = str_body_field(&v, "table", "table").ok_or("Missing field: table")?;
    let enc_table = urlencoding::encode(&table).into_owned();
    let rows_path = format!("/v1/apps/{enc_id}/data/tables/{enc_table}/rows");

    match action.as_str() {
        "rows" => {
            let limit = u64_body_field(&v, "limit", "limit")
                .unwrap_or(50)
                .clamp(1, 100);
            let mut query = format!("?limit={limit}");
            if let Some(after) = str_body_field(&v, "after", "after") {
                query.push_str(&format!("&after={}", urlencoding::encode(&after)));
            }
            if let Some(direction) = str_body_field(&v, "direction", "direction") {
                query.push_str(&format!("&direction={}", urlencoding::encode(&direction)));
            }
            // All three filter parts or none: the API ignores a value with no
            // column, which reads to an agent as "the filter did nothing".
            let column = str_body_field(&v, "filter_column", "filterColumn");
            let op = str_body_field(&v, "filter_op", "filterOp");
            if let (Some(column), Some(op)) = (column.as_ref(), op.as_ref()) {
                query.push_str(&format!(
                    "&filterColumn={}&filterOp={}",
                    urlencoding::encode(column),
                    urlencoding::encode(op)
                ));
                if let Some(value) = str_body_field(&v, "filter_value", "filterValue") {
                    query.push_str(&format!("&filterValue={}", urlencoding::encode(&value)));
                }
            } else if column.is_some() != op.is_some() {
                return Err(
                    "filter_column and filter_op must be given together (ops: eq, contains, isNull, notNull)"
                        .to_string(),
                );
            }
            let out = fc
                .get_json(&format!("{rows_path}{query}"))
                .await
                .map_err(|e| format!("Cloud API app rows failed: {e}"))?;
            Ok(serde_json::json!({
                "action": "rows",
                "app_id": app_id,
                "table": table,
                "primary_key": out.get("primaryKey").cloned().unwrap_or(serde_json::json!([])),
                "editable": out.get("editable").cloned().unwrap_or(serde_json::json!(false)),
                "rows": out.get("rows").cloned().unwrap_or(serde_json::json!([])),
                "next_cursor": out.get("nextCursor").cloned().unwrap_or(serde_json::Value::Null),
            })
            .to_string())
        }
        "update_row" | "delete_row" => {
            let row_key = match str_body_field(&v, "row_key", "rowKey") {
                Some(opaque) => opaque,
                None => {
                    let key = v
                        .get("key")
                        .ok_or("Missing field: key (the row's primary-key columns)")?;
                    let pk = app_data_primary_key(&fc, &enc_id, &table).await?;
                    encode_app_data_row_key(&pk, key)?
                }
            };
            let path = format!("{rows_path}/{}", urlencoding::encode(&row_key));
            if action == "delete_row" {
                fc.delete_json(&path)
                    .await
                    .map_err(|e| format!("Cloud API row delete failed: {e}"))?;
                return Ok(serde_json::json!({
                    "ok": true, "action": "delete_row",
                    "app_id": app_id, "table": table,
                })
                .to_string());
            }
            let patch = v
                .get("patch")
                .filter(|p| p.is_object())
                .ok_or("Missing field: patch (an object of column → new value)")?;
            let out = fc
                .patch_json(&path, &serde_json::json!({ "patch": patch }))
                .await
                .map_err(|e| format!("Cloud API row update failed: {e}"))?;
            Ok(serde_json::json!({
                "ok": true,
                "action": "update_row",
                "app_id": app_id,
                "table": table,
                // The row as the database stored it: triggers and defaults may
                // have rewritten what was submitted.
                "row": out.get("row").cloned().unwrap_or(serde_json::Value::Null),
            })
            .to_string())
        }
        other => Err(format!(
            "Unknown action: {other} (expected tables, rows, update_row or delete_row)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "s3cr3t-token-value";

    /// Build the header map for a request carrying `extra_headers` on top of
    /// the ones every sidecar call has. The literals stay in the raw wire form
    /// they arrive in, so a test still reads like the request it describes;
    /// hyper does the parsing in production, and what is under test here is the
    /// policy, not the parser.
    fn request(extra_headers: &str) -> HeaderMap {
        headers_from(&format!(
            "Host: 127.0.0.1:13144\r\nContent-Type: application/json\r\n{extra_headers}"
        ))
    }

    /// Parse CRLF-separated `Name: value` lines into a `HeaderMap`.
    fn headers_from(raw: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for line in raw.split("\r\n").filter(|l| !l.is_empty()) {
            let (name, value) = line.split_once(':').expect("header line");
            headers.append(
                name.trim()
                    .parse::<axum::http::HeaderName>()
                    .expect("header name"),
                value
                    .trim_start()
                    .parse::<axum::http::HeaderValue>()
                    .expect("header value"),
            );
        }
        headers
    }

    #[test]
    fn happy_path_with_matching_bearer() {
        let headers = request(&format!("Authorization: Bearer {TOKEN}\r\n"));
        assert_eq!(authorize_request(&headers, TOKEN), Ok(()));
    }

    #[test]
    fn bearer_scheme_is_case_insensitive_and_header_name_too() {
        let headers = request(&format!("authorization: BEARER {TOKEN}\r\n"));
        assert_eq!(authorize_request(&headers, TOKEN), Ok(()));
    }

    #[test]
    fn missing_token_is_401() {
        let headers = request("");
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Unauthorized(_))
        ));
    }

    #[test]
    fn empty_bearer_is_401() {
        let headers = request("Authorization: Bearer \r\n");
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Unauthorized(_))
        ));
    }

    #[test]
    fn wrong_token_is_401() {
        let headers = request("Authorization: Bearer nope\r\n");
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Unauthorized(_))
        ));
        // Same length, one byte off — the constant-time path, not the length
        // short-circuit.
        let near_miss = format!("{}X", &TOKEN[..TOKEN.len() - 1]);
        let headers = request(&format!("Authorization: Bearer {near_miss}\r\n"));
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Unauthorized(_))
        ));
    }

    #[test]
    fn non_bearer_scheme_is_401() {
        let headers = request(&format!("Authorization: Basic {TOKEN}\r\n"));
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Unauthorized(_))
        ));
    }

    #[test]
    fn any_origin_header_is_403_even_with_a_valid_token() {
        let headers = request(&format!(
            "Authorization: Bearer {TOKEN}\r\nOrigin: http://127.0.0.1:13144\r\n"
        ));
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Forbidden(_))
        ));
        // `Origin: null` (sandboxed iframes, file://) is still a browser.
        let headers = request(&format!(
            "Authorization: Bearer {TOKEN}\r\nOrigin: null\r\n"
        ));
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Forbidden(_))
        ));
    }

    #[test]
    fn non_loopback_host_is_403_even_with_a_valid_token() {
        let headers = headers_from(&format!(
            "Host: evil.example:13144\r\nAuthorization: Bearer {TOKEN}\r\n"
        ));
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Forbidden(_))
        ));
    }

    #[test]
    fn missing_host_is_403() {
        let headers = headers_from(&format!("Authorization: Bearer {TOKEN}\r\n"));
        assert!(matches!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Forbidden(_))
        ));
    }

    #[test]
    fn loopback_host_spellings() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:13144",
            "localhost",
            "LOCALHOST:13144",
            "[::1]",
            "[::1]:13144",
        ] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in [
            "evil.example",
            "127.0.0.1.evil.example",
            "10.0.0.1:13144",
            "[::1]evil",
            "",
        ] {
            assert!(!is_loopback_host(host), "{host} should not be loopback");
        }
    }

    #[test]
    fn origin_check_runs_before_host_and_bearer() {
        // A browser request with a bad Host and no token: the message names
        // the Origin, so the log says "browser" rather than something the
        // sidecar could plausibly have done.
        let headers = headers_from("Origin: https://a.example\r\nHost: a.example\r\n");
        assert_eq!(
            authorize_request(&headers, TOKEN),
            Err(Rejection::Forbidden(
                "Forbidden: browser-originated requests are not accepted"
            ))
        );
    }

    // ── The gate as the router actually applies it ─────────────────────────
    //
    // STR-5/STR-10: the checks above are unit tests of a pure function. These
    // drive the real middleware stack — hyper's header parsing, the layer
    // ordering, the fallback — because that is where the axum move could go
    // wrong without any of the assertions above noticing. Real handlers need an
    // `AppHandle`, so the routes here are stubs; the gate and the fallback are
    // the production ones.

    fn gated_router(token: Arc<str>) -> Router {
        Router::new()
            .route("/mcp-put", axum::routing::post(|| async { "handler ran" }))
            .fallback(not_found)
            .layer(axum::middleware::from_fn_with_state(token, gate))
    }

    async fn send(
        router: Router,
        req: axum::http::Request<axum::body::Body>,
    ) -> (StatusCode, String) {
        use tower::ServiceExt as _;
        let response = router.oneshot(req).await.expect("router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn post(path: &str) -> axum::http::request::Builder {
        axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1:13144")
    }

    #[tokio::test]
    async fn router_runs_the_handler_for_a_valid_bearer() {
        let (status, body) = send(
            gated_router(Arc::from(TOKEN)),
            post("/mcp-put")
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(axum::body::Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "handler ran");
    }

    #[test]
    fn handler_response_labels_success_json_and_failure_plain() {
        let ok = handler_response(Ok(r#"{"ok":true}"#.into()));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()["content-type"], "application/json");

        let err = handler_response(Err("workspace not set".into()));
        assert_eq!(err.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            err.headers()
                .get("content-type")
                .is_none_or(|v| !v.as_bytes().starts_with(b"application/json")),
            "an error sentence must not claim to be JSON"
        );
    }

    #[tokio::test]
    async fn router_rejects_a_missing_bearer_with_a_challenge() {
        use tower::ServiceExt as _;
        let response = gated_router(Arc::from(TOKEN))
            .oneshot(post("/mcp-put").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()["www-authenticate"], "Bearer");
    }

    #[tokio::test]
    async fn router_rejects_a_browser_request_even_with_a_valid_bearer() {
        let (status, _) = send(
            gated_router(Arc::from(TOKEN)),
            post("/mcp-put")
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("origin", "https://evil.example")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn router_rejects_a_rebound_host_even_with_a_valid_bearer() {
        let (status, _) = send(
            gated_router(Arc::from(TOKEN)),
            axum::http::Request::builder()
                .method("POST")
                .uri("/mcp-put")
                .header("host", "evil.example")
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_unknown_path_is_gated_before_it_is_404() {
        // The whole reason the layer wraps the fallback: without a bearer,
        // "does /mcp-put exist?" must be unanswerable.
        let (unauth_known, _) = send(
            gated_router(Arc::from(TOKEN)),
            post("/mcp-put").body(axum::body::Body::empty()).unwrap(),
        )
        .await;
        let (unauth_unknown, _) = send(
            gated_router(Arc::from(TOKEN)),
            post("/does-not-exist")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(unauth_known, StatusCode::UNAUTHORIZED);
        assert_eq!(unauth_unknown, StatusCode::UNAUTHORIZED);

        // With a bearer, the two are told apart.
        let (auth_unknown, body) = send(
            gated_router(Arc::from(TOKEN)),
            post("/does-not-exist")
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(auth_unknown, StatusCode::NOT_FOUND);
        assert!(body.contains("/does-not-exist"), "{body}");
    }

    #[tokio::test]
    async fn a_get_to_a_post_route_is_405_not_a_side_effect() {
        let (status, _) = send(
            gated_router(Arc::from(TOKEN)),
            axum::http::Request::builder()
                .method("GET")
                .uri("/mcp-put")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn generated_tokens_are_long_random_and_url_safe() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 43, "32 bytes base64url-no-pad is 43 chars");
        assert_ne!(a, b);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn token_file_is_written_owner_only_and_overwrites_stale_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run").join(INTROSPECT_TOKEN_FILE);

        // Stale, world-readable leftover from a previous launch.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "old-token-that-is-longer-than-the-new-one!!!!!!!!!!").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        write_token_file(&path, "fresh").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    // --- Apps ---------------------------------------------------------------

    #[test]
    fn app_brief_prefers_the_public_url_over_the_raw_function_host() {
        // `fcEndpoint` carries a random suffix and is not the address the
        // product hands out. Reporting both would have the agent quote the one
        // that stops working the moment a vanity domain exists.
        let with_vanity = serde_json::json!({
            "id": "app-1", "name": "Notes",
            "publicUrl": "https://notes-0c0a97bf.apps.example.com",
            "fcEndpoint": "https://raw-suffix.fcapp.run",
        });
        assert_eq!(
            app_brief(&with_vanity)["url"],
            "https://notes-0c0a97bf.apps.example.com"
        );

        let no_vanity = serde_json::json!({
            "id": "app-1", "publicUrl": serde_json::Value::Null,
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
    fn row_key_orders_values_by_the_table_s_own_primary_key() {
        use base64::Engine as _;
        let pk = vec!["tenant".to_string(), "id".to_string()];
        // Deliberately supplied in the other order: a composite key silently
        // ordered wrong addresses a DIFFERENT row, which is not an error the
        // caller would ever see.
        let key = serde_json::json!({ "id": 42, "tenant": "acme" });
        let encoded = encode_app_data_row_key(&pk, &key).unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&encoded)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), r#"["acme",42]"#);
    }

    #[test]
    fn row_key_refuses_a_half_specified_composite_key() {
        let pk = vec!["tenant".to_string(), "id".to_string()];
        let err = encode_app_data_row_key(&pk, &serde_json::json!({ "id": 42 })).unwrap_err();
        assert!(err.contains("tenant"), "{err}");

        let err = encode_app_data_row_key(&pk, &serde_json::json!([42])).unwrap_err();
        assert!(err.contains("2 value(s)"), "{err}");
    }

    #[test]
    fn row_key_matches_what_the_frontend_and_the_server_agree_on() {
        // `appDataRowKey` in the web app and `decodeRowKey` in the Cloud API
        // both use unpadded base64url of the JSON array. Padding here would be
        // a 400 from the server, only for keys whose length lands wrong.
        let pk = vec!["id".to_string()];
        assert_eq!(
            encode_app_data_row_key(&pk, &serde_json::json!({ "id": 1 })).unwrap(),
            "WzFd",
        );
    }
}
