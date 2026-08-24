/*
 * SPDX-License-Identifier: MIT
 *
 * TeamClu StopWatch — milestone 1.
 *
 * Offline bring-up: the whole interaction model from the design canvas running
 * on real hardware with no Wi-Fi, no MQTT and no audio. Every hook that would
 * reach the network is stubbed here and marked MILESTONE 2, so the seams are
 * visible rather than implied.
 *
 * Hardware access goes through the M5Stack StopWatch HAL vendored under hal/
 * (MIT, see README).
 */
#include <driver/gpio.h>
#include <hal/hal.h>
#include <mooncake_log.h>

#include <cstdio>
#include <string>

#include "face/face_state.h"
#include "face/face_ui.h"
#include "power/battery_log.h"
#include "power/power_hw.h"
#include "net/net_link.h"
#include "power/sleep_policy.h"

namespace {

constexpr const char* kTag = "main";

// Device identifier for the Wifi screen: last two MAC bytes, matching the
// SoftAP SSID suffix so the user can tell which AP is theirs. Not a secret and
// not the pairing code -- see plan 8.1.
std::string deviceCodeFromMac()
{
    const auto mac = GetHAL().getFactoryMac();
    char buf[8];
    std::snprintf(buf, sizeof(buf), "%02X%02X", mac[4], mac[5]);
    return std::string(buf);
}

std::string clockNow()
{
    const auto t = GetHAL().getTimeHms();
    char buf[8];
    std::snprintf(buf, sizeof(buf), "%02u:%02u", t.hour, t.minute);
    return std::string(buf);
}

// Screens that must not dim or sleep, however long they last.
//
// Two different reasons, both of which mean "the inactivity ladder is wrong
// here":
//   * Listen/Think/Reply/Saving — audio is in flight or the agent is mid-turn.
//   * Wifi — the user is *reading* it: a pairing screen that dims after 15 s
//     and blanks after 60 s goes dark exactly while they are on their phone
//     hunting for the access point. "No button pressed" is not idleness here.
//
// Error is deliberately absent: it should be readable, but it is dismissed with
// any button, so letting it sleep is fine.
bool keepAwake(face::Screen s)
{
    switch (s) {
        case face::Screen::Listen:
        case face::Screen::Think:
        case face::Screen::Reply:
        case face::Screen::Saving:
        case face::Screen::Wifi:
            return true;
        default:
            return false;
    }
}

face::Hooks makeHooks()
{
    face::Hooks h;

    h.vibrate = [](std::uint16_t ms, std::uint8_t strength) {
        GetHAL().vibrate(ms, strength);
    };

    // MILESTONE 2: start streaming Opus frames to
    // amux/{team}/{actor}/voice/mic with intent=chat|note.
    h.onCaptureStart = [](face::Mode m) {
        mclog::info(kTag, "capture start ({})", m == face::Mode::Chat ? "chat" : "note");
    };

    // MILESTONE 2: stop the mic and commit the utterance. For note mode this is
    // also where the offline queue gets a row if the link is down.
    h.onCaptureEnd = [](face::Mode m) {
        mclog::info(kTag, "capture end ({})", m == face::Mode::Chat ? "chat" : "note");
    };

    // MILESTONE 2: publish a flush marker on .../voice/ctl at QoS 1 and stop
    // playback locally. Deliberately not on the audio topic — see plan §5.
    h.onCancelPlayback = []() { mclog::info(kTag, "cancel playback"); };

    // Screen and CPU handling live in the sleep policy, which sees the Sleep
    // screen as `userAsleep`. These hooks only record the intent.
    h.onEnterSleep = []() { mclog::info(kTag, "sleep"); };
    h.onExitSleep = []() { mclog::info(kTag, "wake"); };

    h.onPowerOff = []() {
        mclog::info(kTag, "power off requested");
        // MILESTONE 2: real power-down via the M5PM1. Reboot is a stand-in that
        // is at least observably distinct from sleep.
        GetHAL().reboot();
    };

    h.onOpenNotes = []() { mclog::info(kTag, "open notes"); };

    return h;
}

}  // namespace

