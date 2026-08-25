//! CosyVoice local TTS adapter.
//!
//! CosyVoice is ModelScope's open-source TTS — the same family as FunASR on
//! the STT side, so a deployment that already runs one is not adopting a
//! second ecosystem to run the other. Like FunASR it was chosen over the
//! plan's default (Cartesia, §1) for the blunt reason that **no Cartesia API
//! key exists**, plus the same three properties that made FunASR the STT
//! default: no per-character billing, no audio egress, Chinese-first quality.
//!
//! ## Deployment this adapter targets
//!
//! The `runtime/python/fastapi` server from the CosyVoice repo, which exposes
//! `POST /inference_sft` with form fields `tts_text` and `spk_id` and answers
//! with a **chunked stream of raw little-endian i16 PCM** at the model's own
//! sample rate. There is no envelope, no WAV header, no JSON — the body is
//! samples, and the stream ends when the utterance is fully synthesised.
//!
//! ## Sample rate
//!
//! CosyVoice2 synthesises at 24 kHz, CosyVoice1 at 22.05 kHz; the device
//! decodes 16 kHz. [`super::resample`] bridges that, per stream so the filter
//! state survives HTTP chunk boundaries. Setting [`CosyVoiceConfig::sample_rate`]
//! wrong does not error — it just plays back at the wrong speed and pitch — so
//! it is the first thing to check if hardware playback sounds off.
//!
//! ## One request per sentence
//!
//! [`super::tts::SentenceChunker`] hands this adapter sentence-sized pieces and
//! each becomes its own HTTP request, issued as the piece arrives. Sentence 2
//! is therefore synthesised while sentence 1 is still being spoken, which is
//! what keeps first-audio latency inside the §9 budget without waiting for the
//! agent's full reply. Pieces are processed in order — the device plays a
//! single sequential audio stream, so out-of-order completion would be worse
//! than the lost parallelism.
//!
//! ## State
//!
//! **Never run against a real CosyVoice server** — none is deployed yet, and
//! the protocol here is transcribed from the repo's `server.py` rather than
//! observed on the wire. The same caveat as [`super::funasr`] applies: treat
//! the field names as the most likely thing to be wrong.

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::resample::Resampler;
use super::tts::{PcmChunk, TtsError, TtsProvider, TtsStream, TTS_SAMPLE_RATE};

/// Which CosyVoice inference endpoint to call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CosyVoiceMode {
    /// Pre-trained speaker (`/inference_sft`). Needs only a speaker id.
    Sft,
    /// Natural-language style control (`/inference_instruct`).
    Instruct,
}

impl CosyVoiceMode {
    fn path(self) -> &'static str {
        match self {
            CosyVoiceMode::Sft => "/inference_sft",
            CosyVoiceMode::Instruct => "/inference_instruct",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CosyVoiceConfig {
    /// Base URL of the CosyVoice fastapi server, no trailing slash.
    pub base_url: String,
    /// Pre-trained speaker id, e.g. `中文女` / `中文男`.
    pub speaker: String,
    pub mode: CosyVoiceMode,
    /// Style prompt for [`CosyVoiceMode::Instruct`]; ignored for `Sft`.
    pub instruct: String,
    /// The server's output rate. 24000 for CosyVoice2, 22050 for CosyVoice1.
    /// Wrong values are inaudible in tests and obvious on hardware.
    pub sample_rate: u32,
}

impl Default for CosyVoiceConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:50000".to_string(),
            speaker: "中文女".to_string(),
            mode: CosyVoiceMode::Sft,
            instruct: String::new(),
            sample_rate: 24_000,
        }
    }
}

impl CosyVoiceConfig {
    /// Override from the environment. Deployment-specific and no secrets, so
    /// env is the right home — unlike an API key, which would want config.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        if let Ok(url) = std::env::var("TEAMCLU_COSYVOICE_URL") {
            if !url.trim().is_empty() {
                cfg.base_url = url.trim().trim_end_matches('/').to_string();
            }
        }
        if let Ok(spk) = std::env::var("TEAMCLU_COSYVOICE_SPEAKER") {
            if !spk.trim().is_empty() {
                cfg.speaker = spk.trim().to_string();
            }
        }
        if let Ok(rate) = std::env::var("TEAMCLU_COSYVOICE_SAMPLE_RATE") {
            if let Ok(parsed) = rate.trim().parse::<u32>() {
                if parsed > 0 {
                    cfg.sample_rate = parsed;
                }
            }
        }
        cfg
    }

    fn endpoint(&self) -> String {
        format!(
            "{}{}",
            self.base_url.trim_end_matches('/'),
            self.mode.path()
        )
    }
}

#[derive(Debug, Clone, Default)]
pub struct CosyVoiceProvider {
    pub config: CosyVoiceConfig,
}

impl CosyVoiceProvider {
    pub fn new(config: CosyVoiceConfig) -> Self {
        Self { config }
    }

