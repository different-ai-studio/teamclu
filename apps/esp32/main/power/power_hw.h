/*
 * SPDX-License-Identifier: MIT
 *
 * The hardware half of the sleep policy: turns a Tier into actual brightness,
 * LVGL lifecycle and light-sleep calls. Kept apart from sleep_policy.* so the
 * decision logic stays host-testable.
 */
#pragma once
#include <cstdint>

#include "sleep_policy.h"

namespace power {

// Applies a tier. Call only on a tier change (SleepPolicy::changed()).
void applyTier(Tier tier, std::uint8_t userBrightnessPct, std::uint8_t dimBrightnessPct);

// One slice of light sleep. Blocks until a button edge or the timer fires.
//
// The timer is not a power optimisation, it is a safety net *and* a
// requirement: the power button lives on the PMIC behind I2C with no interrupt
// line to the ESP32 (see hal_pmic.cpp), so the only way to notice it is to wake
// up and look. It also guarantees a mis-configured GPIO wake can never strand
// the device looking dead.
void lightSleepSlice(std::uint32_t maxMs);

// Loop delay appropriate to a tier, in milliseconds.
std::uint32_t loopDelayMs(Tier tier);

}  // namespace power
