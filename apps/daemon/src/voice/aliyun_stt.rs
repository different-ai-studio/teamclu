//! Alibaba NLS streaming recognition (`SpeechTranscriber`).
//!
//! The hosted half of plan §13.9: the same Paraformer model the withdrawn
//! self-hosted plan wanted, without hosting it. Credentials come from
//! [`super::credentials`]; the AccessKey behind them never reaches this process.
//!
//! ## Opus is decoded here
//!
//! The device ships Opus (plan §1) and **NLS ingests PCM only** — unlike the
//! FunASR server, which accepted Opus directly. So this adapter owns the
//! decode, which is exactly the flexibility [`SttProvider`]'s docs describe:
//! the voice router above never branches on format.
//!
//! Decoding here rather than in the router also keeps the uplink cheap. Opus at
//! 24 kbps is ~60 bytes per 20 ms frame; the same audio as PCM is 640 bytes.
//! Expanding it before it needs expanding would cost ten times the memory in
//! every queue between the broker and this point.
//!
//! ## Partials and finals
//!
//! `TranscriptionResultChanged` is a partial, `SentenceEnd` closes a sentence.
//! A single utterance can produce several `SentenceEnd`s, so the final this
//! provider emits is the **accumulation** of them — emitting each as a final
//! would hand the chat sink several prompts for one button press.
//!
//! ## Status — verified on the live gateway 2026-08-25
//!
//! Synthesised speech fed back in 20 ms frames transcribed verbatim, with
//! partials arriving before the final. The one thing the live run corrected is
//! documented at the handshake in [`run_session`]: audio sent before
//! `TranscriptionStarted` is rejected outright, which would have failed every
//! turn on hardware.

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::warn;

use super::credentials::CredentialSource;
use super::nls::{envelope, handshake, nls_id, NlsMessage};
use super::stt::{AudioFormat, AudioFrame, Intent, SttError, SttProvider, SttStream, Transcript};
use std::sync::Arc;

const NAMESPACE: &str = "SpeechTranscriber";
/// 20 ms at 16 kHz mono — the device's frame size, and the decoder's output.
const FRAME_SAMPLES: usize = 320;
/// Largest number of samples one Opus packet can decode to at 16 kHz (120 ms).
const MAX_DECODED_SAMPLES: usize = 16_000 * 120 / 1000;

pub struct AliyunNlsProvider {
    credentials: Arc<dyn CredentialSource>,
}

impl AliyunNlsProvider {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Self {
        Self { credentials }
    }
}

/// Opus → PCM, one packet at a time.
///
/// Kept separate from the socket loop so the decode can be tested without a
/// gateway, and so a malformed packet is a dropped frame rather than a dead
/// stream: the uplink is QoS 0 and already tolerates loss, so aborting a whole
/// utterance because one frame arrived corrupt would be a worse trade.
pub struct OpusToPcm {
    decoder: audiopus::coder::Decoder,
    scratch: Vec<i16>,
    dropped: u32,
}

impl OpusToPcm {
    pub fn new() -> Result<Self, SttError> {
        use audiopus::{coder::Decoder, Channels, SampleRate};
        let decoder = Decoder::new(SampleRate::Hz16000, Channels::Mono)
            .map_err(|e| SttError::Decode(format!("opus decoder init: {e}")))?;
        Ok(Self {
            decoder,
            scratch: vec![0i16; MAX_DECODED_SAMPLES],
            dropped: 0,
        })
    }

