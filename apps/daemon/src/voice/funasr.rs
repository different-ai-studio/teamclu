//! FunASR / Paraformer-large local adapter (structural stub — M3-2).
//!
//! FunASR is the open-source release of the same Paraformer model that
//! powers Aliyun NLS real-time ASR. Running it on the amuxd host gives
//! Aliyun-grade Chinese accuracy with **zero cross-network latency, zero
//! per-minute billing, and no audio egress** — which is why it is the
//! recommended default for a Chinese-first device (see `voice/mod.rs`).
//!
//! ## Deployment this adapter targets
//!
//! The standard local deployment is the `funasr-wss-server` Docker image,
//! which exposes a WebSocket (default `ws://127.0.0.1:10095`) speaking the
//! protocol below. This adapter is a client of that server; it does *not*
//! run the model in-process (that would pull a heavy runtime + ONNX/Torch
//! deps into amuxd, and the server already manages a model pool).
//!
//! ## Wire protocol (to implement in M3-2)
//!
//! ```text
//! → connect ws://host:port
//! → text  {"mode":"2pass","wav_name":"<turn>","audio_format":"opus",
//!         "hotwords":"{\"热词\":1}", "itn":true}
//! → bin   <opus 20ms frame> … (repeat)
//! → text  {"is_end":true}
//! ← text  {"mode":"2pass-online","text":"partial…","is_final":false}
//! ← text  {"mode":"2pass-offline","text":"final…","is_final":true,
//!          "timestamp":"[[s,e],[s,e]]"}
//! ```
//!
//! `2pass` = online (streaming partial) + offline (final) combined, which is
//! exactly the partial-then-final shape [`SttProvider`] wants. Opus ingest is
//! supported by the server, so this adapter can forward device frames
//! directly without decoding to PCM — unlike the Aliyun hosted path.
//!
//! ## What is real here vs stubbed
//!
//! Real: [`FunasrConfig`] (server URL, model, language, hotwords, mode),
//! [`FunasrProvider::new`], [`FunasrProvider::default`], and the name. The
//! `recognize` loop returns [`SttError::NotImplemented`] tagged `M3-2` —
//! wiring it means adding `tokio-tungstenite` to `Cargo.toml` and
//! implementing `run_stream` below per the protocol above. No new deps are
//! pulled in by this skeleton.
//!
//! `Deepgram` and `AliyunNls` backends are refused at the factory
//! ([`super::stt::build_provider`]) rather than here.

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::stt::{Intent, SttError, SttProvider, SttStream};

/// FunASR recognition mode. `TwoPass` is the default and the only one that
/// yields the partial-then-final shape the voice adapter wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunasrMode {
    /// Online-only: streaming partials, no final refinement. Lowest latency.
    Online,
    /// Offline-only: one final transcript at end of utterance. Highest
    /// accuracy, no partials (suitable for `Intent::Note`).
    Offline,
    /// Online partials + offline final. The default; matches `SttProvider`.
    TwoPass,
}

impl FunasrMode {
    pub fn as_str(self) -> &'static str {
        match self {
            FunasrMode::Online => "online",
            FunasrMode::Offline => "offline",
            FunasrMode::TwoPass => "2pass",
        }
    }
}

/// Configuration for a FunASR WSS session. All fields are plain data so the
/// same struct serialises straight into the server's opening JSON.
#[derive(Debug, Clone)]
pub struct FunasrConfig {
    /// `ws://` or `wss://` URL of the local `funasr-wss-server`.
    pub server_url: String,
    /// Model id, e.g. `paraformer-zh` (Chinese) or `paraformer-zh-streaming`.
    pub model: String,
    /// `zh`, `en`, or `auto` for multilingual. Defaults to `zh` (device is
    /// Chinese-first; plan §12 open decision 4).
    pub language: String,
    pub mode: FunasrMode,
    /// Hotword boost JSON, e.g. `{"TeamClu":1}`. Empty string = none.
    pub hotwords: String,
    /// Inverse text normalisation (numbers/dates). On by default.
    pub itn: bool,
}

