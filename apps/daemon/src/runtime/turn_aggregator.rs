//! Per-runtime accumulator that turns the streaming ACP event firehose into
//! discrete "logical messages" (thinking blocks, tool calls/results, agent
//! replies). The daemon runs one of these per agent_id and feeds every
//! `AcpEvent` into it; emitted messages get persisted (TOML, plus the cloud
//! backend for **turn-final** AGENT_REPLY) and broadcast on session/live.
//!
//! ## Cloud vs live
//!
//! Mid-turn `AgentReply` slices (flushed before each `ToolUse`) are live/TOML
//! only. Cloud `messages` receives at most one non-empty `AgentReply` per turn
//! — the Active→Idle flush (including interrupted turns). OpenCode / Cursor /
//! Claude Code / Pi all map run completion onto that Idle boundary.
//!
//! ## metadata_json shapes
//!
//! Renderers should treat `metadata_json` as a stable contract per kind:
//!
//! - AgentThinking: `""` (no metadata)
//! - AgentToolCall: `{"tool_id": str, "tool_name": str, "description": str}`
//! - AgentToolResult: `{"tool_id": str, "success": bool}`
//! - AgentReply: `""` normally; special turn endings use non-empty
//!   agent-facing English content plus:
//!   - `{"turn_status":"interrupted"}` — user abort
//!   - `{"turn_status":"no_final_reply"}` — Idle with no final prose
//!     (frontends hide the English notice and render a localized strip)
//!   - `{"turn_status":"skill_created_in_unsupported_directory", ...}` —
//!     native-only skill write detected (fail-closed; replaces turn success)
//!
//! Always emit all keys for a kind (use empty strings/false rather than
//! omitting). New keys may be added; existing keys must not be removed
//! without a coordinated schema bump.

use crate::proto::amux;
use crate::proto::teamclu::MessageKind;

/// Durable AGENT_REPLY body when the user aborts a turn.
///
/// Kept English so model history / catchup context always sees an explicit
/// stop instruction regardless of UI locale. Frontends hide this text when
/// `metadata.turn_status == "interrupted"` and render a localized strip.
pub const INTERRUPTED_AGENT_REPLY_CONTENT: &str = "\
[Turn interrupted by user] The user stopped this turn before it finished. \
Do not continue, resume, or retry the interrupted work unless the user \
explicitly asks again.";

const INTERRUPTED_REPLY_METADATA_JSON: &str = r#"{"turn_status":"interrupted"}"#;

/// Durable AGENT_REPLY body when a turn ends at Idle with no final prose
/// (tool-only, thinking-only, or all narration was mid-flushed before Idle).
///
/// English so agent context / catchup understand completion. Frontends hide
/// this notice when `metadata.turn_status == "no_final_reply"` and render a
/// localized status strip.
pub const NO_FINAL_REPLY_AGENT_CONTENT: &str = "\
[Turn completed with no final reply] The agent finished this turn without \
producing a final written answer. Treat the turn as successfully completed. \
Do not invent a summary, continue earlier narration, or re-run work unless \
the user explicitly asks.";

const NO_FINAL_REPLY_METADATA_JSON: &str = r#"{"turn_status":"no_final_reply"}"#;

fn is_turn_abort_error(err: &amux::AcpError) -> bool {
    let message = err.message.to_ascii_lowercase();
    let details = err.details.to_ascii_lowercase();
    message.contains("messageaborted")
        || details.contains("messageaborted")
        || message.contains("turninterrupted")
        || details.contains("turninterrupted")
}

fn tool_use_metadata(tu: &amux::AcpToolUse) -> String {
    serde_json::json!({
        "tool_id": tu.tool_id,
        "tool_name": tu.tool_name,
        "tool_kind": tu.tool_kind,
        "description": tu.description,
        "params": tu.params,
        "raw_input_json": tu.raw_input_json,
        "status": tu.status,
        "locations": tu
            .locations
            .iter()
            .map(|loc| {
                serde_json::json!({
                    "path": loc.path,
                    "line": loc.line,
                })
            })
            .collect::<Vec<_>>(),
        "content": proto_tool_content_json(&tu.content),
    })
    .to_string()
}

