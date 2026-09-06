//! opencode serve SSE event → `amux::AcpEvent` translation.
//!
//! Pure, per-session stateful translation: the SSE stream interleaves user
//! prompt echoes, assistant text/reasoning deltas, tool part updates, and
//! lifecycle events. `TranslateState` tracks message roles and per-part
//! progress so the emitted `AcpEvent`s match what the old ACP adapter
//! produced (streaming `Output` chunks, `Thinking`, `ToolUse`/`ToolResult`).

use std::collections::HashMap;

use crate::proto::amux;

/// Max chars carried in a `ToolResult.summary` (ported from the ACP adapter).
const TOOL_SUMMARY_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartKind {
    Text,
    Reasoning,
}

#[derive(Debug)]
struct PartMeta {
    kind: PartKind,
    /// Bytes of the part text already emitted as streaming chunks.
    emitted: usize,
}

/// Per-session translation state (message roles + part progress).
#[derive(Debug, Default)]
pub struct TranslateState {
    /// messageID → role ("user" | "assistant").
    roles: HashMap<String, String>,
    parts: HashMap<String, PartMeta>,
    /// tool partID → last emitted state signature, for dedupe.
    tool_last_sig: HashMap<String, String>,
}

fn text_event(kind: PartKind, text: String) -> amux::AcpEvent {
    let event = match kind {
        PartKind::Text => amux::acp_event::Event::Output(amux::AcpOutput {
            text,
            is_complete: false,
        }),
        PartKind::Reasoning => amux::acp_event::Event::Thinking(amux::AcpThinking { text }),
    };
    amux::AcpEvent {
        event: Some(event),
        model: String::new(),
    }
}

pub fn truncate_tool_summary(summary: String) -> String {
    if summary.chars().count() > TOOL_SUMMARY_LIMIT {
        format!(
            "{}...",
            summary.chars().take(TOOL_SUMMARY_LIMIT).collect::<String>()
        )
    } else {
        summary
    }
}

fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn params_from_input(input: Option<&serde_json::Value>) -> HashMap<String, String> {
    match input {
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), json_value_to_string(v)))
            .collect(),
        Some(v) if !v.is_null() => HashMap::from([("input".to_string(), json_value_to_string(v))]),
        _ => HashMap::new(),
    }
}

/// Map opencode tool names onto the ACP-style `tool_kind` vocabulary the
/// clients already render.
fn tool_kind_for(tool: &str) -> &'static str {
    match tool {
        "bash" => "execute",
        "edit" | "write" | "patch" => "edit",
        "read" => "read",
        "grep" | "glob" | "list" => "search",
        "webfetch" => "fetch",
        "todowrite" | "todoread" => "think",
        _ => "other",
    }
}

impl TranslateState {
    fn is_user_message(&self, message_id: &str) -> bool {
        self.roles.get(message_id).map(String::as_str) == Some("user")
    }
}

/// Translate one opencode SSE event (`event_type` + `properties`) into zero or
/// more `amux::AcpEvent`s.
///
/// Handled here: `message.updated`, `message.part.delta`,
/// `message.part.updated` (text / reasoning / tool), `session.error`.
/// Lifecycle events (`session.idle`, `permission.asked`, …) are handled by the
/// event router, not this pure layer.
pub fn translate_event(
    state: &mut TranslateState,
    event_type: &str,
    props: &serde_json::Value,
) -> Vec<amux::AcpEvent> {
    match event_type {
        "message.updated" => {
            if let (Some(id), Some(role)) = (
                props.pointer("/info/id").and_then(|v| v.as_str()),
                props.pointer("/info/role").and_then(|v| v.as_str()),
            ) {
                state.roles.insert(id.to_string(), role.to_string());
            }
            vec![]
        }
        "message.part.delta" => {
            let message_id = props
                .get("messageID")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if state.is_user_message(message_id) {
                return vec![];
            }
            if props.get("field").and_then(|v| v.as_str()) != Some("text") {
                return vec![];
            }
            let part_id = props.get("partID").and_then(|v| v.as_str()).unwrap_or("");
            let delta = props
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if delta.is_empty() {
                return vec![];
            }
            let meta = state.parts.entry(part_id.to_string()).or_insert(PartMeta {
                kind: PartKind::Text,
                emitted: 0,
            });
            meta.emitted += delta.len();
            vec![text_event(meta.kind, delta.to_string())]
        }
        "message.part.updated" => {
            let Some(part) = props.get("part") else {
                return vec![];
            };
            translate_part_updated(state, part)
        }
        "session.error" => {
            let name = props
                .pointer("/error/name")
                .and_then(|v| v.as_str())
                .unwrap_or("SessionError");
            let details = props
                .pointer("/error/data/message")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: name.to_string(),
                    details: details.to_string(),
                })),
                model: String::new(),
            }]
        }
        _ => vec![],
    }
}

