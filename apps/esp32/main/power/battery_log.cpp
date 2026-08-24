/*
 * SPDX-License-Identifier: MIT
 */
#include "battery_log.h"

#include <hal/hal.h>

#include <cstdio>

namespace power {

void BatteryLog::init(std::uint32_t intervalMs)
{
    _intervalMs = intervalMs == 0 ? 10000 : intervalMs;
    _lastMs = 0;
    _headerPrinted = false;
}

void BatteryLog::tick(std::uint32_t nowMs, const char* state)
{
    // First call emits immediately so a run always has a t=0 baseline.
    if (_headerPrinted && (nowMs - _lastMs) < _intervalMs) {
        return;
    }

    if (!_headerPrinted) {
        // Deliberately printf and not the logger: the logger prefixes every
        // line with a timestamp and tag, which the host parser would have to
        // strip. A bare line keeps the CSV contract simple.
        std::printf("BATT,ms,mv,pct,charging,state\n");
        _headerPrinted = true;
    }
    _lastMs = nowMs;

    const std::uint16_t mv = GetHAL().getBatteryMilliVolts();
    const std::uint8_t pct = GetHAL().getBatteryLevel();
    const bool charging = GetHAL().isBatteryCharging();

    std::printf("BATT,%lu,%u,%u,%d,%s\n", static_cast<unsigned long>(nowMs),
                static_cast<unsigned>(mv), static_cast<unsigned>(pct), charging ? 1 : 0,
                state == nullptr ? "?" : state);
}

}  // namespace power
