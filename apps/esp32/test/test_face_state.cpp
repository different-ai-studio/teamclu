/*
 * SPDX-License-Identifier: MIT
 *
 * Host tests for the face state machine. No LVGL, no ESP-IDF, no hardware —
 * this is the payoff for keeping face_state.* free of them.
 *
 *   ./test/run.sh
 */
#include <cstdio>
#include <string>
#include <vector>

#include "../main/face/face_state.h"

using namespace face;

static int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);    \
            ++g_failures;                                                    \
        }                                                                    \
    } while (0)

namespace {

struct Log {
    std::vector<std::string> events;
    bool has(const std::string& e) const
    {
        for (const auto& x : events) {
            if (x == e) return true;
        }
        return false;
    }
    int count(const std::string& e) const
    {
        int n = 0;
        for (const auto& x : events) {
            if (x == e) ++n;
        }
        return n;
    }
    void clear() { events.clear(); }
};

Hooks makeHooks(Log& log)
{
    Hooks h;
    h.vibrate = [&log](std::uint16_t, std::uint8_t) { log.events.push_back("vibrate"); };
    h.onCaptureStart = [&log](Mode m) {
        log.events.push_back(m == Mode::Chat ? "capture_start:chat" : "capture_start:note");
    };
    h.onCaptureEnd = [&log](Mode m) {
        log.events.push_back(m == Mode::Chat ? "capture_end:chat" : "capture_end:note");
    };
    h.onCancelPlayback = [&log]() { log.events.push_back("cancel_playback"); };
    h.onEnterSleep = [&log]() { log.events.push_back("sleep"); };
    h.onExitSleep = [&log]() { log.events.push_back("wake"); };
    h.onPowerOff = [&log]() { log.events.push_back("power_off"); };
    h.onOpenNotes = [&log]() { log.events.push_back("open_notes"); };
    return h;
}

void test_short_press_a_is_inert_when_idle()
{
    std::printf("short press A from idle is inert\n");
    Log log;
    FaceState s(makeHooks(log));
    s.onButtonDown(Button::A, 0);
    s.tick(100);  // below the 240ms hold threshold
    s.onButtonUp(Button::A, 120);
    CHECK(s.screen() == Screen::Idle);
    CHECK(!log.has("capture_start:chat"));
}

void test_chat_hold_flow()
{
    std::printf("hold A -> listen -> think -> reply\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onButtonDown(Button::A, 1000);
    s.tick(1100);
    CHECK(s.screen() == Screen::Idle);  // not held long enough yet

    s.tick(1000 + FaceState::HoldThresholdMs);
    CHECK(s.screen() == Screen::Listen);
    CHECK(s.mode() == Mode::Chat);
    CHECK(log.has("capture_start:chat"));
    CHECK(log.has("vibrate"));  // PTT-grab bump

    s.onButtonUp(Button::A, 2000);
    CHECK(s.screen() == Screen::Think);
    CHECK(log.has("capture_end:chat"));

    s.tick(2000 + FaceState::ThinkToReplyMs - 1);
    CHECK(s.screen() == Screen::Think);
    s.tick(2000 + FaceState::ThinkToReplyMs);
    CHECK(s.screen() == Screen::Reply);
}

void test_short_press_a_interrupts_playback()
{
    std::printf("short press A during reply interrupts playback\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setScreen(Screen::Reply);
    log.clear();

    s.onButtonDown(Button::A, 5000);
    s.onButtonUp(Button::A, 5050);  // under the hold threshold
    CHECK(log.has("cancel_playback"));
    CHECK(s.screen() == Screen::Idle);
}

void test_note_hold_flow()
{
    std::printf("hold B -> listen(note) -> saving -> saved -> idle\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onButtonDown(Button::B, 0);
    s.tick(FaceState::HoldThresholdMs);
    CHECK(s.screen() == Screen::Listen);
    CHECK(s.mode() == Mode::Note);
    CHECK(log.has("capture_start:note"));

    s.onButtonUp(Button::B, 900);
    CHECK(s.screen() == Screen::Saving);
    CHECK(log.has("capture_end:note"));

    s.tick(900 + FaceState::SavingToSavedMs);
    CHECK(s.screen() == Screen::Saved);

    s.tick(900 + FaceState::SavingToSavedMs + FaceState::SavedToIdleMs);
    CHECK(s.screen() == Screen::Idle);
}

void test_silent_note_with_agent_expected_reports_no_agent()
{
    std::printf("note with a backend bound: silence is an error, not a smile\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setAgentExpected(true);

    s.onButtonDown(Button::B, 0);
    s.tick(FaceState::HoldThresholdMs);
    s.onButtonUp(Button::B, 900);
    CHECK(s.screen() == Screen::Saving);

    // The old timer would have shown "saved" here whether or not amuxd stored
    // anything. With a backend bound that cue is a claim, so it has to wait.
    s.tick(900 + FaceState::SavingToSavedMs + 1);
    CHECK(s.screen() == Screen::Saving);

    s.tick(900 + FaceState::AgentTimeoutMs);
    CHECK(s.screen() == Screen::Error);
    CHECK(s.error() == ErrorKind::NoAgent);
}

void test_note_saved_marker_cancels_the_timeout()
{
    std::printf("note_saved arrives -> saved, then idle; no error fires\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setAgentExpected(true);

    s.onButtonDown(Button::B, 0);
    s.tick(FaceState::HoldThresholdMs);
    s.onButtonUp(Button::B, 900);
    CHECK(s.screen() == Screen::Saving);

    s.onNoteSaved(1500, "09:12", "周会挪到周四");
    CHECK(s.screen() == Screen::Saved);
    CHECK(s.noteCount() == 1);
    CHECK(s.notes()[0].time == "09:12");
    CHECK(s.notes()[0].text == "周会挪到周四");

    // The pending NoAgent deadline must be gone, not merely overtaken.
    s.tick(900 + FaceState::AgentTimeoutMs);
    CHECK(s.screen() != Screen::Error);

    s.tick(1500 + FaceState::SavedToIdleMs);
    CHECK(s.screen() == Screen::Idle);
}

void test_a_hold_on_the_error_screen_starts_talking_without_a_second_press()
{
    // The three-press bug: dismissing an error used to swallow the press, so a
    // user whose session had expired had to press once to clear the screen and
    // again to speak. A hold means "I want to talk"; it should be honoured on
    // the first try.
    FaceState s;
    s.setLink(Link::Online);
    s.onError(ErrorKind::NoAgent);
    CHECK(s.screen() == Screen::Error);

    s.onButtonDown(Button::A, 1000);
    s.tick(1000 + FaceState::HoldThresholdMs);

    CHECK(s.screen() == Screen::Listen);
}

void test_a_tap_on_the_error_screen_only_dismisses()
{
    // The other half: a short press is not an utterance, so it must clear the
    // error and leave the device idle rather than opening a turn nobody spoke
    // into.
    FaceState s;
    s.setLink(Link::Online);
    s.onError(ErrorKind::NoAgent);

    s.onButtonDown(Button::A, 1000);
    s.onButtonUp(Button::A, 1000 + FaceState::HoldThresholdMs / 2);
    s.tick(1000 + FaceState::HoldThresholdMs);

    CHECK(s.screen() != Screen::Error);
    CHECK(s.screen() != Screen::Listen);
}

void test_late_note_saved_replaces_the_error()
{
    std::printf("note_saved after the timeout still shows saved\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setAgentExpected(true);

    s.onButtonDown(Button::B, 0);
    s.tick(FaceState::HoldThresholdMs);
    s.onButtonUp(Button::B, 900);
    s.tick(900 + FaceState::AgentTimeoutMs);
    CHECK(s.screen() == Screen::Error);

    // A slow backend that eventually succeeded. Leaving the error up would be
    // the same lie as the old fake smile, just pointing the other way.
    s.onNoteSaved(60000, "09:13", "迟到的笔记");
    CHECK(s.screen() == Screen::Saved);
    CHECK(s.error() == ErrorKind::None);
    CHECK(s.noteCount() == 1);
}

void test_note_saved_without_text_adds_no_blank_row()
{
    std::printf("note_saved with empty text adds nothing to the list\n");
    Log log;
    FaceState s(makeHooks(log));
    s.onNoteSaved(1000, "09:14", "");
    CHECK(s.screen() == Screen::Saved);
    CHECK(s.noteCount() == 0);
}

void test_note_without_a_backend_still_demos_offline()
{
    std::printf("unbound note keeps the offline timer path\n");
    Log log;
    FaceState s(makeHooks(log));  // agentExpected defaults to false

    s.onButtonDown(Button::B, 0);
    s.tick(FaceState::HoldThresholdMs);
    s.onButtonUp(Button::B, 900);
    s.tick(900 + FaceState::SavingToSavedMs);
    CHECK(s.screen() == Screen::Saved);
}

void test_short_press_b_toggles_notes()
{
    std::printf("short press B toggles the notes screen\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onButtonDown(Button::B, 0);
    s.onButtonUp(Button::B, 50);
    CHECK(s.screen() == Screen::Notes);
    CHECK(log.has("open_notes"));

    s.onButtonDown(Button::B, 500);
    s.onButtonUp(Button::B, 550);
    CHECK(s.screen() == Screen::Idle);
}

void test_sleep_gates_ptt()
{
    std::printf("sleep gates A/B; power wakes\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onButtonDown(Button::Pwr, 0);
    s.onButtonUp(Button::Pwr, 60);
    CHECK(s.screen() == Screen::Sleep);
    CHECK(log.has("sleep"));

    // A is inert while asleep (design canvas behaviour; see README divergences)
    s.onButtonDown(Button::A, 100);
    s.tick(100 + FaceState::HoldThresholdMs);
    CHECK(s.screen() == Screen::Sleep);
    CHECK(!log.has("capture_start:chat"));

    s.onButtonDown(Button::Pwr, 1000);
    s.onButtonUp(Button::Pwr, 1060);
    CHECK(s.screen() == Screen::Idle);
    CHECK(log.has("wake"));
}

void test_power_long_press()
{
    std::printf("power long press powers off, and does not also sleep\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onButtonDown(Button::Pwr, 0);
    s.tick(FaceState::PwrLongPressMs);
    CHECK(log.has("power_off"));

    // The release must not additionally toggle sleep — the press was consumed.
    s.onButtonUp(Button::Pwr, FaceState::PwrLongPressMs + 100);
    CHECK(s.screen() != Screen::Sleep);
}

void test_one_utterance_at_a_time()
{
    std::printf("a second PTT is ignored while one is held\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onButtonDown(Button::A, 0);
    s.tick(FaceState::HoldThresholdMs);
    CHECK(s.mode() == Mode::Chat);

    s.onButtonDown(Button::B, 500);
    s.tick(500 + FaceState::HoldThresholdMs);
    CHECK(s.mode() == Mode::Chat);  // unchanged
    CHECK(!log.has("capture_start:note"));

    s.onButtonUp(Button::B, 900);
    CHECK(s.screen() == Screen::Listen);  // B's release must not commit A's turn
    CHECK(!log.has("capture_end:note"));
}

void test_error_is_dismissable()
{
    std::printf("any press dismisses an error\n");
    Log log;
    FaceState s(makeHooks(log));

    s.onError(ErrorKind::NoAgent);
    CHECK(s.screen() == Screen::Error);
    CHECK(s.error() == ErrorKind::NoAgent);

    s.onButtonDown(Button::A, 100);
    CHECK(s.screen() == Screen::Idle);
    CHECK(s.error() == ErrorKind::None);
}

void test_recent_notes_are_newest_first()
{
    std::printf("recentNotes is newest-first and capped\n");
    Log log;
    FaceState s(makeHooks(log));
    s.addNote("09:12", "one");
    s.addNote("10:04", "two");
    s.addNote("11:38", "three");
    s.addNote("12:00", "four");

    const auto r = s.recentNotes(3);
    CHECK(r.size() == 3);
    CHECK(r[0].text == "four");
    CHECK(r[1].text == "three");
    CHECK(r[2].text == "two");
    CHECK(s.noteCount() == 4);
}

void test_config_ap_pins_the_wifi_screen()
{
    std::printf("config AP pins the wifi screen and survives a rebuild\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setScreen(Screen::Notes);

    s.setLink(Link::ConfigAp);
    CHECK(s.screen() == Screen::Wifi);
    CHECK(s.link() == Link::ConfigAp);
}

void test_config_ap_makes_talk_buttons_inert()
{
    std::printf("config AP makes A/B inert but leaves power working\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setLink(Link::ConfigAp);

    // Holding PTT with no link would record into nowhere.
    s.onButtonDown(Button::A, 0);
    s.tick(FaceState::HoldThresholdMs);
    CHECK(s.screen() == Screen::Wifi);
    CHECK(!log.has("capture_start:chat"));

    s.onButtonDown(Button::B, 1000);
    s.tick(1000 + FaceState::HoldThresholdMs);
    CHECK(s.screen() == Screen::Wifi);
    CHECK(!log.has("capture_start:note"));

    // Power must still work — the device has to be sleepable regardless.
    s.onButtonDown(Button::Pwr, 2000);
    s.onButtonUp(Button::Pwr, 2060);
    CHECK(s.screen() == Screen::Sleep);
    CHECK(log.has("sleep"));
}

void test_leaving_config_ap_returns_to_idle()
{
    std::printf("leaving config AP drops the wifi screen\n");
    Log log;
    FaceState s(makeHooks(log));

    s.setLink(Link::ConfigAp);
    CHECK(s.screen() == Screen::Wifi);

    s.setLink(Link::Connecting);
    CHECK(s.screen() == Screen::Idle);

    // And PTT works again.
    s.onButtonDown(Button::A, 0);
    s.tick(FaceState::HoldThresholdMs);
    CHECK(s.screen() == Screen::Listen);
}

void test_link_changes_do_not_disturb_other_screens()
{
    std::printf("ordinary link changes leave the current screen alone\n");
    Log log;
    FaceState s(makeHooks(log));
    s.setScreen(Screen::Notes);

    s.setLink(Link::Connecting);
    CHECK(s.screen() == Screen::Notes);
    s.setLink(Link::Online);
    CHECK(s.screen() == Screen::Notes);
}

void test_silent_turn_with_no_agent_fakes_a_reply()
{
    std::printf("unbound: a silent turn still reaches reply (demo placeholder)\n");
    Log log;
    FaceState st(makeHooks(log));
    st.setAgentExpected(false);

    st.onButtonDown(Button::A, 0);
    st.tick(FaceState::HoldThresholdMs);
    st.onButtonUp(Button::A, 1000);
    CHECK(st.screen() == Screen::Think);

    st.tick(1000 + FaceState::ThinkToReplyMs);
    CHECK(st.screen() == Screen::Reply);
}

void test_silent_turn_with_agent_expected_reports_no_agent()
{
    std::printf("bound: a silent turn becomes the no-agent error, not a fake reply\n");
    Log log;
    FaceState st(makeHooks(log));
    st.setAgentExpected(true);

    st.onButtonDown(Button::A, 0);
    st.tick(FaceState::HoldThresholdMs);
    st.onButtonUp(Button::A, 1000);
    CHECK(st.screen() == Screen::Think);

    // The old placeholder deadline must NOT fire.
    st.tick(1000 + FaceState::ThinkToReplyMs);
    CHECK(st.screen() == Screen::Think);

    st.tick(1000 + FaceState::AgentTimeoutMs);
    CHECK(st.screen() == Screen::Error);
    CHECK(st.error() == ErrorKind::NoAgent);
}

void test_agent_reply_cancels_the_timeout()
{
    std::printf("an agent that answers cancels the no-agent timeout\n");
    Log log;
    FaceState st(makeHooks(log));
    st.setAgentExpected(true);

    st.onButtonDown(Button::A, 0);
    st.tick(FaceState::HoldThresholdMs);
    st.onButtonUp(Button::A, 1000);

    st.onAgentSpeaking();           // ctl spk_start arrives
    CHECK(st.screen() == Screen::Reply);

    // Well past the timeout: it must not fire now that we are speaking.
    st.tick(1000 + FaceState::AgentTimeoutMs + 1000);
    CHECK(st.screen() == Screen::Reply);
    CHECK(st.error() == ErrorKind::None);
}

}  // namespace

int main()
{
    test_short_press_a_is_inert_when_idle();
    test_chat_hold_flow();
    test_short_press_a_interrupts_playback();
    test_note_hold_flow();
    test_silent_note_with_agent_expected_reports_no_agent();
    test_note_saved_marker_cancels_the_timeout();
    test_a_hold_on_the_error_screen_starts_talking_without_a_second_press();
    test_a_tap_on_the_error_screen_only_dismisses();
    test_late_note_saved_replaces_the_error();
    test_note_saved_without_text_adds_no_blank_row();
    test_note_without_a_backend_still_demos_offline();
    test_short_press_b_toggles_notes();
    test_sleep_gates_ptt();
    test_power_long_press();
    test_one_utterance_at_a_time();
    test_error_is_dismissable();
    test_recent_notes_are_newest_first();
    test_config_ap_pins_the_wifi_screen();
    test_config_ap_makes_talk_buttons_inert();
    test_leaving_config_ap_returns_to_idle();
    test_link_changes_do_not_disturb_other_screens();
    test_silent_turn_with_no_agent_fakes_a_reply();
    test_silent_turn_with_agent_expected_reports_no_agent();
    test_agent_reply_cancels_the_timeout();

    if (g_failures == 0) {
        std::printf("\nall face_state tests passed\n");
        return 0;
    }
    std::printf("\n%d check(s) failed\n", g_failures);
    return 1;
}