extern "C" void app_main(void)
{
    mclog::set_level(mclog::level_info);
    mclog::set_time_format(mclog::time_format_unix_milliseconds);

    GetHAL().init();
    GetHAL().syncRtcTimeToSystem();

    face::FaceState state(makeHooks());
    state.setDeviceCode(deviceCodeFromMac());

    // MILESTONE 1 ONLY: seed the notes list so the Notes screen has something
    // to render before STT exists. Delete once real transcripts arrive.
    state.addNote("09:12", "周会挪到周四下午");
    state.addNote("10:04", "亮度曲线要重标");
    state.addNote("11:38", "问 CST820B 中断脚");

    power::BatteryLog battery;
    // 10 s: the HAL filters vbat over ~8 s, so faster only re-reports the same value.
    battery.init(10000);

    face::FaceUi ui;
    {
        LvglLockGuard lock;
        ui.init(lv_screen_active());
    }
    GetHAL().startLvglUpdate();

    // Captured once: the tier logic scales *from* the user's chosen brightness,
    // so re-reading it after we have dimmed would ratchet it down to nothing.
    const auto userBrightness = static_cast<std::uint8_t>(GetHAL().getBackLightBrightness(true));

    power::SleepPolicy sleep;
    sleep.init(power::SleepConfig{}, GetHAL().millis());

    // Escape hatch: hold BOTH buttons through boot to wipe provisioning.
    // Read the pads directly rather than via the debounced Button_Class, which
    // needs several update cycles before it reports anything this early.
    // Without this a device configured for a network it cannot see retries that
    // network forever and never reopens the portal — unrecoverable short of a
    // reflash, which is not a thing a user can do.
    {
        bool bothHeld = true;
        for (int i = 0; i < 5 && bothHeld; ++i) {
            bothHeld = (gpio_get_level(GPIO_NUM_2) == 0) && (gpio_get_level(GPIO_NUM_1) == 0);
            GetHAL().delay(40);
        }
        if (bothHeld) {
            mclog::info(kTag, "both buttons held at boot: forgetting provisioning");
            GetHAL().vibrate(120, 100);
            net::forgetProvisioning();
        }
    }

    // Radio last: everything above must be able to render before the network
    // has any opinion, so a provisioning screen has a face to appear on.
    net::start(state.deviceCode());

    mclog::info(kTag, "face up, device {}", state.deviceCode());

    std::uint32_t lastClockMs = 0;

    while (true) {
        GetHAL().feedTheDog();

        const std::uint32_t now = GetHAL().millis();

        // Buttons: the HAL debounces and tracks edges; we only translate them
        // into the state machine's vocabulary.
        GetHAL().updateButtonStates();
        bool touched = false;
        if (GetHAL().btnA.wasPressed())    { state.onButtonDown(face::Button::A, now);   touched = true; }
        if (GetHAL().btnA.wasReleased())   { state.onButtonUp(face::Button::A, now);     touched = true; }
        if (GetHAL().btnB.wasPressed())    { state.onButtonDown(face::Button::B, now);   touched = true; }
        if (GetHAL().btnB.wasReleased())   { state.onButtonUp(face::Button::B, now);     touched = true; }
        if (GetHAL().btnPwr.wasPressed())  { state.onButtonDown(face::Button::Pwr, now); touched = true; }
        if (GetHAL().btnPwr.wasReleased()) { state.onButtonUp(face::Button::Pwr, now);   touched = true; }
        if (touched) {
            sleep.noteActivity(now);
        }

        net::poll();  // deferred network work; never run from the event task
        state.setLink(net::linkState());
        state.tick(now);

        power::Inputs pin;
        pin.busy = keepAwake(state.screen());
        pin.userAsleep = (state.screen() == face::Screen::Sleep);
        const power::Tier tier = sleep.tick(now, pin);
        if (sleep.changed()) {
            power::applyTier(tier, userBrightness, sleep.config().dimBrightnessPct);
        }

        // Label samples with screen *and* tier: the point of the profiling is
        // comparing what each tier costs.
        char label[40];
        std::snprintf(label, sizeof(label), "%s/%s", face::screenName(state.screen()),
                      power::tierName(tier));
        battery.tick(now, label);

        const bool drawing = (tier == power::Tier::Active || tier == power::Tier::Dim);
        if (drawing) {
            if (now - lastClockMs >= 1000) {
                lastClockMs = now;
                ui.setClock(clockNow());
                state.setBattery(GetHAL().getBatteryLevel(), GetHAL().isBatteryCharging());
            }
            LvglLockGuard lock;
            ui.render(state, now);
        }

        if (tier == power::Tier::LightSleep) {
            // Blocks until a button edge or the safety timer; see power_hw.h for
            // why that timer is mandatory rather than an optimisation.
            power::lightSleepSlice(250);
        } else {
            GetHAL().delay(power::loopDelayMs(tier));
        }
    }
}
