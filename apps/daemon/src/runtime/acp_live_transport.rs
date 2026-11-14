//! Shrink ACP tool events before session/live MQTT (and the local SSE tee).
//!
//! Tool adapters faithfully copy opencode tool state into `raw_*_json`, which
//! can include multi‑MB base64 attachments or write/edit payloads. The UI reads
//! `summary` + structured `params`; giant raw blobs are only needed locally.

use crate::proto::amux;
use crate::proto::amux::Envelope as AmuxEnvelope;
use serde_json::{Map, Value};
use tracing::debug;

pub const RAW_JSON_FIELD_LIMIT: usize = 8 * 1024;
pub const OUTPUT_PREVIEW_LIMIT: usize = 4 * 1024;
pub const PARAM_VALUE_LIMIT: usize = 4 * 1024;
pub const LIVE_ACP_BODY_LIMIT: usize = 64 * 1024;

const TRUNCATED_SUFFIX: &str = "...[truncated for live transport]";

/// Keys on tool *input* objects that may carry file-sized payloads.
const LARGE_INPUT_KEYS: &[&str] = &[
    "content",
    "patch",
    "diff",
    "prompt",
    "old_string",
    "new_string",
    "text",
    "body",
    "data",
    "code",
    "script",
];

/// Returns encoded `AmuxEnvelope` bytes, compacting tool events when needed.
pub fn prepare_acp_event_body_for_live(envelope: &AmuxEnvelope) -> Vec<u8> {
    if !envelope_carries_tool_event(envelope) {
        return envelope.encode_to_vec();
    }

    let mut wire = envelope.clone();
    let changed = compact_acp_envelope_for_live(&mut wire);
    if changed {
        enforce_live_body_limit(&mut wire);
        let body = wire.encode_to_vec();
        debug!(
            compacted_len = body.len(),
            "compacted ACP tool event for live transport"
        );
        body
    } else {
        wire.encode_to_vec()
    }
}

/// Mutates tool_use / tool_result fields in place. Returns whether anything changed.
pub fn compact_acp_envelope_for_live(envelope: &mut AmuxEnvelope) -> bool {
    let Some(amux::envelope::Payload::AcpEvent(ev)) = &mut envelope.payload else {
        return false;
    };
    match &mut ev.event {
        Some(amux::acp_event::Event::ToolResult(tr)) => compact_tool_result(tr),
        Some(amux::acp_event::Event::ToolUse(tu)) => compact_tool_use(tu),
        _ => false,
    }
}

fn envelope_carries_tool_event(envelope: &AmuxEnvelope) -> bool {
    matches!(
        &envelope.payload,
        Some(amux::envelope::Payload::AcpEvent(ev))
            if matches!(
                &ev.event,
                Some(amux::acp_event::Event::ToolUse(_))
                    | Some(amux::acp_event::Event::ToolResult(_))
            )
    )
}

fn compact_tool_result(tr: &mut amux::AcpToolResult) -> bool {
    let mut changed = false;
    if !tr.raw_output_json.is_empty() {
        let before = tr.raw_output_json.len();
        tr.raw_output_json = compact_tool_state_json(&tr.raw_output_json);
        changed |= tr.raw_output_json.len() != before;
    }
    changed
}

fn compact_tool_use(tu: &mut amux::AcpToolUse) -> bool {
    let mut changed = false;
    if !tu.raw_input_json.is_empty() {
        let before = tu.raw_input_json.len();
        tu.raw_input_json = compact_tool_input_json(&tu.raw_input_json);
        changed |= tu.raw_input_json.len() != before;
    }
    if !tu.raw_output_json.is_empty() {
        let before = tu.raw_output_json.len();
        tu.raw_output_json = compact_tool_state_json(&tu.raw_output_json);
        changed |= tu.raw_output_json.len() != before;
    }
    for value in tu.params.values_mut() {
        if value.len() > PARAM_VALUE_LIMIT {
            *value = truncate_chars(value, PARAM_VALUE_LIMIT);
            changed = true;
        }
    }
    changed
}

/// Compact opencode `tool_state` JSON (ToolResult raw output, task in_progress).
fn compact_tool_state_json(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return truncate_chars(raw, RAW_JSON_FIELD_LIMIT);
    };

    if let Value::Object(map) = &mut value {
        map.remove("attachments");
        let is_read = map
            .get("input")
            .and_then(|v| v.get("filePath"))
            .and_then(|v| v.as_str())
            .is_some_and(|p| !p.is_empty());
        let is_task = map
            .get("metadata")
            .and_then(|v| v.get("sessionId"))
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());

        if is_read {
            strip_large_output_fields(map);
        } else if is_task {
            truncate_field(map, "output", OUTPUT_PREVIEW_LIMIT);
            truncate_field(map, "error", OUTPUT_PREVIEW_LIMIT);
        } else {
            truncate_field(map, "output", OUTPUT_PREVIEW_LIMIT);
            truncate_field(map, "error", OUTPUT_PREVIEW_LIMIT);
        }
    }

    cap_json_value(&mut value, RAW_JSON_FIELD_LIMIT);
    value.to_string()
}

