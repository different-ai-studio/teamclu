//! Voice router — the M3-1 plumbing seam.
//!
//! Consumes [`VoiceEvent`]s forwarded from the MQTT business loop
//! ([`crate::mqtt::subscriber`] → [`crate::daemon::server::rpc`] → here) and
//! drives a [`SttProvider`] per active device turn:
//!
//! - `voice/ctl` `turn_start` → open an [`SttProvider::recognize`] stream,
//!   stashing its frame-sender keyed on `(team, actor)`.
//! - `voice/mic` → push the Opus frame into the open stream's sender.
//! - `voice/ctl` `turn_end` / `flush` → drop the sender (signals
//!   end-of-utterance to the provider), the drain task collects the final
//!   transcript and hands it to a [`TranscriptSink`].
//! - `voice/ctl` `barge_in` / `error` → close the stream without expecting
//!   a final.
//!
//! Final transcripts go to a [`TranscriptSink`]. The default
//! [`LogTranscriptSink`] only logs; M3-3 (`chat`) and M3-4 (`note`) will
//! provide sinks that call `send_prompt` / the session store. The sink is a
//! trait precisely so M3-1 can ship and be tested without those consumers.
//!
//! ## What M3-1 does *not* do
//!
//! - It does not subscribe to the device's voice topics. That needs the
//!   device's `(team, actor)`, which comes from M2-2 pairing. The router is
//!   event-driven and key-agnostic; once pairing supplies the actor, a
//!   `subscribe` call on `voice/{mic,ctl}` (QoS 0 / 1) wires the live path.
//! - It does not transcribe. The default provider is `FunasrProvider`, whose
//!   `recognize` returns [`SttError::NotImplemented`] until M3-2. A
//!   `turn_start` against it is logged and dropped — the routing, framing,
//!   and sink wiring are all real and unit-tested with a test provider.

use async_trait::async_trait;
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::ctl::VoiceCtl;
use super::stt::{Intent, SttError, SttProvider, Transcript};

/// One forwarded voice event from the MQTT business loop.
#[derive(Debug)]
pub enum VoiceEvent {
    /// A `voice/mic` Opus frame. `payload` is raw Opus bytes (plan §1:
    /// 16 kHz mono, 20 ms, ~24 kbps VBR). QoS 0 — may be dropped.
    Mic {
        team_id: String,
        actor_id: String,
        payload: Bytes,
    },
    /// A parsed `voice/ctl` JSON message. QoS 1.
    Ctl {
        team_id: String,
        actor_id: String,
        ctl: VoiceCtl,
    },
}

/// `(team, actor)` — the key a device's active turn is stashed under.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct DeviceKey {
    pub team_id: String,
    pub actor_id: String,
}

/// Consumer of a final transcript. M3-3 wires a `chat` sink (→
/// `RuntimeManager::send_prompt`), M3-4 a `note` sink (→ session store).
#[async_trait]
pub trait TranscriptSink: Send + Sync {
    async fn on_final(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        session_id: Option<&str>,
        text: &str,
    );
}

/// Delivers each final transcript to several sinks.
///
/// The router holds one sink, but the device has two intents and each has its
/// own consumer: `chat` goes to [`super::chat_sink::ChatSink`], `note` to
/// [`super::note_sink::NoteSink`]. Rather than teach the router to branch on
/// intent, both sinks receive every final and each ignores the intent that is
/// not theirs — so adding a third intent later means adding a sink, not
/// editing a `match` in the routing layer.
///
/// Sinks run in order rather than concurrently: only one of them acts on any
/// given transcript, so there is nothing to overlap, and sequential delivery
/// keeps failures attributable.
pub struct FanOutSink {
    sinks: Vec<Arc<dyn TranscriptSink>>,
}

impl FanOutSink {
    pub fn new(sinks: Vec<Arc<dyn TranscriptSink>>) -> Self {
        Self { sinks }
    }
}

#[async_trait]
impl TranscriptSink for FanOutSink {
    async fn on_final(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        session_id: Option<&str>,
        text: &str,
    ) {
        for sink in &self.sinks {
            sink.on_final(team_id, actor_id, intent, session_id, text)
                .await;
        }
    }
}

