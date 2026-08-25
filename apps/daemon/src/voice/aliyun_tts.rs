//! Alibaba NLS streaming synthesis (`SpeechSynthesizer`).
//!
//! The synthesis half of plan §13.9. Credentials come from
//! [`super::credentials`]; the AccessKey behind them never reaches this process.
//!
//! ## No resampler on this path
//!
//! NLS takes `sample_rate` as a synthesis parameter, so this asks for **16 kHz
//! PCM directly** — the rate the device's Opus decoder and
//! [`super::tts::TTS_SAMPLE_RATE`] already use. That is the difference between
//! a hosted API and the withdrawn self-hosted CosyVoice, which emitted 24 kHz
//! and forced [`super::resample`] into the path.
//!
//! [`super::resample`] is deliberately still in the tree: the rate here is a
//! *request*, and until it has been observed on the wire that it is honoured,
//! deleting the only thing that could correct a mismatch would be premature.
//! [`AliyunTtsConfig::sample_rate`] exists so the correction is one config
//! change away.
//!
//! ## One session per sentence
//!
//! [`super::tts::SentenceChunker`] hands this adapter sentence-sized pieces and
//! each becomes its own short WebSocket session, in order. `SpeechSynthesizer`
//! synthesises one text per session, so this is what the protocol offers
//! without moving to `FlowingSpeechSynthesizer` (streamed text on one
//! connection) — worth doing if per-sentence handshakes show up in the §9
//! numbers, and not before.
//!
//! ## Status — verified on the live gateway 2026-08-25
//!
//! A real synthesis returned **16 kHz PCM**, in variable-sized binary frames
//! (8000 bytes typically, but 320 and 296 were both observed), closed by
//! `SynthesisCompleted`. So the no-resampler claim above is measured, not
//! assumed. Frame sizes really do vary, which is why [`pcm_from_bytes`] carries
//! a straddling byte rather than trusting alignment.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::warn;

use super::credentials::CredentialSource;
use super::nls::{envelope, handshake, nls_id, NlsMessage};
use super::resample::Resampler;
use super::tts::{PcmChunk, TtsError, TtsProvider, TtsStream, TTS_SAMPLE_RATE};

const NAMESPACE: &str = "SpeechSynthesizer";

#[derive(Debug, Clone)]
pub struct AliyunTtsConfig {
    /// What to ask NLS to synthesise at. Matches the device, so no resampling
    /// happens unless this is changed away from it.
    pub sample_rate: u32,
    /// -500..500, NLS's speed scale. 0 is the voice's natural rate.
    pub speech_rate: i32,
    /// 0..100.
    pub volume: u32,
}

impl Default for AliyunTtsConfig {
    fn default() -> Self {
        Self {
            sample_rate: TTS_SAMPLE_RATE,
            speech_rate: 0,
            volume: 50,
        }
    }
}

pub struct AliyunTtsProvider {
    credentials: Arc<dyn CredentialSource>,
    config: AliyunTtsConfig,
}

impl AliyunTtsProvider {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Self {
        Self {
            credentials,
            config: AliyunTtsConfig::default(),
        }
    }

    pub fn with_config(mut self, config: AliyunTtsConfig) -> Self {
        self.config = config;
        self
    }
}

#[async_trait]
impl TtsProvider for AliyunTtsProvider {
    fn name(&self) -> &'static str {
        "aliyun-nls-tts"
    }

    async fn speak(&self) -> Result<TtsStream, TtsError> {
        let creds = self
            .credentials
            .credentials()
            .await
            .map_err(TtsError::Connect)?;
        let cfg = self.config.clone();

        let (text_tx, mut text_rx) = mpsc::channel::<String>(16);
        let (audio_tx, audio_rx) = mpsc::channel::<PcmChunk>(32);

        tokio::spawn(async move {
            // One resampler across the whole utterance, so filter state
            // survives sentence boundaries — a fresh one per sentence would
            // re-run its settling transient and tick at every join.
            let mut resampler = (cfg.sample_rate != TTS_SAMPLE_RATE)
                .then(|| Resampler::new(cfg.sample_rate, TTS_SAMPLE_RATE));

            while let Some(text) = text_rx.recv().await {
                if text.trim().is_empty() {
                    continue;
                }
                if let Err(e) = synth_one(&creds, &cfg, &text, &mut resampler, &audio_tx).await {
                    // One failed sentence must not silence the rest of the
                    // reply.
                    warn!(target: "voice", error = %e, "NLS synthesis failed for a sentence");
                }
            }

            if let Some(mut r) = resampler {
                let tail = to_i16(r.flush());
                if !tail.is_empty() {
                    let _ = audio_tx.send(PcmChunk { samples: tail }).await;
                }
            }
        });

        Ok(TtsStream { text_tx, audio_rx })
    }
}

