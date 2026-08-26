//! ESP32 voice terminal as a [`ChannelDriver`].
//!
//! The kernel sees text only. STT/TTS and MQTT stay in the injected
//! [`Esp32Downlink`] (wired from the daemon later). This crate must not
//! depend on either.

use std::sync::Arc;

use async_trait::async_trait;

use crate::driver::{
    ChannelCaps, ChannelDriver, ChannelId, Conversation, DeliveryId, DriverError, ExternalSender,
    OutboundMessage, Threading,
};

/// How the daemon speaks and publishes ctl to one device.
///
/// Injected so the gateway crate stays free of MQTT and NLS.
#[async_trait]
pub trait Esp32Downlink: Send + Sync {
    async fn speak(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError>;
    async fn publish_ctl(&self, device: &Esp32Target, json: &str) -> Result<(), DriverError>;
}

/// MQTT addressing for one StopWatch: team + paired actor + device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Esp32Target {
    pub team_id: String,
    /// `conversation.id` — the pairing product, not the MAC.
    pub actor_id: String,
    pub device_id: String,
}

pub struct Esp32Driver {
    pub downlink: Arc<dyn Esp32Downlink>,
    pub team_id: String,
}

/// Last six characters of a device id (or the whole id if shorter).
fn short_device(id: &str) -> &str {
    match id.char_indices().nth_back(5) {
        Some((i, _)) => &id[i..],
        None => id,
    }
}

/// `reply_context` from inbound: `{team_id}/{actor_id}/{device_id}`.
fn parse_reply_context(reply_context: &str) -> Result<Esp32Target, DriverError> {
    let mut parts = reply_context.split('/');
    let team_id = parts.next().filter(|s| !s.is_empty());
    let actor_id = parts.next().filter(|s| !s.is_empty());
    let device_id = parts.next().filter(|s| !s.is_empty());
    let extra = parts.next();
    match (team_id, actor_id, device_id, extra) {
        (Some(team_id), Some(actor_id), Some(device_id), None) => Ok(Esp32Target {
            team_id: team_id.to_string(),
            actor_id: actor_id.to_string(),
            device_id: device_id.to_string(),
        }),
        _ => Err(DriverError::Payload(format!(
            "esp32 reply_context must be team/actor/device, got {reply_context:?}"
        ))),
    }
}

#[async_trait]
impl ChannelDriver for Esp32Driver {
    fn id(&self) -> ChannelId {
        "esp32"
    }

    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            // Phase 1: one-shot speak. Streaming edit lands in Phase 2.
            streaming_edit: false,
            media_upload: false,
            interactive: true,
            threading: Threading::Inline,
            // Voice has no message-length notion — `0` means do not split.
            max_chars: 0,
            turn_timeout_secs: 60,
        }
    }

    fn binding(&self, conversation: &Conversation) -> String {
        format!("esp32://{}/{}", self.team_id, conversation.id)
    }

    fn sender_urn(&self, _conversation: &Conversation, sender: &ExternalSender) -> String {
        format!("esp32:{}", sender.external_id)
    }

    fn session_title(&self, _conversation: &Conversation, sender: &ExternalSender) -> String {
        format!("StopWatch {}", short_device(&sender.external_id))
    }

    async fn deliver(
        &self,
        _to: &Conversation,
        reply_context: Option<&str>,
        msg: &OutboundMessage,
    ) -> Result<DeliveryId, DriverError> {
        // Device id is not on Conversation — inbound must carry
        // `team/actor/device` so we can address MQTT. Phase 3 will also
        // read `msg.question` for a ctl menu; for now speak the text
        // (which usually includes the prompt when a question is present).
        let Some(ctx) = reply_context else {
            return Err(DriverError::Payload(
                "esp32 deliver requires reply_context team/actor/device".into(),
            ));
        };
        let target = parse_reply_context(ctx)?;
        self.downlink.speak(&target, &msg.text).await?;
        Ok(DeliveryId(target.device_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::{ConversationKind, InteractiveQuestion};
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeDownlink {
        speaks: Mutex<Vec<(String, String, String, String)>>,
    }

    #[async_trait]
    impl Esp32Downlink for FakeDownlink {
        async fn speak(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError> {
            self.speaks.lock().unwrap().push((
                device.team_id.clone(),
                device.actor_id.clone(),
                device.device_id.clone(),
                text.to_string(),
            ));
            Ok(())
        }

        async fn publish_ctl(&self, _device: &Esp32Target, _json: &str) -> Result<(), DriverError> {
            Ok(())
        }
    }

    fn driver(downlink: Arc<FakeDownlink>) -> Esp32Driver {
        Esp32Driver {
            downlink,
            team_id: "team-1".into(),
        }
    }

    fn conversation() -> Conversation {
        Conversation {
            channel: "esp32",
            bot_id: None,
            kind: ConversationKind::Direct,
            id: "actor-1".into(),
        }
    }

    fn sender(external_id: &str) -> ExternalSender {
        ExternalSender {
            external_id: external_id.into(),
            display_name: "StopWatch".into(),
            email: None,
        }
    }

    #[test]
    fn binding_sender_urn_and_session_title_shapes() {
        let d = driver(Arc::new(FakeDownlink::default()));
        let c = conversation();
        assert_eq!(d.binding(&c), "esp32://team-1/actor-1");
        assert_eq!(
            d.sender_urn(&c, &sender("aabbccddeeff")),
            "esp32:aabbccddeeff"
        );
        assert_eq!(
            d.session_title(&c, &sender("aabbccddeeff")),
            "StopWatch ddeeff"
        );
        assert_eq!(d.session_title(&c, &sender("abc")), "StopWatch abc");
        assert_eq!(d.session_title(&c, &sender("abcdef")), "StopWatch abcdef");
    }

    #[test]
    fn caps_are_phase1_voice() {
        let d = driver(Arc::new(FakeDownlink::default()));
        let caps = d.caps();
        assert_eq!(d.id(), "esp32");
        assert!(!caps.streaming_edit);
        assert!(caps.interactive);
        assert!(!caps.media_upload);
        assert_eq!(caps.threading, Threading::Inline);
        assert_eq!(caps.max_chars, 0);
        assert_eq!(caps.turn_timeout_secs, 60);
    }

    #[tokio::test]
    async fn deliver_speaks_text_and_returns_delivery_id() {
        let downlink = Arc::new(FakeDownlink::default());
        let d = driver(Arc::clone(&downlink));
        let msg = OutboundMessage {
            text: "hello from the agent".into(),
            question: Some(InteractiveQuestion {
                question_id: "q1".into(),
                prompt: "pick one".into(),
                options: vec!["A".into(), "B".into()],
            }),
            ..Default::default()
        };

        let id = d
            .deliver(&conversation(), Some("team-1/actor-1/dev-99"), &msg)
            .await
            .expect("deliver");

        assert_eq!(id, DeliveryId("dev-99".into()));
        let speaks = downlink.speaks.lock().unwrap().clone();
        assert_eq!(
            speaks,
            vec![(
                "team-1".into(),
                "actor-1".into(),
                "dev-99".into(),
                "hello from the agent".into(),
            )]
        );
    }

    #[tokio::test]
    async fn deliver_without_reply_context_fails() {
        let d = driver(Arc::new(FakeDownlink::default()));
        let msg = OutboundMessage {
            text: "hello".into(),
            ..Default::default()
        };
        let err = d
            .deliver(&conversation(), None, &msg)
            .await
            .expect_err("missing reply_context");
        assert!(matches!(err, DriverError::Payload(_)));
    }
}
