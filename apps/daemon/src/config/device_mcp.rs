//! Device-level MCP servers — `~/.amuxd/mcp.json`.
//!
//! These five servers are identical for every workspace on the machine:
//! `amuxd-send` (this daemon's own socket), `teamclu-introspect` (the bundled
//! sidecar), `playwright`, `chrome-control` and `autoui` (all `npx` tools).
//! They used to be materialized into every
//! `<workspace>/opencode.json`, which meant N copies of the same thing, each
//! carrying **this** machine's absolute binary paths — so opening the same repo
//! on another machine rewrote the file, and a committed copy churned forever.
//!
//! Shape is opencode's own `{ "mcp": { name: { type, enabled, command: [...] } } }`,
//! not the Cursor `mcpServers` shape the *team* file uses. Two reasons: the
//! Cursor shape has nowhere to put `enabled` (playwright ships disabled), and
//! every consumer already parses this shape for the workspace file — the device
//! file is just a second path through the same code.
//!
//! Read by all three MCP consumers, same as the team file:
//! - `team_mcp::load_merged_mcp` — the settings UI's merged view
//! - `runtime/sidecar/mcp.rs` — cursor / claude-agent / pi
//! - `runtime/team_cloud_config::sync_opencode_generated` — opencode, via
//!   `OPENCODE_CONFIG`
//!
//! `teamclu-introspect` is deliberately NOT here: its argv carries
//! `--workspace <abs path>`, so it is the one inherent server that is genuinely
//! per-workspace and stays in the workspace config.

use std::collections::HashMap;
use std::path::PathBuf;

use tracing::info;

use super::workspace_control::{McpServerConfig, WorkspaceControlError};

/// Inherent servers that live at device scope. Order is irrelevant; membership
/// is what `team_mcp` uses to keep them out of workspace configs.
pub const DEVICE_MCP_NAMES: &[&str] = &[
    "amuxd-send",
    "teamclu-introspect",
    "playwright",
    "chrome-control",
    "autoui",
];

pub fn is_device_scoped(name: &str) -> bool {
    DEVICE_MCP_NAMES.contains(&name)
}

/// `~/.amuxd/mcp.json`.
pub fn device_mcp_file() -> PathBuf {
    super::layout::device_mcp_file()
}

/// Every device server, or an empty map when the file is missing or unreadable.
///
/// Deliberately lossy on error: a corrupt device file must not take the whole
/// MCP listing down with it, and the next `ensure_device_mcp` rewrites it.
pub fn load_device_mcp() -> HashMap<String, McpServerConfig> {
    let Ok(content) = std::fs::read_to_string(device_mcp_file()) else {
        return HashMap::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return HashMap::new();
    };
    json.get("mcp")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

fn read_raw() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(device_mcp_file())
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| json.as_object().cloned())
        .unwrap_or_default()
}

fn write_raw(
    root: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), WorkspaceControlError> {
    let path = device_mcp_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    let body = serde_json::to_string_pretty(&serde_json::Value::Object(root.clone()))
        .map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
    // tmp+rename: the readers above are uncoordinated with this writer, and a
    // truncated prefix parses as "no device MCP at all".
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        WorkspaceControlError::Io(e.to_string())
    })
}

/// This daemon's `send` bridge. Rebuilt rather than remembered: the binary path
/// changes with every reinstall and the socket path with `$AMUXD_HOME`.
fn send_mcp_config() -> Result<serde_json::Value, WorkspaceControlError> {
    let amuxd_bin =
        std::env::current_exe().map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    let sock = super::DaemonConfig::sock_path();
    Ok(serde_json::json!({
        "type": "local",
        "enabled": true,
        "command": [
            amuxd_bin.to_string_lossy(),
            "mcp-server",
            format!("--sock={}", sock.to_string_lossy())
        ]
    }))
}