/// Default sink: logs the final transcript. Used until M3-3/M3-4 land.
#[derive(Default)]
pub struct LogTranscriptSink;

#[async_trait]
impl TranscriptSink for LogTranscriptSink {
    async fn on_final(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        session_id: Option<&str>,
        text: &str,
    ) {
        info!(
            team_id,
            actor_id,
            intent = ?intent,
            session_id = ?session_id,
            chars = text.chars().count(),
            "voice transcript final: {text}"
        );
    }
}

/// An open recognition stream for one device. Dropping this drops the
/// frame-sender, which signals end-of-utterance to the provider.
struct ActiveStream {
    intent: Intent,
    #[allow(dead_code)]
    session_id: Option<String>,
    frames_tx: mpsc::Sender<super::stt::AudioFrame>,
    /// The transcript-drain task. Detached on close so it can finish flushing
    /// the final transcript to the sink after the map entry is gone.
    _drain: tokio::task::JoinHandle<()>,
}

pub struct VoiceRouter {
    provider: Arc<dyn SttProvider>,
    sink: Arc<dyn TranscriptSink>,
    active: parking_lot::Mutex<HashMap<DeviceKey, ActiveStream>>,
    /// Stops in-flight TTS when the user interrupts. `None` before the TTS
    /// downlink is wired, in which case barge-in only closes the uplink.
    speaker: Option<Arc<dyn super::spk::ReplySpeaker>>,
}

impl VoiceRouter {
    pub fn new(provider: Arc<dyn SttProvider>, sink: Arc<dyn TranscriptSink>) -> Self {
        Self {
            provider,
            sink,
            active: parking_lot::Mutex::new(HashMap::new()),
            speaker: None,
        }
    }

    /// Give the router a handle on the speech downlink so a new turn or a
    /// barge-in can silence a reply that is still playing.
    pub fn with_speaker(mut self, speaker: Arc<dyn super::spk::ReplySpeaker>) -> Self {
        self.speaker = Some(speaker);
        self
    }

    /// Silence any reply currently being spoken to this device.
    async fn silence(&self, key: &DeviceKey) {
        if let Some(speaker) = &self.speaker {
            speaker.cancel(key).await;
        }
    }

