//! Workspace MCP manifest → `@cursor/sdk` `AgentOptions.mcpServers`.
//!
//! Four sources, merged in this order (later wins a name clash):
//!
//! 1. `~/.amuxd/mcp.json` `mcp` map — this machine's own servers (`amuxd-send`,
//!    the `npx` bridges). Used to be copied into every workspace config.
//! 2. `~/.amuxd/teams/<id>/cloud/mcp.json` — Cursor `{ "mcpServers": … }`.
//! 3. `<worktree>/opencode.json` `mcp` map — the user's own servers.
//! 4. `mcp_config_path` — host-level `remote-tools-host.json`.
//!
//! The SDK wants `Record<string, McpServerConfig>` (`options.d.ts:235`) where a
//! stdio entry is `{type:"stdio", command: string, args: string[], env}` — note
//! `command` is a *string*, unlike opencode.json's `command: string[]`.
//! Non-stdio servers map to `{type:"http", url, headers}`.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Map, Value};

/// Servers keyed by name, ready to hand to `create_agent` / `resume_agent`.
pub type McpServers = Map<String, Value>;

/// Split an opencode `command: ["cmd", "arg", ...]` array into the SDK's
/// `(command, args)` pair. Returns None for an empty / non-string array.
fn split_command(command: &[Value]) -> Option<(String, Vec<Value>)> {
    let head = command.first()?.as_str()?.to_string();
    if head.is_empty() {
        return None;
    }
    if !command.iter().all(|a| a.is_string()) {
        return None;
    }
    Some((head, command[1..].to_vec()))
}

/// One `opencode.json` `mcp` entry → an SDK server config.
fn server_from_opencode_entry(entry: &Map<String, Value>) -> Option<Value> {
    if entry.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        return None;
    }
    if entry.get("type").and_then(|v| v.as_str()) == Some("remote") {
        let url = entry.get("url").and_then(|v| v.as_str())?;
        if url.is_empty() {
            return None;
        }
        let mut out = json!({ "type": "http", "url": url });
        if let Some(headers) = entry.get("headers").and_then(|v| v.as_object()) {
            out["headers"] = Value::Object(headers.clone());
        }
        return Some(out);
    }
    let command = entry.get("command").and_then(|v| v.as_array())?;
    let (command, args) = split_command(command)?;
    let mut out = json!({ "type": "stdio", "command": command });
    if !args.is_empty() {
        out["args"] = Value::Array(args);
    }
    // opencode calls it `environment`; the SDK calls it `env`.
    if let Some(env) = entry.get("environment").and_then(|v| v.as_object()) {
        if !env.is_empty() {
            out["env"] = Value::Object(env.clone());
        }
    }
    Some(out)
}

/// `{"mcpServers": {name: {command: "x", args: [...]}}}` → SDK servers. This is
/// the amuxd-written host config shape, where `command` is already a string.
pub fn servers_from_mcp_config_value(root: &Value) -> McpServers {
    let mut out = Map::new();
    let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
        return out;
    };
    for (name, server) in servers {
        let Some(command) = server.get("command").and_then(|v| v.as_str()) else {
            continue;
        };
        if command.is_empty() {
            continue;
        }
        let mut entry = json!({ "type": "stdio", "command": command });
        if let Some(args) = server.get("args").and_then(|v| v.as_array()) {
            if !args.is_empty() {
                entry["args"] = Value::Array(args.clone());
            }
        }
        if let Some(env) = server.get("env").and_then(|v| v.as_object()) {
            if !env.is_empty() {
                entry["env"] = Value::Object(env.clone());
            }
        }
        out.insert(name.clone(), entry);
    }
    out
}

/// `opencode.json` value → SDK servers.
pub fn servers_from_opencode_value(root: &Value) -> McpServers {
    let mut out = Map::new();
    let Some(mcp) = root.get("mcp").and_then(|v| v.as_object()) else {
        return out;
    };
    // BTreeMap first so the output order is stable across runs (the map feeds
    // the process fingerprint / logs).
    let ordered: BTreeMap<&String, &Value> = mcp.iter().collect();
    for (name, server) in ordered {
        let Some(entry) = server.as_object() else {
            continue;
        };
        if let Some(cfg) = server_from_opencode_entry(entry) {
            out.insert(name.clone(), cfg);
        }
    }
    out
}

fn read_json(path: &Path) -> Option<Value> {
    let body = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&body).ok()
}

