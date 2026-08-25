//! Text-to-speech provider trait and shared types.
//!
//! Mirrors [`super::stt`] deliberately: backends sit behind a trait so the
//! publish-to-`voice/spk` plumbing can land and be tested before the vendor
//! question is settled. Plan §1 pins Cartesia, but its API key does not exist —
//! the same discovery that pushed STT to a local FunASR server — so the default
//! here is a self-hosted server for the same reasons: no key, no per-minute
//! billing, no audio egress, Chinese-first.
//!
//! ## Streaming is the point
//!
//! The provider yields [`PcmChunk`]s as they are synthesised rather than one
//! finished buffer. Plan §9 budgets ~90–200 ms to first audio, and a
//! synthesise-then-send design spends the whole utterance's synthesis time
//! before the first sample is heard. `speak` therefore takes a *stream* of text
//! (sentence-sized pieces, as the agent produces them) and returns a *stream* of
//! audio.
//!
//! ## Why PCM and not Opus
//!
//! Providers emit PCM at [`TTS_SAMPLE_RATE`]; the Opus framing lives one layer
//! up in [`super::spk`]. Encoding is identical for every backend, and a provider
//! that had to produce 20 ms Opus frames itself would need to own the framing
//! and the encoder state as well.

use async_trait::async_trait;
use thiserror::Error;
use tokio::sync::mpsc;

/// Sample rate every provider must emit. Matches the device's decoder and the
/// wire format in plan §1 — anything else would need a resampler between the
/// provider and the encoder.
pub const TTS_SAMPLE_RATE: u32 = 16_000;

/// One piece of synthesised audio: PCM 16 kHz, 16-bit, mono.
#[derive(Debug, Clone)]
pub struct PcmChunk {
    pub samples: Vec<i16>,
}

#[derive(Debug, Error)]
pub enum TtsError {
    #[error("tts connect error: {0}")]
    Connect(String),
    #[error("tts upstream error: {0}")]
    Upstream(String),
    /// The backend is configured but has no adapter yet.
    #[error("tts backend '{0}' not implemented ({1})")]
    NotImplemented(&'static str, &'static str),
}

/// Which TTS backend a team routes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtsBackend {
    /// Local CosyVoice HTTP server. Same ModelScope family as FunASR, so a
    /// deployment that already runs one is not adopting a second ecosystem.
    CosyVoiceLocal,
    /// Cartesia Sonic (plan §1 default). Lowest first-audio latency; needs a key.
    Cartesia,
    /// Aliyun hosted TTS. Needs a key.
    AliyunTts,
}

#[derive(Debug, Clone)]
pub struct TtsConfig {
    pub backend: TtsBackend,
}

impl TtsConfig {
    pub fn cosyvoice_local() -> Self {
        Self {
            backend: TtsBackend::CosyVoiceLocal,
        }
    }
}

/// A live synthesis session. Push text pieces into `text_tx` and drop it to
/// signal end-of-utterance; `audio_rx` yields PCM until synthesis finishes.
pub struct TtsStream {
    pub text_tx: mpsc::Sender<String>,
    pub audio_rx: mpsc::Receiver<PcmChunk>,
}

impl std::fmt::Debug for TtsStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TtsStream").finish_non_exhaustive()
    }
}

#[async_trait]
pub trait TtsProvider: Send + Sync {
    fn name(&self) -> &'static str;

    /// Open a streaming synthesis session.
    async fn speak(&self) -> Result<TtsStream, TtsError>;
}

impl std::fmt::Debug for dyn TtsProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TtsProvider")
            .field("name", &self.name())
            .finish_non_exhaustive()
    }
}

/// Build a boxed provider. Backends without an adapter are refused here with
/// their milestone tag rather than failing later at synthesis time.
pub fn build_provider(
    cfg: &TtsConfig,
    credentials: Option<std::sync::Arc<dyn super::credentials::CredentialSource>>,
) -> Result<Box<dyn TtsProvider>, TtsError> {
    match cfg.backend {
        // Hosted NLS is the current default per plan §13.9. It cannot be built
        // without a credential source: the AccessKey lives in FC and this
        // process only ever holds a minted, expiring token.
        TtsBackend::AliyunTts => match credentials {
            Some(source) => Ok(Box::new(super::aliyun_tts::AliyunTtsProvider::new(source))),
            None => Err(TtsError::NotImplemented(
                "AliyunTts",
                "needs a CredentialSource (POST /v1/teams/:id/voice/credentials)",
            )),
        },
        TtsBackend::CosyVoiceLocal => Ok(Box::new(super::cosyvoice::CosyVoiceProvider::default())),
        TtsBackend::Cartesia => Err(TtsError::NotImplemented(
            "Cartesia",
            "no API key exists; superseded by AliyunTts (plan §13.9)",
        )),
    }
}

