use serde_json::{json, Map, Value};

/// MCP names TeamClu auto-injects — cannot be deleted via this tool.
const INHERENT_MCP_NAMES: &[&str] = &[
    "playwright",
    "chrome-control",
    "autoui",
    "teamclu-introspect",
];

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        "list" => list_servers(workspace, api_port).await,
        "get" => {
            let name = require_name(arguments)?;
            get_server(workspace, api_port, name).await
        }
        "add" => add_server(workspace, api_port, arguments).await,
        "update" => update_server(workspace, api_port, arguments).await,
        "remove" | "delete" => {
            let name = require_name(arguments)?;
            remove_server(workspace, api_port, name).await
        }
        "enable" => set_enabled(workspace, api_port, require_name(arguments)?, true).await,
        "disable" => set_enabled(workspace, api_port, require_name(arguments)?, false).await,
        unknown => Err(format!(
            "Unknown action: '{unknown}'. Valid actions: list, get, add, update, remove, enable, disable"
        )),
    }
}

fn require_name(arguments: &Value) -> Result<&str, String> {
    arguments
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Missing field: name".to_string())
}

fn is_inherent(name: &str) -> bool {
    INHERENT_MCP_NAMES.contains(&name)
}

async fn fetch_servers(workspace: &str, api_port: u16) -> Result<Map<String, Value>, String> {
    let resp = post_api(api_port, "/mcp-get", &json!({ "workspace": workspace })).await?;
    resp.as_object()
        .cloned()
        .ok_or_else(|| "MCP get response is not an object".to_string())
}

async fn put_servers(
    workspace: &str,
    api_port: u16,
    servers: &Map<String, Value>,
) -> Result<Value, String> {
    post_api(
        api_port,
        "/mcp-put",
        &json!({
            "workspace": workspace,
            "servers": Value::Object(servers.clone()),
        }),
    )
    .await
}

async fn list_servers(workspace: &str, api_port: u16) -> Result<Value, String> {
    let servers = fetch_servers(workspace, api_port).await?;
    let mut out = Map::new();
    for (name, cfg) in servers {
        out.insert(name, redact_server(&cfg));
    }
    Ok(json!({
        "servers": out,
        "note": "Secret environment/header values are redacted. Mutations require an agent runtime restart to take effect."
    }))
}

async fn get_server(workspace: &str, api_port: u16, name: &str) -> Result<Value, String> {
    let servers = fetch_servers(workspace, api_port).await?;
    let cfg = servers
        .get(name)
        .ok_or_else(|| format!("MCP server '{name}' not found"))?;
    Ok(json!({
        "name": name,
        "config": redact_server(cfg),
    }))
}

async fn add_server(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let name = require_name(arguments)?;
    if is_inherent(name) {
        return Err(format!(
            "'{name}' is a built-in TeamClu MCP server and cannot be re-added. Use enable/disable or update instead."
        ));
    }

    let mut servers = fetch_servers(workspace, api_port).await?;
    if let Some(existing) = servers.get(name) {
        if source_of(existing) == Some("team") {
            return Err(format!(
                "'{name}' is a team-shared MCP server (managed under teamclu-team/.mcp). Cannot overwrite from here."
            ));
        }
        return Err(format!(
            "MCP server '{name}' already exists. Use action=update to modify it."
        ));
    }

    let config = build_config(arguments, None)?;
    servers.insert(name.to_string(), config);
    let outcome = put_servers(workspace, api_port, &servers).await?;
    Ok(json!({
        "ok": true,
        "action": "add",
        "name": name,
        "outcome": outcome.get("outcome").cloned().unwrap_or(json!("restart_required")),
        "note": "Restart the agent runtime for the new MCP server to become available."
    }))
}

async fn update_server(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let name = require_name(arguments)?;
    let mut servers = fetch_servers(workspace, api_port).await?;
    let existing = servers
        .get(name)
        .cloned()
        .ok_or_else(|| format!("MCP server '{name}' not found"))?;

    if source_of(&existing) == Some("team") {
        return Err(format!(
            "'{name}' is a team-shared MCP server (managed under teamclu-team/.mcp). Edit the team file and sync instead."
        ));
    }

    let config = if is_inherent(name) {
        patch_inherent(&existing, arguments)?
    } else {
        build_config(arguments, Some(&existing))?
    };
    servers.insert(name.to_string(), config);
    let outcome = put_servers(workspace, api_port, &servers).await?;
    Ok(json!({
        "ok": true,
        "action": "update",
        "name": name,
        "outcome": outcome.get("outcome").cloned().unwrap_or(json!("restart_required")),
        "note": "Restart the agent runtime for MCP changes to take effect."
    }))
}