fn to_i16(samples: Vec<f32>) -> Vec<i16> {
    samples
        .into_iter()
        .map(|s| s.clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

/// Decode a little-endian PCM byte run, carrying an odd trailing byte forward.
///
/// A 16-bit sample can straddle two WebSocket frames. Dropping the stray byte
/// shifts every later sample by one and turns the rest of the utterance into
/// noise, so it is held instead.
pub fn pcm_from_bytes(bytes: &[u8], carry: &mut Option<u8>) -> Vec<i16> {
    let mut buf: Vec<u8> = Vec::with_capacity(bytes.len() + 1);
    if let Some(b) = carry.take() {
        buf.push(b);
    }
    buf.extend_from_slice(bytes);
    if buf.len() % 2 == 1 {
        *carry = buf.pop();
    }
    buf.chunks_exact(2)
        .map(|p| i16::from_le_bytes([p[0], p[1]]))
        .collect()
}

async fn synth_one(
    creds: &super::credentials::VoiceCredentials,
    cfg: &AliyunTtsConfig,
    text: &str,
    resampler: &mut Option<Resampler>,
    audio_tx: &mpsc::Sender<PcmChunk>,
) -> Result<(), TtsError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let request = handshake(&creds.gateway_endpoint, &creds.token).map_err(TtsError::Connect)?;
    let (ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| TtsError::Connect(format!("{}: {e}", creds.gateway_endpoint)))?;
    let (mut sink, mut stream) = ws.split();

    let task_id = nls_id();
    let start = envelope(
        NAMESPACE,
        "StartSynthesis",
        &creds.app_key,
        &task_id,
        serde_json::json!({
            "text": text,
            "voice": creds.tts_voice,
            "format": "pcm",
            "sample_rate": cfg.sample_rate,
            "volume": cfg.volume,
            "speech_rate": cfg.speech_rate,
        }),
    );
    sink.send(Message::Text(start))
        .await
        .map_err(|e| TtsError::Upstream(format!("StartSynthesis: {e}")))?;

    let mut carry: Option<u8> = None;

    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Binary(bytes)) => {
                let samples = pcm_from_bytes(&bytes, &mut carry);
                if samples.is_empty() {
                    continue;
                }
                let out = match resampler {
                    Some(r) => {
                        let f: Vec<f32> = samples.iter().map(|&s| s as f32).collect();
                        to_i16(r.push(&f))
                    }
                    None => samples,
                };
                if out.is_empty() {
                    continue;
                }
                // A closed receiver means the turn was cancelled (barge-in, or
                // the device went away). Stop rather than filling a dead
                // channel — and do not call it an error.
                if audio_tx.send(PcmChunk { samples: out }).await.is_err() {
                    return Ok(());
                }
            }
            Ok(Message::Text(text)) => {
                let m = NlsMessage::parse(&text).map_err(TtsError::Upstream)?;
                if let Some(reason) = m.failure() {
                    return Err(TtsError::Upstream(reason));
                }
                if m.header.name == "SynthesisCompleted" {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(e) => return Err(TtsError::Upstream(format!("socket: {e}"))),
        }
    }
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

    #[test]
    fn the_default_rate_matches_the_device_so_nothing_resamples() {
        // The whole reason the hosted path is simpler than the self-hosted one.
        // If this ever drifts, audio plays at the wrong speed and no test
        // downstream would notice.
        assert_eq!(AliyunTtsConfig::default().sample_rate, TTS_SAMPLE_RATE);
        assert_eq!(TTS_SAMPLE_RATE, 16_000);
    }

    #[test]
    fn pcm_decode_is_little_endian() {
        let mut carry = None;
        // 0x0100 LE = 1, 0xFFFF LE = -1
        let out = pcm_from_bytes(&[0x01, 0x00, 0xff, 0xff], &mut carry);
        assert_eq!(out, vec![1, -1]);
        assert!(carry.is_none());
    }

    #[test]
    fn an_odd_byte_is_carried_to_the_next_frame() {
        // Dropping it would shift every later sample and turn the rest of the
        // utterance into noise.
        let mut carry = None;
        let a = pcm_from_bytes(&[0x01, 0x00, 0x02], &mut carry);
        assert_eq!(a, vec![1]);
        assert_eq!(carry, Some(0x02));

        let b = pcm_from_bytes(&[0x00, 0x03, 0x00], &mut carry);
        assert_eq!(b, vec![2, 3], "the carried byte forms the next sample");
        assert_eq!(carry, None);
    }

    #[test]
    fn an_empty_run_yields_nothing_and_keeps_the_carry() {
        let mut carry = Some(0x07);
        assert!(pcm_from_bytes(&[], &mut carry).is_empty());
        assert_eq!(carry, Some(0x07), "an empty frame must not eat the carry");
    }

    #[tokio::test]
    async fn opening_a_stream_does_not_contact_the_gateway() {
        // Turn setup must not depend on the vendor being reachable; only
        // pushing text does.
        let p = AliyunTtsProvider::new(Arc::new(StaticCredentials(creds())));
        let stream = p.speak().await.expect("stream opens");
        drop(stream.text_tx);
        let mut rx = stream.audio_rx;
        assert!(rx.recv().await.is_none(), "no text pushed, so no audio");
    }

    #[tokio::test]
    async fn a_dead_gateway_closes_the_stream_rather_than_hanging() {
        // Port 1 refuses every connection. `spk`'s pump awaits this channel to
        // close before it reports the turn finished.
        let p = AliyunTtsProvider::new(Arc::new(StaticCredentials(creds())));
        let stream = p.speak().await.expect("stream opens");
        stream.text_tx.send("你好。".into()).await.expect("send");
        drop(stream.text_tx);
        let mut rx = stream.audio_rx;
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let mut n = 0;
            while rx.recv().await.is_some() {
                n += 1;
            }
            n
        })
        .await
        .expect("must close, not hang");
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn blank_pieces_never_open_a_session() {
        let p = AliyunTtsProvider::new(Arc::new(StaticCredentials(creds())));
        let stream = p.speak().await.expect("stream opens");
        for blank in ["   ", "\n", ""] {
            stream.text_tx.send(blank.into()).await.expect("send");
        }
        drop(stream.text_tx);
        let mut rx = stream.audio_rx;
        // Reaching here without a connection attempt per blank is the point;
        // the assertion is that it terminates promptly.
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while rx.recv().await.is_some() {}
            })
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn a_credential_failure_surfaces_fcs_diagnosis() {
        struct Failing;
        #[async_trait]
        impl CredentialSource for Failing {
            async fn credentials(&self) -> Result<VoiceCredentials, String> {
                Err("HTTP 502: voice_upstream_failed".into())
            }
        }
        let p = AliyunTtsProvider::new(Arc::new(Failing));
        let err = p.speak().await.expect_err("no creds");
        assert!(
            matches!(err, TtsError::Connect(ref m) if m.contains("voice_upstream_failed")),
            "got {err:?}"
        );
    }
}

