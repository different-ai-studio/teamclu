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
    InteractiveQuestion, OutboundMessage, Threading, TurnEnd,
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
    ///
    /// `turn` identifies which delivery this belongs to. Without it the
    /// downlink keys only by device, and a superseded turn's `end_turn` tears
    /// down whatever the *current* turn had opened.
    async fn speak_delta(
        &self,
        device: &Esp32Target,
        turn: &str,
        text: &str,
    ) -> Result<(), DriverError>;

    /// Flush remaining audio and close the turn. `TurnEnd::NoAnswer` shows the
    /// device error face (`no_agent` / 电脑没醒着) instead of a quiet idle.
    async fn end_turn(
        &self,
        device: &Esp32Target,
        turn: &str,
        end: TurnEnd,
    ) -> Result<(), DriverError>;

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

/// Options published with a `menu` ctl, keyed by `question_id` so a later
/// `menu_reply` can resolve `index` → option text (design §4.4).
#[derive(Debug, Clone)]
pub struct PendingMenu {
    pub target: Esp32Target,
    pub options: Vec<String>,
}

pub struct Esp32Driver {
    pub downlink: Arc<dyn Esp32Downlink>,
    pub team_id: String,
    playback: Mutex<HashMap<String, Playback>>,
    /// Last MQTT address per conversation actor — mid-turn `question` events
    /// have a binding but no fresh `reply_context`.
    last_targets: Mutex<HashMap<String, Esp32Target>>,
    pending_menus: Mutex<HashMap<String, PendingMenu>>,
}

impl Esp32Driver {
    pub fn new(downlink: Arc<dyn Esp32Downlink>, team_id: impl Into<String>) -> Self {
        Self {
            downlink,
            team_id: team_id.into(),
            playback: Mutex::new(HashMap::new()),
            last_targets: Mutex::new(HashMap::new()),
            pending_menus: Mutex::new(HashMap::new()),
        }
    }

    /// Remember where to address MQTT for this actor (from inbound `reply_context`).
    pub fn remember_target(&self, target: Esp32Target) {
        self.last_targets
            .lock()
            .unwrap()
            .insert(target.actor_id.clone(), target);
    }

    /// Look up the last device for an actor (pairing product = conversation id).
    pub fn last_target_for_actor(&self, actor_id: &str) -> Option<Esp32Target> {
        self.last_targets.lock().unwrap().get(actor_id).cloned()
    }

    /// Resolve a `menu_reply` index against the options we published.
    /// Removes the pending entry (one shot).
    pub fn take_menu_option(
        &self,
        question_id: &str,
        index: usize,
    ) -> Option<(Esp32Target, String)> {
        let mut map = self.pending_menus.lock().unwrap();
        let pending = map.remove(question_id)?;
        let text = pending.options.get(index)?.clone();
        Some((pending.target, text))
    }

    /// Keep at most one playback per device.
    ///
    /// The map is keyed by delivery id and only `update(.., Some(end))` removes
    /// an entry, so three paths leaked one each: a one-shot `deliver` (Core
    /// `say`, an error line, an attachment) is never updated at all, and a
    /// streaming turn that fails returns through `?` before it reaches its end.
    /// In a driver that lives as long as the process that is unbounded growth.
    ///
    /// Bounding by device rather than by count is not a heuristic: this channel
    /// serialises turns per device — a second press cancels the first — so a
    /// device that has started a new delivery can have no use for the old one.
    fn retire_previous_playback(&self, target: &Esp32Target) {
        self.playback
            .lock()
            .unwrap()
            .retain(|_, p| &p.target != target);
    }

    /// Forget a menu nobody answered, and say where it was showing.
    ///
    /// Separate from [`Self::take_menu_option`] because that one answers a
    /// question; this one abandons it. Reusing it with an out-of-range index
    /// would remove the entry and then return `None`, leaving the caller unable
    /// to tell the device its menu is gone — a side effect reported as failure.
    pub fn forget_menu(&self, question_id: &str) -> Option<Esp32Target> {
        self.pending_menus
            .lock()
            .unwrap()
            .remove(question_id)
            .map(|m| m.target)
    }

    /// Publish a raw ctl to one device. Used to retract a withdrawn menu.
    pub async fn publish_ctl_for(
        &self,
        target: &Esp32Target,
        json: &str,
    ) -> Result<(), DriverError> {
        self.downlink.publish_ctl(target, json).await
    }

