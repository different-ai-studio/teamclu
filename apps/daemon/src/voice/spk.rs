//! Speech downlink — the agent's reply becomes audio on `voice/spk` (M3-5).
//!
//! This closes the loop. [`super::chat_sink`] gets a spoken question to the
//! agent; this gets the answer back to the speaker.
//!
//! ## The device contract, which already exists
//!
//! `apps/esp32/main/net/ctl_parse.cpp` already recognises five inbound ctl
//! types, and `main.cpp` already acts on all of them — the firmware half has
//! been waiting for a producer:
//!
//! | ctl `type`  | Device does                                          |
//! |-------------|------------------------------------------------------|
//! | `session`   | logs the session id for this turn                    |
//! | `thinking`  | `onAgentThinking()` → Think screen, arms its timeout  |
//! | `spk_start` | `beginPlayback()` **then** `onAgentSpeaking()`        |
//! | `spk_end`   | `endPlayback()` + `onAgentDone()` → back to idle      |
//! | `error`     | `stopCapture()` + `endPlayback()` + Error screen      |
//!
//! These are not optional decoration. The face arms a deadline when it enters
//! Think and falls to the `NoAgent` error screen if nothing arrives, so a
//! daemon that synthesises perfect audio but never sends `thinking` /
//! `spk_start` shows the user an error and then talks over it.
//!
//! ## Why frames are paced instead of blasted
//!
//! The obvious implementation publishes every Opus frame the moment it is
//! encoded. Two things make that wrong:
//!
//! 1. **Barge-in stops meaning anything.** If a ten-second reply is already
//!    sitting in the device's play queue, cancelling the turn on this side
//!    cancels nothing — the user keeps hearing the rest of it.
//! 2. `onSpkFrame` hands each decoded buffer to the HAL's play task
//!    (`audioPlay(pcm, true)`), so a burst becomes queue pressure on a device
//!    with one small ring, and the overflow counter is `framesDroppedRx`.
//!
//! So frames go out at wall-clock speed after an initial
//! [`SpkConfig::prebuffer_frames`] burst that gives the device something to
//! absorb jitter with.
//!
//! ## Ordering: subscribe before prompting
//!
//! [`ReplySpeaker::begin`] must be called *before* `send_prompt`, and takes
//! only the live half of the subscription — never the backlog. Subscribing
//! afterwards races the first token deltas (the start of the reply goes
//! missing), and replaying the backlog would speak the *previous* turn's
//! answer. Taking `live` from a subscription opened before the prompt gets
//! both right without needing to know the current sequence number.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::time::Instant;
use tracing::{info, warn};
use uuid::Uuid;

use super::adapter::DeviceKey;
use super::tts::{PcmChunk, SentenceChunker, TtsProvider, TtsStream};
use crate::http::events::{EventKind, SessionEvent};
use crate::http::runtime_adapter::RuntimeAdapter;

/// 20 ms at 16 kHz — the frame size the device's decoder is built around
/// (`kFrameSamples` in `voice_audio.cpp`). Not a tunable: a different frame
/// size on this side is silently wrong on that one.
pub const SPK_FRAME_SAMPLES: usize = 320;
pub const SPK_FRAME_MS: u64 = 20;

/// Largest single Opus packet libopus will emit; the encode scratch buffer.
const MAX_OPUS_PACKET: usize = 1275;

#[derive(Debug, Clone)]
pub struct SpkConfig {
    /// Opus target bitrate. 24 kbps matches the uplink (plan §1).
    pub bitrate: i32,
    /// Frames sent back-to-back before pacing kicks in — the device's jitter
    /// cushion. 10 frames = 200 ms.
    pub prebuffer_frames: usize,
    /// Pace frames at wall-clock speed. Only tests turn this off; leaving it
    /// off in production would reintroduce both problems in the module docs.
    pub paced: bool,
    /// Give up if the agent goes this long without emitting an event. Bounds
    /// the lifetime of a task whose session died quietly.
    pub idle_timeout: Duration,
}

impl Default for SpkConfig {
    fn default() -> Self {
        Self {
            bitrate: 24_000,
            prebuffer_frames: 10,
            paced: true,
            idle_timeout: Duration::from_secs(120),
        }
    }
}

/// Publishes to a device's voice topics. A trait so this module is testable
/// without a broker; the daemon supplies an MQTT-backed implementation.
#[async_trait]
pub trait VoicePublisher: Send + Sync {
    /// `qos1` selects QoS 1 for ctl (must arrive) vs QoS 0 for audio frames
    /// (a late frame is worse than a missing one).
    async fn publish(&self, topic: String, payload: Vec<u8>, qos1: bool) -> Result<(), String>;
}