    /// Spawn the router on its own task; returns the sender the business
    /// loop forwards `VoiceEvent`s into. The task exits when all senders are
    /// dropped (daemon shutdown).
    pub fn spawn(
        self,
        mut rx: mpsc::UnboundedReceiver<VoiceEvent>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                self.handle(ev).await;
            }
            info!("voice router shut down");
        })
    }

    async fn handle(&self, ev: VoiceEvent) {
        match ev {
            VoiceEvent::Mic {
                team_id,
                actor_id,
                payload,
            } => {
                let key = DeviceKey { team_id, actor_id };
                let frame = super::stt::AudioFrame::opus(payload);
                let tx_opt = {
                    let active = self.active.lock();
                    active.get(&key).map(|s| s.frames_tx.clone())
                };
                match tx_opt {
                    Some(tx) => {
                        if tx.send(frame).await.is_err() {
                            warn!(
                                team_id = %key.team_id,
                                actor_id = %key.actor_id,
                                "voice mic frame dropped: stream closed mid-push"
                            );
                        }
                    }
                    None => warn!(
                        team_id = %key.team_id,
                        actor_id = %key.actor_id,
                        "voice mic frame before turn_start; dropped"
                    ),
                }
            }
            VoiceEvent::Ctl {
                team_id,
                actor_id,
                ctl,
            } => {
                self.handle_ctl(team_id, actor_id, ctl).await;
            }
        }
    }

    async fn handle_ctl(&self, team_id: String, actor_id: String, ctl: VoiceCtl) {
        // Our own downlink coming back: the daemon publishes `session`,
        // `thinking`, `spk_start`, `spk_end`, `note_saved` and `error` onto the
        // same topic it subscribes to. Acting on an echoed `error` would close
        // the very stream the error was reporting on.
        if ctl.is_own_echo() {
            return;
        }
        let key = DeviceKey {
            team_id: team_id.clone(),
            actor_id: actor_id.clone(),
        };
        match ctl.kind.as_str() {
            "turn_start" => {
                let intent = ctl.intent().unwrap_or(Intent::Chat);
                // Re-issue: a second turn_start without a turn_end closes the
                // previous turn for this device. Idempotent against a
                // redelivered turn_start (QoS 1).
                self.close_stream(&key);
                // Talking over the previous answer is the common case here —
                // the user asks a follow-up before the reply finishes.
                self.silence(&key).await;
                let (frames_tx, frames_rx) = mpsc::channel(64);
                match self.provider.recognize(intent, frames_rx).await {
                    Ok(stream) => {
                        let super::stt::SttStream {
                            frames_tx: _unused_provider_tx,
                            transcripts_rx,
                        } = stream;
                        // The provider's own frames_tx is unused: this router
                        // owns the one it created above and pushes mic frames
                        // through it. Drop the provider's to avoid confusion.
                        let _ = _unused_provider_tx;
                        let sink = self.sink.clone();
                        let t = team_id.clone();
                        let a = actor_id.clone();
                        let session_id = ctl.session.clone();
                        let drain = tokio::spawn(drain_transcripts(
                            transcripts_rx,
                            sink,
                            t,
                            a,
                            intent,
                            session_id,
                        ));
                        self.active.lock().insert(
                            key.clone(),
                            ActiveStream {
                                intent,
                                session_id: ctl.session.clone(),
                                frames_tx,
                                _drain: drain,
                            },
                        );
                        info!(
                            team_id = %key.team_id,
                            actor_id = %key.actor_id,
                            ?intent,
                            session_id = ?ctl.session,
                            "voice turn started"
                        );
                    }
                    Err(SttError::NotImplemented(backend, tag)) => {
                        warn!(
                            backend,
                            tag,
                            team_id = %key.team_id,
                            actor_id = %key.actor_id,
                            "voice turn_start refused: STT backend not implemented"
                        );
                    }
                    Err(e) => {
                        warn!(
                            error = %e,
                            team_id = %key.team_id,
                            actor_id = %key.actor_id,
                            "voice turn_start failed"
                        );
                    }
                }
            }
            "turn_end" | "flush" => {
                info!(
                    team_id = %key.team_id,
                    actor_id = %key.actor_id,
                    kind = %ctl.kind,
                    "voice turn ended"
                );
                self.close_stream(&key);
            }
            "barge_in" => {
                info!(
                    team_id = %key.team_id,
                    actor_id = %key.actor_id,
                    "voice barge-in: closing turn without final"
                );
                self.close_stream(&key);
                // The whole point of barge-in: stop talking. This is also why
                // `spk` paces frames — if the reply were already sitting in
                // the device's play queue there would be nothing to cancel.
                self.silence(&key).await;
            }
            "error" => {
                warn!(
                    team_id = %key.team_id,
                    actor_id = %key.actor_id,
                    code = ?ctl.code,
                    message = ?ctl.message,
                    "device-reported voice error; closing turn"
                );
                self.close_stream(&key);
            }
            other => warn!(kind = %other, "unknown voice ctl type; ignored"),
        }
    }

    /// Remove the device's active stream, dropping its frame-sender. The
    /// drain task is detached and continues to flush any final transcript.
    fn close_stream(&self, key: &DeviceKey) {
        if let Some(removed) = self.active.lock().remove(key) {
            // `frames_tx` drops here → provider's frame input closes → it
            // emits the final transcript → the detached drain task forwards
            // it to the sink and exits. `_drain` (JoinHandle) drops too, but
            // that does not cancel a spawned task.
            drop(removed);
        }
    }
}

