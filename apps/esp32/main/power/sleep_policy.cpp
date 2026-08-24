/*
 * SPDX-License-Identifier: MIT
 */
#include "sleep_policy.h"

namespace power {

const char* tierName(Tier t)
{
    switch (t) {
        case Tier::Active:     return "active";
        case Tier::Dim:        return "dim";
        case Tier::ScreenOff:  return "screenoff";
        case Tier::LightSleep: return "lightsleep";
    }
    return "?";
}

void SleepPolicy::init(SleepConfig cfg, std::uint32_t nowMs)
{
    _cfg = cfg;
    _tier = Tier::Active;
    _changed = true;  // force the host to apply the initial tier
    _lastActivityMs = nowMs;
    _wasUserAsleep = false;
    _userSleepAtMs = nowMs;
}

void SleepPolicy::noteActivity(std::uint32_t nowMs)
{
    _lastActivityMs = nowMs;
}

Tier SleepPolicy::tick(std::uint32_t nowMs, const Inputs& in)
{
    const Tier previous = _tier;

    // Track the moment the user asked for sleep, so the shortened ladder is
    // measured from the press rather than from the last unrelated activity.
    if (in.userAsleep && !_wasUserAsleep) {
        _userSleepAtMs = nowMs;
    }
    _wasUserAsleep = in.userAsleep;

    if (in.busy) {
        // Streaming audio or playing a reply. Staying awake is not negotiable,
        // and this also refreshes the idle clock so releasing the button does
        // not immediately drop the device into Dim.
        _lastActivityMs = nowMs;
        _tier = Tier::Active;
    } else if (in.userAsleep) {
        // Explicit sleep: dark at once, then light sleep shortly after.
        const std::uint32_t since = nowMs - _userSleepAtMs;
        if (_cfg.enableLightSleep && since >= _cfg.lightSleepAfterUserSleepMs) {
            _tier = Tier::LightSleep;
        } else {
            _tier = Tier::ScreenOff;
        }
    } else {
        const std::uint32_t idle = nowMs - _lastActivityMs;
        if (_cfg.enableLightSleep && idle >= _cfg.lightSleepAfterMs) {
            _tier = Tier::LightSleep;
        } else if (idle >= _cfg.screenOffAfterMs) {
            _tier = Tier::ScreenOff;
        } else if (idle >= _cfg.dimAfterMs) {
            _tier = Tier::Dim;
        } else {
            _tier = Tier::Active;
        }
    }

    _changed = (_tier != previous);
    return _tier;
}

}  // namespace power
