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
                tr.raw_output_json =
                    truncate_chars(&tr.raw_output_json, RAW_JSON_FIELD_LIMIT / 4);
            }
            Some(amux::acp_event::Event::ToolUse(tu)) => {
                tu.raw_input_json = truncate_chars(&tu.raw_input_json, RAW_JSON_FIELD_LIMIT / 4);
                tu.raw_output_json = truncate_chars(&tu.raw_output_json, RAW_JSON_FIELD_LIMIT / 4);
                tu.params
                    .retain(|k, _| k == "filePath" || k == "command" || k == "name" || k == "subagent_type");
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

    fn tool_use_envelope(raw_input_json: String, params: std::collections::HashMap<String, String>) -> AmuxEnvelope {
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
        assert!(parsed["output"].as_str().unwrap_or("").len() <= OUTPUT_PREVIEW_LIMIT + TRUNCATED_SUFFIX.len());
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
        assert!(parsed["content"].as_str().unwrap_or("").contains(TRUNCATED_SUFFIX));
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
}