fn translate_part_updated(
    state: &mut TranslateState,
    part: &serde_json::Value,
) -> Vec<amux::AcpEvent> {
    let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let message_id = part.get("messageID").and_then(|v| v.as_str()).unwrap_or("");
    let part_id = part.get("id").and_then(|v| v.as_str()).unwrap_or("");

    match part_type {
        "text" | "reasoning" => {
            if state.is_user_message(message_id) {
                return vec![];
            }
            let kind = if part_type == "reasoning" {
                PartKind::Reasoning
            } else {
                PartKind::Text
            };
            let text = part
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let meta = state
                .parts
                .entry(part_id.to_string())
                .or_insert(PartMeta { kind, emitted: 0 });
            meta.kind = kind;
            // Full-replace semantics: emit only the unseen suffix so that
            // sessions with deltas don't double-emit, and sessions without
            // deltas still stream incremental text.
            if text.len() > meta.emitted {
                // `emitted` is accumulated from delta byte lengths; if the
                // full text ever disagrees with the delta concatenation the
                // boundary can land mid-character — back off to the nearest
                // char boundary instead of panicking on the byte slice.
                let mut start = meta.emitted.min(text.len());
                while start > 0 && !text.is_char_boundary(start) {
                    start -= 1;
                }
                let chunk = text[start..].to_string();
                meta.emitted = text.len();
                if chunk.is_empty() {
                    vec![]
                } else {
                    vec![text_event(kind, chunk)]
                }
            } else {
                vec![]
            }
        }
        "tool" => translate_tool_part(state, part),
        _ => vec![],
    }
}

fn translate_tool_part(
    state: &mut TranslateState,
    part: &serde_json::Value,
) -> Vec<amux::AcpEvent> {
    let call_id = part.get("callID").and_then(|v| v.as_str()).unwrap_or("");
    let tool = part.get("tool").and_then(|v| v.as_str()).unwrap_or("");
    let part_id = part.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let Some(tool_state) = part.get("state") else {
        return vec![];
    };
    let status = tool_state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Dedupe repeated identical updates (opencode re-sends the whole part;
    // the post-reconnect reconcile replays persisted parts). A terminal
    // status re-sent with the same input is always redundant too — the
    // output can't have changed after completion.
    let sig = format!(
        "{status}|{}",
        tool_state
            .get("input")
            .map(|v| v.to_string())
            .unwrap_or_default()
    );
    if state.tool_last_sig.get(part_id) == Some(&sig) {
        return vec![];
    }
    state.tool_last_sig.insert(part_id.to_string(), sig);

    let input = tool_state.get("input");
    let raw_input_json = input.map(|v| v.to_string()).unwrap_or_default();

    match status {
        "pending" | "running" => {
            let title = tool_state
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: call_id.to_string(),
                    tool_name: if title.is_empty() {
                        tool.to_string()
                    } else {
                        title.to_string()
                    },
                    description: String::new(),
                    params: params_from_input(input),
                    tool_kind: tool_kind_for(tool).to_string(),
                    raw_input_json,
                    raw_output_json: String::new(),
                    content: vec![],
                    locations: vec![],
                    status: if status == "pending" {
                        "pending".to_string()
                    } else {
                        "in_progress".to_string()
                    },
                })),
                model: String::new(),
            }]
        }
        "completed" => {
            let output = tool_state
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: call_id.to_string(),
                    success: true,
                    summary: truncate_tool_summary(output.to_string()),
                    raw_output_json: tool_state.to_string(),
                    content: vec![],
                })),
                model: String::new(),
            }]
        }
        "error" => {
            let error = tool_state
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("tool failed");
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: call_id.to_string(),
                    success: false,
                    summary: truncate_tool_summary(error.to_string()),
                    raw_output_json: tool_state.to_string(),
                    content: vec![],
                })),
                model: String::new(),
            }]
        }
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Permission mapping (wire strings match the old adapter/permission.rs)
// ---------------------------------------------------------------------------

