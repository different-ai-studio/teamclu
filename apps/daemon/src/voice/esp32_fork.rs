//! VoiceRouter → Core fork for `[channels.esp32] use_core = true`.
//!
//! After a final chat transcript, builds an [`InboundMessage`] (design §5.1)
//! and calls [`Esp32InboundSink::accept`]. Note intent never reaches this
//! sink — [`super::note_sink::NoteSink`] stays on the FanOut for both flags
//! (design §7.3).
//!
//! ## Phase 1 device identity
//!
//! MQTT topics are still `team/daemon_actor/voice/*` (device shares the
//! daemon actor until pairing). `conversation.id` is the topic `actor_id`.
//! `device_id` prefers a single configured `[[channels.esp32.devices]]`
//! entry; otherwise it equals `actor_id`.

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::{
    Conversation, ConversationKind, ExternalSender, InboundMessage, InboundSink,
};
use tracing::{error, info};

use super::adapter::{DeviceKey, TranscriptSink};
use super::spk::ReplySpeaker;
use super::stt::Intent;
use crate::config::Esp32Channel;

/// Resolves `(device_id, display_name)` for Phase 1 (pre-pairing).
///
/// Prefer the sole roster entry when exactly one device is configured;
/// otherwise look up by `device_id == actor_id`; fall back to `actor_id` /
/// `"StopWatch"`.
pub fn resolve_esp32_device(cfg: &Esp32Channel, actor_id: &str) -> (String, String) {
    if cfg.devices.len() == 1 {
        let d = &cfg.devices[0];
        return (d.device_id.clone(), d.name.clone());
    }
    if let Some(d) = cfg.devices.iter().find(|d| d.device_id == actor_id) {
        return (d.device_id.clone(), d.name.clone());
    }
    (actor_id.to_string(), "StopWatch".to_string())
}

/// Builds the gateway inbound message for one chat final (design §5.1).
pub fn build_esp32_inbound_message(
    team_id: &str,
    actor_id: &str,
    device_id: &str,
    device_name: &str,
    boot_id: &str,
    seq: u64,
    text: &str,
) -> InboundMessage {
    InboundMessage {
        conversation: Conversation {
            channel: "esp32",
            bot_id: None,
            kind: ConversationKind::Direct,
            // Pairing product — today the MQTT actor (daemon actor on bench).
            id: actor_id.to_string(),
        },
        sender: ExternalSender {
            external_id: device_id.to_string(),
            display_name: device_name.to_string(),
            email: None,
        },
        external_message_id: format!("esp32:{device_id}:{boot_id}:{seq}"),
        text: text.to_string(),
        attachments: vec![],
        addressed_to_bot: true,
        quoted_text: None,
        // Carry device addressing for Esp32Driver::deliver MQTT topics.
        reply_context: Some(format!("{team_id}/{actor_id}/{device_id}")),
    }
}

/// [`TranscriptSink`] that forks chat finals into [`Esp32InboundSink`].
pub struct Esp32CoreForkSink {
    inbound: Arc<dyn InboundSink>,
    speaker: Arc<dyn ReplySpeaker>,
    /// Roster + flags used only for device_id / display_name resolution.
    esp32: Esp32Channel,
}

impl Esp32CoreForkSink {
    pub fn new(
        inbound: Arc<dyn InboundSink>,
        speaker: Arc<dyn ReplySpeaker>,
        esp32: Esp32Channel,
    ) -> Self {
        Self {
            inbound,
            speaker,
            esp32,
        }
    }
}

#[async_trait]
impl TranscriptSink for Esp32CoreForkSink {
    async fn on_final(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        session_id: Option<&str>,
        text: &str,
    ) {
        self.on_final_turn(team_id, actor_id, intent, session_id, text, None, 0)
            .await;
    }