fn servers_from_team_cloud_value(root: &Value) -> McpServers {
    let mut out = Map::new();
    let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
        return out;
    };
    for (name, raw) in servers {
        let Ok(parsed) =
            serde_json::from_value::<crate::config::team_mcp::CursorMcpServer>(raw.clone())
        else {
            continue;
        };
        let cfg = crate::config::team_mcp::convert_cursor_server(&parsed);
        let Ok(val) = serde_json::to_value(&cfg) else {
            continue;
        };
        let Some(entry) = val.as_object() else {
            continue;
        };
        if let Some(sdk) = server_from_opencode_entry(entry) {
            out.insert(name.clone(), sdk);
        }
    }
    out
}

/// Assemble every MCP server a cursor session should see. Missing or malformed
/// files contribute nothing rather than failing the attach.
pub fn assemble(worktree: &str, mcp_config_path: Option<&Path>) -> McpServers {
    // Device servers first — the machine's own tools, in the same shape as a
    // workspace config. They used to be copied into every workspace, which is
    // why a workspace entry of the same name still overwrites them below.
    let mut out = read_json(&crate::config::device_mcp::device_mcp_file())
        .map(|v| servers_from_opencode_value(&v))
        .unwrap_or_default();
    // Team servers next, so a same-named workspace entry overwrites them below.
    // Local override beats the team's copy.
    for (name, cfg) in crate::config::team_mcp::onboarded_team_id()
        .map(|id| crate::runtime::team_cloud_config::team_cloud_mcp_file(&id))
        .and_then(|p| read_json(&p))
        .map(|v| servers_from_team_cloud_value(&v))
        .unwrap_or_default()
    {
        out.insert(name, cfg);
    }
    for (name, cfg) in read_json(&Path::new(worktree).join("opencode.json"))
        .map(|v| servers_from_opencode_value(&v))
        .unwrap_or_default()
    {
        out.insert(name, cfg);
    }
    // remote-tools is daemon-owned; it wins over a same-named workspace entry.
    if let Some(extra) = mcp_config_path
        .and_then(read_json)
        .map(|v| servers_from_mcp_config_value(&v))
    {
        for (name, cfg) in extra {
            out.insert(name, cfg);
        }
    }
    out
}