    /// Decode one frame to little-endian PCM bytes, or `None` if it could not
    /// be decoded.
    pub fn decode(&mut self, frame: &AudioFrame) -> Option<Vec<u8>> {
        // A provider upstream may already have decoded; pass PCM straight
        // through rather than trying to Opus-decode raw samples.
        if frame.format == AudioFormat::Pcm16kMono {
            return Some(frame.data.to_vec());
        }
        // audiopus defines its OWN `TryInto` (not std's) and implements it for
        // `&[u8]` and `&mut [i16]` directly, so the packet and signal wrappers
        // are built by the call rather than by hand.
        let bytes: &[u8] = frame.data.as_ref();
        // Destructured so the borrow checker sees two disjoint fields rather
        // than one `&mut self` used twice.
        let Self {
            decoder,
            scratch,
            dropped,
        } = self;
        match decoder.decode(Some(bytes), &mut scratch[..], false) {
            Ok(n) if n > 0 => {
                let mut out = Vec::with_capacity(n * 2);
                for s in &scratch[..n] {
                    out.extend_from_slice(&s.to_le_bytes());
                }
                Some(out)
            }
            Ok(_) => None,
            Err(e) => {
                *dropped += 1;
                // Once per stream is enough; a corrupt uplink would otherwise
                // fill the log at 50 lines a second.
                if *dropped == 1 {
                    warn!(target: "voice", error = %e, "opus decode failed; dropping frame(s)");
                }
                None
            }
        }
    }

    pub fn dropped(&self) -> u32 {
        self.dropped
    }
}

#[async_trait]
impl SttProvider for AliyunNlsProvider {
    fn name(&self) -> &'static str {
        "aliyun-nls"
    }

    async fn recognize(
        &self,
        intent: Intent,
        frames_rx: mpsc::Receiver<AudioFrame>,
    ) -> Result<SttStream, SttError> {
        let creds = self
            .credentials
            .credentials()
            .await
            .map_err(SttError::Connect)?;

        let (transcripts_tx, transcripts_rx) = mpsc::channel(16);
        // The router owns the sender it pushes frames through; this one is
        // handed back only to satisfy the trait shape.
        let (frames_tx, _unused) = mpsc::channel(64);

        tokio::spawn(async move {
            if let Err(e) = run_session(creds, intent, frames_rx, transcripts_tx.clone()).await {
                warn!(target: "voice", error = %e, "NLS recognition session failed");
                // Close the utterance rather than leaving the router waiting
                // for a final that will never come.
                let _ = transcripts_tx.send(Transcript::final_(String::new())).await;
            }
        });

        Ok(SttStream {
            frames_tx,
            transcripts_rx,
        })
    }
}

