//! Voice adapter — device `voice/*` topics → STT → pi prompt → TTS → `spk`.
//!
//! This module is the amuxd side of the ESP32 voice terminal
//! (`docs/plans/2026-08-24-esp32-voice-terminal.md`, Milestone 3). The device
//! publishes Opus frames on `amux/{team}/{actor}/voice/mic` with an
//! `intent=chat|note` marker; amuxd is responsible for turning those frames
//! into text. That translation is the `SttProvider` trait below.
//!
//! ## Why a trait
//!
//! The plan locks Deepgram streaming as the default STT, but the same model
//! (Paraformer-large) is open-sourced as FunASR and runs locally with zero
//! cross-network latency, zero per-minute billing, and no data egress —
//! which matters for a Chinese-first device. Aliyun NLS hosted ASR is the
//! *same Paraformer model* behind a WebSocket. Keeping all three behind one
//! `SttProvider` trait lets us route per `team/region` (§7 facade philosophy)
//! and switch on §9 latency / §8.3 cost numbers without rewriting the voice
//! adapter.
//!
//! ## Current state
//!
//! The whole chain now exists in code — [`adapter`] routes turns, [`funasr`]
//! transcribes, [`chat_sink`] prompts the agent, and [`spk`] speaks the reply
//! back through [`cosyvoice`] → [`resample`] → Opus. **None of it has run.**
//! Two things stand between here and a working device:
//!
//! 1. **Nothing subscribes to `voice/mic` / `voice/ctl`.** `parse_incoming`
//!    understands both, but no subscription is ever issued, because the
//!    device's `(team, actor)` comes from M2-2 pairing. Until that lands, the
//!    router is reachable only from tests.
//! 2. **The daemon still builds the router with `LogTranscriptSink`** (see
//!    `daemon::server`), not [`ChatSink`] + [`SpeechSynthesizer`]. The runtime
//!    adapter those need is constructed later in startup than the router is.
//!
//! Neither is a gap in this module; both are wiring in `daemon::server`. The
//! backends also need deploying — there is no `funasr-wss-server` and no
//! CosyVoice server anywhere yet, so both clients are written against
//! documentation rather than an observed wire.
//!
//! ## Topic layout
//!
//! Voice topic strings live here (not in `teamclu_types::mqtt::Topics`) to
//! keep the device-specific vocabulary off the shared crate that has a Swift
//! mirror. The paths mirror `apps/esp32/main/net/mqtt_link.cpp`'s
//! `voiceBase` 1:1 — see plan §7.
//!
//! | Topic                                  | Dir      | Payload                          |
//! |----------------------------------------|----------|----------------------------------|
//! | `amux/{team}/{actor}/voice/mic`         | dev→amuxd| Opus 20 ms frames + intent       |
//! | `amux/{team}/{actor}/voice/spk`         | amuxd→dev| Opus frames (chat only)          |
//! | `amux/{team}/{actor}/voice/ctl`        | both     | JSON: session/turn/flush/error   |
//! | `amux/{team}/{actor}/voice/state`      | dev→brkr | retained: battery, queue, LWT     |

#![allow(dead_code, unused_imports)]  // M3-1 (subscriber routing) + M3-2 (funasr WSS) consume these

pub mod adapter;
pub mod aliyun_stt;
pub mod aliyun_tts;
pub mod chat_sink;
pub mod cosyvoice;
pub mod credentials;
pub mod ctl;
pub mod esp32_downlink;
pub mod funasr;
pub mod mqtt_publisher;
pub mod nls;
pub mod note_sink;
pub mod resample;
pub mod spk;
pub mod stt;
pub mod tts;

pub use adapter::{
    DeviceKey, FanOutSink, LogTranscriptSink, TranscriptSink, VoiceEvent, VoiceRouter,
};
pub use chat_sink::ChatSink;
pub use aliyun_stt::AliyunNlsProvider;
pub use aliyun_tts::{AliyunTtsConfig, AliyunTtsProvider};
pub use cosyvoice::{CosyVoiceConfig, CosyVoiceProvider};
pub use credentials::{CloudApiCredentials, CredentialSource, StaticCredentials, VoiceCredentials};
pub use ctl::VoiceCtl;
pub use esp32_downlink::{esp32_downlink, Esp32VoiceDownlink};
pub use mqtt_publisher::TransportVoicePublisher;
pub use note_sink::{BackendNoteStore, Note, NoteSink, NoteStore};
pub use spk::{ReplySpeaker, SpeechSynthesizer, SpkConfig, VoicePublisher};
pub use tts::{TtsBackend, TtsConfig, TtsError, TtsProvider, TtsStream};
pub use stt::{
    AudioFormat, AudioFrame, Intent, SttBackend, SttConfig, SttError, SttProvider, SttStream,
    Transcript,
};

/// `amux/{team}/{actor}/voice` — the voice subtree root for one device.
/// All four leaf topics are `<base>/{mic,spk,ctl,state}`.
pub fn voice_base(team_id: &str, actor_id: &str) -> String {
    format!("amux/{team_id}/{actor_id}/voice")
}

pub fn voice_mic_topic(team_id: &str, actor_id: &str) -> String {
    format!("{}/mic", voice_base(team_id, actor_id))
}

pub fn voice_spk_topic(team_id: &str, actor_id: &str) -> String {
    format!("{}/spk", voice_base(team_id, actor_id))
}

pub fn voice_ctl_topic(team_id: &str, actor_id: &str) -> String {
    format!("{}/ctl", voice_base(team_id, actor_id))
}

pub fn voice_state_topic(team_id: &str, actor_id: &str) -> String {
    format!("{}/state", voice_base(team_id, actor_id))
}

#[cfg(test)]
mod topic_tests {
    use super::*;

    #[test]
    fn voice_topics_match_plan_section_7() {
        assert_eq!(voice_base("t", "a"), "amux/t/a/voice");
        assert_eq!(voice_mic_topic("t", "a"), "amux/t/a/voice/mic");
        assert_eq!(voice_spk_topic("t", "a"), "amux/t/a/voice/spk");
        assert_eq!(voice_ctl_topic("t", "a"), "amux/t/a/voice/ctl");
        assert_eq!(voice_state_topic("t", "a"), "amux/t/a/voice/state");
    }
}
