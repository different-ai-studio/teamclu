use chrono::Utc;
use prost::Message;
use std::sync::Arc;
use teamclu_transport::{DeliveryGuarantee, MessagePublisher};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::mqtt::Topics;
use crate::runtime::acp_live_transport::prepare_acp_event_body_for_live;
use crate::proto::amux;
use crate::proto::amux::Envelope as AmuxEnvelope;
use crate::proto::teamclu::{IdeaEvent, LiveEventEnvelope, Participant, SessionMessageEnvelope};

const RUMQTTC_DEFAULT_PACKET_LIMIT_BYTES: usize = 10 * 1024;
const LIVE_EVENT_WARN_BYTES: usize = 512 * 1024;

/// Re-export: the type lives in the HTTP module so the standalone-compiled
/// HTTP test tree doesn't need `teamclu`.
pub use crate::http::live_events::LiveTeeEvent;

#[derive(Clone)]
pub struct LivePublisher {
    client: Arc<dyn MessagePublisher>,
    topics: Topics,
    /// Local fast-path tee. When set, every session/live publish is also
    /// broadcast to in-process subscribers (`GET /v1/live/events` SSE) BEFORE
    /// the MQTT publish, so a local UI is never gated on broker latency.
    local_tee: Option<tokio::sync::broadcast::Sender<LiveTeeEvent>>,
}

impl LivePublisher {
    pub fn new(client: Arc<dyn MessagePublisher>, team_id: String, actor_id: String) -> Self {
        Self {
            client,
            topics: Topics::new(&team_id, &actor_id),
            local_tee: None,
        }
    }

    pub fn set_local_tee(&mut self, tx: tokio::sync::broadcast::Sender<LiveTeeEvent>) {
        self.local_tee = Some(tx);
    }

    pub async fn publish_message(
        &self,
        session_id: &str,
        actor_id: &str,
        envelope: &SessionMessageEnvelope,
    ) -> crate::error::Result<()> {
        self.publish_with(
            "message.created",
            session_id,
            actor_id,
            envelope.encode_to_vec(),
            DeliveryGuarantee::AtLeastOnce,
        )
        .await
    }

    pub async fn publish_idea_event(
        &self,
        event_type: &str,
        session_id: &str,
        actor_id: &str,
        event: &IdeaEvent,
    ) -> crate::error::Result<()> {
        self.publish_with(
            event_type,
            session_id,
            actor_id,
            event.encode_to_vec(),
            DeliveryGuarantee::AtLeastOnce,
        )
        .await
    }

    /// Publishes an ACP `Envelope` (output deltas, thinking, tool_use, etc.)
    /// to the session/{id}/live channel. Wraps the envelope bytes inside a
    /// `LiveEventEnvelope` with `event_type = "acp.event"`. iOS subscribes by
    /// session_id (which it owns), so this replaces the legacy per-runtime
    /// `runtime/{id}/events` topic that required iOS to know the daemon's
    /// actor_id and the daemon-generated runtime_id.
    pub async fn publish_acp_event(
        &self,
        session_id: &str,
        actor_id: &str,
        envelope: &AmuxEnvelope,
    ) -> crate::error::Result<()> {
        self.publish_with(
            "acp.event",
            session_id,
            actor_id,
            prepare_acp_event_body_for_live(envelope),
            acp_event_guarantee(envelope),
        )
        .await
    }

    /// Announce an adopted session title so clients can update their session
    /// lists in place (no refetch). Body is the UTF-8 title.
    pub async fn publish_session_title(
        &self,
        session_id: &str,
        actor_id: &str,
        title: &str,
    ) -> crate::error::Result<()> {
        self.publish_with(
            "session.title_updated",
            session_id,
            actor_id,
            title.as_bytes().to_vec(),
            DeliveryGuarantee::AtLeastOnce,
        )
        .await
    }

    pub async fn publish_presence_event(
        &self,
        event_type: &str,
        session_id: &str,
        participant: &Participant,
    ) -> crate::error::Result<()> {
        self.publish_with(
            event_type,
            session_id,
            &participant.actor_id,
            participant.encode_to_vec(),
            DeliveryGuarantee::AtLeastOnce,
        )
        .await
    }