/// Splits streamed agent text into pieces worth synthesising.
///
/// The agent emits token deltas — often a character or two. Synthesising each
/// would be absurd, and buffering the whole answer would forfeit the streaming
/// latency the provider exists to give. This accumulates until a sentence
/// boundary, and flushes oversized runs so a reply with no punctuation (a URL,
/// a code line) cannot stall audio indefinitely.
pub struct SentenceChunker {
    buf: String,
    max_chars: usize,
}

impl Default for SentenceChunker {
    fn default() -> Self {
        Self {
            buf: String::new(),
            // Long enough that ordinary sentences flush on punctuation, short
            // enough that a punctuation-free run still speaks promptly.
            max_chars: 60,
        }
    }
}

impl SentenceChunker {
    /// Feed a token delta. Returns any pieces that are ready to synthesise.
    pub fn push(&mut self, delta: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ch in delta.chars() {
            self.buf.push(ch);
            // Chinese punctuation first: the device is Chinese-first, and a
            // reply is far more likely to end on 。than on '.'.
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

    /// Flush whatever is left when the turn ends.
    pub fn finish(&mut self) -> Option<String> {
        let piece = self.buf.trim().to_string();
        self.buf.clear();
        if piece.is_empty() {
            None
        } else {
            Some(piece)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_refuses_keyless_backends() {
        let err = build_provider(
            &TtsConfig {
                backend: TtsBackend::Cartesia,
            },
            None,
        )
        .expect_err("cartesia has no key");
        assert!(matches!(err, TtsError::NotImplemented("Cartesia", _)));
    }

    #[test]
    fn aliyun_tts_without_credentials_is_refused_not_silently_broken() {
        let err = build_provider(
            &TtsConfig {
                backend: TtsBackend::AliyunTts,
            },
            None,
        )
        .expect_err("no credential source");
        match err {
            TtsError::NotImplemented("AliyunTts", tag) => {
                assert!(tag.contains("credentials"), "got {tag:?}")
            }
            other => panic!("expected NotImplemented, got {other:?}"),
        }
    }

    #[test]
    fn aliyun_tts_builds_with_a_credential_source() {
        use crate::voice::credentials::{StaticCredentials, VoiceCredentials};
        let creds = std::sync::Arc::new(StaticCredentials(VoiceCredentials {
            gateway_endpoint: "wss://nls/ws/v1".into(),
            app_key: "ak".into(),
            token: "tok".into(),
            expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
            stt_model: "paraformer-realtime-v2".into(),
            tts_voice: "zhixiaobai".into(),
        }));
        let p = build_provider(
            &TtsConfig {
                backend: TtsBackend::AliyunTts,
            },
            Some(creds),
        )
        .expect("builds");
        assert_eq!(p.name(), "aliyun-nls-tts");
    }

    #[test]
    fn factory_builds_cosyvoice() {
        let p = build_provider(&TtsConfig::cosyvoice_local(), None).expect("builds");
        assert_eq!(p.name(), "cosyvoice");
    }

    #[test]
    fn chunker_flushes_on_chinese_punctuation() {
        let mut c = SentenceChunker::default();
        assert!(c.push("今天").is_empty(), "no boundary yet");
        let out = c.push("天气不错。");
        assert_eq!(out, vec!["今天天气不错。"]);
    }

    #[test]
    fn chunker_handles_token_sized_deltas() {
        // This is the real shape: the agent emits a character at a time.
        let mut c = SentenceChunker::default();
        let mut pieces = Vec::new();
        for ch in "你好。再见！".chars() {
            pieces.extend(c.push(&ch.to_string()));
        }
        assert_eq!(pieces, vec!["你好。", "再见！"]);
    }

    #[test]
    fn a_run_without_punctuation_still_flushes() {
        // A URL or a code line would otherwise buffer forever and the user
        // would hear nothing at all.
        let mut c = SentenceChunker::default();
        let long: String = "a".repeat(80);
        let out = c.push(&long);
        assert!(!out.is_empty(), "oversized run must flush");
        assert!(out[0].chars().count() <= 60);
    }

    #[test]
    fn finish_returns_the_tail() {
        let mut c = SentenceChunker::default();
        c.push("没有句号的结尾");
        assert_eq!(c.finish().as_deref(), Some("没有句号的结尾"));
        assert!(c.finish().is_none(), "finish is idempotent");
    }

    #[test]
    fn whitespace_only_is_not_a_piece() {
        let mut c = SentenceChunker::default();
        assert!(c.push("  \n  ").iter().all(|p| !p.is_empty()));
        assert!(c.finish().is_none());
    }
}
