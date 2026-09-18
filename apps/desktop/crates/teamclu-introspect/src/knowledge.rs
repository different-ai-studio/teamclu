//! Team knowledge vault search/read via amuxd `cmd: knowledge`.

use serde_json::{json, Value};

use crate::daemon_sock;

pub fn tool_definitions() -> [Value; 2] {
    [
        json!({
            "name": "knowledge_search",
            "description": "Search the team's Markdown knowledge vault (not the workspace, not team-documents). Matches every whitespace-separated term as a substring of a page's title or body — Chinese two-character words like 渠道 work. Returns path, title, heading, a short snippet, sourceRef, and contentHash. Title hits rank first. If nothing matches, tell the user you don't know; do not invent pages. After a useful hit, call knowledge_read with its sourceRef before quoting the page.",
            "inputSchema": {
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Free text. Whitespace-separated terms are ANDed."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 8,
                        "description": "Max hits. Defaults to 8."
                    },
                    "pathPrefix": {
                        "type": "string",
                        "description": "Optional vault-relative prefix, e.g. 40-runbooks/"
                    }
                }
            }
        }),
        json!({
            "name": "knowledge_read",
            "description": "Read a few knowledge-vault pages or heading sections previously returned by knowledge_search. Pass sourceRef values (or vault-relative paths). Total characters across chunks are hard-capped. Only quote what this tool returns.",
            "inputSchema": {
                "type": "object",
                "required": ["sourceRefs"],
                "properties": {
                    "sourceRefs": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": { "type": "string" },
                        "description": "kb:v1:… refs or vault-relative paths from knowledge_search."
                    },
                    "maxChars": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 12000,
                        "description": "Hard cap across all chunks. Defaults to 8000."
                    }
                }
            }
        }),
    ]
}

pub async fn handle(
    sock: &std::path::Path,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let action = match tool_name {
        "knowledge_search" => "search",
        "knowledge_read" => "read",
        other => return Err(format!("Unknown knowledge tool: {other}")),
    };

    let mut payload = arguments.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("cmd".to_string(), json!("knowledge"));
        obj.insert("action".to_string(), json!(action));
        if action == "search" && obj.get("limit").is_none() {
            obj.insert("limit".to_string(), json!(8));
        }
    }

    let raw = daemon_sock::knowledge_via_daemon(sock.to_path_buf(), payload).await?;
    if raw.get("ok").and_then(Value::as_bool) == Some(false) {
        let code = raw
            .get("errorCode")
            .and_then(Value::as_str)
            .unwrap_or("knowledge_failed");
        let message = raw
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("knowledge operation failed");
        return Err(format!("{code}: {message}"));
    }
    Ok(raw.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_match_dispatch() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["knowledge_search", "knowledge_read"]);
    }
}