/// Options presented to clients for an opencode permission request. Kinds use
/// the same wire vocabulary the ACP adapter produced
/// (`allow_once` / `allow_always` / `reject_once`).
pub fn permission_options() -> Vec<amux::AcpPermissionOption> {
    vec![
        amux::AcpPermissionOption {
            option_id: "once".to_string(),
            kind: "allow_once".to_string(),
            name: "Allow once".to_string(),
        },
        amux::AcpPermissionOption {
            option_id: "always".to_string(),
            kind: "allow_always".to_string(),
            name: "Always allow".to_string(),
        },
        amux::AcpPermissionOption {
            option_id: "reject".to_string(),
            kind: "reject_once".to_string(),
            name: "Reject".to_string(),
        },
    ]
}

/// Map an amux permission resolution onto the opencode reply body value
/// (`once` | `always` | `reject`).
pub fn permission_response_for(granted: bool, option_id: Option<&str>) -> &'static str {
    if !granted {
        "reject"
    } else if option_id == Some("always") {
        "always"
    } else {
        "once"
    }
}

/// Build the `AcpPermissionRequest` proto for a `permission.asked` event.
/// `props` is the event's `properties` object (a `PermissionRequest`).
///
/// When `child_session_id` is set (opencode task subagent), stamp it into
/// params so the desktop can bind the ask to the parent task tool while the
/// reply still targets that child session id.
pub fn permission_request_event(
    props: &serde_json::Value,
    requester_actor_id: Option<&str>,
    child_session_id: Option<&str>,
) -> amux::AcpEvent {
    let id = props.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let permission = props
        .get("permission")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut params: HashMap<String, String> = props
        .get("metadata")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), json_value_to_string(v)))
                .collect()
        })
        .unwrap_or_default();
    if let Some(patterns) = props.get("patterns").and_then(|v| v.as_array()) {
        let joined = patterns
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if !joined.is_empty() {
            params.entry("patterns".to_string()).or_insert(joined);
        }
    }
    if let Some(call_id) = props
        .pointer("/tool/callID")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        params
            .entry("toolCallId".to_string())
            .or_insert_with(|| call_id.to_string());
    }
    if let Some(child) = child_session_id.map(str::trim).filter(|s| !s.is_empty()) {
        params.insert("childSessionId".to_string(), child.to_string());
    }
    if let Some(requester) = requester_actor_id.filter(|s| !s.is_empty()) {
        params.insert("requester_actor_id".to_string(), requester.to_string());
    }
    amux::AcpEvent {
        event: Some(amux::acp_event::Event::PermissionRequest(
            amux::AcpPermissionRequest {
                request_id: id.to_string(),
                tool_name: permission.to_string(),
                description: String::new(),
                params,
                options: permission_options(),
            },
        )),
        model: String::new(),
    }
}