    async fn publish_with(
        &self,
        event_type: &str,
        session_id: &str,
        actor_id: &str,
        body: Vec<u8>,
        guarantee: DeliveryGuarantee,
    ) -> crate::error::Result<()> {
        let body_len = body.len();
        let payload = LiveEventEnvelope {
            event_id: Uuid::new_v4().to_string(),
            event_type: event_type.to_string(),
            session_id: session_id.to_string(),
            actor_id: actor_id.to_string(),
            sent_at: Utc::now().timestamp(),
            body,
        }
        .encode_to_vec();
        let topic = self.topics.session_live(session_id);
        let payload_len = payload.len();

        // Local fast-path tee: deliver to in-process SSE subscribers first so
        // the local UI is independent of broker RTT. Send errors just mean no
        // subscriber is connected — ignore.
        if let Some(tee) = &self.local_tee {
            let _ = tee.send(LiveTeeEvent {
                topic: topic.clone(),
                payload: payload.clone(),
            });
        }

        if payload_len > LIVE_EVENT_WARN_BYTES {
            warn!(
                event_type,
                session_id,
                actor_id,
                topic,
                payload_len,
                body_len,
                "large MQTT session/live publish"
            );
        } else if payload_len > RUMQTTC_DEFAULT_PACKET_LIMIT_BYTES {
            debug!(
                event_type,
                session_id,
                actor_id,
                topic,
                payload_len,
                body_len,
                "MQTT session/live publish exceeds rumqttc default packet cap"
            );
        }

        self.client
            .publish(&topic, payload, false, guarantee)
            .await?;
        Ok(())
    }
}