/// Starts and stops spoken replies for a device. Implemented by
/// [`SpeechSynthesizer`]; a trait so [`super::chat_sink`] does not depend on
/// the TTS stack to be testable.
#[async_trait]
pub trait ReplySpeaker: Send + Sync {
    /// Start watching `session_id` and speak whatever the agent replies.
    /// **Call before `send_prompt`** — see the module docs.
    async fn begin(&self, key: DeviceKey, session_id: Uuid);

    /// Stop any in-flight speech (barge-in, or a new turn superseding it).
    async fn cancel(&self, key: &DeviceKey);

    /// Abandon the turn and put the device on its error screen.
    async fn fail(&self, key: &DeviceKey, code: &str, message: &str);
}

// ---------------------------------------------------------------------------
// Opus framing
// ---------------------------------------------------------------------------

/// Accumulates PCM and emits exactly-20 ms Opus packets.
///
/// The TTS provider's chunk boundaries have nothing to do with frame
/// boundaries, so this buffers across them: encoding whatever arrived as one
/// packet would produce frames the device's fixed-size decode buffer cannot
/// take.
pub struct SpkEncoder {
    enc: audiopus::coder::Encoder,
    pending: Vec<i16>,
}

impl SpkEncoder {
    pub fn new(bitrate: i32) -> Result<Self, String> {
        use audiopus::{coder::Encoder, Application, Bitrate, Channels, SampleRate};
        let mut enc = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
            .map_err(|e| format!("opus encoder init: {e}"))?;
        enc.set_bitrate(Bitrate::BitsPerSecond(bitrate))
            .map_err(|e| format!("opus set_bitrate: {e}"))?;
        Ok(Self {
            enc,
            pending: Vec::new(),
        })
    }