async fn run_session(
    creds: super::credentials::VoiceCredentials,
    intent: Intent,
    mut frames_rx: mpsc::Receiver<AudioFrame>,
    transcripts_tx: mpsc::Sender<Transcript>,
) -> Result<(), SttError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let request = handshake(&creds.gateway_endpoint, &creds.token).map_err(SttError::Connect)?;
    let (ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| SttError::Connect(format!("{}: {e}", creds.gateway_endpoint)))?;
    let (mut sink, mut stream) = ws.split();

    let task_id = nls_id();
    let start = envelope(
        NAMESPACE,
        "StartTranscription",
        &creds.app_key,
        &task_id,
        serde_json::json!({
            "format": "pcm",
            "sample_rate": 16000,
            // A note is read back on screen rather than spoken, so it can
            // trade first-partial latency for accuracy — the same call the
            // FunASR adapter makes for the same reason.
            "enable_intermediate_result": intent == Intent::Chat,
            "enable_punctuation_prediction": true,
            "enable_inverse_text_normalization": true,
        }),
    );
    sink.send(Message::Text(start))
        .await
        .map_err(|e| SttError::Upstream(format!("StartTranscription: {e}")))?;

    let mut decoder = OpusToPcm::new()?;
    let mut sentences: Vec<String> = Vec::new();

    // The gateway refuses binary until it has answered `TranscriptionStarted`:
    //
    //     TaskFailed 40000002
    //     Gateway:MESSAGE_INVALID:Invalid binary message while server state is 'ROUTING'
    //
    // Mic frames start arriving within milliseconds of `turn_start`, well
    // inside that window, so audio sent eagerly would fail *every* turn.
    // Frames are buffered until the gateway is ready and flushed in order.
    // (Observed on the live gateway 2026-08-25; the handshake is short, so the
    // buffer holds a few hundred milliseconds of 640-byte frames at most.)
    let mut ready = false;
    let mut pending: Vec<Vec<u8>> = Vec::new();
    let mut frames_done = false;
    let mut sent_stop = false;

    loop {
        tokio::select! {
            frame = frames_rx.recv(), if !frames_done => match frame {
                Some(f) => {
                    if let Some(pcm) = decoder.decode(&f) {
                        if ready {
                            if sink.send(Message::Binary(pcm)).await.is_err() {
                                break;
                            }
                        } else {
                            pending.push(pcm);
                        }
                    }
                }
                None => {
                    // End of utterance. If the gateway is still handshaking the
                    // stop has to wait too, or it races the buffered audio.
                    frames_done = true;
                    if ready && !sent_stop {
                        let stop = envelope(NAMESPACE, "StopTranscription", &creds.app_key,
                                            &task_id, serde_json::json!({}));
                        let _ = sink.send(Message::Text(stop)).await;
                        sent_stop = true;
                    }
                }
            },
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let m = NlsMessage::parse(&text).map_err(SttError::Upstream)?;
                    if let Some(reason) = m.failure() {
                        return Err(SttError::Upstream(reason));
                    }
                    match m.header.name.as_str() {
                        "TranscriptionStarted" => {
                            ready = true;
                            for pcm in pending.drain(..) {
                                if sink.send(Message::Binary(pcm)).await.is_err() {
                                    break;
                                }
                            }
                            // The user may have released the button while we
                            // were still handshaking.
                            if frames_done && !sent_stop {
                                let stop = envelope(NAMESPACE, "StopTranscription",
                                                    &creds.app_key, &task_id,
                                                    serde_json::json!({}));
                                let _ = sink.send(Message::Text(stop)).await;
                                sent_stop = true;
                            }
                        }
                        "TranscriptionResultChanged" => {
                            if let Some(t) = m.result_text().filter(|t| !t.is_empty()) {
                                // Partials are best-effort: a full channel means
                                // the consumer is behind, and a stale partial is
                                // worth less than the next one.
                                let _ = transcripts_tx.try_send(Transcript::partial(t));
                            }
                        }
                        "SentenceEnd" => {
                            if let Some(t) = m.result_text().filter(|t| !t.is_empty()) {
                                sentences.push(t.to_string());
                            }
                        }
                        "TranscriptionCompleted" => break,
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(SttError::Upstream(format!("socket: {e}"))),
            },
        }
    }

    if decoder.dropped() > 0 {
        warn!(target: "voice", dropped = decoder.dropped(),
              "NLS recognition: some frames failed to decode");
    }
    // One final per utterance, not one per sentence: several finals would be
    // several prompts for a single button press.
    let _ = transcripts_tx
        .send(Transcript::final_(sentences.join("")))
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::credentials::{StaticCredentials, VoiceCredentials};
    use chrono::{Duration, Utc};

    fn creds() -> VoiceCredentials {
        VoiceCredentials {
            gateway_endpoint: "wss://127.0.0.1:1/ws/v1".into(),
            app_key: "ak".into(),
            token: "tok".into(),
            expires_at: Utc::now() + Duration::hours(1),
            stt_model: "paraformer-realtime-v2".into(),
            tts_voice: "zhixiaobai".into(),
        }
    }

    fn opus_frame(samples: &[i16]) -> Vec<u8> {
        use audiopus::{coder::Encoder, Application, Channels, SampleRate};
        let enc =
            Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip).expect("encoder");
        let mut buf = vec![0u8; 1275];
        let n = enc.encode(samples, &mut buf).expect("encode");
        buf.truncate(n);
        buf
    }

    #[test]
    fn a_real_opus_frame_decodes_to_one_frame_of_pcm() {
        // Round-trips through libopus rather than asserting on a fixture, so
        // this stays honest if the encoder settings change.
        let pcm: Vec<i16> = (0..FRAME_SAMPLES)
            .map(|i| ((i % 200) as i16 - 100) * 60)
            .collect();
        let mut d = OpusToPcm::new().expect("decoder");
        let out = d
            .decode(&AudioFrame::opus(opus_frame(&pcm)))
            .expect("decodes");
        // 320 samples * 2 bytes. Opus is lossy in value, not in length.
        assert_eq!(out.len(), FRAME_SAMPLES * 2);
        assert_eq!(d.dropped(), 0);
    }

    #[test]
    fn pcm_is_passed_through_rather_than_opus_decoded() {
        // A provider upstream may have decoded already; trying to Opus-decode
        // raw samples would drop every frame.
        let mut d = OpusToPcm::new().expect("decoder");
        let raw = vec![1u8, 2, 3, 4];
        let frame = AudioFrame {
            format: AudioFormat::Pcm16kMono,
            data: raw.clone().into(),
            capture_ms: 0,
        };
        assert_eq!(d.decode(&frame), Some(raw));
    }

    #[test]
    fn a_corrupt_frame_is_dropped_not_fatal() {
        // The uplink is QoS 0 and already tolerates loss; killing the whole
        // utterance over one bad packet would be the worse trade.
        let mut d = OpusToPcm::new().expect("decoder");
        assert_eq!(d.decode(&AudioFrame::opus(vec![0xff, 0xff, 0xff])), None);
        assert_eq!(d.dropped(), 1);

        // …and the decoder still works afterwards.
        let pcm: Vec<i16> = (0..FRAME_SAMPLES).map(|i| (i as i16) * 10).collect();
        assert!(d.decode(&AudioFrame::opus(opus_frame(&pcm))).is_some());
    }

    #[test]
    fn an_empty_frame_is_dropped() {
        let mut d = OpusToPcm::new().expect("decoder");
        assert_eq!(d.decode(&AudioFrame::opus(Vec::new())), None);
    }

    #[test]
    fn decoded_pcm_is_little_endian() {
        // NLS reads 16-bit LE. Big-endian would be accepted and transcribed as
        // noise, with nothing anywhere reporting a problem.
        let mut d = OpusToPcm::new().expect("decoder");
        let silence = vec![0i16; FRAME_SAMPLES];
        let out = d
            .decode(&AudioFrame::opus(opus_frame(&silence)))
            .expect("decodes");
        let first = i16::from_le_bytes([out[0], out[1]]);
        assert!(first.abs() < 500, "near-silence expected, got {first}");
    }

    #[tokio::test]
    async fn an_unreachable_gateway_closes_the_utterance_instead_of_hanging() {
        // Port 1 refuses. The router waits on a final; never sending one would
        // leave the device on its Think screen until the firmware's own
        // deadline expires.
        let provider = AliyunNlsProvider::new(Arc::new(StaticCredentials(creds())));
        let (_tx, rx) = mpsc::channel(4);
        let mut stream = provider
            .recognize(Intent::Chat, rx)
            .await
            .expect("opening a stream must not require the gateway");

        let final_t = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stream.transcripts_rx.recv(),
        )
        .await
        .expect("must not hang")
        .expect("a final");
        assert!(final_t.is_final);
        assert!(final_t.text.is_empty());
    }

    #[tokio::test]
    async fn a_credential_failure_is_reported_as_connect_not_swallowed() {
        struct Failing;
        #[async_trait]
        impl CredentialSource for Failing {
            async fn credentials(&self) -> Result<VoiceCredentials, String> {
                Err("HTTP 503: VOICE_ACCESS_KEY_ID is not set".into())
            }
        }
        let provider = AliyunNlsProvider::new(Arc::new(Failing));
        let (_tx, rx) = mpsc::channel(4);
        let err = provider
            .recognize(Intent::Chat, rx)
            .await
            .expect_err("no creds");
        // FC's diagnosis must survive the trip: it names the missing variable.
        assert!(
            matches!(err, SttError::Connect(ref m) if m.contains("VOICE_ACCESS_KEY_ID")),
            "got {err:?}"
        );
    }
}

