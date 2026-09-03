// Internal HTTP API server for the teamclu-introspect MCP binary.
//
// Listens on 127.0.0.1:13144 and handles:
//   POST /send-wecom        — send a proactive WeCom message
//   POST /cron-run          — manually trigger a cron job
//   POST /team-sync-all     — trigger team sync
//   POST /env-var-set       — create or update an env var (`scope`: personal | team)
//   POST /env-var-delete    — delete an env var (`scope`: personal | team)
//   POST /mcp-get           — fetch merged workspace MCP map (daemon)
//   POST /mcp-put           — replace workspace MCP map (daemon)
//   POST /session-archive   — archive a cloud session (PATCH archivedAt)
//   POST /session-participants — list/add/remove a session's participants
//   POST /session-export    — export session messages as opencode-compatible JSON
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
        .route("/team-sync-all", post_route!(handle_team_sync_all))
        .route("/env-var-set", post_route!(handle_env_var_set))
        .route("/env-var-delete", post_route!(handle_env_var_delete))
        .route("/session-export", post_route!(handle_session_export))
        .route("/channel-set", post_route!(handle_channel_set))
        .route("/mcp-get", post_route!(handle_mcp_get))
        .route("/mcp-put", post_route!(handle_mcp_put))
        .route(
            "/session-participants",
            post_route!(handle_session_participants),
        )
        .route("/session-archive", post_route!(handle_session_archive))
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

async fn handle_session_export(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let req: super::session_export::SessionExportRequest =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let cache_state = app.state::<crate::local_cache::commands::LocalCacheState>();
    super::session_export::export_session_handler(&cache_state, req).await
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
}
