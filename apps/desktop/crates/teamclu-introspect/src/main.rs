mod capabilities;
mod channel_state;
mod config;
mod cron;
mod daemon_http;
mod daemon_sock;
mod desktop_api;
mod env_vars;
mod knowledge;
mod participants;
mod send;
mod session;

use clap::Parser;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

#[derive(Parser, Debug)]
#[command(
    name = "teamclu-introspect",
    about = "TeamClu MCP introspection server",
    // ensure-*-sidecar probes `--version`; without this clap rejects the flag
    // (exit 2), readExecutableVersion returns null, and every tauri:dev pays
    // a cargo rebuild of a binary whose sources did not change.
    version
)]
struct Args {
    /// Path to the TeamClu workspace directory
    #[arg(long, default_value = ".")]
    workspace: String,

    /// Port of the desktop introspect API, used only when the desktop has
    /// not published one in `<amuxd home>/run/introspect.http.port`.
    #[arg(long, default_value_t = 13144)]
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
    let mut tools = json!([
        {
            "name": "get_my_capabilities",
            "description": "Query the AI agent's configured capabilities including channels, role, environment variables, team info, and cron jobs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Optional category filter",
                        "enum": ["channels", "role", "env_vars", "team_info", "cron_jobs"]
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
                        "enum": ["all", "wecom", "seatalk", "discord", "email", "feishu", "kook", "wechat"]
                    },
                    "message": {
                        "type": "string",
                        "description": "The message text to send. Can be empty if sending an image only."
                    },
                    "target": {
                        "type": "string",
                        "description": "Target recipient within the channel. Format varies by channel: wecom: 'single:<userid>' or 'group:<chatid>' (default: single); discord: 'dm:<user_id>' or 'channel:<channel_id>'; feishu: open_id (ou_xxx), user_id (on_xxx), or chat_id (oc_xxx); kook: 'dm:<user_id>' or 'channel:<channel_id>'; wechat: user identifier. Omit target when using reply_token to address this chat — an empty wecom target is not the current conversation."
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
        }
    ]);
    // The knowledge tools live with their handlers.
    if let Value::Array(list) = &mut tools {
        list.extend(knowledge::tool_definitions());
    }
    tools
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
                "get_my_capabilities" => {
                    match capabilities::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "send_channel_message" => {
                    match send::handle(workspace, api_port, sock, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
                "manage_env_vars" => {
                    match env_vars::handle(workspace, api_port, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
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
                "knowledge_search" | "knowledge_read" => {
                    match knowledge::handle(sock, tool_name, &arguments).await {
                        Ok(v) => {
                            let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                            tool_ok(&text)
                        }
                        Err(e) => tool_err(&e),
                    }
                }
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

/// How often a call that is still running tells the client so.
///
/// The MCP client in pi gives up on a request after 60 s of silence, and some
/// calls here legitimately take minutes — one waiting on a native approval
/// dialog, a long export. Progress notifications reset that clock (the client asks for them
/// by sending a `progressToken`), so a call stays alive exactly as long as it is
/// actually running, with no fixed cap that a slow build could outgrow.
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// The request's `params._meta.progressToken`, when the client sent one.
fn progress_token(req: &Value) -> Option<Value> {
    req.get("params")?
        .get("_meta")?
        .get("progressToken")
        .filter(|token| token.is_string() || token.is_number())
        .cloned()
}

/// `notifications/progress` for one heartbeat. MCP requires `progress` to grow
/// with every notification for a token; there is no total, the work has none.
fn progress_notification(token: &Value, progress: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/progress",
        "params": { "progressToken": token, "progress": progress }
    })
}

fn write_line(stdout: &std::sync::Mutex<std::io::Stdout>, message: &Value) {
    let mut out = stdout.lock().unwrap();
    let _ = writeln!(out, "{}", message);
    let _ = out.flush();
}

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
    let stdout = std::sync::Arc::new(std::sync::Mutex::new(std::io::stdout()));
    let reader = BufReader::new(stdin.lock());
    let mut requests = tokio::task::JoinSet::new();

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
                let mut out = stdout.lock().unwrap();
                let _ = writeln!(out, "{}", err_resp);
                let _ = out.flush();
                continue;
            }
        };

        // JoinSet retains completed tasks until they are collected. This is a
        // long-lived MCP process, so reap earlier responses on every request.
        while let Some(result) = requests.try_join_next() {
            if let Err(error) = result {
                eprintln!("[introspect] request task failed: {error}");
            }
        }

        // A call may keep waiting on the desktop (a native approval, a slow
        // write) after the MCP host times out. Let a following request run
        // immediately instead of queuing it behind that unresolved call.
        let stdout = std::sync::Arc::clone(&stdout);
        let workspace = workspace.clone();
        let sock = sock.clone();
        requests.spawn(async move {
            let work = handle_request(&req, &workspace, api_port, &sock);
            let response = match progress_token(&req) {
                None => work.await,
                Some(token) => {
                    tokio::pin!(work);
                    let start = tokio::time::Instant::now() + PROGRESS_INTERVAL;
                    let mut tick = tokio::time::interval_at(start, PROGRESS_INTERVAL);
                    let mut beats = 0u64;
                    loop {
                        tokio::select! {
                            response = &mut work => break response,
                            _ = tick.tick() => {
                                beats += 1;
                                write_line(&stdout, &progress_notification(&token, beats));
                            }
                        }
                    }
                }
            };
            if let Some(response) = response {
                write_line(&stdout, &response);
            }
        });
    }

    while let Some(result) = requests.join_next().await {
        if let Err(error) = result {
            eprintln!("[introspect] request task failed: {error}");
        }
    }
    eprintln!("[introspect] stdin closed, exiting");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_token_is_read_from_request_meta() {
        let req =
            json!({"id":1,"method":"tools/call","params":{"_meta":{"progressToken":7},"name":"x"}});
        assert_eq!(progress_token(&req), Some(json!(7)));
        let req = json!({"id":1,"method":"tools/call","params":{"_meta":{"progressToken":"t"}}});
        assert_eq!(progress_token(&req), Some(json!("t")));
        let req = json!({"id":1,"method":"tools/call","params":{"name":"x"}});
        assert_eq!(progress_token(&req), None);
        let req = json!({"id":1,"method":"tools/call","params":{"_meta":{"progressToken":null}}});
        assert_eq!(progress_token(&req), None);
    }

    #[test]
    fn progress_notification_carries_the_token_and_count() {
        let n = progress_notification(&json!("t"), 3);
        assert_eq!(n["method"], "notifications/progress");
        assert_eq!(n["params"]["progressToken"], "t");
        assert_eq!(n["params"]["progress"], 3);
        assert!(n.get("id").is_none());
    }

    #[test]
    fn tool_names_are_unique() {
        // The knowledge tools are spliced in from `knowledge`; a name defined
        // in both places would list twice and dispatch to whichever arm
        // matched first.
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(names.len(), unique.len(), "{names:?}");
        // P2.5: apps are `amuxd app`, not MCP tools.
        assert!(!names.iter().any(|n| n.contains("_app")), "{names:?}");
        assert!(names.contains(&"knowledge_search"));
        assert!(names.contains(&"knowledge_read"));
    }

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