    /// Synthesise one text piece, forwarding PCM as it streams in.
    ///
    /// `resampler` is threaded through from the caller rather than created
    /// here so filter state carries across sentences: a fresh resampler per
    /// sentence would re-run its settling transient every time, which is an
    /// audible tick at each boundary.
    async fn synth_piece(
        &self,
        client: &reqwest::Client,
        text: &str,
        resampler: &mut Option<Resampler>,
        audio_tx: &mpsc::Sender<PcmChunk>,
    ) -> Result<(), TtsError> {
        use futures_util::StreamExt;

        let mut form = vec![
            ("tts_text".to_string(), text.to_string()),
            ("spk_id".to_string(), self.config.speaker.clone()),
        ];
        if self.config.mode == CosyVoiceMode::Instruct && !self.config.instruct.is_empty() {
            form.push(("instruct_text".to_string(), self.config.instruct.clone()));
        }

        let resp = client
            .post(self.config.endpoint())
            .form(&form)
            .send()
            .await
            .map_err(|e| TtsError::Connect(format!("{}: {e}", self.config.endpoint())))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(200).collect();
            return Err(TtsError::Upstream(format!("HTTP {status}: {snippet}")));
        }

        let mut body = resp.bytes_stream();
        // The body is a byte stream, not a sample stream: a 16-bit sample can
        // straddle two chunks, so a stray odd byte has to be carried forward
        // rather than dropped (dropping it shifts every later sample by one
        // byte and turns the rest of the utterance into noise).
        let mut odd: Option<u8> = None;

        while let Some(chunk) = body.next().await {
            let chunk =
                chunk.map_err(|e| TtsError::Upstream(format!("stream read failed: {e}")))?;
            let mut bytes: Vec<u8> = Vec::with_capacity(chunk.len() + 1);
            if let Some(b) = odd.take() {
                bytes.push(b);
            }
            bytes.extend_from_slice(&chunk);
            if bytes.len() % 2 == 1 {
                odd = bytes.pop();
            }
            if bytes.is_empty() {
                continue;
            }

            let samples: Vec<i16> = bytes
                .chunks_exact(2)
                .map(|p| i16::from_le_bytes([p[0], p[1]]))
                .collect();

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
            // A closed receiver means the turn was cancelled (barge-in, or the
            // device went away). Stop synthesising rather than filling a dead
            // channel — and don't report it as an error.
            if audio_tx.send(PcmChunk { samples: out }).await.is_err() {
                return Ok(());
            }
        }
        Ok(())
    }
}