    async fn on_final_turn(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        _session_id: Option<&str>,
        text: &str,
        boot_id: Option<&str>,
        seq: u64,
    ) {
        if intent != Intent::Chat {
            return;
        }
        if text.trim().is_empty() {
            info!(
                team_id,
                actor_id, "voice: empty chat transcript on core path, nothing to ask"
            );
            return;
        }

        let key = DeviceKey {
            team_id: team_id.to_string(),
            actor_id: actor_id.to_string(),
        };

        let Some(boot_id) = boot_id.filter(|b| !b.is_empty()) else {
            error!(
                team_id,
                actor_id, seq, "voice: use_core chat final missing boot_id; refusing accept"
            );
            self.speaker
                .fail(
                    &key,
                    "missing_boot_id",
                    "turn_start must carry boot_id when use_core is enabled",
                )
                .await;
            return;
        };

        let (device_id, device_name) = resolve_esp32_device(&self.esp32, actor_id);

        // Design §5.4: thinking before Core — speak_text does not send it.
        self.speaker.thinking(&key).await;

        let msg = build_esp32_inbound_message(
            team_id,
            actor_id,
            &device_id,
            &device_name,
            boot_id,
            seq,
            text,
        );
        info!(
            team_id,
            actor_id,
            device_id = %device_id,
            external_message_id = %msg.external_message_id,
            "voice: forking chat final to Esp32InboundSink"
        );
        self.inbound.accept(msg).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Esp32DeviceEntry;
    use crate::voice::adapter::FanOutSink;
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tokio::sync::Mutex as AsyncMutex;

    struct RecordingInbound {
        accepted: AsyncMutex<Vec<InboundMessage>>,
    }

    #[async_trait]
    impl InboundSink for RecordingInbound {
        async fn accept(&self, msg: InboundMessage) {
            self.accepted.lock().await.push(msg);
        }
    }

    struct RecordingSpeaker {
        thinking: Mutex<u32>,
        fails: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl ReplySpeaker for RecordingSpeaker {
        async fn begin(&self, _key: DeviceKey, _session_id: uuid::Uuid) {}
        async fn cancel(&self, _key: &DeviceKey) {}
        async fn fail(&self, _key: &DeviceKey, code: &str, message: &str) {
            self.fails
                .lock()
                .push((code.to_string(), message.to_string()));
        }
        async fn thinking(&self, _key: &DeviceKey) {
            *self.thinking.lock() += 1;
        }
    }

    /// Captures chat finals from FanOut for routing assertions.
    struct CaptureChat {
        finals: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl TranscriptSink for CaptureChat {
        async fn on_final(
            &self,
            _team_id: &str,
            _actor_id: &str,
            intent: Intent,
            _session_id: Option<&str>,
            text: &str,
        ) {
            if intent == Intent::Chat {
                self.finals.lock().push(text.to_string());
            }
        }
    }

    fn esp32_cfg(device_id: &str, name: &str) -> Esp32Channel {
        Esp32Channel {
            enabled: true,
            devices: vec![Esp32DeviceEntry {
                device_id: device_id.into(),
                name: name.into(),
                paired_at: None,
            }],
        }
    }

    fn fork(
        inbound: Arc<RecordingInbound>,
        speaker: Arc<RecordingSpeaker>,
    ) -> Esp32CoreForkSink {
        Esp32CoreForkSink::new(inbound, speaker, esp32_cfg("c19518", "工位 StopWatch"))
    }

    #[tokio::test]
    async fn use_core_with_boot_id_accepts_expected_external_message_id() {
        let inbound = Arc::new(RecordingInbound {
            accepted: AsyncMutex::new(Vec::new()),
        });
        let speaker = Arc::new(RecordingSpeaker {
            thinking: Mutex::new(0),
            fails: Mutex::new(Vec::new()),
        });
        let sink = fork(inbound.clone(), speaker.clone());

        sink.on_final_turn(
            "team-1",
            "actor-1",
            Intent::Chat,
            None,
            "今天几号",
            Some("a1b2c3d4"),
            7,
        )
        .await;

        let accepted = inbound.accepted.lock().await;
        assert_eq!(accepted.len(), 1);
        let msg = &accepted[0];
        assert_eq!(msg.external_message_id, "esp32:c19518:a1b2c3d4:7");
        assert_eq!(msg.conversation.id, "actor-1");
        assert_eq!(msg.sender.external_id, "c19518");
        assert_eq!(msg.sender.display_name, "工位 StopWatch");
        assert_eq!(msg.reply_context.as_deref(), Some("team-1/actor-1/c19518"));
        assert_eq!(msg.text, "今天几号");
        assert!(msg.addressed_to_bot);
        assert_eq!(*speaker.thinking.lock(), 1);
        assert!(speaker.fails.lock().is_empty());
    }

    #[tokio::test]
    async fn use_core_missing_boot_id_skips_accept_and_publishes_error() {
        let inbound = Arc::new(RecordingInbound {
            accepted: AsyncMutex::new(Vec::new()),
        });
        let speaker = Arc::new(RecordingSpeaker {
            thinking: Mutex::new(0),
            fails: Mutex::new(Vec::new()),
        });
        let sink = fork(inbound.clone(), speaker.clone());

        sink.on_final_turn(
            "team-1",
            "actor-1",
            Intent::Chat,
            None,
            "今天几号",
            None,
            7,
        )
        .await;

        assert!(inbound.accepted.lock().await.is_empty());
        assert_eq!(*speaker.thinking.lock(), 0);
        let fails = speaker.fails.lock().clone();
        assert_eq!(fails.len(), 1);
        assert_eq!(fails[0].0, "missing_boot_id");
    }

    #[tokio::test]
    async fn fanout_delivers_chat_finals_to_configured_sink() {
        let chat = Arc::new(CaptureChat {
            finals: Mutex::new(Vec::new()),
        });
        let fan = FanOutSink::new(vec![chat.clone()]);
        fan.on_final_turn("t", "a", Intent::Chat, None, "问题", Some("boot"), 1)
            .await;
        assert_eq!(*chat.finals.lock(), vec!["问题"]);
    }

    #[tokio::test]
    async fn note_intent_is_ignored_by_core_fork() {
        let inbound = Arc::new(RecordingInbound {
            accepted: AsyncMutex::new(Vec::new()),
        });
        let speaker = Arc::new(RecordingSpeaker {
            thinking: Mutex::new(0),
            fails: Mutex::new(Vec::new()),
        });
        let sink = fork(inbound.clone(), speaker);
        sink.on_final_turn(
            "team-1",
            "actor-1",
            Intent::Note,
            None,
            "买牛奶",
            Some("boot"),
            1,
        )
        .await;
        assert!(inbound.accepted.lock().await.is_empty());
    }

    #[test]
    fn resolve_device_prefers_single_roster_entry() {
        let cfg = esp32_cfg("mac-tail", "Desk");
        assert_eq!(
            resolve_esp32_device(&cfg, "daemon-actor"),
            ("mac-tail".into(), "Desk".into())
        );
    }

    #[test]
    fn resolve_device_falls_back_to_actor_id() {
        let cfg = Esp32Channel {
            enabled: true,
            devices: vec![],
        };
        assert_eq!(
            resolve_esp32_device(&cfg, "actor-x"),
            ("actor-x".into(), "StopWatch".into())
        );
    }
}