    /// Feed PCM; returns every complete frame now available.
    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.pending.len() >= SPK_FRAME_SAMPLES {
            let frame: Vec<i16> = self.pending.drain(..SPK_FRAME_SAMPLES).collect();
            if let Some(pkt) = self.encode_frame(&frame) {
                out.push(pkt);
            }
        }
        out
    }

    /// Emit the partial tail, zero-padded to a full frame. Without this the
    /// last few milliseconds of every reply are cut off.
    pub fn flush(&mut self) -> Vec<Vec<u8>> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let mut frame = std::mem::take(&mut self.pending);
        frame.resize(SPK_FRAME_SAMPLES, 0);
        self.encode_frame(&frame).into_iter().collect()
    }

    fn encode_frame(&self, pcm: &[i16]) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; MAX_OPUS_PACKET];
        match self.enc.encode(pcm, &mut buf) {
            Ok(n) if n > 0 => {
                buf.truncate(n);
                Some(buf)
            }
            Ok(_) => None,
            Err(e) => {
                warn!(target: "voice", error = %e, "opus encode failed; frame dropped");
                None
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

struct ActiveSpeech {
    cancel: Arc<AtomicBool>,
}

pub struct SpeechSynthesizer {
    tts: Arc<dyn TtsProvider>,
    publisher: Arc<dyn VoicePublisher>,
    runtime: Arc<dyn RuntimeAdapter>,
    cfg: SpkConfig,
    active: Mutex<HashMap<DeviceKey, ActiveSpeech>>,
    /// Monotonic ctl sequence. Daemon-wide rather than per-device: the
    /// firmware does not dedup on it, so its only job is making a packet
    /// capture readable, and one counter does that fine.
    seq: AtomicU64,
}

impl SpeechSynthesizer {
    pub fn new(
        tts: Arc<dyn TtsProvider>,
        publisher: Arc<dyn VoicePublisher>,
        runtime: Arc<dyn RuntimeAdapter>,
        cfg: SpkConfig,
    ) -> Self {
        Self {
            tts,
            publisher,
            runtime,
            cfg,
            active: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        }
    }

    async fn send_ctl(&self, key: &DeviceKey, mut body: serde_json::Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("seq".into(), serde_json::Value::from(seq));
        }
        publish_ctl(&self.publisher, key, body).await;
    }
}

async fn publish_ctl(
    publisher: &Arc<dyn VoicePublisher>,
    key: &DeviceKey,
    body: serde_json::Value,
) {
    let topic = super::voice_ctl_topic(&key.team_id, &key.actor_id);
    let payload = match serde_json::to_vec(&body) {
        Ok(p) => p,
        Err(e) => {
            warn!(target: "voice", error = %e, "voice ctl serialise failed");
            return;
        }
    };
    if let Err(e) = publisher.publish(topic, payload, true).await {
        warn!(target: "voice", error = %e, kind = ?body.get("type"), "voice ctl publish failed");
    }
}

#[async_trait]
impl ReplySpeaker for SpeechSynthesizer {
    async fn begin(&self, key: DeviceKey, session_id: Uuid) {
        // A new turn supersedes whatever was still being spoken.
        self.cancel(&key).await;

        // Subscribe *before* the caller prompts. The backlog is dropped on
        // purpose: it belongs to earlier turns.
        let live = match self.runtime.subscribe(session_id, None).await {
            Ok(handle) => handle.live,
            Err(e) => {
                warn!(target: "voice", team_id = %key.team_id, session_id = %session_id,
                      error = ?e, "voice: cannot subscribe to session; reply will not be spoken");
                self.fail(&key, "no_agent", "session subscribe failed")
                    .await;
                return;
            }
        };

        self.send_ctl(
            &key,
            serde_json::json!({ "type": "session", "session": session_id.to_string() }),
        )
        .await;
        // Puts the face on the Think screen. Its own timeout is now running,
        // so everything below is on a clock the user can see.
        self.send_ctl(&key, serde_json::json!({ "type": "thinking" }))
            .await;

        let cancel = Arc::new(AtomicBool::new(false));
        self.active.lock().await.insert(
            key.clone(),
            ActiveSpeech {
                cancel: cancel.clone(),
            },
        );

        let tts = self.tts.clone();
        let publisher = self.publisher.clone();
        let cfg = self.cfg.clone();
        let seq_base = self.seq.fetch_add(64, Ordering::Relaxed);
        tokio::spawn(async move {
            run_turn(key, live, tts, publisher, cancel, cfg, seq_base).await;
        });
    }

    async fn cancel(&self, key: &DeviceKey) {
        if let Some(active) = self.active.lock().await.remove(key) {
            // The turn task polls this between frames and exits on its own,
            // which lets it stop cleanly rather than being aborted mid-publish.
            active.cancel.store(true, Ordering::Relaxed);
        }
    }

    async fn fail(&self, key: &DeviceKey, code: &str, message: &str) {
        self.cancel(key).await;
        self.send_ctl(
            key,
            serde_json::json!({ "type": "error", "code": code, "message": message }),
        )
        .await;
    }
}

/// Drives one spoken reply: session events → sentences → TTS → Opus → `spk`.
#[allow(clippy::too_many_arguments)]
async fn run_turn(
    key: DeviceKey,
    mut live: broadcast::Receiver<SessionEvent>,
    tts: Arc<dyn TtsProvider>,
    publisher: Arc<dyn VoicePublisher>,
    cancel: Arc<AtomicBool>,
    cfg: SpkConfig,
    seq_base: u64,
) {
    let TtsStream { text_tx, audio_rx } = match tts.speak().await {
        Ok(s) => s,
        Err(e) => {
            warn!(target: "voice", error = %e, "voice: TTS unavailable");
            publish_ctl(
                &publisher,
                &key,
                serde_json::json!({
                    "type": "error", "code": "tts_unavailable",
                    "message": e.to_string(), "seq": seq_base,
                }),
            )
            .await;
            return;
        }
    };

    // Audio flows on its own task so synthesis of sentence N+1 overlaps
    // playback of sentence N.
    let pump = tokio::spawn(pump_audio(
        key.clone(),
        audio_rx,
        publisher.clone(),
        cancel.clone(),
        cfg.clone(),
        seq_base + 1,
    ));

    // The event loop must never block on the TTS provider. `text_tx` is a
    // bounded channel, so a slow or wedged TTS server would back up into
    // `send().await`, stop us reading `live`, and make the broadcast receiver
    // *lag* — which drops events permanently, `TurnFinished` among them. The
    // turn would then hang until `idle_timeout` with the device stuck on the
    // Speaking face. This forwarder absorbs that: the loop hands pieces to an
    // unbounded queue and keeps reading events no matter what TTS is doing.
    // Unbounded is safe here because the queue holds one agent reply's worth of
    // sentences, not audio.
    let (pieces_tx, mut pieces_rx) = mpsc::unbounded_channel::<String>();
    let forwarder = tokio::spawn(async move {
        while let Some(piece) = pieces_rx.recv().await {
            if text_tx.send(piece).await.is_err() {
                break;
            }
        }
        // Dropping `text_tx` here is what ends the TTS stream.
    });

    let mut chunker = SentenceChunker::default();
    let mut spoke_any = false;
    let mut completed_text: Option<String> = None;
    let mut errored: Option<String> = None;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let ev = match tokio::time::timeout(cfg.idle_timeout, live.recv()).await {
            Err(_) => {
                warn!(target: "voice", team_id = %key.team_id,
                      "voice: agent went quiet; ending the spoken turn");
                break;
            }
            Ok(Ok(ev)) => ev,
            Ok(Err(broadcast::error::RecvError::Lagged(n))) => {
                // Dropped deltas mean a gap in the spoken reply, not a reason
                // to abandon it.
                warn!(target: "voice", skipped = n, "voice: session event lag; reply will have a gap");
                continue;
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => break,
        };

        match ev.kind {
            EventKind::TokenDelta => {
                let Some(text) = ev.data.get("text").and_then(|v| v.as_str()) else {
                    continue;
                };
                for piece in chunker.push(text) {
                    spoke_any = true;
                    if pieces_tx.send(piece).is_err() {
                        break;
                    }
                }
            }
            EventKind::MessageCompleted => {
                // Kept only as a fallback for runtimes that report a finished
                // message without ever streaming deltas.
                if let Some(c) = ev.data.get("content").and_then(|v| v.as_str()) {
                    completed_text = Some(c.to_string());
                }
            }
            EventKind::SessionError => {
                errored = Some(
                    ev.data
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("agent error")
                        .to_string(),
                );
                break;
            }
            EventKind::TurnFinished | EventKind::SessionClosed => break,
            _ => {}
        }
    }

    if let Some(tail) = chunker.finish() {
        spoke_any = true;
        let _ = pieces_tx.send(tail);
    }
    if !spoke_any && errored.is_none() {
        if let Some(content) = completed_text.filter(|c| !c.trim().is_empty()) {
            let mut c = SentenceChunker::default();
            for piece in c.push(&content) {
                spoke_any = true;
                let _ = pieces_tx.send(piece);
            }
            if let Some(tail) = c.finish() {
                spoke_any = true;
                let _ = pieces_tx.send(tail);
            }
        }
    }

    // Closing the queue drains the forwarder, which drops `text_tx`, which ends
    // the TTS stream, which closes the audio side and lets the pump finish.
    // Awaiting the forwarder before the pump matters: it is what guarantees
    // every queued sentence has been handed to TTS before we decide the reply
    // is over.
    drop(pieces_tx);
    let _ = forwarder.await;
    let frames = pump.await.unwrap_or(0);

    if let Some(message) = errored {
        publish_ctl(
            &publisher,
            &key,
            serde_json::json!({
                "type": "error", "code": "upstream", "message": message,
                "seq": seq_base + 62,
            }),
        )
        .await;
        return;
    }
    if cancel.load(Ordering::Relaxed) {
        // Barge-in: the device already stopped playback locally, and telling
        // it the turn finished normally would move the face to idle as if the
        // reply had been heard.
        info!(target: "voice", team_id = %key.team_id, frames, "voice: spoken reply cancelled");
        return;
    }

    // Sent even when there was no audio at all: `spk_end` is what returns the
    // face to idle, and without it the Think screen times out into an error.
    publish_ctl(
        &publisher,
        &key,
        serde_json::json!({ "type": "spk_end", "seq": seq_base + 63 }),
    )
    .await;
    info!(target: "voice", team_id = %key.team_id, actor_id = %key.actor_id, frames,
          "voice: spoken reply complete");
}

/// Encodes and publishes audio, announcing `spk_start` before the first frame.
/// Returns the number of frames published.
async fn pump_audio(
    key: DeviceKey,
    mut audio_rx: mpsc::Receiver<PcmChunk>,
    publisher: Arc<dyn VoicePublisher>,
    cancel: Arc<AtomicBool>,
    cfg: SpkConfig,
    seq: u64,
) -> usize {
    let topic = super::voice_spk_topic(&key.team_id, &key.actor_id);
    let mut enc = match SpkEncoder::new(cfg.bitrate) {
        Ok(e) => e,
        Err(e) => {
            warn!(target: "voice", error = %e, "voice: no Opus encoder; reply cannot be spoken");
            return 0;
        }
    };

    let mut sent = 0usize;
    let mut started: Option<Instant> = None;

    'outer: loop {
        let chunk = match audio_rx.recv().await {
            Some(c) => c,
            None => break,
        };
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        for frame in enc.push(&chunk.samples) {
            if started.is_none() {
                // Announce only once real audio exists, so a reply that
                // synthesises nothing never flashes the Speaking face.
                publish_ctl(
                    &publisher,
                    &key,
                    serde_json::json!({ "type": "spk_start", "seq": seq }),
                )
                .await;
                started = Some(Instant::now());
            }
            if !pace(&cfg, started, sent).await {
                break 'outer;
            }
            if publisher
                .publish(topic.clone(), frame, false)
                .await
                .is_err()
            {
                break 'outer;
            }
            sent += 1;
            if cancel.load(Ordering::Relaxed) {
                break 'outer;
            }
        }
    }

    if !cancel.load(Ordering::Relaxed) {
        for frame in enc.flush() {
            if started.is_none() {
                publish_ctl(
                    &publisher,
                    &key,
                    serde_json::json!({ "type": "spk_start", "seq": seq }),
                )
                .await;
                started = Some(Instant::now());
            }
            if publisher
                .publish(topic.clone(), frame, false)
                .await
                .is_err()
            {
                break;
            }
            sent += 1;
        }
    }
    sent
}

