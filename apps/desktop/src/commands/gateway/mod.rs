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

pub mod agent_channel;
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
pub(crate) fn team_config_path() -> Option<PathBuf> {
    let team = crate::commands::amuxd_active_team()?;
    Some(crate::commands::amuxd_team_state_dir(&team).join("team.toml"))
}

/// The platforms with an enabled `[channels.<name>]` section in the team's
/// `team.toml` — i.e. the ones configured through settings and run by amuxd.
///
/// Presence only, no credentials (those are sealed in `secrets.enc`). This is
/// what lets the agent-side tools answer "is WeCom set up?" from where the
/// configuration actually lives; they used to look in the workspace
/// `teamclu.json`, which settings stopped writing.
pub(crate) fn configured_channels_blocking() -> Vec<String> {
    let Some(path) = team_config_path() else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    configured_channels_in(&content)
}

fn configured_channels_in(team_toml: &str) -> Vec<String> {
    let Ok(parsed) = toml::from_str::<toml::Value>(team_toml) else {
        return Vec::new();
    };
    let Some(channels) = parsed.get("channels").and_then(|c| c.as_table()) else {
        return Vec::new();
    };
    // Only table-valued entries are platforms (`channels.model` is a string),
    // and each carries its own `enabled` switch.
    let mut names: Vec<String> = channels
        .iter()
        .filter(|(_, v)| v.is_table() && v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true))
        .map(|(name, _)| name.clone())
        .collect();
    names.sort();
    names
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

/// Per-app SeaTalk connection status. `appId` is the Open Platform App ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeaTalkBotStatus {
    pub app_id: String,
    pub connected: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn list_seatalk_bots_status() -> Result<Vec<SeaTalkBotStatus>, String> {
    amuxd_control::request_json_async("seatalk-bots-status\n").await
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
pub async fn load_channel_config(platform: String) -> Result<Option<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || load_channel_config_blocking(platform))
        .await
        .map_err(|e| format!("load_channel_config task failed: {e}"))?
}

pub(crate) fn load_channel_config_blocking(
    platform: String,
) -> Result<Option<serde_json::Value>, String> {
    if !matches!(
        platform.as_str(),
        "discord" | "wecom" | "feishu" | "kook" | "wechat" | "wechatpad" | "email" | "seatalk"
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

/// Replace the active team's `[channels.<platform>]` section with the JSON in
/// `config_json` (one of the daemon's per-platform config structs). amuxd
/// parses it, persists team.toml, and reloads the channel manager.
///
/// The daemon replies `{ok:true}` or `{ok:false,error}`. A document it cannot
/// parse is not saved; the error is the reply, not a log line the settings
/// page never sees.
#[tauri::command]
pub async fn save_channel_config(platform: String, config_json: String) -> Result<(), String> {
    // Single-line JSON keeps the framing simple — the daemon reads exactly
    // three newline-terminated tokens off the control channel.
    let single_line = config_json.replace('\n', " ");
    apply_saved_channel(&platform, &single_line).await
}

#[derive(Debug, Deserialize)]
struct ChannelSaveAck {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

pub(crate) async fn apply_saved_channel(platform: &str, config_json: &str) -> Result<(), String> {
    let single_line = config_json.replace('\n', " ");
    let ack: ChannelSaveAck =
        amuxd_control::request_json_async(&format!("channel-save\n{platform}\n{single_line}\n"))
            .await?;
    if ack.ok {
        Ok(())
    } else {
        Err(ack
            .error
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "channel save was rejected".to_string()))
    }
}

/// Read `channels.model` — the model every gateway session starts on when the
/// chat has not set its own with `/model` (ADR-0007).
///
/// Reads team.toml directly, like `load_channel_config`: it is plain structure
/// with no credential in it, so there is nothing for the daemon to decrypt.
/// `None` means unset, which is the pre-ADR-0007 unpinned behaviour.
#[tauri::command]
pub async fn load_gateway_model() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(load_gateway_model_blocking)
        .await
        .map_err(|e| format!("load_gateway_model task failed: {e}"))?
}

fn load_gateway_model_blocking() -> Result<Option<String>, String> {
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
pub async fn load_shortcuts(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    workspace_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    // Resolving the path is a registry lookup; the file read goes off-thread.
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    tokio::task::spawn_blocking(move || load_shortcuts_blocking(&workspace_path))
        .await
        .map_err(|e| format!("load_shortcuts task failed: {e}"))?
}

fn load_shortcuts_blocking(workspace_path: &str) -> Result<Vec<serde_json::Value>, String> {
    let config = teamclu_gateway::read_config(workspace_path)?;
    let shortcuts = config
        .other
        .get("shortcuts")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    Ok(shortcuts.as_array().cloned().unwrap_or_default())
}

/// Save personal shortcuts to the workspace config file (teamclu.json).
#[tauri::command]
pub async fn save_shortcuts(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    nodes: Vec<serde_json::Value>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    tokio::task::spawn_blocking(move || {
        teamclu_gateway::patch_config_value(&workspace_path, "shortcuts", serde_json::json!(nodes))
    })
    .await
    .map_err(|e| format!("save_shortcuts task failed: {e}"))?
}

/// Load the per-workspace system prompt from teamclu.json. Returns "" if unset.
#[tauri::command]
pub async fn load_system_prompt(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    tokio::task::spawn_blocking(move || load_system_prompt_blocking(&workspace_path))
        .await
        .map_err(|e| format!("load_system_prompt task failed: {e}"))?
}

fn load_system_prompt_blocking(workspace_path: &str) -> Result<String, String> {
    let config = teamclu_gateway::read_config(workspace_path)?;
    Ok(config
        .other
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Save the per-workspace system prompt to teamclu.json.
#[tauri::command]
pub async fn save_system_prompt(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    prompt: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &window, &registry)?;
    tokio::task::spawn_blocking(move || save_system_prompt_blocking(&workspace_path, &prompt))
        .await
        .map_err(|e| format!("save_system_prompt task failed: {e}"))?
}

fn save_system_prompt_blocking(workspace_path: &str, prompt: &str) -> Result<(), String> {
    teamclu_gateway::patch_config_value(workspace_path, "systemPrompt", serde_json::json!(prompt))?;
    teamclu_runtime_env::sync_teamclu_claude_md(workspace_path, prompt)
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

#[cfg(test)]
mod configured_channels_tests {
    use super::configured_channels_in;

    #[test]
    fn lists_enabled_platform_sections_only() {
        let toml = r#"
[channels]
model = "team/fast"

[channels.wecom]
enabled = true
bots = [{ bot_id = "b-1" }]

[channels.seatalk]
enabled = false
app_id = "a"

[channels.discord]
enabled = true
"#;
        assert_eq!(configured_channels_in(toml), vec!["discord", "wecom"]);
    }

    #[test]
    fn a_team_without_channels_has_none() {
        assert!(configured_channels_in("[team_share]\nenabled = true\n").is_empty());
        assert!(configured_channels_in("not toml [").is_empty());
    }
}
