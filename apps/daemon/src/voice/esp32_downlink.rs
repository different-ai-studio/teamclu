//! Daemon adapter for [`teamclu_gateway::esp32::Esp32Downlink`].
//!
//! The gateway crate stays free of MQTT and NLS. This module wires the
//! existing [`SpeechSynthesizer`] + [`VoicePublisher`] stack so
//! [`Esp32Driver`](teamclu_gateway::esp32::Esp32Driver) can speak a final
//! reply and publish ctl JSON.
//!
//! **Not** [`ReplySpeaker::begin`]: that watches agent session deltas (ChatSink
//! path). Core Phase 1 deliver already hands the buffered reply text, so
//! [`speak`](Esp32Downlink::speak) TTSes that string via
//! [`SpeechSynthesizer::speak_text`].

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::DriverError;
use teamclu_gateway::esp32::{Esp32Downlink, Esp32Target};

use super::adapter::DeviceKey;
use super::spk::SpeechSynthesizer;

/// Maps [`Esp32Target`] → voice topics through the shared synthesizer.
pub struct Esp32VoiceDownlink {
    synth: Arc<SpeechSynthesizer>,
}

impl Esp32VoiceDownlink {
    pub fn new(synth: Arc<SpeechSynthesizer>) -> Self {
        Self { synth }
    }

    fn key(device: &Esp32Target) -> DeviceKey {
        DeviceKey {
            team_id: device.team_id.clone(),
            actor_id: device.actor_id.clone(),
        }
    }
}

#[async_trait]
impl Esp32Downlink for Esp32VoiceDownlink {
    async fn speak(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError> {
        let key = Self::key(device);
        self.synth
            .speak_text(key, text)
            .await
            .map_err(DriverError::Transport)
    }

    async fn publish_ctl(&self, device: &Esp32Target, json: &str) -> Result<(), DriverError> {
        let key = Self::key(device);
        self.synth
            .publish_ctl_json(&key, json)
            .await
            .map_err(DriverError::Transport)
    }
}

/// Convenience: build a downlink from the same arcs the voice router already has.
pub fn esp32_downlink(synth: Arc<SpeechSynthesizer>) -> Arc<dyn Esp32Downlink> {
    Arc::new(Esp32VoiceDownlink::new(synth))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    use async_trait::async_trait;
    use tokio::sync::{mpsc, Mutex};

    use super::super::spk::{SpkConfig, VoicePublisher, SPK_FRAME_SAMPLES};
    use super::super::tts::{PcmChunk, TtsProvider, TtsStream};
    use crate::http::runtime_adapter::{RuntimeAdapter, StubRuntimeAdapter};

    #[derive(Default)]
    struct RecordingPublisher {
        /// `(topic, payload, qos1)`
        pubs: Mutex<Vec<(String, Vec<u8>, bool)>>,
    }

    #[async_trait]
    impl VoicePublisher for RecordingPublisher {
        async fn publish(
            &self,
            topic: String,
            payload: Vec<u8>,
            qos1: bool,
        ) -> Result<(), String> {
            self.pubs.lock().await.push((topic, payload, qos1));
            Ok(())
        }
    }

    struct FakeTts {
        samples_per_piece: usize,
        spoken: Arc<Mutex<Vec<String>>>,
        opened: Arc<AtomicBool>,
    }

    #[async_trait]
    impl TtsProvider for FakeTts {
        fn name(&self) -> &'static str {
            "fake"
        }
        async fn speak(&self) -> Result<TtsStream, super::super::tts::TtsError> {
            self.opened.store(true, Ordering::Relaxed);
            let (text_tx, mut text_rx) = mpsc::channel::<String>(16);
            let (audio_tx, audio_rx) = mpsc::channel::<PcmChunk>(64);
            let n = self.samples_per_piece;
            let spoken = self.spoken.clone();
            tokio::spawn(async move {
                while let Some(t) = text_rx.recv().await {
                    spoken.lock().await.push(t);
                    let samples: Vec<i16> =
                        (0..n).map(|i| ((i % 200) as i16 - 100) * 40).collect();
                    if audio_tx.send(PcmChunk { samples }).await.is_err() {
                        break;
                    }
                }
            });
            Ok(TtsStream { text_tx, audio_rx })
        }
    }

