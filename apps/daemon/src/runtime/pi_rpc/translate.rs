//! pi RPC stdout event → `amux::AcpEvent` translation.
//!
//! Pure, per-session stateful translation of pi `--mode rpc` events
//! (`message_update` with `assistantMessageEvent` deltas, tool execution
//! lifecycle, extension errors) into the same `AcpEvent` vocabulary the
//! opencode HTTP backend emits (`runtime/opencode_http/translate.rs`), so
//! gateway / MQTT / frontend / iOS consumers see no difference.

use std::collections::HashMap;

use crate::proto::amux;

use crate::runtime::acp_translate::truncate_tool_summary;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum BlockKind {
    Text,
    Thinking,
}

/// Per-session translation state: bytes already emitted per content block so
/// `text_end` / `thinking_end` (full content) never double-emits after deltas
/// but still covers non-streaming responses.
#[derive(Debug, Default)]
pub struct TranslateState {
    emitted: HashMap<(BlockKind, i64), usize>,
    /// toolCallId → toolName (for kind mapping on results, debugging).
    tool_names: HashMap<String, String>,
}

impl TranslateState {
    /// Reset per-turn block progress (called on `agent_start`).
    pub fn reset_turn(&mut self) {
        self.emitted.clear();
    }
}

fn text_event(kind: BlockKind, text: String) -> amux::AcpEvent {
    let event = match kind {
        BlockKind::Text => amux::acp_event::Event::Output(amux::AcpOutput {
            text,
            is_complete: false,
        }),
        BlockKind::Thinking => amux::acp_event::Event::Thinking(amux::AcpThinking { text }),
    };
    amux::AcpEvent {
        event: Some(event),
        model: String::new(),
    }
}

fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn params_from_args(args: Option<&serde_json::Value>) -> HashMap<String, String> {
    match args {
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), json_value_to_string(v)))
            .collect(),
        Some(v) if !v.is_null() => HashMap::from([("input".to_string(), json_value_to_string(v))]),
        _ => HashMap::new(),
    }
}

/// Map pi built-in tool names onto the ACP-style `tool_kind` vocabulary the
/// clients already render (same buckets as the opencode mapping).
fn tool_kind_for(tool: &str) -> &'static str {
    match tool {
        "bash" => "execute",
        "edit" | "write" | "multi_edit" => "edit",
        "read" => "read",
        "grep" | "glob" | "find" | "list" => "search",
        "web_fetch" | "webfetch" => "fetch",
        _ => "other",
    }
}