async fn remove_server(workspace: &str, api_port: u16, name: &str) -> Result<Value, String> {
    if is_inherent(name) {
        return Err(format!(
            "'{name}' is a built-in TeamClu MCP server and cannot be deleted. Use disable instead."
        ));
    }

    let mut servers = fetch_servers(workspace, api_port).await?;
    let existing = servers
        .get(name)
        .ok_or_else(|| format!("MCP server '{name}' not found"))?;
    if source_of(existing) == Some("team") {
        return Err(format!(
            "'{name}' is a team-shared MCP server and cannot be deleted from the workspace. Remove it from teamclu-team/.mcp instead."
        ));
    }

    servers.remove(name);
    let outcome = put_servers(workspace, api_port, &servers).await?;
    Ok(json!({
        "ok": true,
        "action": "remove",
        "name": name,
        "outcome": outcome.get("outcome").cloned().unwrap_or(json!("restart_required")),
        "note": "Restart the agent runtime for MCP changes to take effect."
    }))
}

async fn set_enabled(
    workspace: &str,
    api_port: u16,
    name: &str,
    enabled: bool,
) -> Result<Value, String> {
    let mut servers = fetch_servers(workspace, api_port).await?;
    let mut existing = servers
        .get(name)
        .cloned()
        .ok_or_else(|| format!("MCP server '{name}' not found"))?;

    if source_of(&existing) == Some("team") {
        return Err(format!(
            "'{name}' is a team-shared MCP server (managed under teamclu-team/.mcp). Enable/disable it there."
        ));
    }

    if let Some(obj) = existing.as_object_mut() {
        obj.insert("enabled".to_string(), json!(enabled));
        // Drop API-only provenance before PUT.
        obj.remove("source");
    }
    servers.insert(name.to_string(), existing);
    let outcome = put_servers(workspace, api_port, &servers).await?;
    Ok(json!({
        "ok": true,
        "action": if enabled { "enable" } else { "disable" },
        "name": name,
        "enabled": enabled,
        "outcome": outcome.get("outcome").cloned().unwrap_or(json!("restart_required")),
        "note": "Restart the agent runtime for MCP changes to take effect."
    }))
}

fn source_of(cfg: &Value) -> Option<&str> {
    cfg.get("source").and_then(|v| v.as_str())
}