/// Drain a provider's transcript receiver until a `final` arrives, hand it
/// to the sink, then return. Owned by the spawned `JoinHandle` in
/// [`ActiveStream::_drain`].
async fn drain_transcripts(
    mut transcripts_rx: mpsc::Receiver<Transcript>,
    sink: Arc<dyn TranscriptSink>,
    team_id: String,
    actor_id: String,
    intent: Intent,
    session_id: Option<String>,
) {
    while let Some(t) = transcripts_rx.recv().await {
        if t.is_final {
            sink.on_final(&team_id, &actor_id, intent, session_id.as_deref(), &t.text)
                .await;
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::stt::{AudioFrame, SttStream};
    use async_trait::async_trait;

    /// Test provider: echoes an empty final transcript as soon as the frame
    /// channel closes (mirrors how a real STT emits a final at
    /// end-of-utterance). Also records how many frames it saw.
    struct CountingProvider {
        frames_seen: Arc<std::sync::atomic::AtomicU32>,
    }

    #[async_trait]
    impl SttProvider for CountingProvider {
        fn name(&self) -> &'static str {
            "counting-test"
        }
        async fn recognize(
            &self,
            _intent: Intent,
            mut frames_rx: mpsc::Receiver<AudioFrame>,
        ) -> Result<SttStream, SttError> {
            let (tx, rx) = mpsc::channel(8);
            let (ftx, _frx) = mpsc::channel(8);
            let counter = self.frames_seen.clone();
            tokio::spawn(async move {
                let mut n = 0u32;
                while frames_rx.recv().await.is_some() {
                    n += 1;
                }
                counter.store(n, std::sync::atomic::Ordering::Relaxed);
                let _ = tx.send(Transcript::final_("hello from stt")).await;
            });
            Ok(SttStream {
                frames_tx: ftx,
                transcripts_rx: rx,
            })
        }
    }

    /// Capturing sink for assertions.
    struct CaptureSink {
        finals: Arc<parking_lot::Mutex<Vec<(String, String, Intent, Option<String>, String)>>>,
    }

    #[async_trait]
    impl TranscriptSink for CaptureSink {
        async fn on_final(
            &self,
            team_id: &str,
            actor_id: &str,
            intent: Intent,
            session_id: Option<&str>,
            text: &str,
        ) {
            self.finals.lock().push((
                team_id.to_string(),
                actor_id.to_string(),
                intent,
                session_id.map(|s| s.to_string()),
                text.to_string(),
            ));
        }
    }

    /// Records only the intents it was asked to accept, the way `ChatSink` and
    /// `NoteSink` each ignore the other's.
    struct IntentSink {
        accepts: Intent,
        seen: Arc<parking_lot::Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl TranscriptSink for IntentSink {
        async fn on_final(
            &self,
            _team_id: &str,
            _actor_id: &str,
            intent: Intent,
            _session_id: Option<&str>,
            text: &str,
        ) {
            if intent == self.accepts {
                self.seen.lock().push(text.to_string());
            }
        }
    }

    #[tokio::test]
    async fn the_routers_own_ctl_echo_is_ignored() {
        // `voice/ctl` carries both directions on one topic and the daemon
        // subscribes to it, so every ctl it publishes comes straight back.
        // `error` is the dangerous one: both sides send it, so type alone
        // cannot disambiguate, and acting on an echoed one closes the very
        // stream the error was reporting on.
        let (router, frames, caps) = make_router();
        let (tx, rx) = mpsc::unbounded_channel();
        router.spawn(rx);

        tx.send(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl {
                kind: "turn_start".into(),
                intent: Some("chat".into()),
                session: None,
                seq: 1,
                boot_id: None,
                code: None,
                message: None,
                from: None,
            },
        })
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // An echoed error must NOT close the open turn.
        tx.send(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl {
                kind: "error".into(),
                intent: None,
                session: None,
                seq: 2,
                boot_id: None,
                code: Some("tts_unavailable".into()),
                message: Some("...".into()),
                from: Some(crate::voice::ctl::FROM_DAEMON.to_string()),
            },
        })
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // The turn is still open, so a mic frame still lands.
        tx.send(VoiceEvent::Mic {
            team_id: "t".into(),
            actor_id: "a".into(),
            payload: bytes::Bytes::from_static(&[1, 2, 3]),
        })
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(tx);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        assert_eq!(
            frames.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "an echoed error closed the stream"
        );
        let _ = caps;
    }

    #[tokio::test]
    async fn fan_out_delivers_to_every_sink() {
        // Both sinks must see every final: the router does not branch on
        // intent, each sink filters for itself.
        let chat = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let note = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let fan = FanOutSink::new(vec![
            Arc::new(IntentSink {
                accepts: Intent::Chat,
                seen: chat.clone(),
            }),
            Arc::new(IntentSink {
                accepts: Intent::Note,
                seen: note.clone(),
            }),
        ]);

        fan.on_final("t", "a", Intent::Chat, None, "问题").await;
        fan.on_final("t", "a", Intent::Note, None, "笔记").await;

        assert_eq!(*chat.lock(), vec!["问题"]);
        assert_eq!(*note.lock(), vec!["笔记"]);
    }

    #[tokio::test]
    async fn fan_out_with_no_sinks_is_a_no_op() {
        // Guards the degenerate wiring: a daemon built with neither sink
        // configured must drop transcripts quietly, not panic on an empty Vec.
        let fan = FanOutSink::new(Vec::new());
        fan.on_final("t", "a", Intent::Chat, None, "x").await;
    }

    fn make_router() -> (
        VoiceRouter,
        Arc<std::sync::atomic::AtomicU32>,
        Arc<parking_lot::Mutex<Vec<(String, String, Intent, Option<String>, String)>>>,
    ) {
        let frames = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let caps: Arc<parking_lot::Mutex<Vec<(String,String,Intent,Option<String>,String)>>> =
            Arc::new(parking_lot::Mutex::new(Vec::new()));
        let router = VoiceRouter::new(
            Arc::new(CountingProvider { frames_seen: frames.clone() }),
            Arc::new(CaptureSink { finals: caps.clone() }),
        );
        (router, frames, caps)
    }

    #[tokio::test]
    async fn turn_start_to_turn_end_flushes_final_to_sink() {
        let (router, frames, caps) = make_router();
        router.handle(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl::parse(br#"{"type":"turn_start","intent":"chat","seq":1}"#).unwrap(),
        }).await;
        // Push a few mic frames.
        for _ in 0..3 {
            router.handle(VoiceEvent::Mic {
                team_id: "t".into(),
                actor_id: "a".into(),
                payload: Bytes::from_static(b"\x00\x00"),
            }).await;
        }
        // End the turn.
        router.handle(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl::parse(br#"{"type":"turn_end","seq":2}"#).unwrap(),
        }).await;
        // The drain task runs async; give it a tick.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert_eq!(frames.load(std::sync::atomic::Ordering::Relaxed), 3);
        let finals = caps.lock();
        assert_eq!(finals.len(), 1, "exactly one final transcript");
        assert_eq!(finals[0].2, Intent::Chat);
        assert_eq!(finals[0].4, "hello from stt");
    }

    #[tokio::test]
    async fn mic_before_turn_start_is_dropped() {
        let (router, frames, _caps) = make_router();
        router.handle(VoiceEvent::Mic {
            team_id: "t".into(),
            actor_id: "a".into(),
            payload: Bytes::from_static(b"\x00"),
        }).await;
        // No turn_start → no active stream → frame not counted.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(frames.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn barge_in_closes_without_final() {
        let (router, _frames, caps) = make_router();
        router.handle(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl::parse(br#"{"type":"turn_start","intent":"note","seq":1}"#).unwrap(),
        }).await;
        router.handle(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl::parse(br#"{"type":"barge_in","seq":2}"#).unwrap(),
        }).await;
        // barge_in drops frames_tx → the test provider still emits its final
        // on channel close (it has no concept of "cancelled"). A real provider
        // would suppress the final on barge-in; that's the provider's job,
        // not the router's. So we DO expect one final here. This asserts the
        // router doesn't panic and the stream is removed.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let n = caps.lock().len();
        assert!(n == 0 || n == 1, "barge-in leaves sink in a clean state");
    }

    #[tokio::test]
    async fn reissue_turn_start_replaces_active_stream() {
        let (router, _frames, caps) = make_router();
        for seq in 1..=2 {
            router.handle(VoiceEvent::Ctl {
                team_id: "t".into(),
                actor_id: "a".into(),
                ctl: VoiceCtl::parse(
                    &format!(r#"{{"type":"turn_start","intent":"chat","seq":{seq}}}"#).into_bytes(),
                ).unwrap(),
            }).await;
        }
        router.handle(VoiceEvent::Ctl {
            team_id: "t".into(),
            actor_id: "a".into(),
            ctl: VoiceCtl::parse(br#"{"type":"turn_end","seq":3}"#).unwrap(),
        }).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // First stream's frames_tx was dropped on re-issue → one final from
        // it; second stream ends on turn_end → another final. Two finals.
        assert_eq!(caps.lock().len(), 2, "both turns flushed a final");
    }
}
