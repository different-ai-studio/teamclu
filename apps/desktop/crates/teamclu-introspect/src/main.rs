mod apps;
mod capabilities;
mod channels;
mod config;
mod cron;
mod daemon_http;
mod daemon_sock;
mod desktop_api;
mod env_vars;
mod mcp;
mod participants;
mod roles;
mod send;
mod session;
mod skills;
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
            "description": "Create, pause, resume, delete, list, or inspect cron jobs. New jobs are stored as Global tasks (the default settings list). The TeamClu desktop app must be running.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["create", "list", "pause", "resume", "delete", "run", "get_runs"]
                    },
                    "scope": {
                        "type": "string",
                        "description": "Where to store the job. Defaults to 'global' (the default settings list). Use 'workspace' only for jobs that must run in a specific project folder.",
                        "enum": ["global", "workspace"]
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
            "description": "List the team's Skills catalog, install/uninstall a team Skill for this Agent, or edit the local working copy draft of an installed team Skill. Draft edits affect only this machine until published from the team Skills page; new sessions pick up draft changes, the current session keeps its prior content. get_draft returns SKILL.md plus a file listing (no sidecar bodies). Use read_draft_file with a specific path to fetch a chunk. Then update_draft with expectedDigest; content is optional when only files or deleteFiles change. Cannot target another Actor and cannot manage MCP servers.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "install", "uninstall", "get_draft", "read_draft_file", "update_draft"]
                    },
                    "slug": { "type": "string", "description": "Required except for list." },
                    "version": { "type": "integer", "minimum": 1, "description": "Required for install." },
                    "path": {
                        "type": "string",
                        "description": "Skill-relative file path. Required for read_draft_file (e.g. scripts/run.py or SKILL.md)."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Byte offset for read_draft_file. Defaults to 0."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Max bytes for read_draft_file. Defaults to 16384, capped at 32768."
                    },
                    "content": {
                        "type": "string",
                        "description": "Full SKILL.md with YAML frontmatter. Optional on update_draft when patching files or deleteFiles only."
                    },
                    "files": {
                        "type": "array",
                        "description": "Optional files to add or replace under the skill root on update_draft.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string" },
                                "content": { "type": "string" },
                                "encoding": { "type": "string", "enum": ["utf8", "base64"] }
                            },
                            "required": ["path", "content"]
                        }
                    },
                    "deleteFiles": {
                        "type": "array",
                        "description": "Relative paths to remove explicitly on update_draft.",
                        "items": { "type": "string" }
                    },
                    "expectedDigest": {
                        "type": "string",
                        "description": "Required. Optimistic concurrency digest (sha256:...) from get_draft."
                    }
                },
                "required": ["action"],
                "allOf": [
                    {
                        "if": { "properties": { "action": { "const": "update_draft" } } },
                        "then": { "required": ["slug", "expectedDigest"] }
                    },
                    {
                        "if": { "properties": { "action": { "const": "read_draft_file" } } },
                        "then": { "required": ["slug", "path"] }
                    }
                ]
            }
        },
        {
            "name": "manage_skills",
            "description": "Create, update, or read a personal reusable skill stored under ~/.agents/skills/<slug>/. Use this for normal skills shared across OpenCode, Pi, and Claude Code. For installed team Skills use manage_team_skills get_draft/update_draft instead. Do not write skills directly to .opencode/skills, .pi/skills, or .claude/skills.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "update", "get"],
                        "description": "The action to perform."
                    },
                    "slug": {
                        "type": "string",
                        "description": "Skill directory name (lowercase letters, digits, hyphens). Required for all actions."
                    },
                    "content": {
                        "type": "string",
                        "description": "Full SKILL.md content with YAML frontmatter (name must match slug). Required for create and update."
                    },
                    "files": {
                        "type": "array",
                        "description": "Optional files to add or replace under the skill root. Omitted paths are preserved on update.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string" },
                                "content": { "type": "string" },
                                "encoding": { "type": "string", "enum": ["utf8"] }
                            },
                            "required": ["path", "content"]
                        }
                    },
                    "deleteFiles": {
                        "type": "array",
                        "description": "Relative paths to remove explicitly on update.",
                        "items": { "type": "string" }
                    },
                    "expectedDigest": {
                        "type": "string",
                        "description": "Optimistic concurrency digest (sha256:...) from a prior get/create."
                    }
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
        },
        {
            "name": "export_pi_transcript",
            "description": "Export the complete pi session transcript (what the model actually saw: messages, tool calls, results) for analysis. Talks to local amuxd — the desktop app does not need to be running. Writes a JSON file under the workspace and returns the path; Read that file. Do not paste the whole transcript into chat. Omit session_id to use the current TeamClu session. Secrets are redacted by default.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Cloud session UUID. Optional — omit to export the current TeamClu session."
                    },
                    "workspace_id": {
                        "type": "string",
                        "description": "Optional daemon workspace id when the session has more than one pi binding. Omit to export every local binding."
                    },
                    "sanitize": {
                        "type": "boolean",
                        "description": "Redact JWTs, API keys, and huge inline blobs. Defaults to true."
                    },
                    "output_path": {
                        "type": "string",
                        "description": "Optional workspace-relative or absolute path for the JSON file. Must stay inside the workspace. Defaults to .teamclu/exports/pi-transcript-<session_id>.json."
                    }
                }
            }
        },
        {
            "name": "manage_app",
            "description": "Work with a TeamClu app: list this team's apps, read one's status, deploy it, or read the deployed app's logs. `deploy` runs the full publish (build the checkout on the local machine, upload it, put it live) and PUBLISHES TO THE PUBLIC INTERNET — an app whose auth_mode is \"none\" is readable by anyone with the URL. `logs` reads what the running app printed, which is how you find out why it 500s. Requires the TeamClu desktop app to be running and signed in; the user's own permissions apply (deploying needs admin on the app).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "status", "deploy", "logs"],
                        "description": "list: this team's apps. status: one app, plus where its checkout is on this machine. deploy: build and publish. logs: the deployed app's own output."
                    },
                    "app_id": { "type": "string", "description": "The app's UUID. Give this or app_name (not both); not needed for list." },
                    "app_name": { "type": "string", "description": "The app's name, when it identifies exactly one app in this team." },
                    "since_minutes": { "type": "integer", "description": "logs: how far back to read. Default 30, max 10080 (7 days)." },
                    "limit": { "type": "integer", "description": "logs: how many entries. Default 100, max 200." },
                    "kind": {
                        "type": "string",
                        "enum": ["app", "request", "all"],
                        "description": "logs: `app` is what the app printed (default), `request` is one line per HTTP request with status and duration, `all` is both."
                    },
                    "contains": { "type": "string", "description": "logs: only entries whose message contains this text." },
                    "request_id": { "type": "string", "description": "logs: only entries from this request id — the way to see one failing request end to end." }
                },
                "required": ["action"]
            }
        },
        {
            "name": "manage_app_data",
            "description": "Read and edit the rows in a deployed app's own database — its real production data. Use it to check what the app actually stored, or to fix one bad row. Reads need `prompt` permission on the app and writes need `admin`; only apps with a database (data_app) that have been deployed have one. Writes address exactly one row by primary key; there is no bulk update or delete.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["tables", "rows", "update_row", "delete_row"],
                        "description": "tables: what tables exist, with their columns and primary key. rows: one page of rows. update_row / delete_row: change exactly one row."
                    },
                    "app_id": { "type": "string", "description": "The app's UUID. Give this or app_name, not both." },
                    "app_name": { "type": "string", "description": "The app's name, when it identifies exactly one app in this team." },
                    "table": { "type": "string", "description": "Table name, as reported by action \"tables\". Required for everything but tables." },
                    "limit": { "type": "integer", "description": "rows: page size. Default 50, max 100." },
                    "after": { "type": "string", "description": "rows: the previous page's next_cursor. Omit for the first page." },
                    "direction": { "type": "string", "enum": ["asc", "desc"], "description": "rows: order along the primary key. Default asc." },
                    "filter_column": { "type": "string", "description": "rows: column to filter on. Give with filter_op." },
                    "filter_op": { "type": "string", "enum": ["eq", "contains", "isNull", "notNull"], "description": "rows: how to compare." },
                    "filter_value": { "type": "string", "description": "rows: the value to compare against. Ignored by isNull / notNull." },
                    "key": {
                        "type": "object",
                        "description": "update_row / delete_row: the row's primary-key columns and values, e.g. {\"id\": 42}. Read them off the row you got from action \"rows\".",
                        "additionalProperties": true
                    },
                    "row_key": { "type": "string", "description": "Alternative to `key`: the opaque row key form, if you already have one." },
                    "patch": {
                        "type": "object",
                        "description": "update_row: column → new value. Primary-key columns cannot be changed here.",
                        "additionalProperties": true
                    }
                },
                "required": ["action"]
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
    enforce_tool_budget(text, false)
}

