//! Speech-to-text provider trait and shared types.
//!
//! Backends implement [`SttProvider`] and are selected per team/region via
//! [`SttConfig`] (see [`SttBackend`]). The trait is *audio-format-flexible*:
//! the device ships Opus 20 ms frames (plan §1), but FunASR wants PCM 16 kHz.
//! The provider owns any transcode, so a Deepgram adapter can pass Opus
//! straight through while a FunASR adapter decodes first — the voice adapter
//! above this layer never branches on format.

use async_trait::async_trait;
use bytes::Bytes;
use thiserror::Error;
use tokio::sync::mpsc;

/// Re-exported from [`super::ctl`], where it is defined.
///
/// `Intent` arrives on the `voice/ctl` wire, so that is where it lives — and
/// keeping it there means `ctl` has no dependency on this module. That matters
/// beyond tidiness: the MQTT subscriber pulls in `voice::ctl` alone, and a
/// `ctl -> stt` edge would drag every speech backend into build targets that
/// only ever wanted to parse a control message.
pub use super::ctl::Intent;

/// Wire audio format of an [`AudioFrame`]. The device always sends Opus; the
/// enum exists so a provider that already decoded to PCM locally can hand the
/// decoded bytes to a downstream adapter without a second transcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    /// Opus, 16 kHz mono, 20 ms frames, ~24 kbps VBR (device wire format).
    Opus,
    /// PCM 16 kHz, 16-bit, mono. FunASR / Paraformer's native input.
    Pcm16kMono,
}

/// One chunk of captured audio, in the format the sender happens to hold.
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub format: AudioFormat,
    pub data: Bytes,
    /// Wall-clock capture time of this frame's first sample, in millis since
    /// the provider task started. Used by §9 latency measurement
    /// (PTT-release → first-partial). 0 = unknown.
    pub capture_ms: u64,
}

impl AudioFrame {
    /// Convenience constructor for the device wire format.
    pub fn opus(data: impl Into<Bytes>) -> Self {
        Self {
            format: AudioFormat::Opus,
            data: data.into(),
            capture_ms: 0,
        }
    }
}

/// One transcript update from the provider. `partial` updates arrive as the
/// user speaks; exactly one `is_final` update closes the utterance.
#[derive(Debug, Clone)]
pub struct Transcript {
    pub text: String,
    pub is_final: bool,
    /// Provider-reported confidence in [0.0, 1.0], or 0.0 if not reported.
    pub confidence: f32,
}

impl Transcript {
    pub fn partial(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_final: false,
            confidence: 0.0,
        }
    }

    pub fn final_(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_final: true,
            confidence: 0.0,
        }
    }
}

/// A live recognition session. Drop to end the stream (sends a flush to the
/// provider); the transcripts receiver yields the final transcript, if any,
/// then closes.
pub struct SttStream {
    /// Push captured frames here. The provider closes this when it emits the
    /// final transcript so the voice adapter stops feeding a dead stream.
    pub frames_tx: mpsc::Sender<AudioFrame>,
    /// Transcript updates (partials then one final).
    pub transcripts_rx: mpsc::Receiver<Transcript>,
}

impl std::fmt::Debug for SttStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SttStream").finish_non_exhaustive()
    }
}

#[derive(Debug, Error)]
pub enum SttError {
    /// Backend reachable but returned an error mid-stream.
    #[error("stt upstream error: {0}")]
    Upstream(String),
    /// Could not connect / authenticate to the backend.
    #[error("stt connect error: {0}")]
    Connect(String),
    /// Audio frame could not be decoded (bad Opus packet, wrong length).
    #[error("stt decode error: {0}")]
    Decode(String),
    /// Stream closed by the peer before a final transcript.
    #[error("stt stream closed unexpectedly")]
    Closed,
    /// The backend is configured but not yet implemented for this path.
    /// Carries the milestone tag so the caller can surface a useful error.
    #[error("stt backend '{0}' not implemented ({1})")]
    NotImplemented(&'static str, &'static str),
}

/// Which STT backend a team/actor routes to. See `voice/mod.rs` rationale.
/// Only `FunasrLocal` has an adapter today; the others are explicit stubs so
/// the factory can refuse them with a clear error instead of silently doing
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttBackend {
    /// Local FunASR / Paraformer-large streaming, running on this amuxd host.
    /// Same model as Aliyun NLS hosted ASR, zero cross-network, zero billing.
    FunasrLocal,
    /// Deepgram streaming WebSocket (plan default). Native Opus ingest.
    Deepgram,
    /// Aliyun NLS real-time ASR (Paraformer behind a WebSocket). PCM input.
    AliyunNls,
}

/// Resolved STT configuration. Built from daemon/team config in M3-1; for now
/// it is constructed directly in tests.
#[derive(Debug, Clone)]
pub struct SttConfig {
    pub backend: SttBackend,
}

impl SttConfig {
    pub fn funasr_local() -> Self {
        Self {
            backend: SttBackend::FunasrLocal,
        }
    }
}

/// Blanket `Debug` so `expect_err` / `unwrap` on `Result<Box<dyn SttProvider>, _>`
/// works in tests without forcing every implementor to derive `Debug`.
impl std::fmt::Debug for dyn SttProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SttProvider")
            .field("name", &self.name())
            .finish_non_exhaustive()
    }
}

