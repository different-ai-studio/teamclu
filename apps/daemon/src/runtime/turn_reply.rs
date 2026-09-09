//! Helpers for accumulating agent prose across tool-call boundaries within
//! one ACP turn. Shared by the gateway (`agent_handle::run_turn`) and cron
//! (`drive_cron_turn`).

use std::time::{Duration, Instant};

use crate::proto::teamclu::MessageKind;
use crate::runtime::turn_aggregator::{EmittedMessage, TurnAggregator};

/// Silence is measured from the last ACP event, not from the prompt. An idle
/// budget resets on every event and only fires after actual quiet.
pub fn idle_remaining_at(last_activity: Instant, idle: Duration, now: Instant) -> Duration {
    idle.saturating_sub(now.saturating_duration_since(last_activity))
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
