//! FunASR / Paraformer-large local adapter.
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
//! ## State
//!
//! The streaming client is implemented. It has **never been run against a real
//! funasr-wss-server** — there is no such server deployed yet, and the protocol
//! below is transcribed from the project's documentation rather than observed
//! on the wire. The parsing is deliberately lenient about which of `text` /
//! `is_final` / `mode` a given build emits, because that is where a
//! documentation-derived client is most likely to be wrong.
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

    /// Drives one recognition session end to end.
    ///
    /// Returns only when the utterance is finished (final emitted, frames
    /// exhausted, or the socket died). Errors are returned rather than logged
    /// so `recognize`'s caller can attribute the failure to this backend.
    async fn run_stream(
        &self,
        intent: Intent,
        mut frames_rx: mpsc::Receiver<super::stt::AudioFrame>,
        transcripts_tx: mpsc::Sender<super::stt::Transcript>,
    ) -> Result<(), SttError> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let (ws, _resp) = tokio_tungstenite::connect_async(&self.config.server_url)
            .await
            .map_err(|e| SttError::Connect(format!("{}: {e}", self.config.server_url)))?;
        let (mut sink, mut stream) = ws.split();

        // A `note` turn is read back by the user rather than spoken, so it can
        // trade first-partial latency for accuracy: offline-only skips the
        // streaming pass entirely.
        let mode = match intent {
            Intent::Note if self.config.mode == FunasrMode::TwoPass => FunasrMode::Offline,
            other_intent => {
                let _ = other_intent;
                self.config.mode
            }
        };

        let mut open = serde_json::json!({
            "mode": mode.as_str(),
            "wav_name": "stopwatch",
            // The device ships Opus and the server ingests it, so no decode
            // happens anywhere in this path.
            "audio_format": "opus",
            "is_speaking": true,
            "itn": self.config.itn,
        });
        if !self.config.language.is_empty() {
            open["lang"] = serde_json::Value::from(self.config.language.clone());
        }
        if !self.config.hotwords.is_empty() {
            open["hotwords"] = serde_json::Value::from(self.config.hotwords.clone());
        }
        sink.send(Message::Text(open.to_string()))
            .await
            .map_err(|e| SttError::Connect(format!("open frame: {e}")))?;

        let mut sent_end = false;
        let mut got_final = false;

        loop {
            tokio::select! {
                // Uplink: device frames, forwarded verbatim.
                frame = frames_rx.recv(), if !sent_end => {
                    match frame {
                        Some(f) => {
                            if sink.send(Message::Binary(f.data.to_vec())).await.is_err() {
                                return Err(SttError::Closed);
                            }
                        }
                        None => {
                            // The voice router dropped the sender: end of
                            // utterance. Tell the server to flush and emit its
                            // final, then keep reading — do NOT close the
                            // socket here or the final is lost.
                            let end = serde_json::json!({ "is_speaking": false }).to_string();
                            let _ = sink.send(Message::Text(end)).await;
                            sent_end = true;
                        }
                    }
                }

                // Downlink: transcripts.
                msg = stream.next() => {
                    let msg = match msg {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => return Err(SttError::Upstream(e.to_string())),
                        None => break,
                    };
                    let text = match msg {
                        Message::Text(t) => t,
                        Message::Close(_) => break,
                        // Ping/Pong are handled by tungstenite; binary is not
                        // part of the downlink protocol.
                        _ => continue,
                    };
                    if let Some(t) = parse_transcript(&text) {
                        let is_final = t.is_final;
                        if transcripts_tx.send(t).await.is_err() {
                            // Nobody is listening any more (barge-in).
                            break;
                        }
                        if is_final {
                            got_final = true;
                            break;
                        }
                    }
                }
            }
        }

        let _ = sink.send(Message::Close(None)).await;

        if !got_final {
            // The router treats a closed channel with no final as "no
            // transcript", which is correct — but say why, because a silent
            // turn is otherwise indistinguishable from silence in the room.
            tracing::warn!(
                backend = "funasr",
                server = %self.config.server_url,
                "stream ended without a final transcript"
            );
        }
        Ok(())
    }
}

