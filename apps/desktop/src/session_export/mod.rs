use std::collections::HashMap;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::local_cache::store::MessageRow;

mod opencode;
mod sanitize;

use opencode::{sdk_message_to_opencode, SdkMessage, SdkPart, SdkToolCall};
use sanitize::sanitize_opencode_messages;

#[derive(Debug, Clone, Copy)]
pub struct ExportOptions {
    pub include_thinking: bool,
    pub include_tools: bool,
    pub sanitize: bool,
    pub include_system: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_thinking: true,
            include_tools: true,
            sanitize: true,
            include_system: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionExportSource {
    #[serde(rename = "type")]
    pub source_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionExportBundle {
    pub session_id: String,
    pub exported_at: String,
    pub source: SessionExportSource,
    pub messages: Vec<Value>,
}

fn parse_timestamp_ms(created_at: &str) -> i64 {
    DateTime::parse_from_rfc3339(created_at)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn role_from_kind(kind: &str) -> &'static str {
    match kind {
        "system" => "system",
        "agent_thinking" | "agent_tool_call" | "agent_tool_result" | "agent_reply" => "assistant",
        _ => "user",
    }
}

fn compare_rows(a: &MessageRow, b: &MessageRow) -> std::cmp::Ordering {
    parse_timestamp_ms(&a.created_at)
        .cmp(&parse_timestamp_ms(&b.created_at))
        .then_with(|| a.id.cmp(&b.id))
}

fn parse_sdk_part(part: &Value) -> Option<SdkPart> {
    let obj = part.as_object()?;
    match obj.get("type").and_then(Value::as_str) {
        Some("reasoning") => {
            let text = obj
                .get("text")
                .or_else(|| obj.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(SdkPart::Reasoning { text })
            }
        }
        Some("text") => {
            let text = obj
                .get("text")
                .or_else(|| obj.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(SdkPart::Text { text })
            }
        }
        Some("tool-call") => {
            let tc = obj.get("toolCall")?.as_object()?;
            let name = tc
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let status = tc
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("calling")
                .to_string();
            let arguments = tc
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let result = tc.get("result").cloned();
            let raw_output = tc.get("rawOutput").cloned();
            Some(SdkPart::ToolCall {
                tool_call: Box::new(SdkToolCall {
                    name,
                    status,
                    arguments,
                    result,
                    raw_output,
                }),
            })
        }
        _ => None,
    }
}

fn parse_parts_json(raw: &str) -> Vec<SdkPart> {
    let Ok(parts) = serde_json::from_str::<Vec<Value>>(raw) else {
        return Vec::new();
    };
    parts.iter().filter_map(parse_sdk_part).collect()
}

fn build_single(row: &MessageRow) -> SdkMessage {
    let mut parts = Vec::new();
    if !row.content.is_empty() {
        parts.push(SdkPart::Text {
            text: row.content.clone(),
        });
    }
    SdkMessage {
        id: row.id.clone(),
        session_id: row.session_id.clone(),
        sender_actor_id: row.sender_actor_id.clone(),
        role: role_from_kind(&row.kind).to_string(),
        timestamp_ms: parse_timestamp_ms(&row.created_at),
        model_id: row.model.clone(),
        provider_id: None,
        agent: None,
        parts,
    }
}

fn build_turn(group: &[MessageRow]) -> SdkMessage {
    let first = &group[0];
    let thinking = group
        .iter()
        .filter(|r| r.kind == "agent_thinking")
        .map(|r| r.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    let replies = group
        .iter()
        .filter(|r| r.kind == "agent_reply")
        .collect::<Vec<_>>();

    let mut unique = Vec::<&MessageRow>::new();
    let mut index_by_key = HashMap::<String, usize>::new();
    for reply in replies {
        let key = format!(
            "{}\u{0000}{}",
            reply.content,
            reply.model.clone().unwrap_or_default()
        );
        if let Some(existing_idx) = index_by_key.get(&key).copied() {
            let existing = unique[existing_idx];
            let existing_has_parts = existing
                .parts_json
                .as_deref()
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            let current_has_parts = reply
                .parts_json
                .as_deref()
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            if !existing_has_parts && current_has_parts {
                unique[existing_idx] = reply;
            }
            continue;
        }
        index_by_key.insert(key, unique.len());
        unique.push(reply);
    }

    let canonical_with_parts = unique
        .iter()
        .rev()
        .find(|r| {
            r.parts_json
                .as_deref()
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        })
        .copied();

    if let Some(reply) = canonical_with_parts {
        let parts = parse_parts_json(reply.parts_json.as_deref().unwrap_or(""));
        if !parts.is_empty() {
            return SdkMessage {
                id: reply.id.clone(),
                session_id: reply.session_id.clone(),
                sender_actor_id: reply.sender_actor_id.clone(),
                role: "assistant".to_string(),
                timestamp_ms: parse_timestamp_ms(&first.created_at),
                model_id: reply
                    .model
                    .clone()
                    .or_else(|| group.iter().find_map(|m| m.model.clone())),
                provider_id: None,
                agent: None,
                parts,
            };
        }
    }

    let mut parts = Vec::new();
    if !thinking.is_empty() {
        parts.push(SdkPart::Reasoning { text: thinking });
    }
    let text = unique
        .iter()
        .map(|r| r.content.as_str())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if !text.is_empty() {
        parts.push(SdkPart::Text { text });
    }

    SdkMessage {
        id: unique
            .first()
            .map(|r| r.id.clone())
            .unwrap_or_else(|| first.id.clone()),
        session_id: first.session_id.clone(),
        sender_actor_id: first.sender_actor_id.clone(),
        role: "assistant".to_string(),
        timestamp_ms: parse_timestamp_ms(&first.created_at),
        model_id: unique
            .last()
            .and_then(|r| r.model.clone())
            .or_else(|| group.iter().find_map(|m| m.model.clone())),
        provider_id: None,
        agent: None,
        parts,
    }
}

fn adapt(rows: &[MessageRow]) -> Vec<SdkMessage> {
    let mut sorted = rows.to_vec();
    sorted.sort_by(compare_rows);

    let mut out = Vec::new();
    let mut i = 0usize;
    while i < sorted.len() {
        let row = &sorted[i];
        if role_from_kind(&row.kind) != "assistant"
            || row.turn_id.as_deref().unwrap_or("").is_empty()
        {
            out.push(build_single(row));
            i += 1;
            continue;
        }

        let turn_id = row.turn_id.clone();
        let sender = row.sender_actor_id.clone();
        let mut group = Vec::new();
        while i < sorted.len()
            && sorted[i].turn_id == turn_id
            && sorted[i].sender_actor_id == sender
        {
            group.push(sorted[i].clone());
            i += 1;
        }
        out.push(build_turn(&group));
    }
    out
}

fn filter_parts(message: &mut Value, include_thinking: bool, include_tools: bool) {
    let Some(parts) = message.get_mut("parts").and_then(Value::as_array_mut) else {
        return;
    };
    parts.retain(|part| match part.get("type").and_then(Value::as_str) {
        Some("reasoning") if !include_thinking => false,
        Some("tool") if !include_tools => false,
        _ => true,
    });
}

pub fn export_from_rows(
    session_id: &str,
    rows: &[MessageRow],
    opts: ExportOptions,
) -> Result<SessionExportBundle, String> {
    let sdk = adapt(rows);
    let mut messages = sdk
        .iter()
        .filter(|m| opts.include_system || m.role != "system")
        .map(sdk_message_to_opencode)
        .collect::<Vec<_>>();

    if !opts.include_thinking || !opts.include_tools {
        for msg in &mut messages {
            filter_parts(msg, opts.include_thinking, opts.include_tools);
        }
    }
    if opts.sanitize {
        messages = sanitize_opencode_messages(&messages);
    }

    Ok(SessionExportBundle {
        session_id: session_id.to_string(),
        exported_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        source: SessionExportSource {
            source_type: "teamclu_local_cache".to_string(),
        },
        messages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures live beside these tests; the TS client-side export that once
    // shared them was removed as unreferenced.
    const TURN_MESSAGES_FIXTURE: &str = include_str!("fixtures/turn-messages.json");
    const EXPECTED_OPENCODE_FIXTURE: &str = include_str!("fixtures/expected-opencode.json");

    #[test]
    fn session_export_matches_fixture_messages() {
        let rows = serde_json::from_str::<Vec<MessageRow>>(TURN_MESSAGES_FIXTURE)
            .expect("turn-messages fixture should deserialize");
        let bundle = export_from_rows("sess-export-1", &rows, ExportOptions::default())
            .expect("export should succeed");

        let expected_value = serde_json::from_str::<Value>(EXPECTED_OPENCODE_FIXTURE)
            .expect("expected-opencode fixture should deserialize");
        let expected_messages = match expected_value {
            Value::Object(obj) => obj
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .expect("expected-opencode object fixture must have messages[]"),
            Value::Array(arr) => arr,
            _ => panic!("expected-opencode fixture must be object or array"),
        };

        assert_eq!(bundle.messages, expected_messages);
    }
}