    fn target() -> Esp32Target {
        Esp32Target {
            team_id: "t1".into(),
            actor_id: "a1".into(),
            device_id: "dev-aabbcc".into(),
        }
    }

    async fn setup() -> (
        Arc<dyn Esp32Downlink>,
        Arc<RecordingPublisher>,
        Arc<Mutex<Vec<String>>>,
        Arc<AtomicBool>,
    ) {
        let spoken = Arc::new(Mutex::new(Vec::new()));
        let opened = Arc::new(AtomicBool::new(false));
        let tts: Arc<dyn TtsProvider> = Arc::new(FakeTts {
            samples_per_piece: SPK_FRAME_SAMPLES * 2,
            spoken: spoken.clone(),
            opened: opened.clone(),
        });
        let publisher = Arc::new(RecordingPublisher::default());
        let pub_dyn: Arc<dyn VoicePublisher> = publisher.clone();
        let runtime: Arc<dyn RuntimeAdapter> = StubRuntimeAdapter::new(8);
        let cfg = SpkConfig {
            paced: false,
            ..Default::default()
        };
        let synth = Arc::new(SpeechSynthesizer::new(tts, pub_dyn, runtime, cfg));
        let downlink = esp32_downlink(synth);
        (downlink, publisher, spoken, opened)
    }

    #[tokio::test]
    async fn speak_opens_tts_and_publishes_spk_ctl() {
        let (downlink, publisher, spoken, opened) = setup().await;
        downlink
            .speak(&target(), "你好。")
            .await
            .expect("speak");

        assert!(opened.load(Ordering::Relaxed), "TTS stream must open");
        assert_eq!(*spoken.lock().await, vec!["你好。"]);

        let pubs = publisher.pubs.lock().await;
        let ctl: Vec<_> = pubs
            .iter()
            .filter(|(t, _, _)| t.ends_with("/ctl"))
            .collect();
        assert!(
            ctl.iter().any(|(_, p, qos1)| {
                *qos1 && String::from_utf8_lossy(p).contains("\"spk_start\"")
            }),
            "expected spk_start ctl, got {:?}",
            ctl.iter()
                .map(|(_, p, _)| String::from_utf8_lossy(p).into_owned())
                .collect::<Vec<_>>()
        );
        assert!(
            ctl.iter()
                .any(|(_, p, _)| String::from_utf8_lossy(p).contains("\"spk_end\"")),
            "expected spk_end"
        );
        assert!(
            pubs.iter().any(|(t, _, qos1)| t.ends_with("/spk") && !*qos1),
            "expected at least one spk frame"
        );
    }

    #[tokio::test]
    async fn publish_ctl_goes_to_voice_ctl_with_qos1_and_from() {
        let (downlink, publisher, _, _) = setup().await;
        downlink
            .publish_ctl(&target(), r#"{"type":"thinking"}"#)
            .await
            .expect("publish_ctl");

        let pubs = publisher.pubs.lock().await;
        assert_eq!(pubs.len(), 1);
        let (topic, payload, qos1) = &pubs[0];
        assert_eq!(topic, "amux/t1/a1/voice/ctl");
        assert!(*qos1, "ctl must be qos1");
        let v: serde_json::Value = serde_json::from_slice(payload).unwrap();
        assert_eq!(v["type"], "thinking");
        assert_eq!(v["from"], "amuxd");
    }

    #[tokio::test]
    async fn publish_ctl_preserves_existing_from() {
        let (downlink, publisher, _, _) = setup().await;
        downlink
            .publish_ctl(
                &target(),
                r#"{"type":"error","from":"device","code":"x"}"#,
            )
            .await
            .expect("publish_ctl");
        let pubs = publisher.pubs.lock().await;
        let v: serde_json::Value = serde_json::from_slice(&pubs[0].1).unwrap();
        assert_eq!(v["from"], "device");
    }
}