fn to_i16(samples: Vec<f32>) -> Vec<i16> {
    samples
        .into_iter()
        .map(|s| s.clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

#[async_trait]
impl TtsProvider for CosyVoiceProvider {
    fn name(&self) -> &'static str {
        "cosyvoice"
    }

    async fn speak(&self) -> Result<TtsStream, TtsError> {
        let (text_tx, mut text_rx) = mpsc::channel::<String>(16);
        let (audio_tx, audio_rx) = mpsc::channel::<PcmChunk>(32);

        let provider = self.clone();
        let needs_resample = provider.config.sample_rate != TTS_SAMPLE_RATE;

        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let mut resampler = needs_resample
                .then(|| Resampler::new(provider.config.sample_rate, TTS_SAMPLE_RATE));

            while let Some(text) = text_rx.recv().await {
                if text.trim().is_empty() {
                    continue;
                }
                if let Err(e) = provider
                    .synth_piece(&client, &text, &mut resampler, &audio_tx)
                    .await
                {
                    // One failed sentence should not silence the rest of the
                    // reply; log and keep going.
                    tracing::warn!(error = %e, "cosyvoice piece failed");
                }
            }

            // End of utterance: drain the resampler's tail so the last few
            // milliseconds of the final sentence are not clipped.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_follows_mode() {
        let cfg = CosyVoiceConfig::default();
        assert_eq!(cfg.endpoint(), "http://127.0.0.1:50000/inference_sft");
        let instruct = CosyVoiceConfig {
            mode: CosyVoiceMode::Instruct,
            ..Default::default()
        };
        assert!(instruct.endpoint().ends_with("/inference_instruct"));
    }

    #[test]
    fn endpoint_tolerates_a_trailing_slash() {
        let cfg = CosyVoiceConfig {
            base_url: "http://host:50000/".to_string(),
            ..Default::default()
        };
        assert_eq!(cfg.endpoint(), "http://host:50000/inference_sft");
    }

    #[test]
    fn default_rate_is_cosyvoice2_and_needs_resampling() {
        // If these ever match, the resampler silently drops out of the path —
        // assert the default deployment actually exercises it.
        let cfg = CosyVoiceConfig::default();
        assert_eq!(cfg.sample_rate, 24_000);
        assert_ne!(cfg.sample_rate, TTS_SAMPLE_RATE);
    }

    #[tokio::test]
    async fn speak_yields_a_stream_without_contacting_the_server() {
        // Opening a session must not require the server to be up; only
        // pushing text does. Otherwise a dead TTS box breaks turn setup.
        let p = CosyVoiceProvider::default();
        let stream = p.speak().await.expect("stream opens");
        drop(stream.text_tx);
        let mut rx = stream.audio_rx;
        assert!(rx.recv().await.is_none(), "no text pushed, so no audio");
    }

    #[tokio::test]
    async fn a_dead_server_does_not_hang_the_stream() {
        // Port 1 has nothing on it: every piece fails to connect. The stream
        // must still close cleanly when text ends, not wedge the turn.
        let p = CosyVoiceProvider::new(CosyVoiceConfig {
            base_url: "http://127.0.0.1:1".to_string(),
            ..Default::default()
        });
        let stream = p.speak().await.expect("stream opens");
        stream.text_tx.send("你好".to_string()).await.expect("send");
        drop(stream.text_tx);
        let mut rx = stream.audio_rx;
        let got = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let mut n = 0;
            while rx.recv().await.is_some() {
                n += 1;
            }
            n
        })
        .await
        .expect("stream must close, not hang");
        assert_eq!(got, 0, "a dead server should produce no audio");
    }

    // ---- Round-trips against a stand-in server -------------------------
    //
    // These are the only tests that exercise the actual wire handling: form
    // encoding, raw-PCM decode, resampling, and error paths. They cannot
    // prove the real CosyVoice server speaks this protocol — see the module
    // docs — but they do prove this side is self-consistent.

    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Raw little-endian i16 PCM, the shape `server.py` streams back.
    fn pcm_body(n: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|i| {
                let s =
                    ((i as f64 / 24_000.0 * 440.0 * std::f64::consts::TAU).sin() * 8000.0) as i16;
                s.to_le_bytes()
            })
            .collect()
    }

    async fn provider_for(server: &MockServer) -> CosyVoiceProvider {
        CosyVoiceProvider::new(CosyVoiceConfig {
            base_url: server.uri(),
            ..Default::default()
        })
    }

    async fn collect(stream: TtsStream, pieces: &[&str]) -> Vec<i16> {
        for p in pieces {
            stream.text_tx.send((*p).to_string()).await.expect("send");
        }
        drop(stream.text_tx);
        let mut rx = stream.audio_rx;
        let mut out = Vec::new();
        while let Some(c) = rx.recv().await {
            out.extend(c.samples);
        }
        out
    }

    #[tokio::test]
    async fn synthesised_pcm_arrives_resampled_to_16k() {
        let server = MockServer::start().await;
        // 24000 input samples = 1.0 s at the server's rate.
        Mock::given(method("POST"))
            .and(path("/inference_sft"))
            .and(body_string_contains("tts_text"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(pcm_body(24_000)))
            .mount(&server)
            .await;

        let p = provider_for(&server).await;
        let out = collect(p.speak().await.expect("stream"), &["你好。"]).await;

        // 1.0 s at 24 kHz must come out as ~1.0 s at 16 kHz. Getting 24000
        // samples back here would mean the resampler was skipped and the
        // device would play the reply 1.5x fast.
        let drift = (out.len() as i64 - 16_000).abs();
        assert!(drift < 100, "got {} samples, expected ~16000", out.len());
    }

    #[tokio::test]
    async fn each_sentence_becomes_its_own_request_in_order() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/inference_sft"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(pcm_body(2_400)))
            .expect(3)
            .mount(&server)
            .await;

        let p = provider_for(&server).await;
        let out = collect(
            p.speak().await.expect("stream"),
            &["第一句。", "第二句。", "第三句。"],
        )
        .await;

        // Three 100 ms pieces at 24 kHz → ~300 ms at 16 kHz.
        assert!(
            out.len() > 4_000,
            "expected ~4800 samples, got {}",
            out.len()
        );
        // `.expect(3)` above is verified on drop: fewer or more requests fails.
    }

    #[tokio::test]
    async fn a_server_error_skips_the_piece_without_killing_the_turn() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500).set_body_string("model oom"))
            .mount(&server)
            .await;

        let p = provider_for(&server).await;
        let out = collect(p.speak().await.expect("stream"), &["坏了。", "还好。"]).await;
        assert!(out.is_empty(), "500s should yield no audio");
        // Reaching here at all is the assertion: the stream closed cleanly
        // rather than hanging or propagating a panic out of the task.
    }

    #[tokio::test]
    async fn an_odd_length_body_does_not_desync_samples() {
        // A truncated final byte must be held back, never treated as half a
        // sample — that would shift every subsequent sample and produce noise.
        let server = MockServer::start().await;
        let mut body = pcm_body(1_200);
        body.push(0x7f); // dangling byte
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let p = provider_for(&server).await;
        let out = collect(p.speak().await.expect("stream"), &["测试。"]).await;
        let expected = 1_200 * 16_000 / 24_000;
        assert!(
            (out.len() as i64 - expected as i64).abs() < 40,
            "got {} samples, expected ~{expected}",
            out.len()
        );
    }

    #[tokio::test]
    async fn blank_pieces_never_reach_the_server() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(pcm_body(240)))
            .expect(1)
            .mount(&server)
            .await;

        let p = provider_for(&server).await;
        // Whitespace-only pieces would cost a round-trip and synthesise
        // nothing; only the real one should go out.
        collect(p.speak().await.expect("stream"), &["   ", "\n", "有内容。"]).await;
    }
}