/// Live tests against the real NLS gateway.
///
/// Ignored by default: they need a token, cost vendor quota, and would make CI
/// depend on a third party. Run them when a credential is in hand — they are
/// the only tests that can catch a protocol change, which is the class of bug
/// that produced `Engine return error code: 418` and the `ROUTING` rejection.
///
/// ```sh
/// set -a; . deploy/self-host/.env; set +a
/// TEAMCLU_VOICE_APPKEY=$VOICE_NLS_APPKEY \
///   cargo test -p amuxd --bin amuxd voice::aliyun_tts::live -- --ignored --nocapture
/// ```
#[cfg(test)]
mod live {
    use super::*;
    use crate::voice::credentials::StaticCredentials;

    fn from_env_or_skip() -> Option<Arc<dyn CredentialSource>> {
        StaticCredentials::from_env().map(|c| Arc::new(c) as Arc<dyn CredentialSource>)
    }

    #[tokio::test]
    #[ignore = "needs TEAMCLU_VOICE_APPKEY + TEAMCLU_VOICE_TOKEN"]
    async fn synthesises_real_16k_pcm() {
        let Some(creds) = from_env_or_skip() else {
            eprintln!("no TEAMCLU_VOICE_* in env; skipping");
            return;
        };
        let p = AliyunTtsProvider::new(creds);
        let stream = p.speak().await.expect("stream opens");
        stream
            .text_tx
            .send("今天天气不错。".to_string())
            .await
            .expect("send");
        drop(stream.text_tx);

        let mut rx = stream.audio_rx;
        let mut samples = 0usize;
        while let Some(c) = rx.recv().await {
            samples += c.samples.len();
        }
        // A short Chinese sentence is roughly a second of speech; anything
        // near zero means the protocol was accepted but produced nothing.
        let secs = samples as f64 / TTS_SAMPLE_RATE as f64;
        eprintln!("synthesised {samples} samples = {secs:.2}s");
        assert!(secs > 0.3, "expected real audio, got {secs:.2}s");
        assert!(
            secs < 10.0,
            "suspiciously long for one sentence: {secs:.2}s"
        );
    }

    #[tokio::test]
    #[ignore = "needs TEAMCLU_VOICE_APPKEY + TEAMCLU_VOICE_TOKEN"]
    async fn several_sentences_stream_in_order() {
        let Some(creds) = from_env_or_skip() else {
            eprintln!("no TEAMCLU_VOICE_* in env; skipping");
            return;
        };
        let p = AliyunTtsProvider::new(creds);
        let stream = p.speak().await.expect("stream opens");
        for s in ["第一句。", "第二句。"] {
            stream.text_tx.send(s.to_string()).await.expect("send");
        }
        drop(stream.text_tx);

        let mut rx = stream.audio_rx;
        let mut samples = 0usize;
        while let Some(c) = rx.recv().await {
            samples += c.samples.len();
        }
        let secs = samples as f64 / TTS_SAMPLE_RATE as f64;
        eprintln!("two sentences = {secs:.2}s");
        assert!(
            secs > 0.6,
            "both sentences should be present, got {secs:.2}s"
        );
    }
}
