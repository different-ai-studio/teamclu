/*
 * SPDX-License-Identifier: MIT
 *
 * Battery telemetry for power profiling.
 *
 * WHY THIS IS VOLTAGE-ONLY: the M5PM1 exposes readVbat/readVin/readTemperature
 * and a generic ADC — no current sense, no coulomb counter. So we cannot
 * measure draw directly. Drain has to be inferred from how fast the pack
 * voltage falls, which imposes a measurement protocol:
 *
 *   - one state at a time, held for 30–60 min (a Li-ion curve is nearly flat
 *     mid-range, so short runs show noise, not signal)
 *   - comparable starting SoC between runs, ideally 80%→60% where the curve is
 *     steepest and most linear
 *   - USB unplugged; charging pins the voltage and hides everything
 *
 * For absolute mA, put a USB power meter inline instead. This is for
 * *relative* cost between states, which is what picks a sleep policy.
 *
 * Output is one CSV line per interval on the serial console, prefixed BATT so
 * tools/battery_watch.py can separate it from the normal log stream.
 */
#pragma once
#include <cstdint>

namespace power {

class BatteryLog {
public:
    // `intervalMs` is the sampling period. The HAL's own reader runs at 1 Hz
    // behind an 8-ish-second IIR filter, so sampling faster than ~5 s only
    // re-reports the same filtered value.
    void init(std::uint32_t intervalMs = 10000);

    // Call every loop; emits at most one line per interval. `state` is a short
    // label for whatever the device is doing, so runs can be sliced by state.
    void tick(std::uint32_t nowMs, const char* state);

private:
    std::uint32_t _intervalMs = 10000;
    std::uint32_t _lastMs = 0;
    bool _headerPrinted = false;
};

}  // namespace power