/// `teamclu-introspect`, the bundled sidecar.
///
/// It was the last of the inherent servers still written per workspace, and the
/// only reason was its argv: it carried `--workspace <path>`, which cannot be
/// shared. It does not need to — the flag defaults to `.` and every runtime
/// spawns MCP children with the worktree as their cwd, so one device entry
/// serves every workspace and resolves to the right one at run time.
///
/// Per-workspace was not merely redundant, it was arbitrary: the entry is
/// written when a runtime first prepares a workspace, so a workspace nothing
/// had run in yet simply had no introspect — which is why it was missing from
/// the MCP panel on a machine that has the sidecar installed.
fn introspect_mcp_config() -> Option<serde_json::Value> {
    let binary = crate::runtime::supervisor::resolve_introspect_binary()?;
    Some(serde_json::json!({
        "type": "local",
        "enabled": true,
        "command": [
            binary,
            "--api-port",
            crate::runtime::supervisor::INTROSPECT_API_PORT.to_string()
        ]
    }))
}

fn autoui_environment() -> serde_json::Value {
    serde_json::json!({
        "QWEN_API_KEY": "${QWEN_API_KEY}",
        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "QWEN_MODEL": "qwen3-vl-flash"
    })
}

/// Seed the device servers, non-destructively.
///
/// `amuxd-send` is compared and refreshed (its argv is machine state) and
/// `teamclu-introspect` is refreshed when its binary path has gone stale — a
/// reinstall moves the sidecar. The three `npx` bridges are only created when
/// absent so a user's `enabled` toggle survives.
/// Returns whether the file changed.
pub fn ensure_device_mcp() -> Result<bool, WorkspaceControlError> {
    let mut root = read_raw();
    let mut changed = false;

    if !root.contains_key("$schema") {
        root.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
        changed = true;
    }

    let mcp = root.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("device mcp is not an object".into()))?;

    let send = send_mcp_config()?;
    if mcp_obj.get("amuxd-send") != Some(&send) {
        mcp_obj.insert("amuxd-send".to_string(), send);
        changed = true;
    }

    // Refreshed on a dead path only: a reinstall moves the sidecar, but a user
    // who disabled introspect should not find it back on after one.
    let introspect_stale = match mcp_obj.get("teamclu-introspect") {
        Some(existing) => crate::runtime::supervisor::introspect_command_stale(existing),
        None => true,
    };
    if introspect_stale {
        match introspect_mcp_config() {
            Some(mut cfg) => {
                if let Some(enabled) = mcp_obj
                    .get("teamclu-introspect")
                    .and_then(|existing| existing.get("enabled"))
                    .cloned()
                {
                    cfg["enabled"] = enabled;
                }
                mcp_obj.insert("teamclu-introspect".to_string(), cfg);
                changed = true;
            }
            None => {
                tracing::warn!(
                    "teamclu-introspect binary not found; skipping device MCP registration"
                );
            }
        }
    }

    if !mcp_obj.contains_key("playwright") {
        mcp_obj.insert(
            "playwright".to_string(),
            serde_json::json!({
                "type": "local",
                "enabled": false,
                "command": ["npx", "-y", "@playwright/mcp@latest"]
            }),
        );
        changed = true;
    }

    if !mcp_obj.contains_key("chrome-control") {
        mcp_obj.insert(
            "chrome-control".to_string(),
            serde_json::json!({
                "type": "local",
                "enabled": true,
                "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect"]
            }),
        );
        changed = true;
    }

    match mcp_obj.get_mut("autoui") {
        None => {
            mcp_obj.insert(
                "autoui".to_string(),
                serde_json::json!({
                    "type": "local",
                    "enabled": true,
                    "command": ["npx", "-y", "autoui-mcp@latest"],
                    "environment": autoui_environment()
                }),
            );
            changed = true;
        }
        Some(existing) => {
            // An empty `environment` means an older build (or a hand edit) lost
            // the QWEN placeholders, which leaves autoui unable to authenticate.
            if let Some(obj) = existing.as_object_mut() {
                let needs_restore = obj
                    .get("environment")
                    .and_then(|v| v.as_object())
                    .map(|env| env.is_empty())
                    .unwrap_or(true);
                if needs_restore {
                    obj.insert("environment".to_string(), autoui_environment());
                    changed = true;
                }
            }
        }
    }

    if changed {
        write_raw(&root)?;
        info!(path = %device_mcp_file().display(), "device MCP config updated");
    }
    Ok(changed)
}

