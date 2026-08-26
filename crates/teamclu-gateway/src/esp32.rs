//! ESP32 voice terminal as a [`ChannelDriver`].
//!
//! The kernel sees text only. STT/TTS and MQTT stay in the injected
//! [`Esp32Downlink`] (wired from the daemon later). This crate must not
//! depend on either.
//!
//! ## Streaming edit = keep speaking (design §4.3)
//!
//! Core calls `deliver` once, then `update` with the growing full text.
//! Voice cannot rewrite what already played, so the driver keeps a playback
//! cursor and a [`SentenceChunker`], and only sends newly completed sentences
//! via [`Esp32Downlink::speak_delta`]. A final `update(..., Some(end))` flushes
//! the tail and [`Esp32Downlink::end_turn`].
//!
//! `SentenceChunker` is copied here (not imported from the daemon's
//! `voice/tts.rs`) so the gateway crate stays free of daemon deps — design
//! "chunker lives in the driver".

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::driver::{
    ChannelCaps, ChannelDriver, ChannelId, Conversation, DeliveryId, DriverError, ExternalSender,
    OutboundMessage, Threading, TurnEnd,
};

/// How the daemon speaks and publishes ctl to one device.
///
/// Injected so the gateway crate stays free of MQTT and NLS.
#[async_trait]
pub trait Esp32Downlink: Send + Sync {
    /// One-shot speak (open TTS, play `text`, `spk_end`). Used by non-streaming
    /// callers and by [`Esp32Driver::deliver`] when the message is already
    /// complete (e.g. Core `say`).
    async fn speak(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError>;

    /// Feed one sentence-sized chunk without ending the turn. Opens the TTS
    /// stream on the first call; keeps it open until [`Self::end_turn`].
    async fn speak_delta(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError>;

    /// Flush remaining audio and close the turn. `TurnEnd::NoAnswer` shows the
    /// device error face (`no_agent` / 电脑没醒着) instead of a quiet idle.
    async fn end_turn(&self, device: &Esp32Target, end: TurnEnd) -> Result<(), DriverError>;

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

/// Per-delivery playback cursor (design §4.3).
struct Playback {
    target: Esp32Target,
    /// How many chars of the cumulative full text have been fed to `chunker`.
    cursor: usize,
    chunker: SentenceChunker,
}

pub struct Esp32Driver {
    pub downlink: Arc<dyn Esp32Downlink>,
    pub team_id: String,
    playback: Mutex<HashMap<String, Playback>>,
}

impl Esp32Driver {
    pub fn new(downlink: Arc<dyn Esp32Downlink>, team_id: impl Into<String>) -> Self {
        Self {
            downlink,
            team_id: team_id.into(),
            playback: Mutex::new(HashMap::new()),
        }
    }

    /// Feed `full_text[cursor..]` into the chunker; return ready pieces and
    /// advance the cursor. When `flush`, also take [`SentenceChunker::finish`].
    fn advance(
        playback: &mut Playback,
        full_text: &str,
        flush: bool,
    ) -> Result<Vec<String>, DriverError> {
        let already = playback.cursor;
        let total = full_text.chars().count();
        if total < already {
            return Err(DriverError::Payload(format!(
                "esp32 update text shrank (cursor={already}, chars={total})"
            )));
        }
        let suffix: String = full_text.chars().skip(already).collect();
        playback.cursor = total;
        let mut pieces = playback.chunker.push(&suffix);
        if flush {
            if let Some(tail) = playback.chunker.finish() {
                pieces.push(tail);
            }
        }
        Ok(pieces)
    }
}

/// Splits streamed agent text into pieces worth synthesising.
///
/// Copied from `apps/daemon/src/voice/tts.rs` so the driver owns the render
/// strategy without depending on the daemon crate.
struct SentenceChunker {
    buf: String,
    max_chars: usize,
}

impl Default for SentenceChunker {
    fn default() -> Self {
        Self {
            buf: String::new(),
            max_chars: 60,
        }
    }
}

impl SentenceChunker {
    fn push(&mut self, delta: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ch in delta.chars() {
            self.buf.push(ch);
            let boundary = matches!(ch, '。' | '！' | '？' | '；' | '\n' | '.' | '!' | '?' | ';');
            if boundary || self.buf.chars().count() >= self.max_chars {
                let piece = self.buf.trim().to_string();
                if !piece.is_empty() {
                    out.push(piece);
                }
                self.buf.clear();
            }
        }
        out
    }

    fn finish(&mut self) -> Option<String> {
        let piece = self.buf.trim().to_string();
        self.buf.clear();
        if piece.is_empty() {
            None
        } else {
            Some(piece)
        }
    }
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
            // Phase 2: Core streams growing text; we speak the delta.
            streaming_edit: true,
            media_upload: false,
            interactive: true,
            threading: Threading::Inline,
            // Voice has no message-length notion — `0` means do not split.
            max_chars: 0,
            // 180, the same floor every other channel gets (`ChannelCaps::MINIMAL`).
            //
            // The design doc asked for 60 on the reasoning that the device gives
            // up after 8 s anyway. That reasoning was wrong twice over: this
            // value is not a queue property here — the ESP32 sink bypasses
            // `SessionQueue` — it is wired straight into `AgentTurns::turn_timeout`,
            // so it caps the *agent*. And the device's 8 s deadline is cancelled
            // the moment `thinking` arrives (`onAgentThinking` → `clearDeadline`),
            // so there is nothing short about what the device will tolerate.
            //
            // At 60 s any question a coding agent works on for a minute came back
            // as `CoreError::Turn` → "电脑没醒着", with the agent alive and still
            // working.
            turn_timeout_secs: 180,
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
        // Unique per deliver so concurrent turns on the same device do not
        // share a cursor (device_id alone collided under streaming).
        let id = DeliveryId(uuid::Uuid::new_v4().to_string());

        if msg.text.is_empty() {
            // Streaming placeholder: Core will `update` as the reply grows.
            self.playback.lock().unwrap().insert(
                id.0.clone(),
                Playback {
                    target,
                    cursor: 0,
                    chunker: SentenceChunker::default(),
                },
            );
            return Ok(id);
        }

        // One-shot (Core `say`, proactive): full speak + end. No update follows.
        self.downlink.speak(&target, &msg.text).await?;
        self.playback.lock().unwrap().insert(
            id.0.clone(),
            Playback {
                target,
                cursor: msg.text.chars().count(),
                chunker: SentenceChunker::default(),
            },
        );
        Ok(id)
    }

    async fn update(
        &self,
        id: &DeliveryId,
        text: &str,
        end: Option<TurnEnd>,
    ) -> Result<(), DriverError> {
        let (target, pieces) = {
            let mut map = self.playback.lock().unwrap();
            let playback = map.get_mut(&id.0).ok_or_else(|| {
                DriverError::Payload(format!("esp32 update unknown delivery id {}", id.0))
            })?;
            let flush = end.is_some();
            let pieces = Self::advance(playback, text, flush)?;
            (playback.target.clone(), pieces)
        };

        for piece in &pieces {
            self.downlink.speak_delta(&target, piece).await?;
        }

        if let Some(end) = end {
            self.downlink.end_turn(&target, end).await?;
            self.playback.lock().unwrap().remove(&id.0);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::{ConversationKind, InteractiveQuestion};

    #[derive(Default)]
    struct FakeDownlink {
        speaks: Mutex<Vec<(String, String)>>,
        deltas: Mutex<Vec<(String, String)>>,
        ends: Mutex<Vec<(String, TurnEnd)>>,
    }

    #[async_trait]
    impl Esp32Downlink for FakeDownlink {
        async fn speak(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError> {
            self.speaks
                .lock()
                .unwrap()
                .push((device.device_id.clone(), text.to_string()));
            Ok(())
        }

        async fn speak_delta(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError> {
            self.deltas
                .lock()
                .unwrap()
                .push((device.device_id.clone(), text.to_string()));
            Ok(())
        }

        async fn end_turn(&self, device: &Esp32Target, end: TurnEnd) -> Result<(), DriverError> {
            self.ends
                .lock()
                .unwrap()
                .push((device.device_id.clone(), end));
            Ok(())
        }

        async fn publish_ctl(&self, _device: &Esp32Target, _json: &str) -> Result<(), DriverError> {
            Ok(())
        }
    }

    fn driver(downlink: Arc<FakeDownlink>) -> Esp32Driver {
        Esp32Driver::new(downlink, "team-1")
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
    fn caps_are_streaming_voice() {
        let d = driver(Arc::new(FakeDownlink::default()));
        let caps = d.caps();
        assert_eq!(d.id(), "esp32");
        assert!(caps.streaming_edit);
        assert!(caps.interactive);
        assert!(!caps.media_upload);
        assert_eq!(caps.threading, Threading::Inline);
        assert_eq!(caps.max_chars, 0);
        assert_eq!(caps.turn_timeout_secs, 180);
    }

    #[tokio::test]
    async fn deliver_empty_opens_playback_without_speaking() {
        let downlink = Arc::new(FakeDownlink::default());
        let d = driver(Arc::clone(&downlink));
        let id = d
            .deliver(
                &conversation(),
                Some("team-1/actor-1/dev-99"),
                &OutboundMessage::default(),
            )
            .await
            .expect("deliver");

        assert!(!id.0.is_empty());
        assert_ne!(id.0, "dev-99", "delivery id must not be the device id");
        assert!(downlink.speaks.lock().unwrap().is_empty());
        assert!(downlink.deltas.lock().unwrap().is_empty());
        assert!(d.playback.lock().unwrap().contains_key(&id.0));
    }

    #[tokio::test]
    async fn deliver_nonempty_is_oneshot_speak() {
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

        let _id = d
            .deliver(&conversation(), Some("team-1/actor-1/dev-99"), &msg)
            .await
            .expect("deliver");

        assert_eq!(
            downlink.speaks.lock().unwrap().clone(),
            vec![("dev-99".into(), "hello from the agent".into())]
        );
        assert!(downlink.deltas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deliver_then_update_streams_sentence_deltas_in_order() {
        let downlink = Arc::new(FakeDownlink::default());
        let d = driver(Arc::clone(&downlink));
        let id = d
            .deliver(
                &conversation(),
                Some("team-1/actor-1/dev-99"),
                &OutboundMessage::default(),
            )
            .await
            .expect("deliver");

        d.update(&id, "你好", None).await.expect("partial");
        assert!(
            downlink.deltas.lock().unwrap().is_empty(),
            "no sentence boundary yet"
        );

        d.update(&id, "你好。世界", None).await.expect("grows");
        assert_eq!(
            downlink.deltas.lock().unwrap().clone(),
            vec![("dev-99".into(), "你好。".into())]
        );

        d.update(&id, "你好。世界！完了", Some(TurnEnd::Answered))
            .await
            .expect("end");

        assert_eq!(
            downlink.deltas.lock().unwrap().clone(),
            vec![
                ("dev-99".into(), "你好。".into()),
                ("dev-99".into(), "世界！".into()),
                ("dev-99".into(), "完了".into()),
            ]
        );
        assert_eq!(
            downlink.ends.lock().unwrap().clone(),
            vec![("dev-99".into(), TurnEnd::Answered)]
        );
        assert!(
            !d.playback.lock().unwrap().contains_key(&id.0),
            "playback cleared after end"
        );
    }

    #[tokio::test]
    async fn update_no_answer_ends_with_no_answer() {
        let downlink = Arc::new(FakeDownlink::default());
        let d = driver(Arc::clone(&downlink));
        let id = d
            .deliver(
                &conversation(),
                Some("team-1/actor-1/dev-99"),
                &OutboundMessage::default(),
            )
            .await
            .expect("deliver");

        d.update(&id, "", Some(TurnEnd::NoAnswer))
            .await
            .expect("end");

        assert!(downlink.deltas.lock().unwrap().is_empty());
        assert_eq!(
            downlink.ends.lock().unwrap().clone(),
            vec![("dev-99".into(), TurnEnd::NoAnswer)]
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

    #[test]
    fn chunker_flushes_on_chinese_punctuation() {
        let mut c = SentenceChunker::default();
        assert!(c.push("今天").is_empty());
        assert_eq!(c.push("天气不错。"), vec!["今天天气不错。"]);
    }
}
