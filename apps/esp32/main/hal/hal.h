/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "utils/button/Button_Class.hpp"
#include <apps/common/common.h>
#include <memory>
#include <cstdint>
#include <string>
#include <lvgl.h>
#include <functional>
#include <smooth_ui_toolkit.hpp>
#include <uitk/short_namespace.hpp>
#include <smooth_lvgl.hpp>
#include <i2c_bus.h>
#include <string_view>
#include <array>
#include <M5GFX.h>

/**
 * @brief
 *
 */
struct AlarmStorageEntry {
    uint8_t hour     = 0;
    uint8_t minute   = 0;
    uint8_t enabled  = 0;
    uint8_t reserved = 0;

    bool isValid() const
    {
        return hour < 24 && minute < 60 && enabled <= 1;
    }
};

/**
 * @brief
 *
 */
struct AlarmStorageSnapshot {
    static constexpr std::size_t maxAlarmCount = 16;

    uint8_t version                                     = 1;
    uint8_t count                                       = 0;
    uint16_t reserved                                   = 0;
    std::array<AlarmStorageEntry, maxAlarmCount> alarms = {};
};

/**
 * @brief
 *
 */
struct TimeHms {
    uint8_t hour   = 0;
    uint8_t minute = 0;
    uint8_t second = 0;

    bool isValid() const
    {
        return hour < 24 && minute < 60 && second < 60;
    }
};

/**
 * @brief
 *
 */
struct DateYmd {
    uint16_t year = 2026;
    uint8_t month = 1;
    uint8_t day   = 1;

    static bool isLeapYear(uint16_t year)
    {
        return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    }

    static uint8_t daysInMonth(uint16_t year, uint8_t month)
    {
        static constexpr uint8_t month_days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        if (month < 1 || month > 12) {
            return 0;
        }
        if (month == 2 && isLeapYear(year)) {
            return 29;
        }
        return month_days[month - 1];
    }

    bool isValid() const
    {
        const uint8_t max_day = daysInMonth(year, month);
        return year >= 2000 && year <= 2099 && max_day != 0 && day >= 1 && day <= max_day;
    }
};

/**
 * @brief
 *
 */
class BootLogo {
public:
    BootLogo()
    {
        _panel = std::make_unique<uitk::lvgl_cpp::Container>(lv_screen_active());
        _panel->setSize(466, 466);
        _panel->setAlign(LV_ALIGN_CENTER);
        _panel->setBorderWidth(0);
        _panel->setBgOpa(0);
        _panel->setPaddingAll(0);
        _panel->setBgColor(lv_color_black());

        _label_logo = std::make_unique<uitk::lvgl_cpp::Label>(_panel->get());
        _label_logo->setTextFont(&lv_font_montserrat_28);
        _label_logo->setTextColor(lv_color_hex(0xFFFFFF));
        _label_logo->align(LV_ALIGN_CENTER, 0, -14);
        _label_logo->setText("StopWatch");

        _label_msg = std::make_unique<uitk::lvgl_cpp::Label>(_panel->get());
        _label_msg->setTextFont(&lv_font_montserrat_16);
        _label_msg->setTextColor(lv_color_hex(0xBFBFBF));
        _label_msg->align(LV_ALIGN_CENTER, 0, 14);
        _label_msg->setText("Starting up ...");

        _label_version = std::make_unique<uitk::lvgl_cpp::Label>(_panel->get());
        _label_version->setTextFont(&lv_font_montserrat_14);
        _label_version->setTextColor(lv_color_hex(0x8B8B8B));
        _label_version->align(LV_ALIGN_BOTTOM_MID, 0, -12);
        _label_version->setText(common::FirmwareVersion);
    }

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_logo;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_msg;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_version;
};

/**
 * @brief
 *
 */
class Hal {
public:
    void init();

    /* --------------------------------- System --------------------------------- */
    void delay(std::uint32_t ms);
    std::uint32_t millis();
    void feedTheDog();
    std::array<uint8_t, 6> getFactoryMac();
    std::string getFactoryMacString(std::string divider = "");
    void reboot();
    void factoryReset();

    /* ---------------------------------- Power --------------------------------- */
    uint8_t getBatteryLevel();
    // Filtered battery voltage in millivolts. Added (not upstream) for power
    // profiling: the M5PM1 has no current sense and no coulomb counter, so
    // drain can only be inferred from voltage decline — and getBatteryLevel()'s
    // 1% steps are ~9 mV, too coarse to show a trend within an hour.
    uint16_t getBatteryMilliVolts();
    bool isBatteryCharging(bool strict = false);

    /* --------------------------------- Display -------------------------------- */
    void setBackLightBrightness(int brightness, bool saveToSettings = false);
    int getBackLightBrightness(bool loadFromSettings = false);

    // M5GFX
    LGFX_Device& getDisplay();
    LGFX_Sprite& getCanvas();
    void updateCanvas();

    // Lvgl
    lv_indev_t* lvTouchpad = nullptr;
    std::unique_ptr<BootLogo> bootLogo;
    bool lvglLock();
    void lvglUnlock();
    void startLvglUpdate();
    void stopLvglUpdate();