/// Selects the MQTT delivery guarantee for an ACP `Envelope`.
///
/// Streaming text deltas are transient: the finalized AGENT_REPLY
/// (message.created, QoS1) and the backend row are the durable copies, and
/// every client reconciles the full text on finalize. Losing one delta on a
/// flaky link costs a few characters of live preview until finalize corrects
/// it — not worth a per-packet PUBACK round-trip, so Output/Thinking go
/// AtMostOnce (QoS0). Tool calls / status changes / permission requests /
/// errors stay AtLeastOnce (QoS1): they drive client state machines (flush,
/// permission prompts, tool cards).
fn acp_event_guarantee(envelope: &AmuxEnvelope) -> DeliveryGuarantee {
    let transient = matches!(
        &envelope.payload,
        Some(amux::envelope::Payload::AcpEvent(ev))
            if matches!(
                &ev.event,
                Some(amux::acp_event::Event::Output(_))
                    | Some(amux::acp_event::Event::Thinking(_))
            )
    );
    if transient {
        DeliveryGuarantee::AtMostOnce
    } else {
        DeliveryGuarantee::AtLeastOnce
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use teamclu_transport::{IncomingFrame, PublisherError};

    /// Records the `DeliveryGuarantee` of every `publish` call so tests can
    /// assert the QoS chosen by `LivePublisher`.
    #[derive(Default)]
    struct RecordingPublisher {
        calls: Mutex<Vec<(DeliveryGuarantee, Vec<u8>)>>,
    }

    impl RecordingPublisher {
        fn guarantees(&self) -> Vec<DeliveryGuarantee> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(delivery, _)| delivery.clone())
                .collect()
        }

        fn payloads(&self) -> Vec<Vec<u8>> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(_, payload)| payload.clone())
                .collect()
        }
    }

    #[async_trait]
    impl MessagePublisher for RecordingPublisher {
        async fn publish(
            &self,
            _topic: &str,
            payload: Vec<u8>,
            _retain: bool,
            delivery: DeliveryGuarantee,
        ) -> Result<(), PublisherError> {
            self.calls.lock().unwrap().push((delivery, payload));
            Ok(())
        }

        async fn subscribe(
            &self,
            _topic: &str,
            _delivery: DeliveryGuarantee,
        ) -> Result<(), PublisherError> {
            unimplemented!("subscribe not used in LivePublisher tests")
        }

        async fn unsubscribe(&self, _topic: &str) -> Result<(), PublisherError> {
            unimplemented!("unsubscribe not used in LivePublisher tests")
        }
    }

    fn acp_envelope(event: amux::acp_event::Event) -> AmuxEnvelope {
        AmuxEnvelope {
            payload: Some(amux::envelope::Payload::AcpEvent(amux::AcpEvent {
                event: Some(event),
                model: String::new(),
            })),
            ..Default::default()
        }
    }

    fn publisher() -> (Arc<RecordingPublisher>, LivePublisher) {
        let recorder = Arc::new(RecordingPublisher::default());
        let live = LivePublisher::new(
            recorder.clone() as Arc<dyn MessagePublisher>,
            "team-1".to_string(),
            "actor-1".to_string(),
        );
        (recorder, live)
    }

    #[test]
    fn output_delta_is_transient_qos0() {
        let env = acp_envelope(amux::acp_event::Event::Output(amux::AcpOutput {
            text: "hi".to_string(),
            ..Default::default()
        }));
        assert_eq!(acp_event_guarantee(&env), DeliveryGuarantee::AtMostOnce);
    }

    #[test]
    fn thinking_delta_is_transient_qos0() {
        let env = acp_envelope(amux::acp_event::Event::Thinking(amux::AcpThinking {
            text: "pondering".to_string(),
        }));
        assert_eq!(acp_event_guarantee(&env), DeliveryGuarantee::AtMostOnce);
    }

    #[test]
    fn tool_use_is_control_qos1() {
        let env = acp_envelope(amux::acp_event::Event::ToolUse(amux::AcpToolUse::default()));
        assert_eq!(acp_event_guarantee(&env), DeliveryGuarantee::AtLeastOnce);
    }

    #[test]
    fn status_change_is_control_qos1() {
        let env = acp_envelope(amux::acp_event::Event::StatusChange(
            amux::AcpStatusChange::default(),
        ));
        assert_eq!(acp_event_guarantee(&env), DeliveryGuarantee::AtLeastOnce);
    }

    #[tokio::test]
    async fn publish_acp_output_uses_qos0() {
        let (recorder, live) = publisher();
        let env = acp_envelope(amux::acp_event::Event::Output(amux::AcpOutput {
            text: "hi".to_string(),
            ..Default::default()
        }));
        live.publish_acp_event("session-1", "actor-1", &env)
            .await
            .unwrap();
        assert_eq!(recorder.guarantees(), vec![DeliveryGuarantee::AtMostOnce]);
    }

    #[tokio::test]
    async fn live_event_id_is_on_wire_for_durable_replay_dedup() {
        let (recorder, live) = publisher();
        let env = acp_envelope(amux::acp_event::Event::Output(amux::AcpOutput {
            text: "hi".to_string(),
            ..Default::default()
        }));
        live.publish_acp_event("session-1", "actor-1", &env)
            .await
            .unwrap();

        let payload = recorder.payloads().pop().expect("published payload");
        let wire = LiveEventEnvelope::decode(payload.as_slice()).unwrap();
        assert!(!wire.event_id.is_empty());
        assert_eq!(
            crate::mqtt::subscriber::stable_message_id(&IncomingFrame {
                topic: "amux/team-1/session/session-1/live".to_string(),
                payload,
                retained: false,
            }),
            Some(wire.event_id)
        );
    }

    #[tokio::test]
    async fn publish_acp_thinking_uses_qos0() {
        let (recorder, live) = publisher();
        let env = acp_envelope(amux::acp_event::Event::Thinking(amux::AcpThinking {
            text: "pondering".to_string(),
        }));
        live.publish_acp_event("session-1", "actor-1", &env)
            .await
            .unwrap();
        assert_eq!(recorder.guarantees(), vec![DeliveryGuarantee::AtMostOnce]);
    }

    #[tokio::test]
    async fn publish_acp_tool_use_uses_qos1() {
        let (recorder, live) = publisher();
        let env = acp_envelope(amux::acp_event::Event::ToolUse(amux::AcpToolUse::default()));
        live.publish_acp_event("session-1", "actor-1", &env)
            .await
            .unwrap();
        assert_eq!(recorder.guarantees(), vec![DeliveryGuarantee::AtLeastOnce]);
    }

    #[tokio::test]
    async fn publish_acp_status_change_uses_qos1() {
        let (recorder, live) = publisher();
        let env = acp_envelope(amux::acp_event::Event::StatusChange(
            amux::AcpStatusChange::default(),
        ));
        live.publish_acp_event("session-1", "actor-1", &env)
            .await
            .unwrap();
        assert_eq!(recorder.guarantees(), vec![DeliveryGuarantee::AtLeastOnce]);
    }

    #[tokio::test]
    async fn publish_message_stays_qos1() {
        let (recorder, live) = publisher();
        let envelope = SessionMessageEnvelope::default();
        live.publish_message("session-1", "actor-1", &envelope)
            .await
            .unwrap();
        assert_eq!(recorder.guarantees(), vec![DeliveryGuarantee::AtLeastOnce]);
    }
}
