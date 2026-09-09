use crate::proto::amux;
use tokio::sync::mpsc;

/// ACP event plus the originating ACP session id (root or child subagent).
#[derive(Clone, Debug)]
pub struct AcpEventFrame {
    pub acp_session_id: String,
    pub event: amux::AcpEvent,
    /// User `messages.id` for the in-flight turn that produced this frame.
    /// Bound when the prompt worker dequeues a job (not at enqueue time), so
    /// concurrent queued prompts cannot overwrite an earlier turn's stamp.
    pub turn_reply_to_message_id: Option<String>,
}

impl AcpEventFrame {
    pub fn new(acp_session_id: impl Into<String>, event: amux::AcpEvent) -> Self {
        Self {
            acp_session_id: acp_session_id.into(),
            event,
            turn_reply_to_message_id: None,
        }
    }

    pub fn with_reply_to(mut self, reply_to_message_id: Option<String>) -> Self {
        self.turn_reply_to_message_id = reply_to_message_id.filter(|id| !id.is_empty());
        self
    }
}

/// ACP event from a checked-out turn (gateway / cron) that still needs to
/// reach `session/live`.
///
/// The turn owner takes `event_rx` for the whole turn, so `poll_events` —
/// and with it `forward_agent_event` — never sees these frames. Cron already
/// forwarded them; gateway turns must do the same or the desktop session
/// sits still until the final reply (no thinking, no tools, no streaming).
#[derive(Clone, Debug)]
pub struct CheckedOutTurnEvent {
    /// Runtime key. After ADR-0004 this is the cloud session id, which is
    /// also what `target_sessions` publishes onto `session/{id}/live`.
    pub agent_id: String,
    /// Set only for subagent sessions, matching `forward_agent_event`.
    pub child_acp_session_id: Option<String>,
    pub event: amux::AcpEvent,
}

impl CheckedOutTurnEvent {
    pub fn from_frame(agent_id: &str, root_acp_sid: &str, frame: &AcpEventFrame) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            child_acp_session_id: Some(frame.acp_session_id.clone())
                .filter(|sid| !sid.is_empty() && sid != root_acp_sid),
            event: frame.event.clone(),
        }
    }
}

/// Best-effort copy onto the run-loop live channel. A full channel drops
/// the frame rather than stalling the model turn; `tx == None` is a no-op
/// (unit tests, or a daemon that has not started its MQTT loop yet).
pub fn forward_checked_out_turn_event(
    tx: Option<&mpsc::Sender<CheckedOutTurnEvent>>,
    agent_id: &str,
    root_acp_sid: &str,
    frame: &AcpEventFrame,
) {
    let Some(tx) = tx else {
        return;
    };
    let forwarded = CheckedOutTurnEvent::from_frame(agent_id, root_acp_sid, frame);
    if tx.try_send(forwarded).is_err() {
        tracing::debug!(
            agent_id,
            "checked-out turn: live event channel full; dropping one streaming frame"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thinking_frame(acp_sid: &str, text: &str) -> AcpEventFrame {
        AcpEventFrame::new(
            acp_sid,
            amux::AcpEvent {
                event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking {
                    text: text.into(),
                })),
                model: String::new(),
            },
        )
    }

    #[test]
    fn forwards_thinking_frames_onto_the_live_channel() {
        let (tx, mut rx) = mpsc::channel(8);
        let frame = thinking_frame("acp-root", "let me look that up");
        forward_checked_out_turn_event(Some(&tx), "cloud-session", "acp-root", &frame);

        let got = rx.try_recv().expect("thinking must reach session/live");
        assert_eq!(got.agent_id, "cloud-session");
        assert_eq!(got.child_acp_session_id, None);
        match got.event.event {
            Some(amux::acp_event::Event::Thinking(t)) => {
                assert_eq!(t.text, "let me look that up");
            }
            other => panic!("expected thinking, got {other:?}"),
        }
    }

    #[test]
    fn stamps_child_acp_session_id_for_subagent_frames() {
        let (tx, mut rx) = mpsc::channel(8);
        let frame = thinking_frame("acp-child", "nested plan");
        forward_checked_out_turn_event(Some(&tx), "cloud-session", "acp-root", &frame);

        let got = rx.try_recv().expect("subagent thinking must be forwarded");
        assert_eq!(got.child_acp_session_id.as_deref(), Some("acp-child"));
    }

    #[test]
    fn missing_live_channel_is_a_noop() {
        let frame = thinking_frame("acp-root", "unused");
        forward_checked_out_turn_event(None, "cloud-session", "acp-root", &frame);
    }
}
