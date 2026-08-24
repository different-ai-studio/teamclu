/*
 * SPDX-License-Identifier: MIT
 *
 * Face state machine.
 *
 * Deliberately free of LVGL, M5GFX and ESP-IDF: this is the whole interaction
 * model of the device as plain C++, so it can be reasoned about (and later
 * host-tested) without hardware. Rendering subscribes to it; side effects
 * (vibration, audio capture, MQTT) are injected as hooks.
 *
 * Milestone 1 runs this with every hook stubbed except vibrate — that is what
 * makes the 10 screens exercisable on real hardware with no network at all.
 * Milestone 2 fills the hooks in; the state machine should not need to change.
 */
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace face {

enum class Screen {
    Idle,     // clock + tall eyes, occasional blink and sway
    Listen,   // eyes closed to lines + live waveform, while a button is held
    Think,    // squares bobbing + drifting dots, waiting on the agent
    Reply,    // eyes + chewing mouth, agent is speaking. No text, by design.
    Saving,   // white eyes + red dots, note is being committed
    Saved,    // smile + block, note landed
    Notes,    // today's notes as a list. The one screen that shows text.
    Wifi,     // pairing code + captive-AP hint
    Sleep,    // two dashes
    Error,    // 错 — see ErrorKind
};

// Short stable label for a screen. Used for logs and for slicing power
// measurements by state — keep these terse and don't rename casually, the
// battery-profiling tooling groups on them.
const char* screenName(Screen s);

// Network reachability, driven by the Wi-Fi layer.
//
// ConfigAp is not merely "offline": the device is hosting its own access point
// and waiting to be provisioned, which is a mode the user has to act on. It
// therefore takes over the screen and makes the talk buttons inert — pretending
// PTT works with no link would just record audio into nowhere.
enum class Link {
    Booting,     // radio not up yet
    ConfigAp,    // hosting the provisioning AP; screen is pinned to Wifi
    Connecting,  // credentials known, associating
    Online,
};

const char* linkName(Link l);

// Which button path the current utterance belongs to. Chat expects a spoken
// reply; Note is fire-and-forget and queues offline.
enum class Mode { Chat, Note };

// The design canvas has no error screen; the plan (rev2 §4) requires the device
// to distinguish *why* it failed, because "it just doesn't work" is the failure
// mode that makes a tethered device unsupportable.
enum class ErrorKind {
    None,
    NoWifi,      // not associated
    NoBroker,    // associated, broker unreachable
    NoAgent,     // broker fine, amuxd absent (see plan §2.1 — laptop asleep)
    Upstream,    // STT / LLM / TTS failed
};

enum class Button { A, B, Pwr };

struct Note {
    std::string time;  // "HH:MM"
    std::string text;
};

// Side effects the state machine triggers but does not implement.
struct Hooks {
    std::function<void(std::uint16_t durationMs, std::uint8_t strength)> vibrate;
    std::function<void(Mode)> onCaptureStart;   // PTT engaged, start mic
    std::function<void(Mode)> onCaptureEnd;     // PTT released, commit utterance
    std::function<void()> onCancelPlayback;     // barge-in / interrupt TTS
    std::function<void()> onEnterSleep;
    std::function<void()> onExitSleep;
    std::function<void()> onPowerOff;
    std::function<void()> onOpenNotes;          // chance to refresh the list
};

class FaceState {
public:
    /* ------------------------------- Timings ------------------------------- */
    // Transcribed from the design canvas's own prototype logic, which is the
    // closest thing we have to a signed-off interaction spec.
    static constexpr std::uint32_t HoldThresholdMs = 240;   // press -> "held"
    static constexpr std::uint32_t ThinkToReplyMs  = 1300;  // placeholder until the agent answers
    static constexpr std::uint32_t SavingToSavedMs = 1000;
    static constexpr std::uint32_t SavedToIdleMs   = 2200;
    static constexpr std::uint32_t PwrLongPressMs  = 1500;  // -> power off
    // How long to wait for amuxd to say anything after an utterance is
    // committed, before concluding nobody is listening. Generous: the budget in
    // plan §9 is ~1 s, but a cold STT connection or a busy laptop can exceed it
    // without being broken.
    static constexpr std::uint32_t AgentTimeoutMs  = 8000;

    explicit FaceState(Hooks hooks = {});

    /* -------------------------------- Input -------------------------------- */
    void onButtonDown(Button b, std::uint32_t nowMs);
    void onButtonUp(Button b, std::uint32_t nowMs);

    // Drive time-based transitions. Call every frame; cheap and idempotent.
    void tick(std::uint32_t nowMs);

    /* ------------------------- Agent-driven input -------------------------- */
    // Milestone 2 wires these to the MQTT ctl channel. Milestone 1 leaves them
    // unused, which is why Think falls through to Reply on a timer instead.
    void onAgentThinking();
    void onAgentSpeaking();
    void onAgentDone();
    void onError(ErrorKind kind);
    void clearError();

    /* -------------------------------- State -------------------------------- */
    Screen screen() const { return _screen; }
    Mode mode() const { return _mode; }
    ErrorKind error() const { return _error; }
    bool asleep() const { return _screen == Screen::Sleep; }

    const std::vector<Note>& notes() const { return _notes; }
    std::size_t noteCount() const { return _notes.size(); }
    // Most recent first, capped — matches the canvas's notes.slice(-3).reverse().
    std::vector<Note> recentNotes(std::size_t max = 3) const;
    void addNote(std::string time, std::string text);

    // Device identifier shown on the Wifi screen: the last two bytes of the
    // factory MAC, which is also the SoftAP SSID suffix, so the user can tell
    // which access point is theirs.
    //
    // This is NOT the pairing code. The pairing code is generated by amuxd and
    // typed *into* the device's captive portal; it is never displayed here and
    // never derived from the MAC, which is public (see plan §8.1).
    void setDeviceCode(std::string code) { _deviceCode = std::move(code); }
    const std::string& deviceCode() const { return _deviceCode; }

    // Battery, shown on the idle screen. Held here rather than read from the
    // HAL in the renderer so face_ui stays hardware-free and testable.
    void setBattery(std::uint8_t pct, bool charging)
    {
        _batteryPct = pct > 100 ? 100 : pct;
        _batteryCharging = charging;
    }
    std::uint8_t batteryPct() const { return _batteryPct; }
    bool batteryCharging() const { return _batteryCharging; }

    // Driven by the Wi-Fi layer. Entering ConfigAp pins the screen to Wifi;
    // leaving it returns to Idle.
    void setLink(Link l);
    Link link() const { return _link; }

    // True once MQTT is connected AND a device token bound us to a team/actor,
    // i.e. there is somebody who could answer.
    //
    // This decides what a silent turn means. Unbound, the think->reply timer is
    // a demo placeholder so the face is exercisable with no backend. Bound, the
    // same silence means amuxd never answered, and pretending it replied would
    // put the device on the speaking screen with nothing to say — so it becomes
    // the "电脑没醒着" error instead (plan §3.1).
    void setAgentExpected(bool expected) { _agentExpected = expected; }
    bool agentExpected() const { return _agentExpected; }

    void setScreen(Screen s);  // for the on-device screen jumper / tests

private:
    void enterIdle();
    void beginHold(Mode m);
    void commitHold(Mode m, std::uint32_t nowMs);
    void shortPress(Mode m);
    void armDeadline(std::uint32_t nowMs, std::uint32_t delayMs, Screen next);
    void clearDeadline();

    Hooks _hooks;
    Screen _screen = Screen::Idle;
    Mode _mode = Mode::Chat;
    ErrorKind _error = ErrorKind::None;

    // Per-button press bookkeeping. A and B are independent; Pwr is separate
    // because it is the only one with a long-press meaning.
    bool _downA = false, _downB = false, _downPwr = false;
    bool _heldA = false, _heldB = false;
    std::uint32_t _downAtA = 0, _downAtB = 0, _downAtPwr = 0;

    bool _deadlineArmed = false;
    std::uint32_t _deadlineAt = 0;
    Screen _deadlineNext = Screen::Idle;

    std::vector<Note> _notes;
    std::string _deviceCode;
    std::uint8_t _batteryPct = 0;
    bool _batteryCharging = false;
    Link _link = Link::Booting;
    bool _agentExpected = false;
};

}  // namespace face