/// Upsert device-scoped entries (the settings UI toggling `chrome-control` off,
/// for instance). Only names in [`DEVICE_MCP_NAMES`] are accepted; anything else
/// is workspace-owned and belongs in the workspace config.
pub fn put_device_entries(
    entries: HashMap<String, McpServerConfig>,
) -> Result<bool, WorkspaceControlError> {
    if entries.is_empty() {
        return Ok(false);
    }
    let mut root = read_raw();
    let mcp = root.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("device mcp is not an object".into()))?;

    let mut changed = false;
    for (name, cfg) in entries {
        if !is_device_scoped(&name) {
            continue;
        }
        let mut cfg = cfg;
        cfg.source = None;
        let value =
            serde_json::to_value(&cfg).map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
        if mcp_obj.get(&name) != Some(&value) {
            mcp_obj.insert(name, value);
            changed = true;
        }
    }
    if changed {
        write_raw(&root)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_brand_env::BrandEnvGuard;

    /// Every test here writes to `~/.amuxd/mcp.json`, so they all need an
    /// isolated home — and the guard serializes them against every other test
    /// that moves `HOME` / `AMUXD_HOME` (shared `TEST_HOME_LOCK`).
    fn with_temp_home<T>(f: impl FnOnce() -> T) -> T {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        f()
    }

    #[test]
    fn seeding_registers_the_send_bridge_for_the_whole_machine() {
        // The regression this pins is older than the move: `send` used to be
        // written to a per-session config that only a fresh attach applied, so a
        // session the desktop had already attached had no send tool. One
        // registration per machine is what makes it independent of who attached
        // first — and of which backend runs, since every runtime reads this file.
        with_temp_home(|| {
            assert!(ensure_device_mcp().unwrap(), "first seed writes");
            let servers = load_device_mcp();
            let send = servers.get("amuxd-send").expect("send bridge present");
            assert_eq!(send.enabled, Some(true));
            assert!(
                send.command.iter().any(|arg| arg == "mcp-server"),
                "got: {:?}",
                send.command
            );
        })
    }

    #[test]
    fn the_send_bridge_carries_no_session_identity() {
        // Baking `--session-id` / `--binding` into argv is what forced the
        // per-session registration in the first place. The destination now comes
        // from the caller's reply token, so nothing here may be session-scoped.
        with_temp_home(|| {
            ensure_device_mcp().unwrap();
            let command = load_device_mcp()["amuxd-send"].command.join(" ");
            assert!(!command.contains("--session-id"), "got: {command}");
            assert!(!command.contains("--binding"), "got: {command}");
        })
    }

    #[test]
    fn seeding_is_idempotent_and_leaves_user_toggles_alone() {
        with_temp_home(|| {
            ensure_device_mcp().unwrap();
            // playwright ships disabled; a user enabling it must survive re-seeds.
            let mut enabled = load_device_mcp();
            let playwright = enabled.get_mut("playwright").unwrap();
            assert_eq!(playwright.enabled, Some(false), "ships disabled");
            playwright.enabled = Some(true);
            let toggled = HashMap::from([("playwright".to_string(), playwright.clone())]);
            assert!(put_device_entries(toggled).unwrap());

            assert!(
                !ensure_device_mcp().unwrap(),
                "nothing left to seed on the second pass"
            );
            assert_eq!(load_device_mcp()["playwright"].enabled, Some(true));
        })
    }

    #[test]
    fn only_device_scoped_names_are_accepted() {
        with_temp_home(|| {
            let workspace_server = McpServerConfig {
                server_type: "local".to_owned(),
                enabled: Some(true),
                command: vec!["npx".to_owned(), "ctx7".to_owned()],
                environment: HashMap::new(),
                url: None,
                headers: HashMap::new(),
                timeout: None,
                source: None,
                extra: HashMap::new(),
            };
            let rejected = HashMap::from([("ctx7".to_string(), workspace_server)]);
            assert!(!put_device_entries(rejected).unwrap(), "not device-scoped");
            assert!(!load_device_mcp().contains_key("ctx7"));
        })
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_rather_than_failing() {
        with_temp_home(|| {
            let path = device_mcp_file();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{ not json").unwrap();
            assert!(load_device_mcp().is_empty());
            // …and the next seed repairs it.
            assert!(ensure_device_mcp().unwrap());
            assert!(load_device_mcp().contains_key("amuxd-send"));
        })
    }
}
