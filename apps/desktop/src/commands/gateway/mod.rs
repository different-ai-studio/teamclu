// Thin RPC client over amuxd's control channel (a Unix socket, or a named pipe
// on Windows — see `commands::amuxd_control`). The desktop app no longer runs the
// channel gateways itself — amuxd owns those instances and persists their
// config in `daemon.toml`. The three commands here just forward to amuxd.
//
// Cron still reaches into the underlying `teamclu_gateway::*` modules for
// direct send helpers (e.g. `gateway::email::send_notification_email`), so we
// keep `pub use teamclu_gateway::*` to preserve its `crate::commands::gateway::*`
// import paths. `introspect_api` no longer does — its WeCom send goes through
// amuxd now (#933). The legacy per-platform `*Gateway` slots that used to live here
// are gone, and so is the `SessionMapping` that sat beside them — with the map
// went the last reason for a `GatewayState`, so there is no app-level gateway
// state left at all.

pub use teamclu_gateway::*;

pub mod qr;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::commands::amuxd_control;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStatus {
    pub platform: String,
    pub enabled: bool,
    pub connected: bool,
    #[serde(default, rename = "last_error", alias = "lastError")]
    pub last_error: Option<String>,
}

/// The active team's `team.toml`, resolved through daemon.toml's
/// `active_team` pointer. `None` when the daemon has no team yet.
fn team_config_path() -> Option<PathBuf> {
    let team = crate::commands::amuxd_active_team()?;
    Some(crate::commands::amuxd_team_state_dir(&team).join("team.toml"))
}

/// List the six known channel platforms with their `enabled` / `connected`
/// state as reported by amuxd over its control channel. Errors out clearly when the
/// daemon is not running so the UI can surface an "amuxd unreachable" state.
#[tauri::command]
pub async fn list_channels() -> Result<Vec<ChannelStatus>, String> {
    amuxd_control::request_json_async("channel-status\n").await
}

/// Per-bot WeCom connection status as reported by amuxd over its control channel.
/// The daemon emits camelCase keys (`botId`, `connected`, `error`), which we
/// re-expose unchanged to the frontend (matching the TS `WeComBotStatus`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComBotStatus {
    pub bot_id: String,
    pub connected: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// List per-bot WeCom connection status. Mirrors `list_channels`' socket
/// plumbing: writes `wecom-bots-status` to the control channel, reads the single
/// JSON-array line, and deserializes it into `Vec<WeComBotStatus>`.
#[tauri::command]
pub async fn list_wecom_bots_status() -> Result<Vec<WeComBotStatus>, String> {
    amuxd_control::request_json_async("wecom-bots-status\n").await
}

/// Every conversation the configured WeCom bots can be addressed in.
///
/// Answered by each bot's MCP endpoint, not by the gateway: the long
/// connection only ever hears about a chat when someone writes into it, so a
/// cron job's target used to be a chat id typed in by hand. Bots without an
/// api key are simply absent from the list; per-bot failures come back in
/// `errors` so the picker can say which key was refused instead of showing an
/// empty dropdown.
#[tauri::command]
pub async fn list_wecom_chats() -> Result<serde_json::Value, String> {
    amuxd_control::request_json_async("wecom-chat-list\n").await
}

/// Which credential fields already hold a value, as dotted paths
/// (`channels.wecom.bots[aibC…].secret`).
///
/// Credentials read back empty by design — the daemon keeps them in the team's
/// encrypted store — but an empty box is also what "never configured" looks
/// like, so the form needs to be told the difference. Values never travel.
#[tauri::command]
pub async fn list_channel_secret_keys() -> Result<Vec<String>, String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(default)]
        keys: Vec<String>,
    }
    let parsed: Resp = amuxd_control::request_json_async("channel-secret-keys\n").await?;
    Ok(parsed.keys)
}

/// Load a persisted channel config from the active team's `team.toml`, so the
/// settings UI can rehydrate forms after the panel is closed and reopened.
///
/// Credential fields come back **empty**: the daemon splits them into the
/// team's encrypted secret store on save and this read does not decrypt.
/// Saving a form with an empty credential keeps the stored value (the
/// daemon's save treats empty-string secrets as "unchanged"), so round-trips
/// through this read are lossless.
#[tauri::command]
pub fn load_channel_config(platform: String) -> Result<Option<serde_json::Value>, String> {
    if !matches!(
        platform.as_str(),
        "discord" | "wecom" | "feishu" | "kook" | "wechat" | "email" | "seatalk"
    ) {
        return Err(format!("unknown platform: {platform}"));
    }

    let Some(path) = team_config_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: toml::Value =
        toml::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))?;

    let Some(config) = parsed
        .get("channels")
        .and_then(|channels| channels.get(&platform))
    else {
        return Ok(None);
    };

    serde_json::to_value(config)
        .map(Some)
        .map_err(|e| format!("serialize channel config: {e}"))
}