fn tool_err(text: &str) -> Value {
    enforce_tool_budget(text, true)
}

/// Last-resort cap so any introspect tool that inlines too much still cannot
/// blow the model context. get_draft itself stays under 64 KiB; this fuse is
/// 128 KiB and returns a structured envelope instead of slicing JSON.
const MAX_TOOL_RESULT_BYTES: usize = 128 * 1024;

fn tool_payload(text: &str, is_error: bool) -> Value {
    if is_error {
        json!({
            "content": [{"type": "text", "text": text}],
            "isError": true
        })
    } else {
        json!({
            "content": [{"type": "text", "text": text}]
        })
    }
}

fn enforce_tool_budget(text: &str, is_error: bool) -> Value {
    let candidate = tool_payload(text, is_error);
    let encoded = serde_json::to_vec(&candidate).unwrap_or_default();
    if encoded.len() <= MAX_TOOL_RESULT_BYTES {
        return candidate;
    }
    let envelope = json!({
        "truncated": true,
        "reason": "response_budget_exceeded",
        "originalBytes": encoded.len(),
        "hint": "Use a narrower query or read_draft_file with a specific path"
    });
    let text = serde_json::to_string(&envelope).unwrap_or_default();
    tool_payload(&text, true)
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
                "manage_skills" => match skills::handle(workspace, sock, &arguments).await {
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
                "export_pi_transcript" => {
                    match session::export_pi_transcript(workspace, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_app" => match apps::handle_manage(api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
                "manage_app_data" => match apps::handle_data(api_port, &arguments).await {
                    Ok(v) => {
                        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                        tool_ok(&text)
                    }
                    Err(e) => tool_err(&e),
                },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_ok_leaves_small_payloads_alone() {
        let ok = tool_ok("hello");
        assert_eq!(ok["content"][0]["text"], "hello");
        assert!(ok.get("isError").is_none());
    }

    #[test]
    fn tool_ok_returns_structured_envelope_when_over_budget() {
        let big = "x".repeat(MAX_TOOL_RESULT_BYTES + 100);
        let ok = tool_ok(&big);
        let text = ok["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["truncated"], true);
        assert_eq!(parsed["reason"], "response_budget_exceeded");
        assert!(parsed["originalBytes"].as_u64().unwrap() > MAX_TOOL_RESULT_BYTES as u64);
        assert!(parsed["hint"].as_str().unwrap().contains("read_draft_file"));
        assert_eq!(ok["isError"], true);
        assert!(
            serde_json::to_vec(&ok).unwrap().len() < MAX_TOOL_RESULT_BYTES,
            "envelope itself must fit the budget"
        );
        assert!(!text.contains(&"x".repeat(64)));
    }

    #[test]
    fn tool_err_also_uses_structured_envelope() {
        let big = "y".repeat(MAX_TOOL_RESULT_BYTES + 8);
        let err = tool_err(&big);
        let text = err["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("response_budget_exceeded"));
        assert_eq!(err["isError"], true);
    }
}
