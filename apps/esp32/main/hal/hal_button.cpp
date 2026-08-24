/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/settings/settings.h"
#include <apps/common/audio/audio.h>
#include <mooncake_log.h>
#include <driver/gpio.h>
#include <memory>

static const std::string_view _tag = "HAL-BTN";

// USER BUTTON
#define USER_BUTTONA_PIN (gpio_num_t)2
#define USER_BUTTONB_PIN (gpio_num_t)1

void Hal::button_init()
{
    mclog::tagInfo(_tag, "init");

    gpio_reset_pin(USER_BUTTONA_PIN);
    gpio_set_direction(USER_BUTTONA_PIN, GPIO_MODE_INPUT);
    gpio_set_pull_mode(USER_BUTTONA_PIN, GPIO_PULLUP_ONLY);

    gpio_reset_pin(USER_BUTTONB_PIN);
    gpio_set_direction(USER_BUTTONB_PIN, GPIO_MODE_INPUT);
    gpio_set_pull_mode(USER_BUTTONB_PIN, GPIO_PULLUP_ONLY);

    // Load config from settings
    getButtonConfig(true);
}

void Hal::updateButtonStates()
{
    const auto now_ms = millis();
    btnA.setRawState(now_ms, !gpio_get_level(USER_BUTTONA_PIN));
    btnB.setRawState(now_ms, !gpio_get_level(USER_BUTTONB_PIN));

    // The power button hangs off the PMIC and is only readable over I2C — there
    // is no interrupt line to the ESP32. Polling it every frame would put a
    // synchronous I2C transaction in the 60 fps render loop, so rate-limit to
    // ~20 Hz, which is still well inside human press resolution.
    //
    // Upstream had this line commented out because pmic_get_pwr_btn_state() was
    // returning its error code rather than the state; see hal_pmic.cpp.
    static uint32_t _pwr_poll_last_ms = 0;
    constexpr uint32_t _pwr_poll_period_ms = 50;
    if (now_ms - _pwr_poll_last_ms >= _pwr_poll_period_ms) {
        _pwr_poll_last_ms = now_ms;
        btnPwr.setRawState(now_ms, pmic_get_pwr_btn_state());
    }

    auto& config = getButtonConfig();
    if (btnA.wasPressed()) {
        if (config.sfxEnabled) {
            audio::play_tone_from_midi(62 + 32, 0.02);
        }
        if (config.vibrateEnabled) {
            vibrate(20, 60);
        }
    } else if (btnB.wasPressed()) {
        if (config.sfxEnabled) {
            audio::play_tone_from_midi(64 + 32, 0.02);
        }
        if (config.vibrateEnabled) {
            vibrate(20, 60);
        }
    }
}

void Hal::setButtonConfig(ButtonConfig config, bool saveToSettings)
{
    _btn_config = config;
    if (saveToSettings) {
        Settings settings(std::string(Hal::SettingsNs), true);
        settings.SetBool("btn_sfx", config.sfxEnabled);
        settings.SetBool("btn_vibrate", config.vibrateEnabled);
        mclog::tagInfo(_tag, "config saved to settings: sfx={}, vibrate={}", config.sfxEnabled, config.vibrateEnabled);
    }
}

const Hal::ButtonConfig& Hal::getButtonConfig(bool loadFromSettings)
{
    if (loadFromSettings) {
        Settings settings(std::string(Hal::SettingsNs), false);
        _btn_config.sfxEnabled     = settings.GetBool("btn_sfx", true);
        _btn_config.vibrateEnabled = settings.GetBool("btn_vibrate", true);
        mclog::tagInfo(_tag, "config loaded from settings: sfx={}, vibrate={}", _btn_config.sfxEnabled,
                       _btn_config.vibrateEnabled);
    }
    return _btn_config;
}