/// Replace `daemon.toml`'s `[channels.<platform>]` section with the JSON in
/// `config_json` (one of the daemon's per-platform config structs). amuxd
/// auto-reloads the channel manager so the change takes effect immediately.
#[tauri::command]
pub async fn save_channel_config(platform: String, config_json: String) -> Result<(), String> {
    // Single-line JSON keeps the framing simple — the daemon reads exactly
    // three newline-terminated tokens off the control channel.
    let single_line = config_json.replace('\n', " ");
    amuxd_control::send(&format!("channel-save\n{platform}\n{single_line}\n")).await
}

/// Read `channels.model` — the model every gateway session starts on when the
/// chat has not set its own with `/model` (ADR-0007).
///
/// Reads team.toml directly, like `load_channel_config`: it is plain structure
/// with no credential in it, so there is nothing for the daemon to decrypt.
/// `None` means unset, which is the pre-ADR-0007 unpinned behaviour.
#[tauri::command]
pub fn load_gateway_model() -> Result<Option<String>, String> {
    let Some(path) = team_config_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: toml::Value =
        toml::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))?;

    Ok(parsed
        .get("channels")
        .and_then(|channels| channels.get("model"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty()))
}

/// Set `channels.model`. An empty string clears it, restoring the unpinned
/// spawn. Goes through amuxd rather than writing team.toml directly so the
/// channel manager reloads and the next spawn actually uses it.
#[tauri::command]
pub async fn save_gateway_model(model: String) -> Result<(), String> {
    // Two newline-terminated tokens, matching the control channel's line framing.
    amuxd_control::send(&format!(
        "gateway-model\n{}\n",
        model.trim().replace('\n', " ")
    ))
    .await
}

/// Tell amuxd to re-read `daemon.toml` and restart all channels. Cheap;
/// useful when the daemon-managed config file was edited out-of-band.
#[tauri::command]
pub async fn reload_channels() -> Result<(), String> {
    amuxd_control::send("channel-reload\n").await
}

/// Probe SeaTalk App ID / App Secret against the Open Platform token API.
/// Does not require amuxd — useful before saving/starting the gateway.
#[tauri::command]
pub async fn test_seatalk_credentials(
    app_id: String,
    app_secret: String,
) -> Result<String, String> {
    SeaTalkGateway::test_credentials(&app_id, &app_secret).await
}

// ─── Workspace teamclu.json helpers (not channel-specific) ───────────────────
//
// These four commands manage non-channel fields of the workspace-level
// `teamclu.json` (shortcuts list, system prompt, UI locale). They lived in
// this module historically because the file-reader helper was here; rather
// than scatter them across new modules we keep them here as siblings of the
// new sock-RPC commands. The H1 channel rewrite intentionally leaves them
// untouched.

use tauri::State;

/// Load personal shortcuts from the workspace config file (teamclu.json).
#[tauri::command]
pub fn load_shortcuts(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    workspace_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let config = teamclu_gateway::read_config(&workspace_path)?;
    let shortcuts = config
        .other
        .get("shortcuts")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    Ok(shortcuts.as_array().cloned().unwrap_or_default())
}

/// Save personal shortcuts to the workspace config file (teamclu.json).
#[tauri::command]
pub fn save_shortcuts(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    nodes: Vec<serde_json::Value>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    teamclu_gateway::patch_config_value(&workspace_path, "shortcuts", serde_json::json!(nodes))
}

/// Load the per-workspace system prompt from teamclu.json. Returns "" if unset.
#[tauri::command]
pub fn load_system_prompt(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    let config = teamclu_gateway::read_config(&workspace_path)?;
    Ok(config
        .other
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Save the per-workspace system prompt to teamclu.json.
#[tauri::command]
pub fn save_system_prompt(
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    prompt: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    teamclu_gateway::patch_config_value(
        &workspace_path,
        "systemPrompt",
        serde_json::json!(prompt),
    )?;
    teamclu_runtime_env::sync_teamclu_claude_md(&workspace_path, &prompt)
}

/// Report the app's UI language to amuxd, which is what the gateways reply in.
///
/// The language used to be written into the current workspace's teamclu.json,
/// which is why `/help` in WeCom stayed English no matter what the app was set
/// to: the gateways live in amuxd and read a workspace of amuxd's own, never the
/// one the app had open. Language is one app-level preference, so it now lives
/// in daemon.toml (device-scoped) and is pushed here — on a language change and
/// on every workspace open, so a daemon that was down for the change still
/// catches up.
#[tauri::command]
pub async fn set_config_locale(locale: String) -> Result<(), String> {
    // Two newline-terminated tokens, matching the control channel's line framing.
    amuxd_control::send(&format!(
        "gateway-locale\n{}\n",
        locale.trim().replace('\n', " ")
    ))
    .await
}