    /// Speak the prompt only and publish a `menu` ctl (design §4.4).
    ///
    /// Used by [`ChannelDriver::deliver`] when `OutboundMessage.question` is
    /// set, and by the mid-turn question hook when opencode asks live.
    pub async fn present_question(
        &self,
        target: &Esp32Target,
        question: &InteractiveQuestion,
    ) -> Result<(), DriverError> {
        self.remember_target(target.clone());
        {
            // A device shows one menu at a time, so an older one for the same
            // device can never be answered — the screen it belonged to is gone.
            // Without this, every question the user walks away from stays
            // forever.
            let mut map = self.pending_menus.lock().unwrap();
            map.retain(|_, m| &m.target != target);
        }
        self.pending_menus.lock().unwrap().insert(
            question.question_id.clone(),
            PendingMenu {
                target: target.clone(),
                options: question.options.clone(),
            },
        );

        let ctl = serde_json::json!({
            "type": "menu",
            "question_id": question.question_id,
            "prompt": question.prompt,
            "options": question.options,
            "from": "amuxd",
        });
        self.downlink.publish_ctl(target, &ctl.to_string()).await?;

        if !question.prompt.is_empty() {
            self.downlink.speak(target, &question.prompt).await?;
        }
        Ok(())
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
        // `team/actor/device` so we can address MQTT.
        let Some(ctx) = reply_context else {
            return Err(DriverError::Payload(
                "esp32 deliver requires reply_context team/actor/device".into(),
            ));
        };
        let target = parse_reply_context(ctx)?;
        self.remember_target(target.clone());
        // Unique per deliver so concurrent turns on the same device do not
        // share a cursor (device_id alone collided under streaming).
        let id = DeliveryId(uuid::Uuid::new_v4().to_string());

        // Interactive question: speak prompt only + on-device menu (design §4.4).
        // Streaming answer text may follow later via `update` after the user
        // replies; for this turn deliver is primarily menu + prompt speak.
        if let Some(ref question) = msg.question {
            self.present_question(&target, question).await?;
            self.retire_previous_playback(&target);
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

        if msg.text.is_empty() {
            // Streaming placeholder: Core will `update` as the reply grows.
            self.retire_previous_playback(&target);
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
        self.retire_previous_playback(&target);
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
            self.downlink.speak_delta(&target, &id.0, piece).await?;
        }

        if let Some(end) = end {
            self.downlink.end_turn(&target, &id.0, end).await?;
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
        ctls: Mutex<Vec<(String, String)>>,
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

        async fn speak_delta(
            &self,
            device: &Esp32Target,
            _turn: &str,
            text: &str,
        ) -> Result<(), DriverError> {
            self.deltas
                .lock()
                .unwrap()
                .push((device.device_id.clone(), text.to_string()));
            Ok(())
        }

        async fn end_turn(
            &self,
            device: &Esp32Target,
            _turn: &str,
            end: TurnEnd,
        ) -> Result<(), DriverError> {
            self.ends
                .lock()
                .unwrap()
                .push((device.device_id.clone(), end));
            Ok(())
        }

        async fn publish_ctl(&self, device: &Esp32Target, json: &str) -> Result<(), DriverError> {
            self.ctls
                .lock()
                .unwrap()
                .push((device.device_id.clone(), json.to_string()));
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
    async fn deliver_with_question_speaks_prompt_and_publishes_menu() {
        let downlink = Arc::new(FakeDownlink::default());
        let d = driver(Arc::clone(&downlink));
        let msg = OutboundMessage {
            text: "ignored when question present — would have listed options".into(),
            question: Some(InteractiveQuestion {
                question_id: "q1".into(),
                prompt: "pick one".into(),
                options: vec!["A".into(), "B".into(), "C".into()],
            }),
            ..Default::default()
        };

        let id = d
            .deliver(&conversation(), Some("team-1/actor-1/dev-99"), &msg)
            .await
            .expect("deliver");

        assert!(!id.0.is_empty());
        assert_eq!(
            downlink.speaks.lock().unwrap().clone(),
            vec![("dev-99".into(), "pick one".into())],
            "speak prompt only, not the options list"
        );
        let ctls = downlink.ctls.lock().unwrap().clone();
        assert_eq!(ctls.len(), 1);
        assert_eq!(ctls[0].0, "dev-99");
        let body: serde_json::Value = serde_json::from_str(&ctls[0].1).expect("ctl json");
        assert_eq!(body["type"], "menu");
        assert_eq!(body["question_id"], "q1");
        assert_eq!(body["prompt"], "pick one");
        assert_eq!(body["options"], serde_json::json!(["A", "B", "C"]));
        assert_eq!(body["from"], "amuxd");

        let (target, text) = d.take_menu_option("q1", 1).expect("pending menu");
        assert_eq!(target.device_id, "dev-99");
        assert_eq!(text, "B");
        assert!(d.take_menu_option("q1", 0).is_none(), "one-shot");
    }

    #[tokio::test]
    async fn deliver_nonempty_is_oneshot_speak() {
        let downlink = Arc::new(FakeDownlink::default());
        let d = driver(Arc::clone(&downlink));
        let msg = OutboundMessage {
            text: "hello from the agent".into(),
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
        assert!(downlink.ctls.lock().unwrap().is_empty());
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
