/*
 * SPDX-FileCopyrightText: 2025 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 *
 * Parser for the amuxd→device half of `voice/ctl`.
 *
 * The device SENDS turn_start/turn_end/barge_in/error (built in voice_ctl.cpp);
 * amuxd SENDS BACK the agent-side markers that the face's agent-driven input
 * (`onAgentThinking/Speaking/Done`, `onError`) needs to fire without a timer.
 * This module turns the incoming JSON into a tagged struct the main loop can
 * drain and dispatch.
 *
 * Pure C++, no IDF, no LVGL, no logging — host-testable, same rule as
 * face_state (plan §6). The wire format is the flat `VoiceCtl` shape amuxd
 * defines in apps/daemon/src/voice/ctl.rs: `{"type":"...","code":"...",
 * "message":"...","session":"...","seq":N}`. We only extract the fields we act
 * on; unknown types parse as `Unknown` and are logged by the caller, not
 * crashed on — forward-compat with future amuxd ctl types.
 *
 * The scanner is intentionally tiny rather than a real JSON parser: the
 * producer is amuxd (controlled), messages are small and flat, and pulling a
 * JSON lib onto the device for three string fields is not worth the flash.
 */
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace net {

struct IncomingCtl {
    enum class Kind {
        Error,       // amuxd: STT/LLM/TTS failed or agent absent
        Thinking,    // amuxd: prompt dispatched, waiting on the model
        SpkStart,    // amuxd: TTS audio is about to flow on voice/spk
        SpkEnd,      // amuxd: TTS audio finished (turn done, no barge-in)
        Session,     // amuxd: session id assigned for this turn
        NoteSaved,   // amuxd: a note turn was persisted — carries the text back
        Unknown,     // forward-compat: a type this firmware doesn't know yet
    };

    Kind kind = Kind::Unknown;
    std::string code;     // Error: short machine code (e.g. "no_amuxd")
    std::string message;  // Error: human-readable detail
    std::string session;  // Session: cloud session id for this turn
    // NoteSaved: what amuxd actually stored. The text is echoed back rather
    // than kept from the device because the device never had it — it shipped
    // Opus frames, and only amuxd knows what the transcript came out as.
    std::string time;     // NoteSaved: "HH:MM" for the notes list
    std::string text;     // NoteSaved: the stored transcript
};

// Parse one incoming `voice/ctl` JSON document. Malformed input returns
// `Kind::Unknown` with empty fields rather than failing — a dropped ctl is
// better than a crashed firmware, and amuxd redelivers (QoS 1).
IncomingCtl parseIncomingCtl(const char* json, std::size_t len);

}  // namespace net