/// StatusChange event helper (turn open/close markers the aggregator keys on).
pub fn status_change(old: amux::AgentStatus, new: amux::AgentStatus) -> amux::AcpEvent {
    amux::AcpEvent {
        event: Some(amux::acp_event::Event::StatusChange(
            amux::AcpStatusChange {
                old_status: old as i32,
                new_status: new as i32,
            },
        )),
        model: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(state: &mut TranslateState, t: &str, props: serde_json::Value) -> Vec<amux::AcpEvent> {
        translate_event(state, t, &props)
    }

    fn user_msg(state: &mut TranslateState, msg: &str) {
        ev(
            state,
            "message.updated",
            serde_json::json!({"sessionID":"ses_1","info":{"id":msg,"role":"user"}}),
        );
    }

    fn assistant_msg(state: &mut TranslateState, msg: &str) {
        ev(
            state,
            "message.updated",
            serde_json::json!({"sessionID":"ses_1","info":{"id":msg,"role":"assistant"}}),
        );
    }

    #[test]
    fn user_prompt_echo_is_dropped() {
        let mut s = TranslateState::default();
        user_msg(&mut s, "msg_u1");
        let events = ev(
            &mut s,
            "message.part.updated",
            serde_json::json!({"sessionID":"ses_1","part":{
                "id":"prt_1","messageID":"msg_u1","sessionID":"ses_1","type":"text","text":"hi"
            },"time":1.0}),
        );
        assert!(events.is_empty(), "user echo must not become Output");
    }

    #[test]
    fn assistant_text_part_without_deltas_streams_suffixes() {
        let mut s = TranslateState::default();
        assistant_msg(&mut s, "msg_a1");
        let part = |text: &str| {
            serde_json::json!({"sessionID":"ses_1","part":{
                "id":"prt_2","messageID":"msg_a1","sessionID":"ses_1","type":"text","text":text
            },"time":1.0})
        };
        let e1 = ev(&mut s, "message.part.updated", part("Hello"));
        let e2 = ev(&mut s, "message.part.updated", part("Hello world"));
        let e3 = ev(&mut s, "message.part.updated", part("Hello world"));
        let text_of = |events: &[amux::AcpEvent]| match events[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => o.text.clone(),
            other => panic!("unexpected: {other:?}"),
        };
        assert_eq!(text_of(&e1), "Hello");
        assert_eq!(text_of(&e2), " world");
        assert!(e3.is_empty(), "no re-emit of already-seen text");
    }

    #[test]
    fn deltas_stream_and_final_updated_is_suppressed() {
        let mut s = TranslateState::default();
        assistant_msg(&mut s, "msg_a1");
        let d = ev(
            &mut s,
            "message.part.delta",
            serde_json::json!({"sessionID":"ses_1","messageID":"msg_a1","partID":"prt_3","field":"text","delta":"chunk"}),
        );
        assert_eq!(d.len(), 1);
        match d[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => assert_eq!(o.text, "chunk"),
            other => panic!("unexpected: {other:?}"),
        }
        // Final full-text replace carries nothing new → suppressed.
        let e = ev(
            &mut s,
            "message.part.updated",
            serde_json::json!({"sessionID":"ses_1","part":{
                "id":"prt_3","messageID":"msg_a1","sessionID":"ses_1","type":"text","text":"chunk"
            },"time":1.0}),
        );
        assert!(e.is_empty());
    }

    #[test]
    fn reasoning_part_becomes_thinking() {
        let mut s = TranslateState::default();
        assistant_msg(&mut s, "msg_a1");
        let e = ev(
            &mut s,
            "message.part.updated",
            serde_json::json!({"sessionID":"ses_1","part":{
                "id":"prt_r","messageID":"msg_a1","sessionID":"ses_1","type":"reasoning",
                "text":"pondering","time":{"start":1}
            },"time":1.0}),
        );
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Thinking(t) => assert_eq!(t.text, "pondering"),
            other => panic!("unexpected: {other:?}"),
        }
        // A later delta on the same part stays Thinking.
        let d = ev(
            &mut s,
            "message.part.delta",
            serde_json::json!({"sessionID":"ses_1","messageID":"msg_a1","partID":"prt_r","field":"text","delta":" more"}),
        );
        assert!(matches!(
            d[0].event.as_ref().unwrap(),
            amux::acp_event::Event::Thinking(_)
        ));
    }

    #[test]
    fn tool_part_running_then_completed() {
        let mut s = TranslateState::default();
        let running = serde_json::json!({"sessionID":"ses_1","part":{
            "id":"prt_t","messageID":"msg_a1","sessionID":"ses_1","type":"tool",
            "callID":"call_1","tool":"bash",
            "state":{"status":"running","input":{"command":"ls"},"title":"List files","time":{"start":1}}
        },"time":1.0});
        let e = ev(&mut s, "message.part.updated", running.clone());
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolUse(t) => {
                assert_eq!(t.tool_id, "call_1");
                assert_eq!(t.tool_name, "List files");
                assert_eq!(t.tool_kind, "execute");
                assert_eq!(t.status, "in_progress");
                assert_eq!(t.params.get("command"), Some(&"ls".to_string()));
                assert!(t.raw_input_json.contains("ls"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        // Identical re-send is deduped.
        assert!(ev(&mut s, "message.part.updated", running).is_empty());

        let completed = serde_json::json!({"sessionID":"ses_1","part":{
            "id":"prt_t","messageID":"msg_a1","sessionID":"ses_1","type":"tool",
            "callID":"call_1","tool":"bash",
            "state":{"status":"completed","input":{"command":"ls"},"output":"a.txt\n",
                     "title":"List files","metadata":{},"time":{"start":1,"end":2}}
        },"time":2.0});
        let e = ev(&mut s, "message.part.updated", completed);
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolResult(r) => {
                assert_eq!(r.tool_id, "call_1");
                assert!(r.success);
                assert_eq!(r.summary, "a.txt\n");
                assert!(r.raw_output_json.contains("completed"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn suffix_slice_survives_non_char_boundary() {
        let mut s = TranslateState::default();
        assistant_msg(&mut s, "msg_a1");
        // A delta whose byte length lands mid-character in the later full
        // text ("你" is 3 bytes; claim 4 were emitted).
        ev(
            &mut s,
            "message.part.delta",
            serde_json::json!({"sessionID":"ses_1","messageID":"msg_a1","partID":"prt_9","field":"text","delta":"你a"}),
        );
        let e = ev(
            &mut s,
            "message.part.updated",
            serde_json::json!({"sessionID":"ses_1","part":{
                "id":"prt_9","messageID":"msg_a1","sessionID":"ses_1","type":"text","text":"你好世界"
            },"time":1.0}),
        );
        // Must not panic; emits from the nearest char boundary at or below.
        assert_eq!(e.len(), 1);
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => assert_eq!(o.text, "好世界"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn completed_tool_part_resend_is_deduped() {
        let mut s = TranslateState::default();
        let completed = serde_json::json!({"sessionID":"ses_1","part":{
            "id":"prt_t","messageID":"msg_a1","sessionID":"ses_1","type":"tool",
            "callID":"call_1","tool":"bash",
            "state":{"status":"completed","input":{"command":"ls"},"output":"a.txt\n",
                     "title":"List files","metadata":{},"time":{"start":1,"end":2}}
        },"time":2.0});
        let first = ev(&mut s, "message.part.updated", completed.clone());
        assert_eq!(first.len(), 1);
        // Replayed by the post-reconnect reconcile → must not double-emit.
        assert!(ev(&mut s, "message.part.updated", completed).is_empty());
    }

    #[test]
    fn tool_error_becomes_failed_result() {
        let mut s = TranslateState::default();
        let e = ev(
            &mut s,
            "message.part.updated",
            serde_json::json!({"sessionID":"ses_1","part":{
                "id":"prt_t2","messageID":"msg_a1","sessionID":"ses_1","type":"tool",
                "callID":"call_2","tool":"edit",
                "state":{"status":"error","input":{},"error":"permission denied","time":{"start":1,"end":2}}
            },"time":2.0}),
        );
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolResult(r) => {
                assert!(!r.success);
                assert_eq!(r.summary, "permission denied");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn session_error_maps_name_and_message() {
        let mut s = TranslateState::default();
        let e = ev(
            &mut s,
            "session.error",
            serde_json::json!({"sessionID":"ses_1","error":{"name":"UnknownError","data":{"message":"boom"}}}),
        );
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Error(err) => {
                assert_eq!(err.message, "UnknownError");
                assert_eq!(err.details, "boom");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn permission_request_maps_options_and_params() {
        let props = serde_json::json!({
            "id":"per_1","sessionID":"ses_1","permission":"bash",
            "patterns":["ls *"],"metadata":{"command":"ls"},"always":["bash"],
            "tool":{"messageID":"msg_1","callID":"call_1"}
        });
        let e = permission_request_event(&props, Some("actor-a"), Some("ses_child"));
        match e.event.as_ref().unwrap() {
            amux::acp_event::Event::PermissionRequest(p) => {
                assert_eq!(p.request_id, "per_1");
                assert_eq!(p.tool_name, "bash");
                assert_eq!(p.params.get("command"), Some(&"ls".to_string()));
                assert_eq!(p.params.get("patterns"), Some(&"ls *".to_string()));
                assert_eq!(p.params.get("toolCallId"), Some(&"call_1".to_string()));
                assert_eq!(
                    p.params.get("childSessionId"),
                    Some(&"ses_child".to_string())
                );
                assert_eq!(
                    p.params.get("requester_actor_id"),
                    Some(&"actor-a".to_string())
                );
                let kinds: Vec<&str> = p.options.iter().map(|o| o.kind.as_str()).collect();
                assert_eq!(kinds, vec!["allow_once", "allow_always", "reject_once"]);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn permission_response_mapping() {
        assert_eq!(permission_response_for(false, None), "reject");
        assert_eq!(permission_response_for(false, Some("always")), "reject");
        assert_eq!(permission_response_for(true, None), "once");
        assert_eq!(permission_response_for(true, Some("once")), "once");
        assert_eq!(permission_response_for(true, Some("always")), "always");
    }
}