/// Join the `content` blocks of a pi `ToolResult` into one text summary.
fn tool_result_text(result: Option<&serde_json::Value>) -> String {
    let Some(content) = result
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
    else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn delta_or_end(
    state: &mut TranslateState,
    kind: BlockKind,
    ev: &serde_json::Value,
    is_end: bool,
) -> Vec<amux::AcpEvent> {
    let idx = ev.get("contentIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    let key = (kind, idx);
    if is_end {
        // `*_end` carries the full block content; emit only the unseen suffix
        // so streamed sessions don't double-emit and non-streamed ones still
        // produce the text.
        let content = ev.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let emitted = state.emitted.entry(key).or_insert(0);
        if content.len() > *emitted {
            // `get` rather than indexing: the emitted byte count came from
            // *previous* deltas at this index, and if a run reuses an index
            // for a different block the count can land mid-UTF-8 in the new
            // content. A panic here takes the whole reader task down; walking
            // back to the nearest boundary just re-emits a partial character's
            // worth too much, which the client renders as-is.
            let mut start = *emitted;
            while start > 0 && !content.is_char_boundary(start) {
                start -= 1;
            }
            let chunk = content[start..].to_string();
            *emitted = content.len();
            return vec![text_event(kind, chunk)];
        }
        return vec![];
    }
    let delta = ev.get("delta").and_then(|v| v.as_str()).unwrap_or("");
    if delta.is_empty() {
        return vec![];
    }
    *state.emitted.entry(key).or_insert(0) += delta.len();
    vec![text_event(kind, delta.to_string())]
}

/// Translate one pi RPC stdout event into zero or more `amux::AcpEvent`s.
///
/// Handled here: `message_update` (text/thinking deltas + ends),
/// `tool_execution_start` / `tool_execution_end`, `extension_error`.
/// Lifecycle events (`agent_start`, `turn_end`, `agent_settled`,
/// `extension_ui_request`) are handled by the event router (`events.rs`), not
/// this pure layer. `tool_execution_update` partial results are dropped (the
/// final `tool_execution_end` carries the full result).
pub fn translate_event(
    state: &mut TranslateState,
    event: &serde_json::Value,
) -> Vec<amux::AcpEvent> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "message_update" => {
            let Some(ame) = event.get("assistantMessageEvent") else {
                return vec![];
            };
            match ame.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "text_delta" => delta_or_end(state, BlockKind::Text, ame, false),
                "text_end" => delta_or_end(state, BlockKind::Text, ame, true),
                "thinking_delta" => delta_or_end(state, BlockKind::Thinking, ame, false),
                "thinking_end" => delta_or_end(state, BlockKind::Thinking, ame, true),
                _ => vec![],
            }
        }
        "tool_execution_start" => {
            let tool_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tool = event.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
            state
                .tool_names
                .insert(tool_id.to_string(), tool.to_string());
            let args = event.get("args");
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: tool_id.to_string(),
                    tool_name: tool.to_string(),
                    description: String::new(),
                    params: params_from_args(args),
                    tool_kind: tool_kind_for(tool).to_string(),
                    raw_input_json: args.map(|v| v.to_string()).unwrap_or_default(),
                    raw_output_json: String::new(),
                    content: vec![],
                    locations: vec![],
                    status: "in_progress".to_string(),
                })),
                model: String::new(),
            }]
        }
        "tool_execution_end" => {
            let tool_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            state.tool_names.remove(tool_id);
            let is_error = event
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = event.get("result");
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: tool_id.to_string(),
                    success: !is_error,
                    summary: truncate_tool_summary(tool_result_text(result)),
                    raw_output_json: result.map(|v| v.to_string()).unwrap_or_default(),
                    content: vec![],
                })),
                model: String::new(),
            }]
        }
        "extension_error" => {
            let details = event
                .get("error")
                .map(json_value_to_string)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| event.to_string());
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Error(amux::AcpError {
                    message: "pi extension error".to_string(),
                    details,
                })),
                model: String::new(),
            }]
        }
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Crash backfill (get_entries replay)
// ---------------------------------------------------------------------------

/// Replay persisted session entries after a child died mid-turn.
///
/// `entries` is the `get_entries since=<last leaf>` tail — everything pi
/// persisted during the lost turn. Most of it already streamed to the client
/// before the crash, so this must not re-emit the whole thing:
///
/// - Assistant text/thinking blocks go through the same unseen-suffix logic as
///   live `text_end` events ([`TranslateState::emitted`] still holds the turn's
///   per-index byte counts), so only the never-streamed tail comes out.
/// - Tool results are replayed only for calls still registered in
///   [`TranslateState::tool_names`] — i.e. tools that were in flight at the
///   crash, whose `tool_execution_end` never arrived. Completed tools already
///   delivered their result live.
///
/// Anything else in the entries (user messages, model changes, compaction) has
/// no place in a turn replay and is skipped.
pub fn replay_entries(
    state: &mut TranslateState,
    entries: &[serde_json::Value],
) -> Vec<amux::AcpEvent> {
    let mut out = Vec::new();
    for entry in entries {
        if entry.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        match message.get("role").and_then(|v| v.as_str()).unwrap_or("") {
            "assistant" => {
                let blocks = message
                    .get("content")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for (index, block) in blocks.iter().enumerate() {
                    let synthetic = |kind: &str, text_field: &str| {
                        serde_json::json!({
                            "type": kind,
                            "content": block.get(text_field).and_then(|v| v.as_str()).unwrap_or(""),
                            "contentIndex": index as i64,
                        })
                    };
                    match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "text" => out.extend(delta_or_end(
                            state,
                            BlockKind::Text,
                            &synthetic("text_end", "text"),
                            true,
                        )),
                        "thinking" => out.extend(delta_or_end(
                            state,
                            BlockKind::Thinking,
                            &synthetic("thinking_end", "thinking"),
                            true,
                        )),
                        // toolCall blocks are not replayed: an in-flight call
                        // already emitted its ToolUse live, and its result (if
                        // persisted) is handled by the toolResult arm below.
                        _ => {}
                    }
                }
            }
            "toolResult" => {
                let tool_id = message
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // Still registered ⇒ the live `tool_execution_end` never
                // arrived; this result is genuinely unseen.
                if tool_id.is_empty() || state.tool_names.remove(tool_id).is_none() {
                    continue;
                }
                let is_error = message
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                out.push(amux::AcpEvent {
                    event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                        tool_id: tool_id.to_string(),
                        success: !is_error,
                        summary: truncate_tool_summary(tool_result_text(Some(message))),
                        raw_output_json: message.to_string(),
                        content: vec![],
                    })),
                    model: String::new(),
                });
            }
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Question tool (extension_ui_request select dialogs)
// ---------------------------------------------------------------------------

