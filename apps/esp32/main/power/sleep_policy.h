/*
 * SPDX-License-Identifier: MIT
 *
 * Tiered sleep policy.
 *
 * Free of ESP-IDF and LVGL on purpose — this decides *which* tier the device
 * should be in; the host decides what that means in hardware. Same split as
 * face_state, and for the same reason: the interesting bugs here are timing
 * and precedence bugs, and those are far cheaper to find on the host than on
 * a device we cannot even flash without a human holding a button.
 *
 * Precedence, highest first:
 *   1. busy        — audio in flight or the agent is talking. Never sleep.
 *   2. userAsleep  — the user pressed power. Go dark immediately.
 *   3. inactivity  — the ordinary dim -> screen-off -> light-sleep ladder.
 */
#pragma once
#include <cstdint>

namespace power {

enum class Tier {
    Active,      // full brightness, LVGL at frame rate
    Dim,         // reduced brightness, animations still running
    ScreenOff,   // backlight off, LVGL stopped, slow poll loop
    LightSleep,  // esp_light_sleep in slices, woken by buttons or timer
};

const char* tierName(Tier t);

struct SleepConfig {
    std::uint32_t dimAfterMs = 15000;
    std::uint32_t screenOffAfterMs = 60000;
    std::uint32_t lightSleepAfterMs = 180000;

    // After an explicit power-button sleep there is no reason to wait out the
    // full inactivity ladder — the user has said they are done.
    std::uint32_t lightSleepAfterUserSleepMs = 10000;

    // Percent of the user's configured brightness to use in Dim.
    std::uint8_t dimBrightnessPct = 25;

    // Light sleep is the only tier that cannot be validated without hardware,
    // and a wrong wake configuration leaves a device that looks dead until it
    // is reset. Keep it switchable.
    bool enableLightSleep = true;
};

struct Inputs {
    bool busy = false;        // capture/agent in flight
    bool userAsleep = false;  // power button pressed
};

class SleepPolicy {
public:
    void init(SleepConfig cfg, std::uint32_t nowMs);

    // Any interaction: button edge, agent event, anything user-visible.
    void noteActivity(std::uint32_t nowMs);

    // Recompute. Returns the tier the device should now be in.
    Tier tick(std::uint32_t nowMs, const Inputs& in);

    Tier tier() const { return _tier; }

    // True when the last tick() moved between tiers — the host applies
    // hardware changes only on the edge, not every frame.
    bool changed() const { return _changed; }

    // Milliseconds since the last activity, for logging.
    std::uint32_t idleMs(std::uint32_t nowMs) const { return nowMs - _lastActivityMs; }

    const SleepConfig& config() const { return _cfg; }

private:
    SleepConfig _cfg;
    Tier _tier = Tier::Active;
    bool _changed = false;
    std::uint32_t _lastActivityMs = 0;
    bool _wasUserAsleep = false;
    std::uint32_t _userSleepAtMs = 0;
};

}  // namespace power
