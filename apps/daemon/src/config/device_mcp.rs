//! Device-level MCP servers — `~/.amuxd/mcp.json`.
//!
//! These four servers are identical for every workspace on the machine:
//! `teamclu-introspect` (the bundled sidecar), `playwright`, `chrome-control`
//! and `autoui` (all `npx` tools). They used to be materialized into every
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
    "teamclu-introspect",
    "playwright",
    "chrome-control",
    "autoui",
];

/// `amuxd-send` was a second daemon MCP server whose only tool, `send`, is now
/// `send_channel_message`'s `reply_token` branch inside `teamclu-introspect`.
/// Two servers and two send tools in front of the model did one job.
///
/// Kept as a name so existing device files lose the entry instead of keeping a
/// server nothing spawns any more. Workspace copies are cleaned by
/// `LEGACY_MCP_NAMES` in `runtime::supervisor`.
pub const RETIRED_DEVICE_MCP_NAMES: &[&str] = &["amuxd-send"];

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

/// This deployment's app URL scheme, for workspace-scoped MCP tools that emit
/// deeplinks (e.g. `get_session_deeplink`). Precedence:
///   1. `TEAMCLU_APP_SCHEME` env — set by the desktop when it spawns the
///      managed amuxd (baked from `build.config.json`'s `app.scheme`); always
///      correct for a desktop-managed daemon.
///   2. `DaemonConfig.app_scheme` — captured from the onboarding invite; the
///      standalone path (cron / self-hosted daemon not launched by the app).
///   3. `None` — the introspect tool falls back to its built-in `teamclu`.
///
/// Without this, a branded build (scheme `acme`) still emits `teamclu://`
/// deeplinks from MCP, which the OS routes to the wrong handler (or none).
fn resolve_app_scheme() -> Option<String> {
    if let Ok(raw) = std::env::var("TEAMCLU_APP_SCHEME") {
        let s = raw.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    super::DaemonConfig::load(&super::DaemonConfig::default_path())
        .ok()
        .and_then(|c| c.app_scheme)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Whether a resolved scheme is safe to inject as `TEAMCLU_APP_SCHEME` — a URL
/// scheme must start with a lowercase letter then `[a-z0-9+.-]` (same rule as
/// the frontend branding script and the introspect tool's own validator).
fn is_valid_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
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
///
/// `environment.TEAMCLU_APP_SCHEME` is injected when a brand scheme resolves,
/// so `get_session_deeplink` emits deeplinks with THIS build's scheme rather
/// than the hardcoded `teamclu://`.
fn introspect_mcp_config() -> Option<serde_json::Value> {
    let binary = crate::runtime::supervisor::resolve_introspect_binary()?;
    let sock = super::DaemonConfig::sock_path();
    let scheme = resolve_app_scheme()
        .filter(|s| is_valid_scheme(s));
    let entry = match scheme {
        Some(s) => serde_json::json!({
            "type": "local",
            "enabled": true,
            "command": [
                binary,
                "--api-port",
                crate::runtime::supervisor::INTROSPECT_API_PORT.to_string(),
                // `send_channel_message`'s token branch is routed by the daemon, not
                // by the desktop app on `--api-port`: only the daemon can resolve a
                // reply token, and an unattended run has no app to ask.
                format!("--sock={}", sock.to_string_lossy())
            ],
            "environment": { "TEAMCLU_APP_SCHEME": s }
        }),
        None => serde_json::json!({
            "type": "local",
            "enabled": true,
            "command": [
                binary,
                "--api-port",
                crate::runtime::supervisor::INTROSPECT_API_PORT.to_string(),
                format!("--sock={}", sock.to_string_lossy())
            ]
        }),
    };
    Some(entry)
}

/// Whether the existing `teamclu-introspect` entry must be rewritten for the
/// scheme, on top of the dead-binary check. The env is only enforced when a
/// scheme actually resolved; without one we leave a hand-written entry alone
/// rather than thrash it on every call. A stale-or-missing
/// `environment.TEAMCLU_APP_SCHEME` is what self-heals already-onboarded
/// daemons (whose device file predates this field) onto the brand scheme.
fn introspect_scheme_stale(existing: &serde_json::Value, scheme: Option<&str>) -> bool {
    let Some(s) = scheme else {
        return false;
    };
    let current = existing
        .get("environment")
        .and_then(|e| e.get("TEAMCLU_APP_SCHEME"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    current != s
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
/// `teamclu-introspect` is refreshed when its binary path has gone stale — a
/// reinstall moves the sidecar. The three `npx` bridges are only created when
/// absent so a user's `enabled` toggle survives. Retired servers are removed.
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

    for retired in RETIRED_DEVICE_MCP_NAMES {
        if mcp_obj.remove(*retired).is_some() {
            tracing::info!(server = retired, "dropping retired device MCP entry");
            changed = true;
        }
    }

    // Resolve the brand scheme once for this pass. An invalid value is dropped
    // (the introspect tool's own validator will then reject/default it) so we
    // never write a bogus scheme into the device file.
    let app_scheme = resolve_app_scheme().filter(|s| is_valid_scheme(s));

    // Refreshed on a dead path only: a reinstall moves the sidecar, but a user
    // who disabled introspect should not find it back on after one. Also
    // refresh when the resolved scheme env is missing/stale — that self-heals a
    // device file written before the scheme was injected, without a re-onboard.
    let introspect_stale = match mcp_obj.get("teamclu-introspect") {
        Some(existing) => {
            crate::runtime::supervisor::introspect_command_stale(existing)
                || introspect_scheme_stale(existing, app_scheme.as_deref())
        }
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
    fn a_retired_send_bridge_is_removed_from_an_existing_device_file() {
        // `amuxd-send` was a second daemon MCP server for one tool. That tool is
        // `send_channel_message`'s reply_token branch now, and nothing spawns
        // `amuxd mcp-server` any more — the subcommand is gone — so an entry
        // left in the file would only ever fail to start.
        with_temp_home(|| {
            let path = device_mcp_file();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                r#"{"mcp":{"amuxd-send":{"type":"local","enabled":true,
                    "command":["/old/amuxd","mcp-server","--sock=/tmp/amuxd.sock"]}}}"#,
            )
            .unwrap();

            assert!(
                ensure_device_mcp().unwrap(),
                "the retired entry is a change"
            );
            assert!(!load_device_mcp().contains_key("amuxd-send"));
        })
    }

    #[test]
    fn introspect_can_reach_the_daemon_socket() {
        // Its `reply_token` branch is routed by the daemon, so without a --sock
        // an unattended run has no way to reply at all: the rest of the sidecar
        // talks to the desktop app, which is not running at 3am.
        with_temp_home(|| {
            ensure_device_mcp().unwrap();
            let servers = load_device_mcp();
            let Some(introspect) = servers.get("teamclu-introspect") else {
                // The binary is not resolvable on this machine; nothing to assert.
                return;
            };
            let command = introspect.command.join(" ");
            assert!(command.contains("--sock="), "got: {command}");
            // The workspace comes from the child's cwd, not from argv.
            assert!(!command.contains("--workspace"), "got: {command}");
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
            assert!(load_device_mcp().contains_key("chrome-control"));
        })
    }

    #[test]
    fn is_valid_scheme_accepts_brand_schemes_and_rejects_garbage() {
        assert!(is_valid_scheme("teamclu"));
        assert!(is_valid_scheme("acme"));
        assert!(is_valid_scheme("teamclu-dev"));
        assert!(is_valid_scheme("a.b+c-d"));
        // A scheme must start with a lowercase letter.
        assert!(!is_valid_scheme("Teamclu"));
        assert!(!is_valid_scheme("1acme"));
        assert!(!is_valid_scheme(""));
        // No spaces, no slashes — these would misroute a deeplink.
        assert!(!is_valid_scheme("ac me"));
        assert!(!is_valid_scheme("acme://"));
    }

    #[test]
    fn introspect_scheme_stale_self_heals_a_pre_scheme_entry() {
        // A device file written before this fix has no `environment` block —
        // once a scheme resolves, the entry must be rewritten so the brand
        // scheme is injected. Without this, branded builds keep emitting
        // teamclu:// even after the daemon learned the real scheme.
        let pre_fix = serde_json::json!({
            "type": "local",
            "enabled": true,
            "command": ["/bin/teamclu-introspect", "--api-port", "13144", "--sock=/tmp/x"]
        });
        assert!(introspect_scheme_stale(&pre_fix, Some("acme")));

        // After the refresh carries the right env, it is no longer stale.
        let healed = serde_json::json!({
            "type": "local",
            "enabled": true,
            "command": ["/bin/teamclu-introspect", "--api-port", "13144", "--sock=/tmp/x"],
            "environment": { "TEAMCLU_APP_SCHEME": "acme" }
        });
        assert!(!introspect_scheme_stale(&healed, Some("acme")));
        // A different scheme is still stale (re-brand must take effect).
        assert!(introspect_scheme_stale(&healed, Some("teamclu")));

        // No scheme resolved → never claim stale on env grounds. We must not
        // thrash an entry whose scheme we cannot determine.
        assert!(!introspect_scheme_stale(&pre_fix, None));
    }
}