/// Wait until frame `index` is due. Returns false if the wait was cut short.
async fn pace(cfg: &SpkConfig, started: Option<Instant>, index: usize) -> bool {
    if !cfg.paced || index < cfg.prebuffer_frames {
        return true;
    }
    let Some(start) = started else { return true };
    let ahead = (index - cfg.prebuffer_frames + 1) as u64;
    let due = start + Duration::from_millis(ahead * SPK_FRAME_MS);
    tokio::time::sleep_until(due).await;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::events::SessionEvent;

    // ---- fakes ---------------------------------------------------------

    #[derive(Default)]
    struct RecordingPublisher {
        ctl: Mutex<Vec<serde_json::Value>>,
        frames: AtomicU64,
    }

    #[async_trait]
    impl VoicePublisher for RecordingPublisher {
        async fn publish(
            &self,
            topic: String,
            payload: Vec<u8>,
            _qos1: bool,
        ) -> Result<(), String> {
            if topic.ends_with("/ctl") {
                let v: serde_json::Value = serde_json::from_slice(&payload).expect("ctl json");
                self.ctl.lock().await.push(v);
            } else {
                self.frames.fetch_add(1, Ordering::Relaxed);
            }
            Ok(())
        }
    }

    impl RecordingPublisher {
        async fn ctl_types(&self) -> Vec<String> {
            self.ctl
                .lock()
                .await
                .iter()
                .filter_map(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
                .collect()
        }
    }

    /// A TTS provider that turns each text piece into a fixed amount of PCM,
    /// so tests can reason about frame counts without a server.
    struct FakeTts {
        samples_per_piece: usize,
        spoken: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl TtsProvider for FakeTts {
        fn name(&self) -> &'static str {
            "fake"
        }
        async fn speak(&self) -> Result<TtsStream, super::super::tts::TtsError> {
            let (text_tx, mut text_rx) = mpsc::channel::<String>(16);
            let (audio_tx, audio_rx) = mpsc::channel::<PcmChunk>(64);
            let n = self.samples_per_piece;
            let spoken = self.spoken.clone();
            tokio::spawn(async move {
                while let Some(t) = text_rx.recv().await {
                    spoken.lock().await.push(t);
                    // A quiet ramp rather than silence: pure zeros compress to
                    // near-nothing and would not exercise real frame sizes.
                    let samples: Vec<i16> = (0..n).map(|i| ((i % 200) as i16 - 100) * 40).collect();
                    if audio_tx.send(PcmChunk { samples }).await.is_err() {
                        break;
                    }
                }
            });
            Ok(TtsStream { text_tx, audio_rx })
        }
    }

    fn test_cfg() -> SpkConfig {
        SpkConfig {
            paced: false, // real-time pacing would make every test take seconds
            idle_timeout: Duration::from_secs(5),
            ..Default::default()
        }
    }

    fn key() -> DeviceKey {
        DeviceKey {
            team_id: "t1".into(),
            actor_id: "a1".into(),
        }
    }

    fn delta(seq: u64, text: &str) -> SessionEvent {
        SessionEvent::new(
            Uuid::nil(),
            seq,
            EventKind::TokenDelta,
            serde_json::json!({ "text": text }),
        )
    }

    /// Run one turn against a scripted event list. Returns the publisher and
    /// the pieces the TTS provider was asked to speak.
    async fn run_scripted(
        events: Vec<SessionEvent>,
        samples_per_piece: usize,
        cancel: Arc<AtomicBool>,
    ) -> (Arc<RecordingPublisher>, Vec<String>) {
        let (tx, rx) = broadcast::channel(64);
        for e in &events {
            let _ = tx.send(e.clone());
        }
        // Dropping the sender closes the receiver once the backlog is read,
        // which stands in for the session ending.
        drop(tx);

        let spoken = Arc::new(Mutex::new(Vec::new()));
        let tts: Arc<dyn TtsProvider> = Arc::new(FakeTts {
            samples_per_piece,
            spoken: spoken.clone(),
        });
        let publisher = Arc::new(RecordingPublisher::default());
        let pub_dyn: Arc<dyn VoicePublisher> = publisher.clone();

        run_turn(key(), rx, tts, pub_dyn, cancel, test_cfg(), 0).await;
        let said = spoken.lock().await.clone();
        (publisher, said)
    }

    // ---- encoder -------------------------------------------------------

    #[test]
    fn encoder_emits_one_packet_per_20ms() {
        let mut enc = SpkEncoder::new(24_000).expect("encoder");
        // 10 frames' worth, delivered as one lump.
        let pcm: Vec<i16> = (0..SPK_FRAME_SAMPLES * 10)
            .map(|i| (i % 300) as i16)
            .collect();
        let frames = enc.push(&pcm);
        assert_eq!(frames.len(), 10);
        for f in &frames {
            assert!(
                !f.is_empty() && f.len() <= MAX_OPUS_PACKET,
                "len {}",
                f.len()
            );
        }
        assert!(enc.flush().is_empty(), "nothing should be left over");
    }

    #[test]
    fn encoder_buffers_across_chunk_boundaries() {
        // TTS chunk sizes have nothing to do with 320-sample frames; a
        // 500-sample chunk must not become a 500-sample Opus packet.
        let mut enc = SpkEncoder::new(24_000).expect("encoder");
        let chunk: Vec<i16> = (0..500).map(|i| (i % 300) as i16).collect();
        assert_eq!(
            enc.push(&chunk).len(),
            1,
            "500 samples = 1 frame + remainder"
        );
        assert_eq!(enc.push(&chunk).len(), 2, "remainder carries forward");
    }

    #[test]
    fn encoder_flush_pads_the_tail() {
        // Without padding, the last partial frame is dropped and every reply
        // loses its final syllable.
        let mut enc = SpkEncoder::new(24_000).expect("encoder");
        let short: Vec<i16> = (0..100).map(|i| (i % 300) as i16).collect();
        assert!(enc.push(&short).is_empty());
        assert_eq!(enc.flush().len(), 1);
        assert!(enc.flush().is_empty(), "flush is idempotent");
    }

    // ---- turn choreography ---------------------------------------------

    #[tokio::test]
    async fn a_spoken_reply_publishes_start_frames_then_end() {
        let events = vec![
            delta(1, "你好。"),
            SessionEvent::new(
                Uuid::nil(),
                2,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ),
        ];
        let (publisher, said) = run_scripted(
            events,
            SPK_FRAME_SAMPLES * 5,
            Arc::new(AtomicBool::new(false)),
        )
        .await;

        assert_eq!(said, vec!["你好。"], "the sentence reached TTS");
        assert_eq!(publisher.ctl_types().await, vec!["spk_start", "spk_end"]);
        assert_eq!(
            publisher.frames.load(Ordering::Relaxed),
            5,
            "5 frames of audio"
        );
    }

    #[tokio::test]
    async fn spk_start_precedes_every_frame() {
        // The device only arms its decoder on spk_start; a frame that beats
        // it is a clipped first syllable, and the ordering is easy to break.
        let events = vec![
            delta(1, "一句话。"),
            SessionEvent::new(
                Uuid::nil(),
                2,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ),
        ];
        let (publisher, _) = run_scripted(
            events,
            SPK_FRAME_SAMPLES * 3,
            Arc::new(AtomicBool::new(false)),
        )
        .await;
        let types = publisher.ctl_types().await;
        assert_eq!(types.first().map(String::as_str), Some("spk_start"));
    }

    #[tokio::test]
    async fn an_empty_reply_still_ends_the_turn() {
        // No audio, but the face is sitting on Think with a running deadline.
        // Skipping spk_end here is what turns a quiet answer into an error
        // screen.
        let events = vec![SessionEvent::new(
            Uuid::nil(),
            1,
            EventKind::TurnFinished,
            serde_json::json!({}),
        )];
        let (publisher, said) =
            run_scripted(events, SPK_FRAME_SAMPLES, Arc::new(AtomicBool::new(false))).await;
        assert!(said.is_empty());
        assert_eq!(publisher.ctl_types().await, vec!["spk_end"]);
        assert_eq!(publisher.frames.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn deltas_are_chunked_into_sentences_not_tokens() {
        // One TTS request per token would be absurd; the whole reply in one
        // request would forfeit streaming latency.
        let mut events: Vec<SessionEvent> = "今天天气不错。明天呢？"
            .chars()
            .enumerate()
            .map(|(i, c)| delta(i as u64 + 1, &c.to_string()))
            .collect();
        events.push(SessionEvent::new(
            Uuid::nil(),
            99,
            EventKind::TurnFinished,
            serde_json::json!({}),
        ));
        let (_, said) =
            run_scripted(events, SPK_FRAME_SAMPLES, Arc::new(AtomicBool::new(false))).await;
        assert_eq!(said, vec!["今天天气不错。", "明天呢？"]);
    }

    #[tokio::test]
    async fn trailing_text_without_punctuation_is_still_spoken() {
        let events = vec![
            delta(1, "没有句号的回答"),
            SessionEvent::new(
                Uuid::nil(),
                2,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ),
        ];
        let (_, said) =
            run_scripted(events, SPK_FRAME_SAMPLES, Arc::new(AtomicBool::new(false))).await;
        assert_eq!(said, vec!["没有句号的回答"]);
    }

    #[tokio::test]
    async fn a_runtime_that_never_streams_deltas_falls_back_to_the_message() {
        // Not every runtime emits token deltas. Speaking nothing at all in
        // that case would look like the agent ignored the user.
        let events = vec![
            SessionEvent::new(
                Uuid::nil(),
                1,
                EventKind::MessageCompleted,
                serde_json::json!({ "content": "完整答案。" }),
            ),
            SessionEvent::new(
                Uuid::nil(),
                2,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ),
        ];
        let (publisher, said) = run_scripted(
            events,
            SPK_FRAME_SAMPLES * 2,
            Arc::new(AtomicBool::new(false)),
        )
        .await;
        assert_eq!(said, vec!["完整答案。"]);
        assert!(publisher.frames.load(Ordering::Relaxed) > 0);
    }

    #[tokio::test]
    async fn deltas_win_over_the_completed_message() {
        // Both arriving must not speak the answer twice.
        let events = vec![
            delta(1, "流式答案。"),
            SessionEvent::new(
                Uuid::nil(),
                2,
                EventKind::MessageCompleted,
                serde_json::json!({ "content": "流式答案。" }),
            ),
            SessionEvent::new(
                Uuid::nil(),
                3,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ),
        ];
        let (_, said) =
            run_scripted(events, SPK_FRAME_SAMPLES, Arc::new(AtomicBool::new(false))).await;
        assert_eq!(said, vec!["流式答案。"], "spoken once, not twice");
    }

    #[tokio::test]
    async fn an_agent_error_becomes_an_error_ctl_not_an_spk_end() {
        // spk_end tells the face the reply was delivered. On a failure the
        // device needs its error screen instead.
        let events = vec![SessionEvent::new(
            Uuid::nil(),
            1,
            EventKind::SessionError,
            serde_json::json!({ "message": "model exploded" }),
        )];
        let (publisher, _) =
            run_scripted(events, SPK_FRAME_SAMPLES, Arc::new(AtomicBool::new(false))).await;
        let ctl = publisher.ctl.lock().await;
        let last = ctl.last().expect("an error ctl");
        assert_eq!(last["type"], "error");
        assert_eq!(last["message"], "model exploded");
        assert!(
            !ctl.iter().any(|c| c["type"] == "spk_end"),
            "a failed turn must not report success"
        );
    }

    #[tokio::test]
    async fn a_cancelled_turn_does_not_report_completion() {
        // Barge-in: the user is already talking again. Sending spk_end would
        // move the face to idle as if the reply had been heard out.
        let cancel = Arc::new(AtomicBool::new(true));
        let events = vec![
            delta(1, "会被打断的回答。"),
            SessionEvent::new(
                Uuid::nil(),
                2,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ),
        ];
        let (publisher, _) = run_scripted(events, SPK_FRAME_SAMPLES * 50, cancel).await;
        let types = publisher.ctl_types().await;
        assert!(!types.contains(&"spk_end".to_string()), "got {types:?}");
    }

    #[tokio::test]
    async fn a_quiet_session_times_out_instead_of_leaking_the_task() {
        // A session that dies without TurnFinished must not pin a task (and a
        // TTS connection) forever.
        let (tx, rx) = broadcast::channel(8);
        let spoken = Arc::new(Mutex::new(Vec::new()));
        let tts: Arc<dyn TtsProvider> = Arc::new(FakeTts {
            samples_per_piece: SPK_FRAME_SAMPLES,
            spoken,
        });
        let publisher = Arc::new(RecordingPublisher::default());
        let pub_dyn: Arc<dyn VoicePublisher> = publisher.clone();
        let cfg = SpkConfig {
            paced: false,
            idle_timeout: Duration::from_millis(80),
            ..Default::default()
        };
        // `tx` stays alive, so the receiver never closes on its own.
        let done = tokio::time::timeout(
            Duration::from_secs(5),
            run_turn(
                key(),
                rx,
                tts,
                pub_dyn,
                Arc::new(AtomicBool::new(false)),
                cfg,
                0,
            ),
        )
        .await;
        assert!(done.is_ok(), "run_turn must give up on a silent session");
        drop(tx);
        assert_eq!(publisher.ctl_types().await, vec!["spk_end"]);
    }

    /// A TTS provider that accepts text slowly, standing in for an overloaded
    /// server. `text_tx` has capacity 1 so backing up takes only one sentence.
    struct SlowTts {
        delay: Duration,
        spoken: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl TtsProvider for SlowTts {
        fn name(&self) -> &'static str {
            "slow"
        }
        async fn speak(&self) -> Result<TtsStream, super::super::tts::TtsError> {
            let (text_tx, mut text_rx) = mpsc::channel::<String>(1);
            let (_audio_tx, audio_rx) = mpsc::channel::<PcmChunk>(1);
            let delay = self.delay;
            let spoken = self.spoken.clone();
            tokio::spawn(async move {
                while let Some(t) = text_rx.recv().await {
                    tokio::time::sleep(delay).await;
                    spoken.lock().await.push(t);
                }
            });
            Ok(TtsStream { text_tx, audio_rx })
        }
    }

    #[tokio::test]
    async fn a_slow_tts_server_does_not_cost_us_session_events() {
        // The failure this guards: if the event loop blocked on a full
        // `text_tx`, it would stop draining `live` while the agent kept
        // emitting. The broadcast ring would overflow and drop events
        // permanently — losing sentences, and potentially `TurnFinished`
        // itself, which strands the device on the Speaking face.
        //
        // The setup makes the two behaviours diverge: a *small* ring, an agent
        // producing steadily, and a TTS server far slower than the agent. A
        // loop that keeps reading sees every event; one that blocks on TTS
        // cannot, and loses sentences it can never get back.
        const RING: usize = 16;
        const SENTENCES: usize = 30;
        let (tx, rx) = broadcast::channel(RING);

        let producer = tokio::spawn(async move {
            // Let `run_turn` get as far as its event loop before the first
            // event. Without this the ring can overflow during task startup,
            // which would be the test racing itself rather than the property
            // under test failing.
            tokio::time::sleep(Duration::from_millis(150)).await;
            for i in 0..SENTENCES {
                let _ = tx.send(delta(i as u64 + 1, &format!("第{i}句。")));
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
            let _ = tx.send(SessionEvent::new(
                Uuid::nil(),
                999,
                EventKind::TurnFinished,
                serde_json::json!({}),
            ));
        });

        let spoken = Arc::new(Mutex::new(Vec::new()));
        let tts: Arc<dyn TtsProvider> = Arc::new(SlowTts {
            // 30x the agent's per-sentence cadence, so a blocking loop falls
            // behind the ring almost immediately.
            delay: Duration::from_millis(60),
            spoken: spoken.clone(),
        });
        let publisher = Arc::new(RecordingPublisher::default());
        let pub_dyn: Arc<dyn VoicePublisher> = publisher.clone();
        let cfg = SpkConfig {
            paced: false,
            idle_timeout: Duration::from_secs(30),
            ..Default::default()
        };

        let done = tokio::time::timeout(
            Duration::from_secs(30),
            run_turn(
                key(),
                rx,
                tts,
                pub_dyn,
                Arc::new(AtomicBool::new(false)),
                cfg,
                0,
            ),
        )
        .await;
        assert!(
            done.is_ok(),
            "the turn must finish, not wait out its timeout"
        );
        let _ = producer.await;

        // `run_turn` returning means every sentence was *handed to* TTS, not
        // that TTS finished with it: the last couple are still in flight in the
        // capacity-1 channel and its consumer. Wait for them rather than
        // asserting on a number that is deterministically two short.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let n = spoken.lock().await.len();
            if n == SENTENCES || Instant::now() > deadline {
                assert_eq!(
                    n, SENTENCES,
                    "sentences were dropped: the event loop fell behind the agent"
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Reaching TurnFinished rather than the idle timeout.
        assert_eq!(publisher.ctl_types().await, vec!["spk_end"]);
    }

    #[tokio::test]
    async fn pacing_holds_frames_back_after_the_prebuffer() {
        // The safety property behind barge-in: frames must not all be handed
        // to the device up front.
        let cfg = SpkConfig {
            paced: true,
            prebuffer_frames: 2,
            ..Default::default()
        };
        let start = Instant::now();
        // Frame 6 with a 2-frame prebuffer is due 5 * 20 ms in.
        assert!(pace(&cfg, Some(start), 6).await);
        let waited = start.elapsed();
        assert!(
            waited >= Duration::from_millis(90),
            "expected ~100ms of pacing, waited {waited:?}"
        );
    }

    #[tokio::test]
    async fn prebuffered_frames_go_out_immediately() {
        let cfg = SpkConfig {
            paced: true,
            prebuffer_frames: 10,
            ..Default::default()
        };
        let start = Instant::now();
        for i in 0..10 {
            assert!(pace(&cfg, Some(start), i).await);
        }
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "the jitter cushion must not be paced"
        );
    }
}