/// Compact tool-call input JSON (ToolUse raw input).
fn compact_tool_input_json(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return truncate_chars(raw, RAW_JSON_FIELD_LIMIT);
    };

    if let Value::Object(map) = &mut value {
        for key in LARGE_INPUT_KEYS {
            truncate_field(map, key, OUTPUT_PREVIEW_LIMIT);
        }
    }

    cap_json_value(&mut value, RAW_JSON_FIELD_LIMIT);
    value.to_string()
}

fn strip_large_output_fields(map: &mut Map<String, Value>) {
    if let Some(output) = map.get_mut("output") {
        *output = Value::String(String::new());
    }
    truncate_field(map, "error", OUTPUT_PREVIEW_LIMIT);
}

fn truncate_field(map: &mut Map<String, Value>, key: &str, limit: usize) {
    let Some(value) = map.get_mut(key) else {
        return;
    };
    match value {
        Value::String(s) if s.chars().count() > limit => {
            *value = Value::String(truncate_chars(s, limit));
        }
        Value::Array(arr) if serde_json::to_string(arr).unwrap_or_default().len() > limit => {
            *value = Value::String(format!("[{} items truncated]", arr.len()));
        }
        Value::Object(obj) if serde_json::to_string(obj).unwrap_or_default().len() > limit => {
            *value = Value::String("[object truncated]".to_string());
        }
        _ => {}
    }
}

/// Hard-cap serialized JSON; progressively drop heavy fields if still too large.
fn cap_json_value(value: &mut Value, limit: usize) {
    let mut serialized = value.to_string();
    if serialized.len() <= limit {
        return;
    }

    if let Value::Object(map) = value {
        for key in ["output", "error", "content", "data"] {
            map.remove(key);
        }
        serialized = value.to_string();
        if serialized.len() <= limit {
            return;
        }
    }

    serialized = truncate_chars(&serialized, limit);
    if let Ok(parsed) = serde_json::from_str::<Value>(&serialized) {
        *value = parsed;
    } else {
        *value = Value::String(serialized);
    }
}