    /* ---------------------------------- Touch --------------------------------- */
    struct TouchPoint {
        int num = 0;
        int x   = -1;
        int y   = -1;
    };
    TouchPoint getTouchPoint();

    /* ---------------------------------- Audio --------------------------------- */
    // Boot volume. Full scale until a volume control exists — see the comment
    // at the call site in `_audio_init`.
    static constexpr int kDefaultSpeakerVolume = 100;
    void setSpeakerVolume(int volume, bool saveToSettings = false);
    int getSpeakerVolume(bool loadFromSettings = false);
    int getAudioSampleRate();
    // Reopen the codec at a different rate. Added (not upstream) for voice:
    // the codec is opened at 44.1 kHz for the UI sounds, but Opus does not
    // support that rate at all (only 8/12/16/24/48 kHz), and 44100->16000 is
    // not an integer ratio so it cannot be decimated cheaply. Switching the
    // codec for the duration of a turn is far less work than carrying a
    // resampler, and costs one close/open pair per turn.
    bool setAudioSampleRate(int rate);
    void audioRecord(std::vector<int16_t>& data, uint16_t durationMs, float gain = 30.0f);
    void audioPlay(std::vector<int16_t>& data, bool async = true);
    // Append `count` samples to the running output. Unlike `audioPlay`, this
    // neither interrupts what is playing nor pads with silence — it is the
    // path for continuous audio (voice replies). Blocks until the codec
    // accepts the samples; returns false if the codec is closed.
    bool audioWriteStream(const int16_t* samples, std::size_t count);

    struct AudioSpectrumFrame {
        static constexpr std::size_t bandCount = 20;
        std::array<float, bandCount> bands     = {};
        float peakFrequencyHz                  = 0.0f;
    };
    void updateAudioSpectrum();
    const AudioSpectrumFrame& getAudioSpectrum() const
    {
        return _audio_spectrum;
    }

    void playBootSfx();

    /* ----------------------------- Vibrator Motor ----------------------------- */
    void vibrate(uint16_t durationMs, uint8_t strength = 100);
    void stopVibrate();

    /* ----------------------------------- IMU ---------------------------------- */
    struct ImuData {
        float accelX = 0.0f;
        float accelY = 0.0f;
        float accelZ = 0.0f;
        float gyroX  = 0.0f;
        float gyroY  = 0.0f;
        float gyroZ  = 0.0f;
    };
    void updateImuData();
    const ImuData& getImuData() const
    {
        return _imu_data;
    }

    /* ---------------------------------- Time ---------------------------------- */
    void syncRtcTimeToSystem();
    void syncSystemTimeToRtc();
    DateYmd getDateYmd();
    bool setDateYmd(const DateYmd& date);
    TimeHms getTimeHms();
    bool setTimeHms(const TimeHms& time);
    void setTimezone(std::string_view tz);
    std::string getTimezone();
    bool loadAlarmStorage(AlarmStorageSnapshot& snapshot);
    bool saveAlarmStorage(const AlarmStorageSnapshot& snapshot);
    void startAlarm();
    void stopAlarm();

    /* --------------------------------- Button --------------------------------- */
    m5::Button_Class btnA;
    m5::Button_Class btnB;
    m5::Button_Class btnPwr;

    struct ButtonConfig {
        bool sfxEnabled     = true;
        bool vibrateEnabled = true;
    };

    void updateButtonStates();
    void setButtonConfig(ButtonConfig config, bool saveToSettings = false);
    const ButtonConfig& getButtonConfig(bool loadFromSettings = false);

    // The upstream demo's badge feature (hal_badge.cpp) and its image-upload
    // captive portal (utils/config_ap) were removed: we do not ship badges, and
    // Wi-Fi provisioning comes from the 78/esp-wifi-connect component, not from
    // that portal. See docs/plans/2026-08-24-esp32-voice-terminal.md §6.2.

    /* ---------------------------------- Guide --------------------------------- */
    bool shouldShowGuide();

private:
    static constexpr std::string_view SettingsNs = "system";

    i2c_bus_handle_t _i2c_bus = nullptr;
    ImuData _imu_data;
    ButtonConfig _btn_config;
    AudioSpectrumFrame _audio_spectrum;
    int _bl_brightness = 80;
    int _spk_volume    = 100;

    void i2c_init();
    void i2c_detect();
    void pmic_init();
    bool pmic_get_pwr_btn_state();
    void ioe_init();
    void ioe_tp_reset();
    void ioe_speaker_enable(bool enable);
    void display_init();
    void touchpad_init();
    void lvgl_init();
    void audio_init();
    void imu_init();
    void rtc_init();
    void button_init();
    void fs_init();
};

Hal& GetHAL();

/**
 * @brief
 *
 */
class LvglLockGuard {
public:
    LvglLockGuard()
    {
        GetHAL().lvglLock();
    }
    ~LvglLockGuard()
    {
        GetHAL().lvglUnlock();
    }
};
