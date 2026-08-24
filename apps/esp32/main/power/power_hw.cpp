/*
 * SPDX-License-Identifier: MIT
 */
#include "power_hw.h"

#include <driver/gpio.h>
#include <esp_sleep.h>
#include <hal/hal.h>
#include <mooncake_log.h>

namespace power {
namespace {

constexpr const char* kTag = "power";

// Both user buttons are inputs with pull-ups and are active LOW
// (hal_button.cpp reads `!gpio_get_level(...)`), so a press is a falling edge
// and the wake level is 0.
constexpr gpio_num_t kBtnA = GPIO_NUM_2;
constexpr gpio_num_t kBtnB = GPIO_NUM_1;

bool g_lvgl_running = true;

}  // namespace

std::uint32_t loopDelayMs(Tier tier)
{
    switch (tier) {
        case Tier::Active:
        case Tier::Dim:
            return 16;  // ~60 fps; animations are LVGL-driven
        case Tier::ScreenOff:
            return 250;  // nothing is being drawn; just poll buttons
        case Tier::LightSleep:
            return 0;  // the sleep call itself provides the delay
    }
    return 16;
}

void applyTier(Tier tier, std::uint8_t userBrightnessPct, std::uint8_t dimBrightnessPct)
{
    mclog::tagInfo(kTag, "tier -> {}", tierName(tier));

    switch (tier) {
        case Tier::Active:
            if (!g_lvgl_running) {
                GetHAL().startLvglUpdate();
                g_lvgl_running = true;
            }
            GetHAL().setBackLightBrightness(userBrightnessPct);
            break;

        case Tier::Dim:
            if (!g_lvgl_running) {
                GetHAL().startLvglUpdate();
                g_lvgl_running = true;
            }
            GetHAL().setBackLightBrightness(
                static_cast<int>(userBrightnessPct) * dimBrightnessPct / 100);
            break;

        case Tier::ScreenOff:
        case Tier::LightSleep:
            // Backlight first, then stop LVGL — the other order leaves a frozen
            // frame lit on an AMOLED for as long as the teardown takes.
            GetHAL().setBackLightBrightness(0);
            if (g_lvgl_running) {
                GetHAL().stopLvglUpdate();
                g_lvgl_running = false;
            }
            break;
    }
}

void lightSleepSlice(std::uint32_t maxMs)
{
    // Wake on either user button going low.
    gpio_wakeup_enable(kBtnA, GPIO_INTR_LOW_LEVEL);
    gpio_wakeup_enable(kBtnB, GPIO_INTR_LOW_LEVEL);
    esp_sleep_enable_gpio_wakeup();

    // ...and always wake on the timer, so the PMIC power button gets polled and
    // a bad GPIO config cannot leave the device unresponsive.
    esp_sleep_enable_timer_wakeup(static_cast<std::uint64_t>(maxMs) * 1000ULL);

    esp_light_sleep_start();

    // Disarm the level-triggered GPIO wakes. Left armed, a held button would
    // re-trigger immediately and spin this loop at full power.
    gpio_wakeup_disable(kBtnA);
    gpio_wakeup_disable(kBtnB);
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_TIMER);
}

}  // namespace power