fn enforce_live_body_limit(envelope: &mut AmuxEnvelope) {
    if envelope.encode_to_vec().len() <= LIVE_ACP_BODY_LIMIT {
        return;
    }

    if let Some(amux::envelope::Payload::AcpEvent(ev)) = &mut envelope.payload {
        match &mut ev.event {
            Some(amux::acp_event::Event::ToolResult(tr)) => {
                tr.raw_output_json = truncate_chars(&tr.raw_output_json, RAW_JSON_FIELD_LIMIT / 4);
            }
            Some(amux::acp_event::Event::ToolUse(tu)) => {
                tu.raw_input_json = truncate_chars(&tu.raw_input_json, RAW_JSON_FIELD_LIMIT / 4);
                tu.raw_output_json = truncate_chars(&tu.raw_output_json, RAW_JSON_FIELD_LIMIT / 4);
                tu.params.retain(|k, _| {
                    k == "filePath" || k == "command" || k == "name" || k == "subagent_type"
                });
            }
            _ => {}
        }
    }

    if envelope.encode_to_vec().len() > LIVE_ACP_BODY_LIMIT {
        if let Some(amux::envelope::Payload::AcpEvent(ev)) = &mut envelope.payload {
            match &mut ev.event {
                Some(amux::acp_event::Event::ToolResult(tr)) => {
                    tr.raw_output_json.clear();
                }
                Some(amux::acp_event::Event::ToolUse(tu)) => {
                    tu.raw_input_json.clear();
                    tu.raw_output_json.clear();
                }
                _ => {}
            }
        }
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push_str(TRUNCATED_SUFFIX);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;
    use prost::Message;

    fn tool_result_envelope(raw_output_json: String) -> AmuxEnvelope {
        AmuxEnvelope {
            payload: Some(amux::envelope::Payload::AcpEvent(amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: "call_1".to_string(),
                    success: true,
                    summary: "ok".to_string(),
                    raw_output_json,
                    content: vec![],
                })),
                model: String::new(),
            })),
            ..Default::default()
        }
    }

    fn tool_use_envelope(
        raw_input_json: String,
        params: std::collections::HashMap<String, String>,
    ) -> AmuxEnvelope {
        AmuxEnvelope {
            payload: Some(amux::envelope::Payload::AcpEvent(amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: "call_1".to_string(),
                    tool_name: "write".to_string(),
                    params,
                    raw_input_json,
                    ..Default::default()
                })),
                model: String::new(),
            })),
            ..Default::default()
        }
    }

    #[test]
    fn strips_attachments_and_clears_read_output() {
        let huge = "A".repeat(8_000);
        let raw = serde_json::json!({
            "status": "completed",
            "input": { "filePath": "/tmp/image.png" },
            "output": huge,
            "attachments": [{
                "url": format!("data:image/png;base64,{}", "x".repeat(32_000))
            }]
        })
        .to_string();

        let mut env = tool_result_envelope(raw);
        compact_acp_envelope_for_live(&mut env);

        let tr = match &env.payload {
            Some(amux::envelope::Payload::AcpEvent(ev)) => match &ev.event {
                Some(amux::acp_event::Event::ToolResult(tr)) => tr,
                _ => panic!("expected tool result"),
            },
            _ => panic!("expected acp event"),
        };

        let parsed: Value = serde_json::from_str(&tr.raw_output_json).unwrap();
        assert!(parsed.get("attachments").is_none());
        assert_eq!(parsed["output"].as_str(), Some(""));
        assert_eq!(parsed["input"]["filePath"], "/tmp/image.png");
        assert!(prepare_acp_event_body_for_live(&env).len() < LIVE_ACP_BODY_LIMIT);
    }

    #[test]
    fn preserves_task_metadata() {
        let raw = serde_json::json!({
            "status": "running",
            "metadata": {
                "sessionId": "child-ses-1",
                "parentSessionId": "parent-ses-1"
            },
            "output": "x".repeat(20_000)
        })
        .to_string();

        let mut env = tool_result_envelope(raw);
        compact_acp_envelope_for_live(&mut env);

        let tr = match &env.payload {
            Some(amux::envelope::Payload::AcpEvent(ev)) => match &ev.event {
                Some(amux::acp_event::Event::ToolResult(tr)) => tr,
                _ => panic!("expected tool result"),
            },
            _ => panic!("expected acp event"),
        };

        let parsed: Value = serde_json::from_str(&tr.raw_output_json).unwrap();
        assert_eq!(parsed["metadata"]["sessionId"], "child-ses-1");
        assert_eq!(parsed["metadata"]["parentSessionId"], "parent-ses-1");
        assert!(
            parsed["output"].as_str().unwrap_or("").len()
                <= OUTPUT_PREVIEW_LIMIT + TRUNCATED_SUFFIX.len()
        );
    }

    #[test]
    fn truncates_write_tool_input_and_params() {
        let content = "line\n".repeat(50_000);
        let raw_input = serde_json::json!({
            "filePath": "src/foo.ts",
            "content": content
        })
        .to_string();
        let mut params = std::collections::HashMap::new();
        params.insert("filePath".to_string(), "src/foo.ts".to_string());
        params.insert("content".to_string(), content.clone());

        let mut env = tool_use_envelope(raw_input, params);
        compact_acp_envelope_for_live(&mut env);

        let tu = match &env.payload {
            Some(amux::envelope::Payload::AcpEvent(ev)) => match &ev.event {
                Some(amux::acp_event::Event::ToolUse(tu)) => tu,
                _ => panic!("expected tool use"),
            },
            _ => panic!("expected acp event"),
        };

        let parsed: Value = serde_json::from_str(&tu.raw_input_json).unwrap();
        assert_eq!(parsed["filePath"], "src/foo.ts");
        assert!(parsed["content"]
            .as_str()
            .unwrap_or("")
            .contains(TRUNCATED_SUFFIX));
        assert!(tu.params.get("content").unwrap().contains(TRUNCATED_SUFFIX));
        assert!(tu.raw_input_json.len() <= RAW_JSON_FIELD_LIMIT + 64);
    }

    #[test]
    fn non_tool_events_pass_through_unchanged() {
        let env = AmuxEnvelope {
            payload: Some(amux::envelope::Payload::AcpEvent(amux::AcpEvent {
                event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                    text: "hello".to_string(),
                    ..Default::default()
                })),
                model: String::new(),
            })),
            ..Default::default()
        };
        let before = env.encode_to_vec();
        assert_eq!(prepare_acp_event_body_for_live(&env), before);
    }

    /// #1877. The daemon log records only `body_bytes`, not the acp case.
    /// Parent Output and Thinking of the same text differ by the oneof tag.
    /// A child event carries the pi session path and cannot land in the
    /// 141–185 byte band of the 2956 live deltas captured before 10:47:26Z.
    fn live_delta(thinking: bool, text: &str, acp_session_id: &str) -> usize {
        let event = if thinking {
            amux::acp_event::Event::Thinking(amux::AcpThinking {
                text: text.to_string(),
            })
        } else {
            amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.to_string(),
                is_complete: false,
            })
        };
        let envelope = AmuxEnvelope {
            runtime_id: "d43bb384-2384-4282-8141-323fd77ba184".into(),
            actor_id: "d43bb384-2384-4282-8141-323fd77ba184".into(),
            timestamp: 1_763_024_450,
            sequence: 4_000,
            turn_id: "6f3c1a20-7b14-4e0a-9c55-2a1d8e0b7c31".into(),
            acp_session_id: acp_session_id.to_string(),
            payload: Some(amux::envelope::Payload::AcpEvent(amux::AcpEvent {
                event: Some(event),
                model: "team/max".into(),
            })),
            ..Default::default()
        };
        prepare_acp_event_body_for_live(&envelope).len()
    }

    fn message_created_body(content: &str, reply_to: &str) -> usize {
        use crate::proto::teamclu::{Message, MessageKind, SessionMessageEnvelope};
        SessionMessageEnvelope {
            message: Some(Message {
                message_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890".into(),
                session_id: "8da7cfaf-5144-4af1-8cc1-0881ca860d90".into(),
                sender_actor_id: "d43bb384-2384-4282-8141-323fd77ba184".into(),
                kind: MessageKind::AgentReply as i32,
                content: content.to_string(),
                created_at: 1_794_564_523,
                reply_to_message_id: reply_to.to_string(),
                model: "team/max".into(),
                turn_id: "6f3c1a20-7b14-4e0a-9c55-2a1d8e0b7c31".into(),
                ..Default::default()
            }),
            mention_actor_ids: vec![],
        }
        .encode_to_vec()
        .len()
    }

    #[test]
    fn issue_1877_logged_deltas_are_parent_events() {
        let text = "报销";
        let thinking = live_delta(true, text, "");
        let output = live_delta(false, text, "");
        assert!(
            (thinking as i64 - output as i64).abs() <= 2,
            "thinking {thinking} vs output {output}: size cannot tell them apart"
        );
        let child_path = "pi:/Users/xiaoli/.amuxd/teams/4b8e9df9-c8c5-4d6b-b074-986eef7d02d1/state/pi-sessions/b18ccca6a07c1a25/2026-11-02T09-51-28-687Z_01a19bab-c7af-7752-8385-3b527c0be4e8.jsonl";
        let child = live_delta(true, text, child_path);
        assert!(
            child > 185 + 100,
            "child body {child} would sit above the captured 141–185 band"
        );

        // Captured live deltas before 10:47:26Z are 141–185 bytes (2956 events).
        let short = live_delta(true, "我", "");
        let longer = live_delta(true, "报销规则说明", "");
        assert!(
            short <= 185 && longer >= 141,
            "parent delta sizes short={short} longer={longer} must overlap 141–185; child={child}"
        );
        assert!(
            (141..=185).contains(&thinking) || (141..=185).contains(&short),
            "expected a parent token to land in 141–185, got short={short} 报销={thinking} longer={longer} child={child}"
        );

        // message.created bodies in the same log are 263–306. That envelope is a
        // short AgentReply. The long stream, if it were that reply, would be
        // far larger — and it would have been flushed at each tool boundary.
        let reply_to = "df6b44e0-5114-4628-83de-359ae9a9bef7";
        let empty = message_created_body("", "");
        let empty_reply = message_created_body("", reply_to);
        let chars_for = |target: usize, with_reply: bool| -> usize {
            let mut n = 0;
            while message_created_body(&"字".repeat(n), if with_reply { reply_to } else { "" })
                < target
            {
                n += 1;
                assert!(n < 200, "logged {target} is not a short reply");
            }
            n
        };
        let essay = message_created_body(&"报销规则说明".repeat(80), "");
        let n_263 = chars_for(263, true).min(chars_for(263, false));
        let n_306 = chars_for(306, true).max(chars_for(306, false));
        // Measured: parent 1 CJK = 143, 2 CJK thinking=output=146, 6 CJK = 158,
        // child with the pi session path = 318. Logged message.created 263–306
        // is 17–44 CJK chars. The same essay as an AgentReply is 1616.
        assert_eq!(thinking, output, "same text, thinking and output encode to the same size");
        assert!(
            (141..=185).contains(&short) && (141..=185).contains(&longer),
            "parent tokens must sit in the captured band, got {short} and {longer}, child {child}"
        );
        assert!(
            n_306 < 50 && essay > 1500,
            "logged 263–306 is {n_263}–{n_306} CJK chars (empty {empty}/{empty_reply}); essay is {essay}"
        );
    }
}