/// Stamp session-scoped TeamClu MCP tools with an explicit cloud session id for
/// this query/agent. Used by Claude/Cursor bridges where each SDK session gets
/// its own `mcpServers` config.
pub fn stamp_managed_session_context(servers: &mut McpServers, teamclu_session_id: &str) {
    let id = teamclu_session_id.trim();
    if id.is_empty() {
        return;
    }
    for name in ["teamclu-introspect", "teamclaw-introspect"] {
        let Some(server) = servers.get_mut(name) else {
            continue;
        };
        let Some(obj) = server.as_object_mut() else {
            continue;
        };
        let env = obj
            .entry("env")
            .or_insert_with(|| json!({}))
            .as_object_mut();
        let Some(env) = env else {
            continue;
        };
        env.insert(
            teamclu_runtime_env::TEAMCLU_SESSION_ID_ENV.to_string(),
            json!(id),
        );
        env.insert(
            teamclu_runtime_env::TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID_ENV.to_string(),
            json!("1"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_local_server_maps_to_stdio_command_and_args() {
        let root = json!({
            "mcp": {
                "ctx7": {
                    "type": "local",
                    "command": ["npx", "-y", "ctx7-mcp"],
                    "environment": { "TOKEN": "t" }
                }
            }
        });
        let servers = servers_from_opencode_value(&root);
        assert_eq!(
            servers.get("ctx7"),
            Some(&json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "ctx7-mcp"],
                "env": { "TOKEN": "t" }
            }))
        );
    }

    #[test]
    fn opencode_remote_server_maps_to_http() {
        let root = json!({
            "mcp": { "r": { "type": "remote", "url": "https://x/mcp",
                            "headers": { "Authorization": "Bearer t" } } }
        });
        assert_eq!(
            servers_from_opencode_value(&root).get("r"),
            Some(&json!({
                "type": "http",
                "url": "https://x/mcp",
                "headers": { "Authorization": "Bearer t" }
            }))
        );
    }

    #[test]
    fn disabled_and_malformed_servers_are_dropped() {
        let root = json!({
            "mcp": {
                "off": { "command": ["x"], "enabled": false },
                "no-command": { "type": "local" },
                "empty-command": { "command": [] },
                "non-string-args": { "command": ["x", 3] },
                "remote-no-url": { "type": "remote" }
            }
        });
        assert!(servers_from_opencode_value(&root).is_empty());
    }

    #[test]
    fn remote_tools_host_config_maps_to_stdio() {
        let root = json!({
            "mcpServers": {
                "amuxd-remote-tools": {
                    "command": "/usr/local/bin/amuxd",
                    "args": ["remote-tools-mcp", "--sock=/tmp/amuxd.sock"]
                }
            }
        });
        assert_eq!(
            servers_from_mcp_config_value(&root).get("amuxd-remote-tools"),
            Some(&json!({
                "type": "stdio",
                "command": "/usr/local/bin/amuxd",
                "args": ["remote-tools-mcp", "--sock=/tmp/amuxd.sock"]
            }))
        );
        assert!(servers_from_mcp_config_value(&json!({})).is_empty());
    }

    /// `assemble` reads `~/.amuxd/mcp.json`, so every test that calls it needs an
    /// isolated home or this machine's own device servers show up in the result.
    fn isolate_home() -> (crate::test_brand_env::BrandEnvGuard, tempfile::TempDir) {
        let home = tempfile::tempdir().unwrap();
        let guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        (guard, home)
    }

    #[test]
    fn assemble_merges_both_sources_with_remote_tools_winning() {
        let _iso = isolate_home();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"mcp":{"ws":{"command":["ws-bin"]},
                      "amuxd-remote-tools":{"command":["stale"]}}}"#,
        )
        .unwrap();
        let host = dir.path().join("remote-tools-host.json");
        std::fs::write(
            &host,
            r#"{"mcpServers":{"amuxd-remote-tools":{"command":"amuxd","args":["remote-tools-mcp"]}}}"#,
        )
        .unwrap();

        let servers = assemble(&dir.path().to_string_lossy(), Some(&host));
        assert_eq!(servers.len(), 2);
        assert_eq!(servers["ws"]["command"], json!("ws-bin"));
        assert_eq!(servers["amuxd-remote-tools"]["command"], json!("amuxd"));
    }

    #[test]
    fn assemble_tolerates_missing_files() {
        let _iso = isolate_home();
        let dir = tempfile::tempdir().unwrap();
        assert!(assemble(&dir.path().to_string_lossy(), None).is_empty());
        assert!(assemble("/nonexistent/worktree", Some(Path::new("/nope.json"))).is_empty());
    }

    #[test]
    fn team_cloud_value_includes_remote_url() {
        let root = json!({
            "mcpServers": {
                "stdio": { "command": "npx", "args": ["-y", "x"] },
                "remote": { "url": "https://example.invalid/mcp" }
            }
        });
        let servers = servers_from_team_cloud_value(&root);
        assert_eq!(servers["stdio"]["command"], json!("npx"));
        assert_eq!(servers["remote"]["type"], json!("http"));
        assert_eq!(
            servers["remote"]["url"],
            json!("https://example.invalid/mcp")
        );
    }

    #[test]
    fn stamp_managed_session_context_sets_teamclu_introspect_env() {
        let mut servers = Map::new();
        servers.insert(
            "teamclu-introspect".into(),
            json!({
                "type": "stdio",
                "command": "teamclu-introspect",
                "args": []
            }),
        );
        stamp_managed_session_context(&mut servers, "sess-abc");
        let env = servers["teamclu-introspect"]["env"].as_object().unwrap();
        assert_eq!(env["TEAMCLU_SESSION_ID"], "sess-abc");
        assert_eq!(env["TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID"], "1");
    }

    #[test]
    fn stamp_managed_session_context_preserves_existing_env_and_legacy_name() {
        let mut servers = Map::new();
        servers.insert(
            "teamclaw-introspect".into(),
            json!({
                "type": "stdio",
                "command": "teamclu-introspect",
                "env": { "FOO": "bar" }
            }),
        );
        stamp_managed_session_context(&mut servers, "sess-legacy");
        let env = servers["teamclaw-introspect"]["env"].as_object().unwrap();
        assert_eq!(env["FOO"], "bar");
        assert_eq!(env["TEAMCLU_SESSION_ID"], "sess-legacy");
    }

    #[test]
    fn stamp_managed_session_context_creates_env_object_when_missing() {
        let mut servers = Map::new();
        servers.insert(
            "teamclu-introspect".into(),
            json!({
                "type": "stdio",
                "command": "teamclu-introspect"
            }),
        );
        stamp_managed_session_context(&mut servers, "sess-new");
        assert!(servers["teamclu-introspect"]["env"].is_object());
    }

    #[test]
    fn stamp_managed_session_context_skips_non_object_server_entries() {
        let mut servers = Map::new();
        servers.insert("teamclu-introspect".into(), json!("not-an-object"));
        stamp_managed_session_context(&mut servers, "sess-x");
        assert_eq!(servers["teamclu-introspect"], "not-an-object");
    }
}