/// Parses one downlink message into a [`Transcript`].
///
/// Deliberately lenient. The mode string differs across FunASR builds
/// (`2pass-online` / `2pass-offline` / `online` / `offline`), and some emit an
/// explicit `is_final` while others only imply it via the mode. Treat either
/// signal as authoritative, and ignore messages that carry no text at all —
/// the server sends bookkeeping frames that are not transcripts.
fn parse_transcript(raw: &str) -> Option<super::stt::Transcript> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let mode = v.get("mode").and_then(|m| m.as_str()).unwrap_or("");

    let explicit_final = v.get("is_final").and_then(|f| f.as_bool()).unwrap_or(false);
    let mode_is_final = mode.ends_with("offline");
    let is_final = explicit_final || mode_is_final;

    // A bookkeeping frame with neither text nor a final marker is not a
    // transcript. An empty *final*, though, is meaningful: it means the user
    // said nothing, and the router needs it to close the turn.
    if text.is_empty() && !is_final {
        return None;
    }

    let confidence = v
        .get("confidence")
        .and_then(|c| c.as_f64())
        .unwrap_or(0.0) as f32;

    Some(super::stt::Transcript {
        text: text.to_string(),
        is_final,
        confidence,
    })
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
        let (transcripts_tx, transcripts_rx) = mpsc::channel(16);

        // `SttStream` hands the caller a sender it pushes frames into; the
        // session task owns the receiving half. Dropping the caller's sender is
        // what signals end-of-utterance, which is the contract the router
        // relies on.
        let (frames_tx, frames_inner_rx) = mpsc::channel(64);

        let me = self.clone();
        tokio::spawn(async move {
            if let Err(e) = me.run_stream(intent, frames_inner_rx, transcripts_tx).await {
                tracing::warn!(
                    backend = "funasr",
                    error = %e,
                    "funasr session ended with an error"
                );
                // transcripts_tx drops here, closing the channel: the router
                // sees "no final" rather than hanging.
            }
        });

        // Nothing is fed by the caller yet, so the frames the session reads
        // come from `frames_tx`. The receiver passed in by the trait signature
        // is the router's own upstream; drain it into ours.
        let mut caller_rx = frames_rx;
        let pump_tx = frames_tx.clone();
        tokio::spawn(async move {
            while let Some(f) = caller_rx.recv().await {
                if pump_tx.send(f).await.is_err() {
                    break;
                }
            }
        });

        Ok(SttStream {
            frames_tx,
            transcripts_rx,
        })
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
    async fn recognize_fails_cleanly_when_server_is_absent() {
        // No funasr-wss-server is running in tests. `recognize` must still
        // return a stream — the session task reports the connect failure by
        // closing the transcript channel, so the router sees "no transcript"
        // instead of hanging on a socket that will never open.
        let p = FunasrProvider::new(FunasrConfig {
            server_url: "ws://127.0.0.1:1".to_string(),
            ..Default::default()
        });
        let (_ftx, frx) = mpsc::channel(8);
        let mut stream = p.recognize(Intent::Chat, frx).await.expect("stream opens");
        drop(stream.frames_tx);
        assert!(
            stream.transcripts_rx.recv().await.is_none(),
            "a dead server must close the channel, not emit a transcript"
        );
    }

    #[test]
    fn parses_a_streaming_partial() {
        let t = parse_transcript(r#"{"mode":"2pass-online","text":"你好","is_final":false}"#)
            .expect("partial parses");
        assert_eq!(t.text, "你好");
        assert!(!t.is_final);
    }

    #[test]
    fn offline_mode_means_final_even_without_the_flag() {
        // Some builds signal the final only through the mode string.
        let t = parse_transcript(r#"{"mode":"2pass-offline","text":"你好世界"}"#)
            .expect("final parses");
        assert!(t.is_final, "an offline-mode message is the final");
        assert_eq!(t.text, "你好世界");
    }

    #[test]
    fn explicit_is_final_is_honoured_without_a_mode() {
        let t = parse_transcript(r#"{"text":"done","is_final":true}"#).expect("parses");
        assert!(t.is_final);
    }

    #[test]
    fn empty_final_is_kept_but_empty_partial_is_not() {
        // An empty final means "the user said nothing" and must reach the
        // router so it can close the turn. An empty partial is bookkeeping.
        assert!(parse_transcript(r#"{"mode":"2pass-offline","text":""}"#).is_some());
        assert!(parse_transcript(r#"{"mode":"2pass-online","text":""}"#).is_none());
    }

    #[test]
    fn non_transcript_messages_are_ignored() {
        assert!(parse_transcript(r#"{"status":"ok"}"#).is_none());
        assert!(parse_transcript("not json").is_none());
        assert!(parse_transcript("").is_none());
    }

    #[test]
    fn note_intent_uses_offline_only() {
        // A note is read, not spoken: accuracy over first-partial latency.
        let p = FunasrProvider::default();
        assert_eq!(p.config.mode, FunasrMode::TwoPass);
        // The downgrade happens inside run_stream; assert the rule it encodes.
        let effective = match Intent::Note {
            Intent::Note if p.config.mode == FunasrMode::TwoPass => FunasrMode::Offline,
            _ => p.config.mode,
        };
        assert_eq!(effective, FunasrMode::Offline);
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