/// Live tests against the real NLS gateway. See [`super::aliyun_tts::live`] for
/// why these are ignored by default and how to run them.
///
/// The recognition test is a closed loop: synthesise a known sentence, encode
/// it the way the device does, and transcribe it back. That exercises the Opus
/// decode, the handshake ordering, and the transcript accumulation in one go —
/// and it is what caught audio being rejected before `TranscriptionStarted`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::voice::credentials::StaticCredentials;
    use crate::voice::tts::{TtsProvider, TTS_SAMPLE_RATE};

    fn from_env_or_skip() -> Option<Arc<dyn CredentialSource>> {
        StaticCredentials::from_env().map(|c| Arc::new(c) as Arc<dyn CredentialSource>)
    }

    /// Synthesise `text` and return it as the device would send it: Opus,
    /// 16 kHz mono, 20 ms frames.
    async fn speech_as_opus_frames(creds: Arc<dyn CredentialSource>, text: &str) -> Vec<Vec<u8>> {
        use audiopus::{coder::Encoder, Application, Channels, SampleRate};

        let tts = crate::voice::aliyun_tts::AliyunTtsProvider::new(creds);
        let stream = tts.speak().await.expect("tts stream");
        stream.text_tx.send(text.to_string()).await.expect("send");
        drop(stream.text_tx);

        let mut pcm: Vec<i16> = Vec::new();
        let mut rx = stream.audio_rx;
        while let Some(c) = rx.recv().await {
            pcm.extend(c.samples);
        }
        assert!(!pcm.is_empty(), "TTS produced nothing to recognise");

        let enc =
            Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip).expect("encoder");
        pcm.chunks(FRAME_SAMPLES)
            .filter(|c| c.len() == FRAME_SAMPLES)
            .map(|chunk| {
                let mut buf = vec![0u8; 1275];
                let n = enc.encode(chunk, &mut buf).expect("encode");
                buf.truncate(n);
                buf
            })
            .collect()
    }

    #[tokio::test]
    #[ignore = "needs TEAMCLU_VOICE_APPKEY + TEAMCLU_VOICE_TOKEN"]
    async fn transcribes_synthesised_speech_back() {
        let Some(creds) = from_env_or_skip() else {
            eprintln!("no TEAMCLU_VOICE_* in env; skipping");
            return;
        };
        const SENTENCE: &str = "今天天气不错";
        let frames = speech_as_opus_frames(creds.clone(), "今天天气不错。").await;
        eprintln!(
            "{} opus frames = {:.2}s",
            frames.len(),
            (frames.len() * FRAME_SAMPLES) as f64 / TTS_SAMPLE_RATE as f64
        );

        let provider = AliyunNlsProvider::new(creds);
        let (tx, rx) = mpsc::channel(256);
        let mut stream = provider
            .recognize(Intent::Chat, rx)
            .await
            .expect("recognize");

        // Push in real time, the way the device does. Sending the whole
        // utterance at once would not exercise the handshake race.
        tokio::spawn(async move {
            for f in frames {
                if tx.send(AudioFrame::opus(f)).await.is_err() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        });

        let mut final_text = String::new();
        let mut partials = 0;
        while let Some(t) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            stream.transcripts_rx.recv(),
        )
        .await
        .expect("must not hang")
        {
            if t.is_final {
                final_text = t.text;
                break;
            }
            partials += 1;
        }

        eprintln!("partials={partials} final={final_text:?}");
        assert!(
            final_text.contains(SENTENCE),
            "expected {SENTENCE:?} inside {final_text:?}",
        );
        assert!(
            partials > 0,
            "chat intent should produce intermediate results"
        );
    }
}