/// Build a full config for add, or merge onto existing for update.
fn build_config(arguments: &Value, existing: Option<&Value>) -> Result<Value, String> {
    let server_type = arguments
        .get("type")
        .and_then(|v| v.as_str())
        .or_else(|| {
            existing
                .and_then(|e| e.get("type"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("local");

    if server_type != "local" && server_type != "remote" {
        return Err(format!(
            "Invalid type '{server_type}'. Valid types: local, remote"
        ));
    }

    let enabled = arguments
        .get("enabled")
        .and_then(|v| v.as_bool())
        .or_else(|| {
            existing
                .and_then(|e| e.get("enabled"))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true);

    let mut cfg = json!({
        "type": server_type,
        "enabled": enabled,
    });

    if server_type == "local" {
        let command = parse_command(arguments.get("command"))
            .or_else(|| {
                existing
                    .and_then(|e| e.get("command"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
            })
            .ok_or("Missing field: command (required for type=local)")?;
        if command.is_empty() {
            return Err("command must not be empty".to_string());
        }
        cfg["command"] = json!(command);

        if let Some(env) = arguments.get("environment") {
            if !env.is_object() {
                return Err("environment must be a JSON object of string values".to_string());
            }
            cfg["environment"] = env.clone();
        } else if let Some(env) = existing.and_then(|e| e.get("environment")) {
            if env.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                cfg["environment"] = env.clone();
            }
        }
    } else {
        let url = arguments
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                existing
                    .and_then(|e| e.get("url"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .ok_or("Missing field: url (required for type=remote)")?;
        cfg["url"] = json!(url);

        if let Some(headers) = arguments.get("headers") {
            if !headers.is_object() {
                return Err("headers must be a JSON object of string values".to_string());
            }
            cfg["headers"] = headers.clone();
        } else if let Some(headers) = existing.and_then(|e| e.get("headers")) {
            if headers.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                cfg["headers"] = headers.clone();
            }
        }
    }

    if let Some(timeout) = arguments
        .get("timeout")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            existing
                .and_then(|e| e.get("timeout"))
                .and_then(|v| v.as_u64())
        })
    {
        cfg["timeout"] = json!(timeout);
    }

    Ok(cfg)
}

/// Inherent servers: only `enabled` and `environment` may be patched.
fn patch_inherent(existing: &Value, arguments: &Value) -> Result<Value, String> {
    if arguments.get("type").is_some()
        || arguments.get("command").is_some()
        || arguments.get("url").is_some()
        || arguments.get("headers").is_some()
    {
        return Err(
            "Built-in MCP servers only support updating enabled and environment. Use enable/disable for on/off."
                .to_string(),
        );
    }

    let mut cfg = existing.clone();
    let obj = cfg
        .as_object_mut()
        .ok_or("existing config is not an object")?;
    obj.remove("source");

    if let Some(enabled) = arguments.get("enabled").and_then(|v| v.as_bool()) {
        obj.insert("enabled".to_string(), json!(enabled));
    }
    if let Some(env) = arguments.get("environment") {
        if !env.is_object() {
            return Err("environment must be a JSON object of string values".to_string());
        }
        if env.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            obj.remove("environment");
        } else {
            obj.insert("environment".to_string(), env.clone());
        }
    }
    Ok(cfg)
}

fn parse_command(value: Option<&Value>) -> Option<Vec<String>> {
    let value = value?;
    if let Some(arr) = value.as_array() {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        return if parts.is_empty() { None } else { Some(parts) };
    }
    if let Some(s) = value.as_str() {
        let parts: Vec<String> = s.split_whitespace().map(|p| p.to_string()).collect();
        return if parts.is_empty() { None } else { Some(parts) };
    }
    None
}

fn redact_server(cfg: &Value) -> Value {
    let mut out = cfg.clone();
    let Some(obj) = out.as_object_mut() else {
        return out;
    };
    if let Some(env) = obj.get_mut("environment").and_then(|v| v.as_object_mut()) {
        for (_k, v) in env.iter_mut() {
            if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                *v = json!("[set]");
            }
        }
    }
    if let Some(headers) = obj.get_mut("headers").and_then(|v| v.as_object_mut()) {
        for (_k, v) in headers.iter_mut() {
            if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                *v = json!("[set]");
            }
        }
    }
    out
}

async fn post_api(api_port: u16, path: &str, body: &Value) -> Result<Value, String> {
    crate::desktop_api::post(api_port, path, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_command_string_and_array() {
        assert_eq!(
            parse_command(Some(&json!(
                "npx -y @modelcontextprotocol/server-filesystem /tmp"
            ))),
            Some(vec![
                "npx".into(),
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                "/tmp".into()
            ])
        );
        assert_eq!(
            parse_command(Some(&json!(["node", "server.js"]))),
            Some(vec!["node".into(), "server.js".into()])
        );
        assert_eq!(parse_command(Some(&json!(""))), None);
    }

    #[test]
    fn build_config_local_requires_command() {
        let err = build_config(&json!({ "type": "local" }), None).unwrap_err();
        assert!(err.contains("command"));
    }

    #[test]
    fn build_config_remote_requires_url() {
        let err = build_config(&json!({ "type": "remote" }), None).unwrap_err();
        assert!(err.contains("url"));
    }

    #[test]
    fn build_config_local_ok() {
        let cfg = build_config(
            &json!({
                "type": "local",
                "command": ["npx", "-y", "foo"],
                "environment": { "TOKEN": "secret" }
            }),
            None,
        )
        .unwrap();
        assert_eq!(cfg["type"], "local");
        assert_eq!(cfg["enabled"], true);
        assert_eq!(cfg["command"][0], "npx");
        assert_eq!(cfg["environment"]["TOKEN"], "secret");
    }

    #[test]
    fn redact_hides_secrets() {
        let redacted = redact_server(&json!({
            "type": "local",
            "command": ["npx"],
            "environment": { "API_KEY": "super-secret" },
            "headers": { "Authorization": "Bearer x" }
        }));
        assert_eq!(redacted["environment"]["API_KEY"], "[set]");
        assert_eq!(redacted["headers"]["Authorization"], "[set]");
        assert_eq!(redacted["command"][0], "npx");
    }

    #[test]
    fn patch_inherent_rejects_command_change() {
        let existing = json!({
            "type": "local",
            "enabled": true,
            "command": ["npx", "playwright"],
            "source": "inherent"
        });
        let err = patch_inherent(&existing, &json!({ "command": ["evil"] })).unwrap_err();
        assert!(err.contains("Built-in"));
    }

    #[test]
    fn patch_inherent_allows_enabled() {
        let existing = json!({
            "type": "local",
            "enabled": false,
            "command": ["npx", "playwright"],
            "source": "inherent"
        });
        let patched = patch_inherent(&existing, &json!({ "enabled": true })).unwrap();
        assert_eq!(patched["enabled"], true);
        assert!(patched.get("source").is_none());
    }

    #[tokio::test]
    async fn unknown_action_errors() {
        let err = handle(".", 13144, &json!({ "action": "nope" }))
            .await
            .unwrap_err();
        assert!(err.contains("Unknown action"));
    }

    #[tokio::test]
    async fn remove_inherent_rejected_without_network() {
        // Validation runs before API calls for inherent names.
        let err = handle(
            ".",
            13144,
            &json!({ "action": "remove", "name": "teamclu-introspect" }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("built-in"));
    }
}
