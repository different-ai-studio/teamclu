//! Wire format for `amux/{team}/{actor}/voice/ctl` (plan §7).
//!
//! `voice/ctl` is the QoS-1 control channel for a device's voice turn. It
//! carries turn boundaries, barge-in, and device-side errors. Audio frames
//! travel on `voice/mic` (QoS 0); **intent travels here on `turn_start`**,
//! not in the mic payload — this keeps `voice/mic` pure Opus bytes and
//! makes the routing decision (chat→TTS, note→store) a single ctl parse.
//!
//! The shape is deliberately a forgiving flat struct, not a tagged enum:
//! a new `type` from the device must not break the parser, and unknown
//! types are logged-and-dropped by the router rather than crashing the
//! business loop.

use serde::{Deserialize, Serialize};

use super::stt::Intent;

/// A parsed `voice/ctl` JSON message. Field `type` is exposed as `kind`
/// because `type` is a reserved word.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceCtl {
    #[serde(rename = "type")]
    pub kind: String,
    /// `chat` / `note`. Only meaningful on `turn_start`.
    #[serde(default)]
    pub intent: Option<String>,
    /// Cloud session id this turn belongs to (plan §7: "session id … in
    /// `ctl`, never in the path"). None until the device learns it.
    #[serde(default)]
    pub session: Option<String>,
    /// Device-local sequence number for QoS-1 dedup. Defaults to 0.
    #[serde(default)]
    pub seq: u64,
    /// On `error`: short machine code.
    #[serde(default)]
    pub code: Option<String>,
    /// On `error`: human-readable detail.
    #[serde(default)]
    pub message: Option<String>,
}

impl VoiceCtl {
    pub fn is_turn_start(&self) -> bool {
        self.kind == "turn_start"
    }

    /// Resolved intent, defaulting to `Chat` if absent or unparseable.
    pub fn intent(&self) -> Option<Intent> {
        self.intent.as_deref().and_then(|s| match s {
            "chat" => Some(Intent::Chat),
            "note" => Some(Intent::Note),
            _ => None,
        })
    }

    /// Parse a `voice/ctl` payload. Returns `Err` on malformed JSON so the
    /// subscriber can drop with a warning (consistent with how a bad
    /// `RuntimeCommandEnvelope` is handled).
    pub fn parse(payload: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_turn_start() {
        let v = VoiceCtl::parse(br#"{"type":"turn_start","intent":"note","session":"s1","seq":7}"#)
            .expect("parse");
        assert!(v.is_turn_start());
        assert_eq!(v.intent(), Some(Intent::Note));
        assert_eq!(v.session.as_deref(), Some("s1"));
        assert_eq!(v.seq, 7);
    }

    #[test]
    fn parses_minimal_turn_end() {
        let v = VoiceCtl::parse(br#"{"type":"turn_end","seq":8}"#).expect("parse");
        assert!(!v.is_turn_start());
        assert_eq!(v.intent(), None); // absent
        assert_eq!(v.seq, 8);
    }

    #[test]
    fn parses_device_error() {
        let v = VoiceCtl::parse(
            br#"{"type":"error","code":"no_amuxd","message":"laptop asleep","seq":9}"#,
        )
        .expect("parse");
        assert_eq!(v.kind, "error");
        assert_eq!(v.code.as_deref(), Some("no_amuxd"));
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(VoiceCtl::parse(b"{not json").is_err());
    }

    #[test]
    fn unknown_type_still_parses() {
        // Forward-compat: a future ctl type round-trips; the router logs it.
        let v = VoiceCtl::parse(br#"{"type":"future_thing","seq":1}"#).expect("parse");
        assert_eq!(v.kind, "future_thing");
    }
}
