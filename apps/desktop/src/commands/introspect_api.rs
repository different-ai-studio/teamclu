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
// Uses raw TCP + manual HTTP parsing to stay minimal (no axum state needed).

pub const INTROSPECT_API_PORT: u16 = 13144;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub async fn start_introspect_api(app: AppHandle) -> anyhow::Result<()> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", INTROSPECT_API_PORT)).await?;
    println!(
        "[IntrospectAPI] Listening on 127.0.0.1:{}",
        INTROSPECT_API_PORT
    );

    loop {
        let (mut stream, _peer) = listener.accept().await?;
        let app_clone = app.clone();

        tokio::spawn(async move {
            // Read initial chunk (headers + maybe partial body)
            let mut buf = vec![0u8; 65536];
            let n = match stream.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };

            // Parse headers
            let header_end = match find_double_crlf(&buf[..n]) {
                Some(i) => i,
                None => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let header_str = match std::str::from_utf8(&buf[..header_end]) {
                Ok(s) => s,
                Err(_) => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let first_line = header_str.lines().next().unwrap_or("");
            let mut parts = first_line.splitn(3, ' ');
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");

            // Parse Content-Length for large bodies (e.g. image base64)
            let content_length: usize = header_str
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    lower
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);

            // Read remaining body if needed
            let body_start = header_end + 4;
            let mut body_buf: Vec<u8> = buf[body_start..n].to_vec();
            while body_buf.len() < content_length {
                let mut chunk = vec![0u8; 65536];
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(cn) => body_buf.extend_from_slice(&chunk[..cn]),
                    Err(_) => break,
                }
            }
            let body_bytes = &body_buf[..];

            let resp = match (method, path) {
                ("POST", "/send-wecom") => handle_send_wecom(&app_clone, body_bytes).await,
                ("POST", "/cron-run") => handle_cron_run(&app_clone, body_bytes).await,
                ("POST", "/team-sync-all") => handle_team_sync_all(&app_clone, body_bytes).await,
                ("POST", "/env-var-set") => handle_env_var_set(&app_clone, body_bytes).await,
                ("POST", "/env-var-delete") => handle_env_var_delete(&app_clone, body_bytes).await,
                ("POST", "/session-export") => handle_session_export(&app_clone, body_bytes).await,
                ("POST", "/channel-set") => handle_channel_set(&app_clone, body_bytes).await,
                ("POST", "/mcp-get") => handle_mcp_get(&app_clone, body_bytes).await,
                ("POST", "/mcp-put") => handle_mcp_put(&app_clone, body_bytes).await,
                ("POST", "/session-archive") => {
                    handle_session_archive(&app_clone, body_bytes).await
                }
                ("POST", "/session-participants") => {
                    handle_session_participants(&app_clone, body_bytes).await
                }
                _ => Err(format!("Not found: {} {}", method, path)),
            };

            let (status, body) = match resp {
                Ok(msg) => (200u16, msg),
                Err(e) => (500u16, e),
            };
            let _ = write_response(&mut stream, status, &body).await;
        });
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

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

    // Parse target format: "single:{userid}" or "group:{chatid}" or bare chatid
    let (chatid, chat_type) = if let Some(userid) = target.strip_prefix("single:") {
        (userid, 1u32)
    } else if let Some(chatid) = target.strip_prefix("group:") {
        (chatid, 2u32)
    } else {
        // Treat bare value as single user (chat_type=1)
        (target, 1u32)
    };

    // Send text message if provided
    if !message.is_empty() {
        teamclu_gateway::wecom::send_proactive_message(chatid, chat_type, message).await?;
    }

    // Send media file if provided (image/voice/video/file)
    let media_sent = if let Some(b64) = v.get("media_base64").and_then(|v| v.as_str()) {
        let data = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Invalid media base64: {}", e))?;
        let filename = v
            .get("media_filename")
            .and_then(|v| v.as_str())
            .unwrap_or("file");
        let media_type = v
            .get("media_type")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| detect_media_type(filename));

        teamclu_gateway::wecom::upload_and_send_media(
            chatid, chat_type, &data, filename, media_type,
        )
        .await?;
        true
    } else {
        false
    };

    Ok(format!(
        r#"{{"ok":true,"chatid":"{}","chat_type":{},"media_sent":{}}}"#,
        chatid, chat_type, media_sent
    ))
}

async fn handle_team_sync_all(app: &AppHandle, _body: &[u8]) -> Result<String, String> {
    // introspect_api has no calling-window context (HTTP server). Falls back
    // to current_workspace in WindowRegistry.
    let registry = app.state::<super::window::WindowRegistry>();
    let workspace = registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?;
    // Plan B Task 8: the desktop sync engine is gone — the daemon owns team
    // sync now. Forward to the daemon's team-sync endpoint for the workspace.
    let result = super::team_sync_proxy::daemon_team_sync(Some(&workspace), true).await?;
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

/// Detect WeCom media type from filename extension.
fn detect_media_type(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => "image",
        "mp3" | "amr" | "wav" | "ogg" | "m4a" | "aac" => "voice",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" => "video",
        _ => "file",
    }
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
        eprintln!("[IntrospectAPI] local cache soft-delete after archive failed: {e}");
    }

    let payload = serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "archivedAt": archived_at,
    });
    serde_json::to_string(&payload).map_err(|e| format!("Serialization error: {e}"))
}

/// Find the position of `\r\n\r\n` in `data`, returning the index of the first `\r`.
fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

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

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Error" };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await
}
