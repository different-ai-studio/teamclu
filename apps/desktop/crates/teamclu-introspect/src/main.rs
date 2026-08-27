mod capabilities;
mod channels;
mod config;
mod daemon_sock;
mod cron;
mod env_vars;
mod mcp;
mod participants;
mod roles;
mod send;
mod session;
mod sync;
mod team_skills;

use clap::Parser;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Default port of the internal TeamClu introspect HTTP API (must match
/// `commands::introspect_api::INTROSPECT_API_PORT` in the desktop crate).
const DEFAULT_INTROSPECT_API_PORT: u16 = 13144;

#[derive(Parser, Debug)]
#[command(
    name = "teamclu-introspect",
    about = "TeamClu MCP introspection server"
)]
struct Args {
    /// Path to the TeamClu workspace directory
    #[arg(long, default_value = ".")]
    workspace: String,

    /// Port of the local TeamClu API server
    #[arg(long, default_value_t = 1420)]
    api_port: u16,

    /// amuxd control socket. Used for token-addressed sends, which only the
    /// daemon can route — and which must keep working with no desktop app,
    /// as on a cron run. Defaults to `<amuxd home>/run/amuxd.sock`.
    #[arg(long, default_value = "")]
    sock: String,

}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!([
        {
            "name": "get_my_capabilities",
            "description": "Query the AI agent's configured capabilities including channels, role, team members, environment variables, team info, and cron jobs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Optional category filter",
                        "enum": ["channels", "role", "team_members", "env_vars", "team_info", "cron_jobs"]
                    }
                }
            }
        },
        {
            "name": "send_channel_message",
            "description": "Send a text and/or file to a chat. Two ways to address it: pass `reply_token` \
    to answer the chat you are already talking to — the token comes from this run's prompt and is the only \
    way to reply during an unattended run such as a scheduled job — or pass `channel` (plus `target`) to \
    send somewhere specific. Use this when you have generated a file, or want to follow up without waiting \
    to be asked.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "reply_token": {
                        "type": "string",
                        "description": "Reply token from this chat's prompt. Identifies the destination, so `channel` and `target` are not needed; pass them only to narrow the destination within that chat."
                    },
                    "channel": {
                        "type": "string",
                        "description": "The channel to send through, or 'all' to broadcast to all configured channels.",
                        "enum": ["all", "wecom", "discord", "email", "feishu", "kook", "wechat", "seatalk"]
                    },
                    "message": {
                        "type": "string",
                        "description": "The message text to send. Can be empty if sending an image only."
                    },
                    "target": {
                        "type": "string",
                        "description": "Target recipient within the channel. Format varies by channel: wecom: 'single:<userid>' or 'group:<chatid>' (default: single); discord: 'dm:<user_id>' or 'channel:<channel_id>'; feishu: open_id (ou_xxx), user_id (on_xxx), or chat_id (oc_xxx); kook: 'dm:<user_id>' or 'channel:<channel_id>'; wechat: user identifier. If omitted for wecom, sends to the last active conversation."
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to a media file to send. The file will be uploaded and sent natively. Type is auto-detected from extension: image (jpg/png/gif/webp), voice (mp3/amr/wav), video (mp4/mov), or file (any other)."
                    }
                },
                "anyOf": [{ "required": ["reply_token"] }, { "required": ["channel"] }]
            }
        },
        {
            "name": "manage_cron_job",
            "description": "Create, pause, resume, delete, or inspect cron jobs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["create", "pause", "resume", "delete", "run", "get_runs"]
                    },
                    "job_id": {
                        "type": "string",
                        "description": "The cron job ID (required for pause/resume/delete/run/get_runs)."
                    },
                    "name": {
                        "type": "string",
                        "description": "Job name (required for create)."
                    },
                    "description": {
                        "type": "string",
                        "description": "Human-readable description of what the job does."
                    },
                    "schedule": {
                        "description": "Schedule for the job (required for create). A plain string is treated as a 5-field cron expression, e.g. '0 9 * * 1-5'. For one-time or interval jobs, pass an object such as {\"kind\":\"at\",\"at\":\"2026-05-07T09:00:00Z\"}, {\"kind\":\"every\",\"everyMs\":3600000}, or {\"kind\":\"cron\",\"expr\":\"0 9 * * 1-5\",\"tz\":\"Asia/Shanghai\"}.",
                        "anyOf": [
                            { "type": "string" },
                            {
                                "type": "object",
                                "properties": {
                                    "kind": { "type": "string", "enum": ["at", "every", "cron"] },
                                    "at": { "type": "string" },
                                    "everyMs": { "type": "integer" },
                                    "expr": { "type": "string" },
                                    "tz": { "type": "string" }
                                },
                                "required": ["kind"]
                            }
                        ]
                    },
                    "message": {
                        "type": "string",
                        "description": "Message or prompt to execute on each run (required for create)."
                    },
                    "delivery": {
                        "type": "object",
                        "description": "Optional delivery settings for cron results.",
                        "properties": {
                            "mode": { "type": "string", "enum": ["announce", "none"] },
                            "channel": { "type": "string", "enum": ["discord", "feishu", "email", "kook", "wechat", "wecom"] },
                            "to": { "type": "string" },
                            "bestEffort": { "type": "boolean" }
                        },
                        "required": ["mode", "channel", "to"]
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "sync_team_dir",
            "description": "Sync the shared team directory. Pulls remote Git changes, pushes local changes, and returns a summary.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "manage_roles",
            "description": "Manage AI agent roles: list available roles, create a new role, update an existing role, or delete one. Roles are defined by a name, description, and working style.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "create", "update", "delete"],
                        "description": "The action to perform."
                    },
                    "slug": {
                        "type": "string",
                        "description": "Role identifier (directory name). Required for update/delete. Auto-generated from name if omitted for create."
                    },
                    "name": {
                        "type": "string",
                        "description": "Display name for the role (required for create)."
                    },
                    "description": {
                        "type": "string",
                        "description": "Short description of what this role does."
                    },
                    "working_style": {
                        "type": "string",
                        "description": "Working style instructions for the role."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_env_vars",
            "description": "Manage environment variables: list registered keys (no values returned), set a key-value pair, or delete a key. Values are stored securely in the system keychain.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "set", "delete"],
                        "description": "The action to perform."
                    },
                    "key": {
                        "type": "string",
                        "description": "The environment variable name (required for set/delete)."
                    },
                    "value": {
                        "type": "string",
                        "description": "The value to store (required for set). Never returned by list."
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional description for the env var (used for set)."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_channels",
            "description": "View or update message channel configuration (WeCom, Discord, Feishu, Email, KOOK, WeChat). Use 'get' to check what's configured (sensitive values are redacted). Use 'set' to configure a channel with the provided fields.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["get", "set"],
                        "description": "The action to perform."
                    },
                    "channel": {
                        "type": "string",
                        "enum": ["wecom", "discord", "feishu", "email", "kook", "wechat", "seatalk"],
                        "description": "Target channel. Required for set; optional for get (omit to get all channels)."
                    },
                    "config": {
                        "type": "object",
                        "description": "Channel config fields to set. Required for set. Fields vary by channel:\n- wecom: botId, secret, encodingAesKey, ownerId\n- discord: token, dm, guilds\n- feishu: appId, appSecret, chats\n- email: provider, gmailEmail, gmailClientId, gmailClientSecret (or imapServer, smtpServer, username, password for custom)\n- kook: token, dm, guilds\n- wechat: botToken, accountId, baseUrl"
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_mcp",
            "description": "Manage MCP servers for this workspace: list configured servers, get one by name, add/update a local (stdio) or remote (HTTP) server, enable/disable, or remove a custom server. Built-in servers (teamclu-introspect, playwright, chrome-control, autoui) cannot be deleted; team-shared servers under teamclu-team/.mcp cannot be edited or deleted here. Env/header secret values are redacted on list/get. Changes require an agent runtime restart to take effect.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "get", "add", "update", "remove", "enable", "disable"],
                        "description": "The action to perform."
                    },
                    "name": {
                        "type": "string",
                        "description": "MCP server name. Required for get/add/update/remove/enable/disable."
                    },
                    "type": {
                        "type": "string",
                        "enum": ["local", "remote"],
                        "description": "Server kind. Required for add; optional for update."
                    },
                    "command": {
                        "description": "Local stdio command as an argv array, or a whitespace-separated string (e.g. 'npx -y @modelcontextprotocol/server-filesystem /tmp'). Required for add when type=local.",
                        "anyOf": [
                            { "type": "string" },
                            { "type": "array", "items": { "type": "string" } }
                        ]
                    },
                    "environment": {
                        "type": "object",
                        "description": "Environment variables for local servers (string values).",
                        "additionalProperties": { "type": "string" }
                    },
                    "url": {
                        "type": "string",
                        "description": "Base URL for remote HTTP MCP servers. Required for add when type=remote."
                    },
                    "headers": {
                        "type": "object",
                        "description": "HTTP headers for remote servers (string values).",
                        "additionalProperties": { "type": "string" }
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Whether the server is enabled (default true on add)."
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Optional timeout in milliseconds."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "get_session_deeplink",
            "description": "Export a shareable deep link that opens a TeamClu session in the desktop or mobile app. Returns a URL like teamclu://session/<uuid>. When session_id is omitted, daemon-managed agent runtimes inject the current session automatically; standalone CLI may use TEAMCLU_SESSION_ID (legacy workspace active-session-id fallback is deprecated).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Cloud session UUID to link to. Optional — omit to use the current TeamClu session."
                    },
                    "scheme": {
                        "type": "string",
                        "description": "Optional URL scheme override (defaults to teamclu, or TEAMCLU_APP_SCHEME env var for white-label builds)."
                    }
                }
            }
        },
        {
            "name": "manage_participants",
            "description": "Read the roster of a TeamClu session, and pull people into it or take them out. Requires the desktop app to be running and the user to be signed in. When session_id is omitted, daemon-managed agent runtimes inject the current session automatically; standalone CLI may use TEAMCLU_SESSION_ID (legacy workspace active-session-id fallback is deprecated). Actions: 'list' (the full roster, people and agents), 'list_candidates' (people who can be added, excluding those already present), 'add', 'remove'. add/remove handle HUMAN MEMBERS ONLY — agents are joined from the app's session member sheet, which also starts their runtime; asking for one here is refused rather than half-done. Adding someone makes the session, including its history, visible to them, so the target is never guessed: pass actor_id, or a name that matches exactly one person. A name matching none or several comes back as the candidate list instead of a write.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "list_candidates", "add", "remove"],
                        "description": "What to do with the roster."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Cloud session UUID. Optional — omit to act on the current TeamClu session."
                    },
                    "actor_id": {
                        "type": "string",
                        "description": "Actor UUID to add or remove. Use this when you have the id from 'list' or 'list_candidates'."
                    },
                    "name": {
                        "type": "string",
                        "description": "Display name to add or remove, as an alternative to actor_id. Must match exactly one actor in the team; otherwise the candidate list is returned and nothing is written."
                    }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_team_skills",
            "description": "List the team's Skills catalog, or install/uninstall a team Skill for this Agent only. Cannot target another Actor and cannot manage MCP servers.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "install", "uninstall"] },
                    "slug": { "type": "string", "description": "Required for install/uninstall." },
                    "version": { "type": "integer", "minimum": 1, "description": "Required for install." }
                },
                "required": ["action"]
            }
        },
        {
            "name": "archive_session",
            "description": "Archive a TeamClu cloud session (soft-hide from the active session list). Requires the desktop app to be running and the user to be signed in. When session_id is omitted, daemon-managed agent runtimes inject the current session automatically; standalone CLI may use TEAMCLU_SESSION_ID (legacy workspace active-session-id fallback is deprecated).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Cloud session UUID to archive. Optional — omit to archive the current TeamClu session."
                    },
                    "archived_at": {
                        "type": "string",
                        "description": "Optional ISO-8601 timestamp for archivedAt. Defaults to now."
                    }
                }
            }
        }
    ])
}