/// Marker prefix the TeamClu pi extension puts on a select dialog's title when
/// the dialog is really the `question` tool: the remainder of the title is the
/// question payload as JSON (`{"toolCallId": …, "questions": […]}`). Selects
/// without the marker are ordinary extension dialogs and get cancelled.
pub const QUESTION_MARKER: &str = "teamclu.question=";

/// Parse a select title into the question payload, when marked.
pub fn parse_question_payload(title: &str) -> Option<serde_json::Value> {
    let body = title.strip_prefix(QUESTION_MARKER)?;
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .filter(|v| v.is_object())
}

/// Build the `question_asked` raw event clients already render for opencode's
/// question tool: `{id, questions, tool: {callID}}`. `request_id` is the
/// extension_ui_request id — the same id `AnswerQuestion` sends back, which is
/// what lets the reply become an `extension_ui_response`.
pub fn question_asked_event(request_id: &str, payload: &serde_json::Value) -> amux::AcpEvent {
    let body = serde_json::json!({
        "id": request_id,
        "questions": payload.get("questions").cloned().unwrap_or_else(|| serde_json::json!([])),
        "tool": {
            "callID": payload.get("toolCallId").and_then(|v| v.as_str()).unwrap_or(""),
        },
    });
    amux::AcpEvent {
        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
            method: "question_asked".to_string(),
            json_payload: serde_json::to_vec(&body).unwrap_or_default(),
        })),
        model: String::new(),
    }
}

// ---------------------------------------------------------------------------
// Permission mapping (extension_ui_request confirm dialogs)
// ---------------------------------------------------------------------------

/// Options for a pi confirm dialog surfaced as a permission request. Same wire
/// vocabulary as the opencode backend (`allow_once` / `allow_always` /
/// `reject_once`); `allow_always` is offered only when the dialog text
/// indicates an "always" option exists (the TeamClu pi extension remembers
/// always-grants on its side).
pub fn permission_options(offers_always: bool) -> Vec<amux::AcpPermissionOption> {
    let mut options = vec![amux::AcpPermissionOption {
        option_id: "once".to_string(),
        kind: "allow_once".to_string(),
        name: "Allow once".to_string(),
    }];
    if offers_always {
        options.push(amux::AcpPermissionOption {
            option_id: "always".to_string(),
            kind: "allow_always".to_string(),
            name: "Always allow".to_string(),
        });
    }
    options.push(amux::AcpPermissionOption {
        option_id: "reject".to_string(),
        kind: "reject_once".to_string(),
        name: "Reject".to_string(),
    });
    options
}

/// Machine-readable trailer the TeamClu pi extension appends to confirm
/// messages: `teamclu.always-pattern=<pattern>`. The daemon persists the
/// pattern to the session's rules file when the host approves with "always".
pub const ALWAYS_PATTERN_MARKER: &str = "teamclu.always-pattern=";