impl Default for FunasrConfig {
    fn default() -> Self {
        Self {
            server_url: "ws://127.0.0.1:10095".to_string(),
            model: "paraformer-zh".to_string(),
            language: "zh".to_string(),
            mode: FunasrMode::TwoPass,
            hotwords: String::new(),
            itn: true,
        }
    }
}

/// Local FunASR STT provider. Construct with [`FunasrProvider::new`] for a
/// non-default config, or [`FunasrProvider::default`] for the standard local
/// deployment on `127.0.0.1:10095`.
#[derive(Debug, Clone, Default)]
pub struct FunasrProvider {
    pub config: FunasrConfig,
}

impl FunasrProvider {
    pub fn new(config: FunasrConfig) -> Self {
        Self { config }
    }

    /// NOT YET IMPLEMENTED — see module docs. Will: open the WSS connection,
    /// forward Opus frames as binary messages, parse `2pass-online` /
    /// `2pass-offline` JSON into [`super::stt::Transcript`] partials/final,
    /// and close the transcript channel when the final arrives or the frame
    /// channel closes. Tagged `M3-2`.
    ///
    /// Not called today; `recognize` returns `NotImplemented` directly so a
    /// caller gets an attributable error instead of a dead channel. Kept as a
    /// real method with the real signature so M3-2 only fills the body.
    #[allow(dead_code)]
    async fn run_stream(
        &self,
        _intent: Intent,
        _frames_rx: mpsc::Receiver<super::stt::AudioFrame>,
        _transcripts_tx: mpsc::Sender<super::stt::Transcript>,
    ) -> Result<(), SttError> {
        // M3-2: implement against the protocol in the module docs. Add
        // `tokio-tungstenite` to Cargo.toml when you do; this skeleton pulls
        // no new deps.
        tracing::warn!(
            backend = "funasr",
            server = %self.config.server_url,
            model = %self.config.model,
            "funasr stt stream requested but adapter not implemented (M3-2)"
        );
        Err(SttError::NotImplemented(
            "funasr",
            "M3-2: tokio-tungstenite client + 2pass JSON parse",
        ))
    }
}

#[async_trait]
impl SttProvider for FunasrProvider {
    fn name(&self) -> &'static str {
        "funasr"
    }

    async fn recognize(
        &self,
        intent: Intent,
        frames_rx: mpsc::Receiver<super::stt::AudioFrame>,
    ) -> Result<SttStream, SttError> {
        // M3-2: spawn run_stream here — open the WSS, forward Opus frames as
        // binary messages, parse 2pass-online/2pass-offline JSON into
        // Transcript partials/final, close the transcript channel when the
        // final arrives or the frame channel closes. Until then, refuse so a
        // caller gets an attributable error instead of a dead channel.
        let _ = (intent, frames_rx);
        tracing::warn!(
            backend = "funasr",
            server = %self.config.server_url,
            model = %self.config.model,
            "funasr stt stream requested but adapter not implemented (M3-2)"
        );
        Err(SttError::NotImplemented(
            "funasr",
            "M3-2: tokio-tungstenite client + 2pass JSON parse",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::stt::{build_provider, SttBackend, SttConfig};

    #[test]
    fn default_targets_local_server() {
        let p = FunasrProvider::default();
        assert_eq!(p.config.server_url, "ws://127.0.0.1:10095");
        assert_eq!(p.config.language, "zh");
        assert_eq!(p.config.mode, FunasrMode::TwoPass);
    }

    #[tokio::test]
    async fn recognize_surfaces_not_implemented() {
        let p = FunasrProvider::default();
        let (_ftx, frx) = mpsc::channel(8);
        let err = p.recognize(Intent::Chat, frx).await.expect_err("stub errs");
        match err {
            SttError::NotImplemented("funasr", tag) => assert!(tag.starts_with("M3-2")),
            other => panic!("expected NotImplemented, got {other:?}"),
        }
    }

    #[test]
    fn factory_returns_funasr_provider() {
        let p = build_provider(&SttConfig {
            backend: SttBackend::FunasrLocal,
        })
        .expect("funasr builds");
        assert_eq!(p.name(), "funasr");
    }
}