// ---------------------------------------------------------------------------
// MCP response helpers
// ---------------------------------------------------------------------------

fn mcp_result(id: &Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn tool_ok(text: &str) -> Value {
    json!({
        "content": [{"type": "text", "text": text}]
    })
}

fn tool_err(text: &str) -> Value {
    json!({
        "content": [{"type": "text", "text": text}],
        "isError": true
    })
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async fn handle_request(
    req: &Value,
    workspace: &str,
    api_port: u16,
    sock: &std::path::Path,
) -> Option<Value> {
    let method = req.get("method")?.as_str()?;
    let id = req.get("id").cloned().unwrap_or(Value::Null);

    match method {
        // Notifications — no response needed
        "notifications/initialized" | "notifications/cancelled" => None,

        "initialize" => {
            let params = req.get("params");
            let client_info = params.and_then(|p| p.get("clientInfo"));
            eprintln!(
                "[introspect] initialize from {:?}",
                client_info
                    .and_then(|c| c.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown")
            );

            Some(mcp_result(
                &id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "teamclu-introspect",
                        "version": "0.1.0"
                    }
                }),
            ))
        }

        "tools/list" => Some(mcp_result(&id, json!({ "tools": tool_definitions() }))),

        "tools/call" => {
            let params = match req.get("params") {
                Some(p) => p,
                None => return Some(mcp_error(&id, -32602, "Missing params")),
            };
            let tool_name = match params.get("name").and_then(|n| n.as_str()) {
                Some(n) => n,
                None => return Some(mcp_error(&id, -32602, "Missing tool name")),
            };
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

            let tool_result = match tool_name {
                "get_my_capabilities" => match capabilities::handle(workspace, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "send_channel_message" => {
                    match send::handle(workspace, api_port, sock, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_cron_job" => match cron::handle(workspace, api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "sync_team_dir" => match sync::handle(workspace, api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "manage_roles" => match roles::handle(workspace, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "manage_env_vars" => {
                    match env_vars::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_channels" => {
                    match channels::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_mcp" => match mcp::handle(workspace, api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "get_session_deeplink" => match session::handle(workspace, &arguments) {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "manage_participants" => {
                    match participants::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_team_skills" => match team_skills::handle(api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "archive_session" => {
                    match session::archive(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                unknown => tool_err(&format!("Unknown tool: {unknown}")),
            };

            Some(mcp_result(&id, tool_result))
        }

        unknown => {
            eprintln!("[introspect] Unknown method: {unknown}");
            Some(mcp_error(
                &id,
                -32601,
                &format!("Method not found: {unknown}"),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let workspace = args.workspace.clone();
    let api_port = args.api_port;
    let sock = daemon_sock::resolve_sock_path(&args.sock);

    eprintln!(
        "[introspect] Starting MCP server (workspace={}, api_port={})",
        workspace, api_port
    );

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[introspect] stdin read error: {e}");
                break;
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[introspect] JSON parse error: {e}");
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {"code": -32700, "message": format!("Parse error: {e}")}
                });
                let mut out = stdout.lock();
                let _ = writeln!(out, "{}", err_resp);
                let _ = out.flush();
                continue;
            }
        };

        if let Some(response) = handle_request(&req, &workspace, api_port, &sock).await {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{}", response);
            let _ = out.flush();
        }
    }

    eprintln!("[introspect] stdin closed, exiting");
}