/// Extract the "always allow" pattern from a confirm message, if present.
pub fn extract_always_pattern(message: &str) -> Option<String> {
    message
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix(ALWAYS_PATTERN_MARKER))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
}

/// The confirm message with the marker trailer removed (for display).
fn strip_always_pattern(message: &str) -> String {
    message
        .lines()
        .filter(|l| !l.trim().starts_with(ALWAYS_PATTERN_MARKER))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

/// Build the `AcpPermissionRequest` proto for an `extension_ui_request`
/// (`method: "confirm"`). `event` is the full stdout JSON object.
pub fn permission_request_event(
    event: &serde_json::Value,
    requester_actor_id: Option<&str>,
) -> amux::AcpEvent {
    let id = event.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let title = event.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let message = event.get("message").and_then(|v| v.as_str()).unwrap_or("");
    let offers_always = format!("{title} {message}")
        .to_lowercase()
        .contains("always");
    let mut params = HashMap::new();
    let display_message = strip_always_pattern(message);
    if !display_message.is_empty() {
        params.insert("message".to_string(), display_message);
    }
    if let Some(requester) = requester_actor_id.filter(|s| !s.is_empty()) {
        params.insert("requester_actor_id".to_string(), requester.to_string());
    }
    amux::AcpEvent {
        event: Some(amux::acp_event::Event::PermissionRequest(
            amux::AcpPermissionRequest {
                request_id: id.to_string(),
                tool_name: if title.is_empty() {
                    "confirm".to_string()
                } else {
                    title.to_string()
                },
                description: String::new(),
                params,
                options: permission_options(offers_always),
            },
        )),
        model: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(state: &mut TranslateState, json: &str) -> Vec<amux::AcpEvent> {
        translate_event(state, &serde_json::from_str(json).unwrap())
    }

    #[test]
    fn text_deltas_stream_and_end_is_suppressed() {
        let mut s = TranslateState::default();
        let d1 = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello","contentIndex":0}}"#,
        );
        let d2 = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" world","contentIndex":0}}"#,
        );
        let text_of = |events: &[amux::AcpEvent]| match events[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => o.text.clone(),
            other => panic!("unexpected: {other:?}"),
        };
        assert_eq!(text_of(&d1), "Hello");
        assert_eq!(text_of(&d2), " world");
        // text_end repeats the full content → nothing new to emit.
        let end = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Hello world","contentIndex":0}}"#,
        );
        assert!(end.is_empty(), "text_end after deltas must not re-emit");
    }

    #[test]
    fn text_end_without_deltas_emits_full_content() {
        let mut s = TranslateState::default();
        let end = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"non-streamed","contentIndex":0}}"#,
        );
        match end[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => assert_eq!(o.text, "non-streamed"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn thinking_delta_becomes_thinking() {
        let mut s = TranslateState::default();
        let d = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"pondering","contentIndex":1}}"#,
        );
        match d[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Thinking(t) => assert_eq!(t.text, "pondering"),
            other => panic!("unexpected: {other:?}"),
        }
        // Same contentIndex as text is tracked separately.
        let end = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"pondering","contentIndex":1}}"#,
        );
        assert!(end.is_empty());
    }

    #[test]
    fn reset_turn_allows_new_message_at_same_index() {
        let mut s = TranslateState::default();
        ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"one","contentIndex":0}}"#,
        );
        s.reset_turn();
        let end = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"two","contentIndex":0}}"#,
        );
        match end[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => assert_eq!(o.text, "two"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn tool_execution_start_then_end() {
        let mut s = TranslateState::default();
        let start = ev(
            &mut s,
            r#"{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}"#,
        );
        match start[0].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolUse(t) => {
                assert_eq!(t.tool_id, "call_1");
                assert_eq!(t.tool_name, "bash");
                assert_eq!(t.tool_kind, "execute");
                assert_eq!(t.status, "in_progress");
                assert_eq!(t.params.get("command"), Some(&"ls".to_string()));
                assert!(t.raw_input_json.contains("ls"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        let end = ev(
            &mut s,
            r#"{"type":"tool_execution_end","toolCallId":"call_1","result":{"content":[{"type":"text","text":"a.txt"},{"type":"text","text":"b.txt"}]},"isError":false}"#,
        );
        match end[0].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolResult(r) => {
                assert_eq!(r.tool_id, "call_1");
                assert!(r.success);
                assert_eq!(r.summary, "a.txt\nb.txt");
                assert!(r.raw_output_json.contains("a.txt"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn tool_error_maps_to_failed_result() {
        let mut s = TranslateState::default();
        let end = ev(
            &mut s,
            r#"{"type":"tool_execution_end","toolCallId":"call_2","result":{"content":[{"type":"text","text":"permission denied"}]},"isError":true}"#,
        );
        match end[0].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolResult(r) => {
                assert!(!r.success);
                assert_eq!(r.summary, "permission denied");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn tool_execution_update_is_dropped() {
        let mut s = TranslateState::default();
        let e = ev(
            &mut s,
            r#"{"type":"tool_execution_update","toolCallId":"call_1","partialResult":"..."}"#,
        );
        assert!(e.is_empty());
    }

    #[test]
    fn extension_error_becomes_acp_error() {
        let mut s = TranslateState::default();
        let e = ev(
            &mut s,
            r#"{"type":"extension_error","error":"boom in extension"}"#,
        );
        match e[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Error(err) => {
                assert_eq!(err.message, "pi extension error");
                assert_eq!(err.details, "boom in extension");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn lifecycle_events_translate_to_nothing() {
        let mut s = TranslateState::default();
        assert!(ev(&mut s, r#"{"type":"agent_start"}"#).is_empty());
        assert!(ev(&mut s, r#"{"type":"turn_end"}"#).is_empty());
        assert!(ev(&mut s, r#"{"type":"agent_settled"}"#).is_empty());
        assert!(ev(&mut s, r#"{"type":"auto_retry_start","attempt":1}"#).is_empty());
    }

    #[test]
    fn confirm_request_maps_options_and_params() {
        let event: serde_json::Value = serde_json::from_str(
            r#"{"type":"extension_ui_request","id":"ui_1","method":"confirm","title":"Run bash?","message":"ls -la"}"#,
        )
        .unwrap();
        let e = permission_request_event(&event, Some("actor-a"));
        match e.event.as_ref().unwrap() {
            amux::acp_event::Event::PermissionRequest(p) => {
                assert_eq!(p.request_id, "ui_1");
                assert_eq!(p.tool_name, "Run bash?");
                assert_eq!(p.params.get("message"), Some(&"ls -la".to_string()));
                assert_eq!(
                    p.params.get("requester_actor_id"),
                    Some(&"actor-a".to_string())
                );
                let kinds: Vec<&str> = p.options.iter().map(|o| o.kind.as_str()).collect();
                assert_eq!(kinds, vec!["allow_once", "reject_once"]);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn always_pattern_extracted_and_stripped_from_display() {
        assert_eq!(
            extract_always_pattern("{\"command\":\"ls -la\"}\n\nteamclu.always-pattern=ls *"),
            Some("ls *".to_string())
        );
        assert_eq!(extract_always_pattern("no marker here"), None);
        assert_eq!(extract_always_pattern("teamclu.always-pattern="), None);

        let event: serde_json::Value = serde_json::from_str(
            r#"{"type":"extension_ui_request","id":"ui_3","method":"confirm","title":"bash: ls -la","message":"{\"command\":\"ls -la\"}\n\nteamclu.always-pattern=ls *"}"#,
        )
        .unwrap();
        let e = permission_request_event(&event, None);
        match e.event.as_ref().unwrap() {
            amux::acp_event::Event::PermissionRequest(p) => {
                // marker line stripped from the displayed message …
                assert_eq!(
                    p.params.get("message"),
                    Some(&"{\"command\":\"ls -la\"}".to_string())
                );
                // … but its "always" substring still unlocks the allow_always option.
                let kinds: Vec<&str> = p.options.iter().map(|o| o.kind.as_str()).collect();
                assert_eq!(kinds, vec!["allow_once", "allow_always", "reject_once"]);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn replay_entries_emits_only_the_unseen_tail() {
        let mut s = TranslateState::default();
        // Live stream delivered "Hello" before the crash…
        ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello","contentIndex":0}}"#,
        );
        // …and a bash call started but never finished.
        ev(
            &mut s,
            r#"{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}"#,
        );
        let entries: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
                {"type":"message","id":"e1","parentId":null,"timestamp":"t","message":{
                    "role":"assistant",
                    "content":[{"type":"text","text":"Hello world"}]}},
                {"type":"message","id":"e2","parentId":"e1","timestamp":"t","message":{
                    "role":"toolResult","toolCallId":"call_1","toolName":"bash",
                    "content":[{"type":"text","text":"a.txt"}],"isError":false}},
                {"type":"message","id":"e3","parentId":"e2","timestamp":"t","message":{
                    "role":"toolResult","toolCallId":"call_older","toolName":"bash",
                    "content":[{"type":"text","text":"already seen live"}],"isError":false}},
                {"type":"model_change","id":"e4","parentId":"e3","timestamp":"t","provider":"x"}
            ]"#,
        )
        .unwrap();
        let events = replay_entries(&mut s, &entries);
        assert_eq!(events.len(), 2, "text tail + in-flight tool result only");
        match events[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => assert_eq!(o.text, " world"),
            other => panic!("unexpected: {other:?}"),
        }
        match events[1].event.as_ref().unwrap() {
            amux::acp_event::Event::ToolResult(r) => {
                assert_eq!(r.tool_id, "call_1");
                assert_eq!(r.summary, "a.txt");
            }
            other => panic!("unexpected: {other:?}"),
        }
        // Replaying the same entries again emits nothing (idempotent).
        assert!(replay_entries(&mut s, &entries).is_empty());
    }

    #[test]
    fn text_end_survives_non_boundary_emitted_count() {
        let mut s = TranslateState::default();
        // 5 bytes of deltas at index 0…
        ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"aaaaa","contentIndex":0}}"#,
        );
        // …then an end whose content puts byte 5 inside a multi-byte char.
        // Must not panic; walks back to the boundary and re-emits from there.
        let end = ev(
            &mut s,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"aaaa你好","contentIndex":0}}"#,
        );
        match end[0].event.as_ref().unwrap() {
            amux::acp_event::Event::Output(o) => assert_eq!(o.text, "你好"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn question_marker_round_trip() {
        let payload = serde_json::json!({
            "toolCallId": "call_3",
            "questions": [{"header":"H","question":"Q?","options":[{"label":"a"}],"multiple":false}]
        });
        let title = format!("{QUESTION_MARKER}{payload}");
        let parsed = parse_question_payload(&title).expect("marked title parses");
        assert_eq!(parsed["toolCallId"], "call_3");
        // Unmarked / corrupt titles are not questions.
        assert!(parse_question_payload("Pick one").is_none());
        assert!(parse_question_payload("teamclu.question=not json").is_none());

        let ev = question_asked_event("ui_1", &parsed);
        match ev.event.as_ref().unwrap() {
            amux::acp_event::Event::Raw(raw) => {
                assert_eq!(raw.method, "question_asked");
                let body: serde_json::Value = serde_json::from_slice(&raw.json_payload).unwrap();
                assert_eq!(body["id"], "ui_1");
                assert_eq!(body["tool"]["callID"], "call_3");
                assert_eq!(body["questions"][0]["question"], "Q?");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn confirm_request_offers_always_when_text_mentions_it() {
        let event: serde_json::Value = serde_json::from_str(
            r#"{"type":"extension_ui_request","id":"ui_2","method":"confirm","title":"Allow bash?","message":"Choose allow once or always allow"}"#,
        )
        .unwrap();
        let e = permission_request_event(&event, None);
        match e.event.as_ref().unwrap() {
            amux::acp_event::Event::PermissionRequest(p) => {
                let kinds: Vec<&str> = p.options.iter().map(|o| o.kind.as_str()).collect();
                assert_eq!(kinds, vec!["allow_once", "allow_always", "reject_once"]);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
