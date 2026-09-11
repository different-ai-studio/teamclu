//! Helpers for accumulating agent prose across tool-call boundaries within
//! one ACP turn. Shared by the gateway (`agent_handle::run_turn`) and cron
//! (`drive_cron_turn`).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::proto::amux;
use crate::proto::teamclu::MessageKind;
use crate::runtime::turn_aggregator::{
    classify_acp_error, AcpErrorKind, EmittedMessage, TurnAggregator,
};

/// Extra wait after a tool's own `timeout` before the daemon treats it as stuck.
/// Pi may still be killing the process tree when the declared second elapses.
pub const TOOL_TIMEOUT_GRACE: Duration = Duration::from_secs(15);
const MAX_DECLARED_TOOL_TIMEOUT_SECS: u64 = 24 * 3600;

/// Silence is measured from the last ACP event, not from the prompt. An idle
/// budget resets on every event and only fires after actual quiet.
pub fn idle_remaining_at(last_activity: Instant, idle: Duration, now: Instant) -> Duration {
    idle.saturating_sub(now.saturating_duration_since(last_activity))
}

/// How long this wait loop may sleep, combining channel idle with an optional
/// in-flight tool deadline. A bash that declared `timeout: 60` must not sit on
/// WeCom's 600s silence budget; a scrape that declared nothing keeps it.
pub fn wait_remaining_at(
    last_activity: Instant,
    channel_idle: Duration,
    tool_deadline: Option<Instant>,
    now: Instant,
) -> Duration {
    let idle = idle_remaining_at(last_activity, channel_idle, now);
    match tool_deadline {
        Some(deadline) => idle.min(deadline.saturating_duration_since(now)),
        None => idle,
    }
}

/// Seconds the tool asked to live, from ACP `rawInput` or the string params map.
pub fn declared_tool_timeout_secs(
    raw_input_json: &str,
    params: &HashMap<String, String>,
) -> Option<u64> {
    parse_timeout_json(raw_input_json)
        .or_else(|| params.get("timeout").and_then(|s| parse_timeout_str(s)))
        .filter(|&secs| secs > 0 && secs <= MAX_DECLARED_TOOL_TIMEOUT_SECS)
}

fn parse_timeout_json(raw: &str) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    parse_timeout_value(v.get("timeout")?)
}

fn parse_timeout_value(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| *f > 0.0 && f.is_finite())
                .map(|f| f as u64)
        }),
        serde_json::Value::String(s) => parse_timeout_str(s),
        _ => None,
    }
}

fn parse_timeout_str(s: &str) -> Option<u64> {
    s.trim().parse().ok()
}

/// ToolUse with a declared timeout starts a deadline from `now`; ToolResult clears it.
pub fn apply_tool_deadline_from_event(
    event: &amux::AcpEvent,
    deadline: &mut Option<Instant>,
    now: Instant,
) {
    match &event.event {
        Some(amux::acp_event::Event::ToolUse(tu)) => {
            *deadline = declared_tool_timeout_secs(&tu.raw_input_json, &tu.params)
                .map(|secs| now + Duration::from_secs(secs) + TOOL_TIMEOUT_GRACE);
        }
        Some(amux::acp_event::Event::ToolResult(_)) => {
            *deadline = None;
        }
        _ => {}
    }
}

/// Same as [`apply_tool_deadline_from_event`] for the poll_events / sweeper path.
pub fn apply_tool_deadline_unix(event: &amux::AcpEvent, deadline: &mut Option<i64>, now_unix: i64) {
    match &event.event {
        Some(amux::acp_event::Event::ToolUse(tu)) => {
            *deadline = declared_tool_timeout_secs(&tu.raw_input_json, &tu.params).map(|secs| {
                now_unix
                    + i64::try_from(secs).unwrap_or(i64::MAX)
                    + TOOL_TIMEOUT_GRACE.as_secs() as i64
            });
        }
        Some(amux::acp_event::Event::ToolResult(_)) => {
            *deadline = None;
        }
        _ => {}
    }
}

/// What a gateway / cron wait loop should do with an ACP `Error` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayErrorAction {
    /// Host/extension noise. Keep waiting for Active→Idle.
    Continue,
    /// The model already produced prose; return it instead of failing empty.
    ReturnReply(String),
    /// Abort the wait. Payload is the error details for `agent turn failed: …`.
    Fail(String),
}