/// Build a boxed provider from config. The voice adapter (M3-1) will call
/// this once per device session. Each variant that has no adapter yet returns
/// [`SttError::NotImplemented`] with its milestone tag.
pub fn build_provider(
    cfg: &SttConfig,
    credentials: Option<std::sync::Arc<dyn super::credentials::CredentialSource>>,
) -> Result<Box<dyn SttProvider>, SttError> {
    match cfg.backend {
        SttBackend::FunasrLocal => Ok(Box::new(super::funasr::FunasrProvider::default())),
        // Hosted NLS is the current default per plan §13.9. It cannot be built
        // without a credential source: the AccessKey lives in FC and this
        // process only ever holds a minted, expiring token.
        SttBackend::AliyunNls => match credentials {
            Some(source) => Ok(Box::new(super::aliyun_stt::AliyunNlsProvider::new(source))),
            None => Err(SttError::NotImplemented(
                "AliyunNls",
                "needs a CredentialSource (POST /v1/teams/:id/voice/credentials)",
            )),
        },
        SttBackend::Deepgram => Err(SttError::NotImplemented(
            "Deepgram",
            "no API key exists; superseded by AliyunNls (plan §13.9)",
        )),
    }
}

/// The STT seam. Implementations push [`Transcript`] updates (partials then
/// one final) into the returned receiver, reading [`AudioFrame`]s from the
/// passed-in receiver until it closes or they emit the final.
///
/// The stream is *request-driven*: the caller opens it by calling
/// [`SttProvider::recognize`], feeds frames as they arrive from `voice/mic`,
/// and drops the returned [`SttStream`] when the device sends the
/// turn-end flush on `voice/ctl` (plan §7). The provider is responsible for
/// emitting exactly one `is_final` transcript per stream.
#[async_trait]
pub trait SttProvider: Send + Sync {
    /// Human-readable backend id, for logs and error attribution.
    fn name(&self) -> &'static str;

    /// Open a streaming recognition session for this intent. Returns a
    /// frame-sender / transcript-receiver pair.
    async fn recognize(
        &self,
        intent: Intent,
        frames_rx: mpsc::Receiver<AudioFrame>,
    ) -> Result<SttStream, SttError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A no-op provider used to exercise the trait shape and as the default
    /// in tests where the real backend isn't available. It immediately emits
    /// an empty final transcript and closes — the smallest valid stream.
    struct NullStt;

    #[async_trait]
    impl SttProvider for NullStt {
        fn name(&self) -> &'static str {
            "null"
        }

        async fn recognize(
            &self,
            _intent: Intent,
            mut frames_rx: mpsc::Receiver<AudioFrame>,
        ) -> Result<SttStream, SttError> {
            let (partial_tx, transcript_rx) = mpsc::channel(8);
            let (frame_tx, _frame_rx) = mpsc::channel(8);
            tokio::spawn(async move {
                // Drain any frames the caller pushes; we don't transcribe.
                while frames_rx.recv().await.is_some() {}
                let _ = partial_tx.send(Transcript::final_(String::new())).await;
            });
            Ok(SttStream {
                frames_tx: frame_tx,
                transcripts_rx: transcript_rx,
            })
        }
    }

    #[tokio::test]
    async fn null_provider_emits_one_final_then_closes() {
        let provider = NullStt;
        let (ftx, frx) = mpsc::channel(8);
        let mut stream = provider
            .recognize(Intent::Chat, frx)
            .await
            .expect("null recognize");
        // Drop the frame sender to signal end-of-utterance.
        drop(stream.frames_tx);
        drop(ftx);
        let final_t = stream
            .transcripts_rx
            .recv()
            .await
            .expect("final transcript");
        assert!(final_t.is_final);
        assert!(stream.transcripts_rx.recv().await.is_none(), "stream closes");
    }

    #[test]
    fn factory_refuses_unimplemented_backends() {
        let cfg = SttConfig {
            backend: SttBackend::Deepgram,
        };
        let err = build_provider(&cfg, None).expect_err("deepgram not implemented");
        match err {
            // The tag has to say *why*, since Deepgram is not coming back:
            // it was superseded, not merely deferred to a later milestone.
            SttError::NotImplemented("Deepgram", tag) => {
                assert!(tag.contains("AliyunNls"), "got {tag:?}")
            }
            other => panic!("expected NotImplemented, got {other:?}"),
        }
    }

    #[test]
    fn aliyun_nls_without_credentials_is_refused_not_silently_broken() {
        // The AccessKey lives in FC; this process only ever holds a minted
        // token. A provider built without a source would fail at the first
        // turn instead of at wiring time.
        let cfg = SttConfig {
            backend: SttBackend::AliyunNls,
        };
        let err = build_provider(&cfg, None).expect_err("no credential source");
        match err {
            SttError::NotImplemented("AliyunNls", tag) => {
                assert!(tag.contains("credentials"), "got {tag:?}")
            }
            other => panic!("expected NotImplemented, got {other:?}"),
        }
    }

    #[test]
    fn aliyun_nls_builds_with_a_credential_source() {
        use crate::voice::credentials::{StaticCredentials, VoiceCredentials};
        let creds = std::sync::Arc::new(StaticCredentials(VoiceCredentials {
            gateway_endpoint: "wss://nls/ws/v1".into(),
            app_key: "ak".into(),
            token: "tok".into(),
            expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
            stt_model: "paraformer-realtime-v2".into(),
            tts_voice: "zhixiaobai".into(),
        }));
        let cfg = SttConfig {
            backend: SttBackend::AliyunNls,
        };
        let p = build_provider(&cfg, Some(creds)).expect("builds");
        assert_eq!(p.name(), "aliyun-nls");
    }

    #[test]
    fn factory_builds_funasr() {
        let p = build_provider(&SttConfig::funasr_local(), None).expect("funasr builds");
        assert_eq!(p.name(), "funasr");
    }
}
