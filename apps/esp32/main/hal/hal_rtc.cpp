/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/settings/settings.h"
#include "drivers/rx8130/rx8130.h"
#include <mooncake_log.h>
#include <memory>
#include <sys/time.h>
#include <ctime>

static const std::string_view _tag = "HAL-RTC";
static std::unique_ptr<RX8130_Class> _rx8130;

namespace {

bool _get_local_time(struct tm& tm_curr)
{
    std::time_t now = std::time(nullptr);
    return localtime_r(&now, &tm_curr) != nullptr;
}

bool _apply_local_time(struct tm& tm_curr)
{
    const std::time_t local_timestamp = std::mktime(&tm_curr);
    if (local_timestamp < 0) {
        mclog::tagError(_tag, "failed to convert local time to timestamp");
        return false;
    }

    struct timeval tv = {
        .tv_sec  = local_timestamp,
        .tv_usec = 0,
    };
    if (settimeofday(&tv, NULL) != 0) {
        mclog::tagError(_tag, "failed to set system time");
        return false;
    }

    GetHAL().syncSystemTimeToRtc();
    return true;
}

}  // namespace

void Hal::rtc_init()
{
    mclog::tagInfo(_tag, "init");

    _rx8130 = std::make_unique<RX8130_Class>();
    if (!_rx8130->begin(_i2c_bus)) {
        _rx8130.reset();
        mclog::tagError(_tag, "init failed");
        return;
    }

    // Load timezone from settings
    std::string tz = getTimezone();
    setenv("TZ", tz.c_str(), 1);
    tzset();
    mclog::tagInfo(_tag, "load timezone from nvs: {}", tz);

    syncRtcTimeToSystem();
}

void Hal::syncRtcTimeToSystem()
{
    if (!_rx8130) {
        return;
    }

    struct tm tm_curr;
    _rx8130->getTime(&tm_curr);

    // Temporarily set TZ to UTC to interpret RTC time as UTC
    std::string current_tz = getenv("TZ") ? getenv("TZ") : "";
    setenv("TZ", "UTC0", 1);
    tzset();

    time_t t = mktime(&tm_curr);

    // Restore original TZ
    if (!current_tz.empty()) {
        setenv("TZ", current_tz.c_str(), 1);
    } else {
        unsetenv("TZ");
    }
    tzset();

    struct timeval tv = {.tv_sec = t, .tv_usec = 0};
    settimeofday(&tv, NULL);
    mclog::tagInfo(_tag, "rtc synced to system (UTC): {:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}",
                   tm_curr.tm_year + 1900, tm_curr.tm_mon + 1, tm_curr.tm_mday, tm_curr.tm_hour, tm_curr.tm_min,
                   tm_curr.tm_sec);
}

void Hal::syncSystemTimeToRtc()
{
    if (!_rx8130) {
        return;
    }

    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tm_curr;
    gmtime_r(&tv.tv_sec, &tm_curr);

    _rx8130->setTime(&tm_curr);

    mclog::tagInfo(_tag, "system synced to rtc (UTC): {:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}",
                   tm_curr.tm_year + 1900, tm_curr.tm_mon + 1, tm_curr.tm_mday, tm_curr.tm_hour, tm_curr.tm_min,
                   tm_curr.tm_sec);
}

void Hal::setTimezone(std::string_view tz)
{
    setenv("TZ", tz.data(), 1);
    tzset();
    Settings settings("system", true);
    settings.SetString("tz", std::string(tz));
    mclog::tagInfo(_tag, "timezone updated to: {}", tz);
}

std::string Hal::getTimezone()
{
    Settings settings("system", false);
    return settings.GetString("tz", "GMT0");
}

DateYmd Hal::getDateYmd()
{
    struct tm tm_curr;
    if (!_get_local_time(tm_curr)) {
        mclog::tagError(_tag, "get date failed");
        return DateYmd{};
    }

    return DateYmd{
        .year  = static_cast<uint16_t>(tm_curr.tm_year + 1900),
        .month = static_cast<uint8_t>(tm_curr.tm_mon + 1),
        .day   = static_cast<uint8_t>(tm_curr.tm_mday),
    };
}

bool Hal::setDateYmd(const DateYmd& date)
{
    if (!date.isValid()) {
        mclog::tagError(_tag, "set date failed, invalid date: {:04d}-{:02d}-{:02d}", date.year, date.month, date.day);
        return false;
    }

    struct tm tm_curr;
    if (!_get_local_time(tm_curr)) {
        mclog::tagError(_tag, "set date failed, current time unavailable");
        return false;
    }

    tm_curr.tm_year  = static_cast<int>(date.year) - 1900;
    tm_curr.tm_mon   = static_cast<int>(date.month) - 1;
    tm_curr.tm_mday  = static_cast<int>(date.day);
    tm_curr.tm_isdst = -1;

    bool ok = _apply_local_time(tm_curr);
    if (ok) {
        mclog::tagInfo(_tag, "date updated to {:04d}-{:02d}-{:02d}", date.year, date.month, date.day);
    }
    return ok;
}

TimeHms Hal::getTimeHms()
{
    struct tm tm_curr;
    if (!_get_local_time(tm_curr)) {
        mclog::tagError(_tag, "get time failed");
        return TimeHms{};
    }

    return TimeHms{
        .hour   = static_cast<uint8_t>(tm_curr.tm_hour),
        .minute = static_cast<uint8_t>(tm_curr.tm_min),
        .second = static_cast<uint8_t>(tm_curr.tm_sec),
    };
}

bool Hal::setTimeHms(const TimeHms& time)
{
    if (!time.isValid()) {
        mclog::tagError(_tag, "set time failed, invalid time: {:02d}:{:02d}:{:02d}", time.hour, time.minute,
                        time.second);
        return false;
    }

    struct tm tm_curr;
    if (!_get_local_time(tm_curr)) {
        mclog::tagError(_tag, "set time failed, current date unavailable");
        return false;
    }

    tm_curr.tm_hour  = static_cast<int>(time.hour);
    tm_curr.tm_min   = static_cast<int>(time.minute);
    tm_curr.tm_sec   = static_cast<int>(time.second);
    tm_curr.tm_isdst = -1;

    bool ok = _apply_local_time(tm_curr);
    if (ok) {
        mclog::tagInfo(_tag, "time updated to {:02d}:{:02d}:{:02d}", time.hour, time.minute, time.second);
    }
    return ok;
}