fn acp_error_details(err: &amux::AcpError) -> String {
    if err.details.is_empty() {
        err.message.clone()
    } else {
        err.details.clone()
    }
}

/// Classify an ACP error for the gateway / cron wait loop.
///
/// A `pi extension error` (stale ctx after WeCom re-spawn) must not abort the
/// wait — the model is still running. A real provider failure salvages any
/// accumulated text the way a timeout does. User abort still fails the turn.
pub fn gateway_error_action(
    err: &amux::AcpError,
    segments: &[String],
    live: &str,
) -> GatewayErrorAction {
    match classify_acp_error(err) {
        AcpErrorKind::SideChannel => GatewayErrorAction::Continue,
        AcpErrorKind::UserAbort => GatewayErrorAction::Fail(acp_error_details(err)),
        AcpErrorKind::TurnFailure => {
            let acc = compose_reply(segments, live);
            if acc.trim().is_empty() {
                GatewayErrorAction::Fail(acp_error_details(err))
            } else {
                GatewayErrorAction::ReturnReply(acc)
            }
        }
    }
}

/// Join the reply segments a turn has produced so far into the text a
/// channel should display. `live` is the not-yet-flushed tail (output that
/// has arrived but hasn't hit a tool-call or turn-end boundary).
///
/// Segments are the runs of prose between tool calls, so blank-line joining
/// matches how Tauri renders them as separate messages.
pub fn compose_reply(segments: &[String], live: &str) -> String {
    let mut parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    if !live.trim().is_empty() {
        parts.push(live);
    }
    parts.join("\n\n")
}

/// Fold one event's aggregator output into the reply being accumulated.
/// Returns true if a segment was flushed (i.e. the visible text jumped),
/// which the streaming path uses to push an update immediately rather than
/// waiting out the throttle interval.
pub fn absorb_emitted(
    emitted: Vec<EmittedMessage>,
    segments: &mut Vec<String>,
    live: &mut String,
) -> bool {
    let mut flushed = false;
    for m in emitted {
        if matches!(m.kind, MessageKind::AgentReply) {
            // Empty anchors and English status notices (no_final_reply /
            // interrupt instruction) must not become WeCom/channel reply text.
            if !m.content.is_empty() && !TurnAggregator::is_agent_facing_status_notice(&m.content) {
                segments.push(m.content);
            }
            live.clear();
            flushed = true;
        }
    }
    flushed
}

/// Build the turn-final `AgentReply` cron/gateway callers return after
/// Active→Idle, stitching mid-turn flushes into one delivery string while
/// keeping turn metadata from the aggregator's cloud-persistent slice.
pub fn final_agent_reply_emitted(
    segments: &[String],
    live: &str,
    idle_emitted: &[EmittedMessage],
) -> EmittedMessage {
    let content = compose_reply(segments, live);
    let meta = idle_emitted
        .iter()
        .rev()
        .find(|m| TurnAggregator::cloud_persistent(m))
        .or_else(|| {
            idle_emitted
                .iter()
                .rev()
                .find(|m| matches!(m.kind, MessageKind::AgentReply))
        });
    EmittedMessage {
        kind: MessageKind::AgentReply,
        content,
        metadata_json: meta.map(|m| m.metadata_json.clone()).unwrap_or_default(),
        turn_id: meta.map(|m| m.turn_id.clone()).unwrap_or_default(),
        cloud_persist: true,
    }
}