fn tool_result_metadata(tr: &amux::AcpToolResult) -> String {
    serde_json::json!({
        "tool_id": tr.tool_id,
        "success": tr.success,
        "raw_output_json": tr.raw_output_json,
        "content": proto_tool_content_json(&tr.content),
    })
    .to_string()
}

fn proto_tool_content_json(content: &[amux::AcpToolCallContent]) -> Vec<serde_json::Value> {
    content
        .iter()
        .filter_map(|item| {
            Some(match item.payload.as_ref()? {
                amux::acp_tool_call_content::Payload::Text(text) => serde_json::json!({
                    "type": "text",
                    "text": text.text,
                }),
                amux::acp_tool_call_content::Payload::Diff(diff) => serde_json::json!({
                    "type": "diff",
                    "path": diff.path,
                    "old_text": diff.old_text,
                    "new_text": diff.new_text,
                }),
                amux::acp_tool_call_content::Payload::Terminal(terminal) => serde_json::json!({
                    "type": "terminal",
                    "terminal_id": terminal.terminal_id,
                }),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmittedMessage {
    pub kind: MessageKind,
    pub content: String,
    /// JSON blob for structured kinds (tool calls/results). Empty otherwise.
    pub metadata_json: String,
    /// Daemon-assigned correlation id stamped on every emit within one
    /// ACP turn (Idle→Active→…→Idle). Clients group consecutive
    /// same-turn_id AgentReply rows into one bubble. Empty when there
    /// is no active turn (shouldn't happen for agent emissions but
    /// renderers must tolerate it).
    pub turn_id: String,
    /// When true, this `AgentReply` is the turn-final slice (Active→Idle,
    /// including interrupted) and may be written to the cloud backend.
    /// Mid-turn ToolUse flushes keep this false (live + local TOML only).
    pub cloud_persist: bool,
}

#[derive(Debug, Default)]
pub struct TurnAggregator {
    thinking_buf: String,
    reply_buf: String,
    /// `Some(uuid)` while we're inside a turn (Active), `None` while
    /// Idle. Allocated on Idle→Active, cleared on Active→Idle. Every
    /// `EmittedMessage` carries this id so downstream INSERTs can
    /// correlate the rows belonging to the same logical turn.
    current_turn_id: Option<String>,
    /// True once this turn emits thinking, output, or tool events.
    turn_had_activity: bool,
    /// True once this turn emits an AgentReply (mid-turn flush or turn end).
    turn_had_reply: bool,
    /// True when an ACP Error for user abort arrived before Active→Idle.
    turn_was_interrupted: bool,
}

impl TurnAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one ACP event in; return any logical messages this triggers.
    pub fn ingest(&mut self, event: &amux::AcpEvent) -> Vec<EmittedMessage> {
        let mut out = Vec::new();
        match event.event.as_ref() {
            Some(amux::acp_event::Event::Thinking(t)) => {
                self.ensure_turn_started();
                self.turn_had_activity = true;
                self.thinking_buf.push_str(&t.text);
            }
            Some(amux::acp_event::Event::Output(o)) => {
                self.ensure_turn_started();
                self.turn_had_activity = true;
                self.reply_buf.push_str(&o.text);
            }
            Some(amux::acp_event::Event::ToolUse(tu)) => {
                // A tool call interrupts: flush any pending thinking + reply
                // first, then emit the tool call as its own message.
                self.ensure_turn_started();
                self.turn_had_activity = true;
                self.flush_thinking_into(&mut out);
                self.flush_reply_into(&mut out, false);
                let metadata = tool_use_metadata(tu);
                out.push(EmittedMessage {
                    kind: MessageKind::AgentToolCall,
                    content: tu.tool_name.clone(),
                    metadata_json: metadata,
                    turn_id: self.current_turn_id.clone().unwrap_or_default(),
                    cloud_persist: false,
                });
            }
            Some(amux::acp_event::Event::ToolResult(tr)) => {
                self.ensure_turn_started();
                self.turn_had_activity = true;
                let metadata = tool_result_metadata(tr);
                out.push(EmittedMessage {
                    kind: MessageKind::AgentToolResult,
                    content: tr.summary.clone(),
                    metadata_json: metadata,
                    turn_id: self.current_turn_id.clone().unwrap_or_default(),
                    cloud_persist: false,
                });
            }
            Some(amux::acp_event::Event::Error(err)) => {
                // Abort arrives before Active→Idle. Remember it so turn end
                // can emit a durable interrupted AGENT_REPLY (catchup + UI).
                if is_turn_abort_error(err) {
                    self.ensure_turn_started();
                    self.turn_was_interrupted = true;
                    self.turn_had_activity = true;
                }
            }
            Some(amux::acp_event::Event::StatusChange(sc)) => {
                let active = amux::AgentStatus::Active as i32;
                let idle = amux::AgentStatus::Idle as i32;
                // Idle -> Active opens a new turn. Allocate a fresh
                // turn_id so any subsequent thinking/output/tool emits
                // get stamped with it. Defensive: don't clobber an
                // already-open turn (shouldn't happen, but if it does
                // the existing id stays in force).
                if sc.old_status == idle && sc.new_status == active {
                    self.turn_had_activity = false;
                    self.turn_had_reply = false;
                    self.turn_was_interrupted = false;
                    self.ensure_turn_started();
                }
                // Active -> Idle is the canonical "turn ended" signal.
                // Flush pending buffers, then close out the turn so the next
                // turn allocates a fresh id.
                if sc.old_status == active && sc.new_status == idle {
                    self.flush_thinking_into(&mut out);
                    if self.turn_was_interrupted && self.turn_had_activity {
                        // Single durable AGENT_REPLY: keep any unflushed prose in
                        // content (user must see what was generated). Only fall
                        // back to the English interrupt notice when there is no
                        // visible text — still stamp turn_status for UI routing.
                        let prose = std::mem::take(&mut self.reply_buf);
                        let content = if prose.trim().is_empty() {
                            INTERRUPTED_AGENT_REPLY_CONTENT.to_string()
                        } else {
                            prose
                        };
                        out.push(EmittedMessage {
                            kind: MessageKind::AgentReply,
                            content,
                            metadata_json: INTERRUPTED_REPLY_METADATA_JSON.to_string(),
                            turn_id: self.current_turn_id.clone().unwrap_or_default(),
                            cloud_persist: true,
                        });
                        self.turn_had_reply = true;
                    } else {
                        // Non-empty Idle prose → one cloud-final AgentReply.
                        // Empty Idle (tool-only, or mid-turn flushes already
                        // drained the buffer) → durable no_final_reply notice
                        // so catchup sees an agent row and UI can localize.
                        let had_final_prose = !self.reply_buf.trim().is_empty();
                        self.flush_reply_into(&mut out, true);
                        if !had_final_prose && self.turn_had_activity {
                            out.push(EmittedMessage {
                                kind: MessageKind::AgentReply,
                                content: NO_FINAL_REPLY_AGENT_CONTENT.to_string(),
                                metadata_json: NO_FINAL_REPLY_METADATA_JSON.to_string(),
                                turn_id: self.current_turn_id.clone().unwrap_or_default(),
                                cloud_persist: true,
                            });
                            self.turn_had_reply = true;
                        }
                    }
                    self.turn_had_activity = false;
                    self.turn_had_reply = false;
                    self.turn_was_interrupted = false;
                    self.current_turn_id = None;
                }
            }
            _ => {}
        }
        out
    }

    /// Lazy turn open. Some ACP streams emit thinking/output before any
    /// StatusChange to Active (e.g. session resume), so we treat the
    /// first content-bearing event as an implicit turn boundary.
    fn ensure_turn_started(&mut self) {
        if self.current_turn_id.is_none() {
            self.current_turn_id = Some(uuid::Uuid::new_v4().to_string());
        }
    }

    fn flush_thinking_into(&mut self, out: &mut Vec<EmittedMessage>) {
        if !self.thinking_buf.is_empty() {
            out.push(EmittedMessage {
                kind: MessageKind::AgentThinking,
                content: std::mem::take(&mut self.thinking_buf),
                metadata_json: String::new(),
                turn_id: self.current_turn_id.clone().unwrap_or_default(),
                cloud_persist: false,
            });
        }
    }

    fn flush_reply_into(&mut self, out: &mut Vec<EmittedMessage>, cloud_persist: bool) {
        if !self.reply_buf.is_empty() {
            out.push(EmittedMessage {
                kind: MessageKind::AgentReply,
                content: std::mem::take(&mut self.reply_buf),
                metadata_json: String::new(),
                turn_id: self.current_turn_id.clone().unwrap_or_default(),
                cloud_persist,
            });
            self.turn_had_reply = true;
        }
    }

    /// True if this emitted message should be persisted to the cloud backend.
    /// Only non-empty **turn-final** `AgentReply` rows (Active→Idle /
    /// interrupted). Mid-turn ToolUse flushes stay live + local TOML.
    pub fn cloud_persistent(msg: &EmittedMessage) -> bool {
        matches!(msg.kind, MessageKind::AgentReply)
            && msg.cloud_persist
            && !msg.content.trim().is_empty()
    }

    /// English status notices (interrupt / no_final_reply) meant for agent
    /// context and catchup — channel UIs must not treat them as user-visible
    /// reply text.
    pub fn is_agent_facing_status_notice(content: &str) -> bool {
        let trimmed = content.trim_start();
        trimmed.starts_with("[Turn interrupted by user]")
            || trimmed.starts_with("[Turn completed with no final reply]")
            || trimmed.starts_with("[Skill created in unsupported directory]")
    }

    /// Current per-turn correlation id, or `None` between turns. Read by the
    /// publish path so outgoing `Envelope`s carry `turn_id`, letting clients
    /// dedupe `output isComplete=true` events by `(runtime_id, turn_id)`
    /// across daemon-restart-renumbered sequence space.
    pub fn current_turn_id(&self) -> Option<&str> {
        self.current_turn_id.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn thinking_chunk(text: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking {
                text: text.into(),
            })),
            model: String::new(),
        }
    }

    fn output_chunk(text: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.into(),
                is_complete: false,
            })),
            model: String::new(),
        }
    }

    fn tool_use(id: &str, name: &str, desc: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                tool_id: id.into(),
                tool_name: name.into(),
                description: desc.into(),
                params: Default::default(),
                tool_kind: String::new(),
                raw_input_json: String::new(),
                raw_output_json: String::new(),
                content: vec![],
                locations: vec![],
                status: String::new(),
            })),
            model: String::new(),
        }
    }

    fn tool_use_with_params(
        id: &str,
        name: &str,
        desc: &str,
        params: impl IntoIterator<Item = (&'static str, &'static str)>,
    ) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                tool_id: id.into(),
                tool_name: name.into(),
                description: desc.into(),
                params: params
                    .into_iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
                tool_kind: String::new(),
                raw_input_json: String::new(),
                raw_output_json: String::new(),
                content: vec![],
                locations: vec![],
                status: String::new(),
            })),
            model: String::new(),
        }
    }

    fn tool_result(id: &str, success: bool, summary: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                tool_id: id.into(),
                success,
                summary: summary.into(),
                raw_output_json: String::new(),
                content: vec![],
            })),
            model: String::new(),
        }
    }

    fn status_change(old: amux::AgentStatus, new: amux::AgentStatus) -> amux::AcpEvent {
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

    fn abort_error() -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                message: "MessageAbortedError".into(),
                details: "Aborted".into(),
            })),
            model: String::new(),
        }
    }

    #[test]
    fn aggregates_thinking_then_reply_at_turn_end() {
        let mut agg = TurnAggregator::new();
        assert!(agg.ingest(&thinking_chunk("Let me ")).is_empty());
        assert!(agg.ingest(&thinking_chunk("think...")).is_empty());
        assert!(agg.ingest(&output_chunk("The ")).is_empty());
        assert!(agg.ingest(&output_chunk("answer is 579.")).is_empty());

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].kind, MessageKind::AgentThinking);
        assert_eq!(emitted[0].content, "Let me think...");
        assert_eq!(emitted[1].kind, MessageKind::AgentReply);
        assert_eq!(emitted[1].content, "The answer is 579.");
        assert!(emitted[1].cloud_persist);
        assert!(TurnAggregator::cloud_persistent(&emitted[1]));
    }

    #[test]
    fn tool_call_interrupts_and_flushes_thinking_and_reply() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&thinking_chunk("Need to read a file"));
        agg.ingest(&output_chunk("I'll use the Read tool."));
        let emitted = agg.ingest(&tool_use("t1", "Read", "{file:foo}"));

        assert_eq!(emitted.len(), 3);
        assert_eq!(emitted[0].kind, MessageKind::AgentThinking);
        assert_eq!(emitted[1].kind, MessageKind::AgentReply);
        assert!(!emitted[1].cloud_persist);
        assert!(!TurnAggregator::cloud_persistent(&emitted[1]));
        assert_eq!(emitted[2].kind, MessageKind::AgentToolCall);
        assert!(emitted[2].content.contains("Read"));
        assert!(emitted[2].metadata_json.contains("\"tool_id\":\"t1\""));
    }

    #[test]
    fn tool_call_metadata_preserves_params() {
        let mut agg = TurnAggregator::new();
        let emitted = agg.ingest(&tool_use_with_params(
            "t1",
            "Bash",
            "Execute ps command",
            [("command", "ps aux")],
        ));

        assert_eq!(emitted.len(), 1);
        let metadata: serde_json::Value = serde_json::from_str(&emitted[0].metadata_json).unwrap();
        assert_eq!(metadata["params"]["command"], "ps aux");
    }

    #[test]
    fn tool_result_emits_immediately() {
        let mut agg = TurnAggregator::new();
        let emitted = agg.ingest(&tool_result("t1", true, "file content here"));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentToolResult);
        assert_eq!(emitted[0].content, "file content here");
        assert!(emitted[0].metadata_json.contains("\"success\":true"));
    }

    #[test]
    fn tool_only_turn_emits_no_final_reply_notice_at_idle() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&thinking_chunk("Need todos"));
        agg.ingest(&tool_use("t1", "todowrite", "{}"));
        agg.ingest(&tool_result("t1", true, "ok"));

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentReply);
        assert_eq!(emitted[0].content, NO_FINAL_REPLY_AGENT_CONTENT);
        assert!(emitted[0]
            .metadata_json
            .contains("\"turn_status\":\"no_final_reply\""));
        assert!(emitted[0].cloud_persist);
        assert!(!emitted[0].turn_id.is_empty());
        assert!(TurnAggregator::cloud_persistent(&emitted[0]));
    }

    #[test]
    fn empty_prose_idle_is_cloud_persistent_via_no_final_reply_notice() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&thinking_chunk("Need todos"));
        agg.ingest(&tool_use("t1", "todowrite", "{}"));
        agg.ingest(&tool_result("t1", true, "ok"));

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentReply);
        assert!(TurnAggregator::cloud_persistent(&emitted[0]));
    }

    #[test]
    fn interrupted_tool_only_turn_emits_durable_agent_reply() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        let tool_emitted = agg.ingest(&tool_use("t1", "bash", "sleep 10"));
        assert_eq!(tool_emitted.len(), 1);
        assert_eq!(tool_emitted[0].kind, MessageKind::AgentToolCall);
        assert!(agg.ingest(&abort_error()).is_empty());

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentReply);
        assert_eq!(emitted[0].content, INTERRUPTED_AGENT_REPLY_CONTENT);
        assert!(emitted[0]
            .metadata_json
            .contains("\"turn_status\":\"interrupted\""));
        assert!(TurnAggregator::cloud_persistent(&emitted[0]));
    }

    #[test]
    fn interrupted_turn_with_partial_reply_keeps_prose_content() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&output_chunk("partial answer"));
        assert!(agg.ingest(&abort_error()).is_empty());

        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].kind, MessageKind::AgentReply);
        assert_eq!(emitted[0].content, "partial answer");
        assert!(emitted[0]
            .metadata_json
            .contains("\"turn_status\":\"interrupted\""));
        assert!(TurnAggregator::cloud_persistent(&emitted[0]));
    }

    #[test]
    fn turn_end_with_empty_buffers_emits_nothing() {
        let mut agg = TurnAggregator::new();
        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert!(emitted.is_empty());
    }

    #[test]
    fn unrelated_status_changes_do_not_flush() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&output_chunk("partial"));
        let emitted = agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        assert!(emitted.is_empty());
    }

    #[test]
    fn multi_tool_turn_emits_in_order() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&output_chunk("First, "));
        let r1 = agg.ingest(&tool_use("t1", "Read", "{}"));
        assert_eq!(r1.len(), 2); // reply flush + tool call
        assert_eq!(r1[0].kind, MessageKind::AgentReply);
        assert!(!r1[0].cloud_persist);
        assert_eq!(r1[1].kind, MessageKind::AgentToolCall);

        let r2 = agg.ingest(&tool_result("t1", true, "done"));
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0].kind, MessageKind::AgentToolResult);

        agg.ingest(&output_chunk("then "));
        let r3 = agg.ingest(&tool_use("t2", "Edit", "{}"));
        assert_eq!(r3.len(), 2);
        assert_eq!(r3[0].kind, MessageKind::AgentReply);
        assert_eq!(r3[0].content, "then ");
        assert!(!r3[0].cloud_persist);
        assert!(!TurnAggregator::cloud_persistent(&r3[0]));
        assert_eq!(r3[1].kind, MessageKind::AgentToolCall);

        let r4 = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(r4.len(), 1);
        assert_eq!(r4[0].kind, MessageKind::AgentReply);
        assert_eq!(r4[0].content, NO_FINAL_REPLY_AGENT_CONTENT);
        assert!(r4[0].cloud_persist);
        assert!(TurnAggregator::cloud_persistent(&r4[0]));
    }

    #[test]
    fn only_idle_final_reply_is_cloud_persistent() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&output_chunk("mid "));
        let mid = agg.ingest(&tool_use("t1", "Bash", "pwd"));
        assert_eq!(mid[0].kind, MessageKind::AgentReply);
        assert_eq!(mid[0].content, "mid ");
        assert!(!mid[0].cloud_persist);
        assert!(!TurnAggregator::cloud_persistent(&mid[0]));

        agg.ingest(&tool_result("t1", true, "/tmp"));
        agg.ingest(&output_chunk("final answer"));
        let idle = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(idle.len(), 1);
        assert_eq!(idle[0].kind, MessageKind::AgentReply);
        assert_eq!(idle[0].content, "final answer");
        assert!(idle[0].cloud_persist);
        assert!(TurnAggregator::cloud_persistent(&idle[0]));
    }

    #[test]
    fn mid_flush_then_idle_without_prose_emits_no_final_reply_notice() {
        let mut agg = TurnAggregator::new();
        agg.ingest(&status_change(
            amux::AgentStatus::Idle,
            amux::AgentStatus::Active,
        ));
        agg.ingest(&output_chunk("mid "));
        let mid = agg.ingest(&tool_use("t1", "Bash", "pwd"));
        assert!(!TurnAggregator::cloud_persistent(&mid[0]));
        agg.ingest(&tool_result("t1", true, "/tmp"));

        let idle = agg.ingest(&status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        ));
        assert_eq!(idle.len(), 1);
        assert_eq!(idle[0].content, NO_FINAL_REPLY_AGENT_CONTENT);
        assert!(idle[0]
            .metadata_json
            .contains("\"turn_status\":\"no_final_reply\""));
        assert!(TurnAggregator::cloud_persistent(&idle[0]));
    }
}
