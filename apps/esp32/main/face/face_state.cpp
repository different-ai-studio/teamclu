/*
 * SPDX-License-Identifier: MIT
 */
#include "face_state.h"

#include <algorithm>
#include <utility>

namespace face {
namespace {

// Hooks are optional; the milestone-1 host only wires vibrate.
template <typename Fn, typename... Args>
inline void fire(const Fn& fn, Args&&... args)
{
    if (fn) {
        fn(std::forward<Args>(args)...);
    }
}

// Haptic vocabulary, per the design's "表情语言" table and plan rev2 §4.
constexpr std::uint16_t BumpGrabMs = 18;   // PTT engaged
constexpr std::uint16_t BumpReplyMs = 12;  // first audio back
constexpr std::uint16_t BumpDoneMs = 30;   // note landed — the one "done" cue
constexpr std::uint16_t BumpErrorMs = 60;
constexpr std::uint8_t BumpStrength = 100;

}  // namespace

const char* screenName(Screen s)
{
    switch (s) {
        case Screen::Idle:   return "idle";
        case Screen::Listen: return "listen";
        case Screen::Think:  return "think";
        case Screen::Reply:  return "reply";
        case Screen::Saving: return "saving";
        case Screen::Saved:  return "saved";
        case Screen::Notes:  return "notes";
        case Screen::Wifi:   return "wifi";
        case Screen::Sleep:  return "sleep";
        case Screen::Error:  return "error";
    }
    return "?";
}

const char* linkName(Link l)
{
    switch (l) {
        case Link::Booting:    return "booting";
        case Link::ConfigAp:   return "configap";
        case Link::Connecting: return "connecting";
        case Link::Online:     return "online";
    }
    return "?";
}

FaceState::FaceState(Hooks hooks) : _hooks(std::move(hooks)) {}

void FaceState::setLink(Link l)
{
    if (l == _link) {
        return;
    }
    const Link previous = _link;
    _link = l;

    if (l == Link::ConfigAp) {
        // Provisioning takes over the screen: it is the only thing the user can
        // usefully act on, and it must survive whatever screen we were showing.
        clearDeadline();
        _screen = Screen::Wifi;
        return;
    }

    // Leaving provisioning: the Wifi screen has nothing left to say. Anything
    // else the user navigated to is left alone.
    if (previous == Link::ConfigAp && _screen == Screen::Wifi) {
        enterIdle();
    }
}

/* ---------------------------------- Input --------------------------------- */

void FaceState::onButtonDown(Button b, std::uint32_t nowMs)
{
    // Any press dismisses an error and returns to a known state. An error
    // screen the user cannot leave is worse than the error.
    if (_screen == Screen::Error && _error != ErrorKind::None) {
        clearError();
        if (b != Button::Pwr) {
            return;  // consume this press as the dismissal
        }
    }

    if (b == Button::Pwr) {
        _downPwr = true;
        _downAtPwr = nowMs;
        return;
    }

    // Provisioning: A/B are inert. Capturing audio with no link would record
    // into nowhere and the Listen screen would be a lie. Power still works, so
    // the device can always be slept or switched off.
    if (_link == Link::ConfigAp) {
        return;
    }

    // Asleep: A/B are inert, matching the design prototype's `press()` guard.
    // NOTE: plan rev2 §4 says "wake on PTT" instead. The design is the newer
    // artifact so it wins here, but this is a real open question — flipping it
    // is a two-line change at this guard.
    if (_screen == Screen::Sleep) {
        return;
    }

    // One utterance at a time: ignore a second PTT while one is already held.
    if (_heldA || _heldB) {
        return;
    }

    if (b == Button::A) {
        _downA = true;
        _heldA = false;
        _downAtA = nowMs;
    } else {
        _downB = true;
        _heldB = false;
        _downAtB = nowMs;
    }
    clearDeadline();
}

void FaceState::onButtonUp(Button b, std::uint32_t nowMs)
{
    if (b == Button::Pwr) {
        if (!_downPwr) {
            return;  // long-press already consumed it
        }
        _downPwr = false;
        // Short press toggles sleep.
        if (_screen == Screen::Sleep) {
            fire(_hooks.onExitSleep);
            enterIdle();
        } else {
            clearDeadline();
            _screen = Screen::Sleep;
            fire(_hooks.onEnterSleep);
        }
        return;
    }

    const bool isA = (b == Button::A);
    bool& down = isA ? _downA : _downB;
    bool& held = isA ? _heldA : _heldB;
    const Mode m = isA ? Mode::Chat : Mode::Note;

    if (!down) {
        return;
    }
    down = false;

    if (held) {
        held = false;
        commitHold(m, nowMs);
    } else {
        shortPress(m);
    }
}

void FaceState::tick(std::uint32_t nowMs)
{
    // Promote a press into a hold once it outlasts the threshold. This is what
    // separates "短按" from "按住说话" and it has to happen on the clock, not
    // on release, so the screen flips to Listen while the finger is still down.
    if (_downA && !_heldA && (nowMs - _downAtA) >= HoldThresholdMs) {
        _heldA = true;
        beginHold(Mode::Chat);
    }
    if (_downB && !_heldB && (nowMs - _downAtB) >= HoldThresholdMs) {
        _heldB = true;
        beginHold(Mode::Note);
    }

    if (_downPwr && (nowMs - _downAtPwr) >= PwrLongPressMs) {
        _downPwr = false;  // consume, so the release does not also toggle sleep
        fire(_hooks.onPowerOff);
        return;
    }

    if (_deadlineArmed && static_cast<std::int32_t>(nowMs - _deadlineAt) >= 0) {
        const Screen next = _deadlineNext;
        clearDeadline();
        switch (next) {
            case Screen::Reply:
                _screen = Screen::Reply;
                fire(_hooks.vibrate, BumpReplyMs, BumpStrength);
                break;
            case Screen::Saved:
                _screen = Screen::Saved;
                fire(_hooks.vibrate, BumpDoneMs, BumpStrength);
                armDeadline(nowMs, SavedToIdleMs, Screen::Idle);
                break;
            case Screen::Idle:
            default:
                enterIdle();
                break;
        }
    }
}

/* --------------------------------- Gestures -------------------------------- */

void FaceState::beginHold(Mode m)
{
    _mode = m;
    _screen = Screen::Listen;
    fire(_hooks.vibrate, BumpGrabMs, BumpStrength);
    fire(_hooks.onCaptureStart, m);
}

void FaceState::commitHold(Mode m, std::uint32_t nowMs)
{
    fire(_hooks.onCaptureEnd, m);
    if (m == Mode::Chat) {
        // Placeholder timing. Milestone 2 replaces this with onAgentSpeaking()
        // driven by the ctl channel; until then the fall-through keeps the
        // whole gesture demonstrable on hardware with no network.
        _screen = Screen::Think;
        armDeadline(nowMs, ThinkToReplyMs, Screen::Reply);
    } else {
        _screen = Screen::Saving;
        armDeadline(nowMs, SavingToSavedMs, Screen::Saved);
    }
}

void FaceState::shortPress(Mode m)
{
    if (m == Mode::Chat) {
        // "短按打断朗读" — only meaningful while it is speaking.
        if (_screen == Screen::Reply) {
            fire(_hooks.onCancelPlayback);
            enterIdle();
        }
        return;
    }
    // "短按看今日记事" — toggle.
    if (_screen == Screen::Notes) {
        enterIdle();
    } else {
        fire(_hooks.onOpenNotes);
        clearDeadline();
        _screen = Screen::Notes;
    }
}

/* ------------------------------ Agent signals ------------------------------ */

void FaceState::onAgentThinking()
{
    clearDeadline();
    _screen = Screen::Think;
}

void FaceState::onAgentSpeaking()
{
    clearDeadline();
    if (_screen != Screen::Reply) {
        fire(_hooks.vibrate, BumpReplyMs, BumpStrength);
    }
    _screen = Screen::Reply;
}

void FaceState::onAgentDone()
{
    enterIdle();
}

void FaceState::onError(ErrorKind kind)
{
    if (kind == ErrorKind::None) {
        clearError();
        return;
    }
    clearDeadline();
    _error = kind;
    _screen = Screen::Error;
    fire(_hooks.vibrate, BumpErrorMs, BumpStrength);
}

void FaceState::clearError()
{
    _error = ErrorKind::None;
    if (_screen == Screen::Error) {
        enterIdle();
    }
}

/* ---------------------------------- Notes ---------------------------------- */

void FaceState::addNote(std::string time, std::string text)
{
    _notes.push_back(Note{std::move(time), std::move(text)});
    // The device is not an archive; the list screen shows 3 and the count is
    // cosmetic. Bound it so a long uptime cannot grow this without limit.
    constexpr std::size_t MaxNotes = 64;
    if (_notes.size() > MaxNotes) {
        _notes.erase(_notes.begin(), _notes.begin() + (_notes.size() - MaxNotes));
    }
}

std::vector<Note> FaceState::recentNotes(std::size_t max) const
{
    std::vector<Note> out;
    const std::size_t n = std::min(max, _notes.size());
    out.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        out.push_back(_notes[_notes.size() - 1 - i]);  // newest first
    }
    return out;
}

/* --------------------------------- Internal -------------------------------- */

void FaceState::setScreen(Screen s)
{
    clearDeadline();
    _screen = s;
}

void FaceState::enterIdle()
{
    clearDeadline();
    _screen = Screen::Idle;
}

void FaceState::armDeadline(std::uint32_t nowMs, std::uint32_t delayMs, Screen next)
{
    _deadlineArmed = true;
    _deadlineAt = nowMs + delayMs;
    _deadlineNext = next;
}

void FaceState::clearDeadline()
{
    _deadlineArmed = false;
}

}  // namespace face