/// When a cron/gateway turn hits its budget but already produced prose, return
/// the stitched text instead of failing with an empty error.
pub fn salvage_timeout_emitted(
    segments: &[String],
    live: &str,
) -> Result<EmittedMessage, &'static str> {
    let content = compose_reply(segments, live);
    if content.trim().is_empty() {
        Err("ACP turn timed out")
    } else {
        Ok(EmittedMessage {
            kind: MessageKind::AgentReply,
            content,
            metadata_json: r#"{"turn_status":"interrupted"}"#.to_string(),
            turn_id: String::new(),
            cloud_persist: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::turn_aggregator::NO_FINAL_REPLY_AGENT_CONTENT;

    #[test]
    fn idle_remaining_resets_from_last_event_not_prompt() {
        let idle = Duration::from_secs(600);
        let t0 = Instant::now();
        let nine_min = t0 + Duration::from_secs(9 * 60);
        assert_eq!(
            idle_remaining_at(nine_min, idle, nine_min),
            idle,
            "a just-received event restores the full silence budget"
        );
        assert_eq!(
            idle_remaining_at(t0, idle, nine_min),
            Duration::from_secs(60),
            "silence from the prompt would have only a minute left"
        );
    }

    fn acp_err(message: &str, details: &str) -> amux::AcpError {
        amux::AcpError {
            message: message.into(),
            details: details.into(),
        }
    }

    #[test]
    fn gateway_keeps_waiting_on_extension_noise() {
        use crate::runtime::pi_rpc::translate::EXTENSION_ERROR_MESSAGE;
        assert_eq!(
            gateway_error_action(
                &acp_err(
                    EXTENSION_ERROR_MESSAGE,
                    "This extension ctx is stale after session replacement or reload."
                ),
                &[],
                ""
            ),
            GatewayErrorAction::Continue
        );
    }

    #[test]
    fn gateway_fails_user_abort_even_when_text_exists() {
        use crate::runtime::pi_rpc::translate::{ABORTED_ERROR_DETAILS, ABORTED_ERROR_MESSAGE};
        let segments = vec!["partial".to_string()];
        assert_eq!(
            gateway_error_action(
                &acp_err(ABORTED_ERROR_MESSAGE, ABORTED_ERROR_DETAILS),
                &segments,
                ""
            ),
            GatewayErrorAction::Fail(ABORTED_ERROR_DETAILS.to_string())
        );
    }

    #[test]
    fn gateway_salvages_provider_error_after_prose() {
        use crate::runtime::pi_rpc::translate::PROVIDER_ERROR_MESSAGE;
        let segments = vec!["今日抖音来客数据".to_string()];
        assert_eq!(
            gateway_error_action(
                &acp_err(PROVIDER_ERROR_MESSAGE, "400 out of extra usage."),
                &segments,
                ""
            ),
            GatewayErrorAction::ReturnReply("今日抖音来客数据".into())
        );
        assert_eq!(
            gateway_error_action(
                &acp_err(PROVIDER_ERROR_MESSAGE, "400 out of extra usage."),
                &[],
                ""
            ),
            GatewayErrorAction::Fail("400 out of extra usage.".into())
        );
    }

    #[test]
    fn compose_reply_joins_segments_and_live_tail() {
        let segments = vec!["我先查一下".to_string()];
        assert_eq!(
            compose_reply(&segments, "结果是 xxx"),
            "我先查一下\n\n结果是 xxx"
        );
        assert_eq!(compose_reply(&segments, "   "), "我先查一下");
    }

    #[test]
    fn salvage_timeout_marks_interrupted_metadata() {
        let segments = vec!["partial".to_string()];
        let out = salvage_timeout_emitted(&segments, "").unwrap();
        assert_eq!(out.content, "partial");
        assert!(out.metadata_json.contains("interrupted"));
    }

    #[test]
    fn absorb_emitted_skips_status_notices() {
        let mut segments = Vec::new();
        let mut live = "typing".to_string();
        let emitted = vec![EmittedMessage {
            kind: MessageKind::AgentReply,
            content: NO_FINAL_REPLY_AGENT_CONTENT.to_string(),
            metadata_json: String::new(),
            turn_id: "t1".into(),
            cloud_persist: true,
        }];
        assert!(absorb_emitted(emitted, &mut segments, &mut live));
        assert!(segments.is_empty());
        assert!(live.is_empty());
    }

    #[test]
    fn tool_only_idle_yields_empty_delivery_text() {
        let mut segments = Vec::new();
        let mut live = String::new();
        let idle = vec![EmittedMessage {
            kind: MessageKind::AgentReply,
            content: NO_FINAL_REPLY_AGENT_CONTENT.to_string(),
            metadata_json: r#"{"turn_status":"no_final_reply"}"#.into(),
            turn_id: "turn-tool".into(),
            cloud_persist: true,
        }];
        absorb_emitted(idle.clone(), &mut segments, &mut live);
        let out = final_agent_reply_emitted(&segments, &live, &idle);
        assert!(out.content.is_empty());
        assert_eq!(out.turn_id, "turn-tool");
        assert!(out.metadata_json.contains("no_final_reply"));
    }

    #[test]
    fn declared_tool_timeout_reads_json_number_or_params() {
        let empty = std::collections::HashMap::new();
        let mut params = std::collections::HashMap::new();
        params.insert("timeout".into(), "60".into());
        assert_eq!(
            declared_tool_timeout_secs(r#"{"command":"sleep 999","timeout":60}"#, &params),
            Some(60)
        );
        assert_eq!(
            declared_tool_timeout_secs(r#"{"timeout":"90"}"#, &empty),
            Some(90)
        );
        assert_eq!(
            declared_tool_timeout_secs("{}", &params),
            Some(60),
            "params fallback when JSON has no timeout"
        );
        assert_eq!(
            declared_tool_timeout_secs(r#"{"command":"ls"}"#, &empty),
            None
        );
        assert_eq!(
            declared_tool_timeout_secs(r#"{"timeout":0}"#, &empty),
            None,
            "zero is not a declared budget"
        );
    }

    #[test]
    fn wait_remaining_honors_tool_deadline_without_killing_undeclared_scrapes() {
        let idle = Duration::from_secs(600);
        let t0 = Instant::now();
        let after_75s = t0 + Duration::from_secs(75);
        let tool_deadline = Some(t0 + Duration::from_secs(60) + TOOL_TIMEOUT_GRACE);
        assert_eq!(
            wait_remaining_at(t0, idle, tool_deadline, after_75s),
            Duration::ZERO,
            "bash timeout=60 plus grace must expire well before the 600s channel idle"
        );
        assert_eq!(
            wait_remaining_at(t0, idle, None, after_75s),
            Duration::from_secs(525),
            "a scrape that never declared timeout keeps the channel idle budget"
        );
        let just_started = t0 + Duration::from_secs(1);
        assert_eq!(
            wait_remaining_at(t0, idle, tool_deadline, just_started),
            Duration::from_secs(74),
            "tool deadline is measured from tool start, not reset by the idle clock"
        );
    }

    #[test]
    fn tool_use_with_timeout_sets_deadline_and_result_clears_it() {
        let now = Instant::now();
        let mut deadline: Option<Instant> = None;
        let tool_use = crate::proto::amux::AcpEvent {
            event: Some(crate::proto::amux::acp_event::Event::ToolUse(
                crate::proto::amux::AcpToolUse {
                    tool_id: "1".into(),
                    tool_name: "bash".into(),
                    description: String::new(),
                    params: Default::default(),
                    tool_kind: "execute".into(),
                    raw_input_json: r#"{"timeout":60}"#.into(),
                    raw_output_json: String::new(),
                    content: vec![],
                    locations: vec![],
                    status: "in_progress".into(),
                },
            )),
            model: String::new(),
        };
        apply_tool_deadline_from_event(&tool_use, &mut deadline, now);
        assert_eq!(
            deadline,
            Some(now + Duration::from_secs(60) + TOOL_TIMEOUT_GRACE)
        );

        let result = crate::proto::amux::AcpEvent {
            event: Some(crate::proto::amux::acp_event::Event::ToolResult(
                crate::proto::amux::AcpToolResult {
                    tool_id: "1".into(),
                    success: true,
                    summary: String::new(),
                    raw_output_json: String::new(),
                    content: vec![],
                },
            )),
            model: String::new(),
        };
        apply_tool_deadline_from_event(&result, &mut deadline, now + Duration::from_secs(2));
        assert_eq!(deadline, None);
    }

    #[test]
    fn final_agent_reply_stitches_mid_turn_prose() {
        let mut segments = vec!["我先查一下".to_string()];
        let mut live = String::new();
        let idle = vec![EmittedMessage {
            kind: MessageKind::AgentReply,
            content: "结果是 xxx".to_string(),
            metadata_json: r#"{"turn_status":"completed"}"#.into(),
            turn_id: "turn-1".into(),
            cloud_persist: true,
        }];
        absorb_emitted(idle.clone(), &mut segments, &mut live);
        let out = final_agent_reply_emitted(&segments, &live, &idle);
        assert_eq!(out.content, "我先查一下\n\n结果是 xxx");
        assert_eq!(out.turn_id, "turn-1");
        assert!(out.cloud_persist);
        assert!(out.metadata_json.contains("completed"));
    }
}
