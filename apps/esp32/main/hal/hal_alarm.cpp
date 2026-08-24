/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/settings/settings.h"
#include <apps/common/audio/audio.h>
#include <algorithm>
#include <cstring>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mooncake_log.h>
#include <memory>
#include <mutex>
#include <vector>

static const std::string_view _tag = "HAL-Alarm";

namespace {

constexpr const char* _alarm_settings_namespace = "alarm";
constexpr const char* _alarm_storage_key        = "storage";
constexpr uint8_t _alarm_storage_version        = 1;
constexpr std::size_t _alarm_beep_count         = 4;
constexpr TickType_t _alarm_beep_interval       = pdMS_TO_TICKS(180);
constexpr TickType_t _alarm_cycle_interval      = pdMS_TO_TICKS(720);
constexpr uint16_t _alarm_vibrate_duration_ms   = 70;
constexpr uint8_t _alarm_vibrate_strength       = 90;
constexpr int _alarm_tone_frequency_hz          = 1760;
constexpr float _alarm_tone_duration_sec        = 0.07f;

AlarmStorageSnapshot make_default_snapshot()
{
    AlarmStorageSnapshot snapshot;
    snapshot.version  = _alarm_storage_version;
    snapshot.count    = 0;
    snapshot.reserved = 0;
    snapshot.alarms.fill({});
    return snapshot;
}

AlarmStorageSnapshot sanitize_snapshot(const AlarmStorageSnapshot& source, bool& changed)
{
    AlarmStorageSnapshot sanitized = make_default_snapshot();

    if (source.version != _alarm_storage_version) {
        changed = true;
        mclog::tagWarn(_tag, "unsupported alarm storage version: {}", source.version);
        return sanitized;
    }

    changed = changed || source.reserved != 0;

    const std::size_t input_count = std::min<std::size_t>(source.count, AlarmStorageSnapshot::maxAlarmCount);
    changed                       = changed || input_count != source.count;

    for (std::size_t index = 0; index < input_count; ++index) {
        const auto& entry = source.alarms[index];
        if (!entry.isValid()) {
            changed = true;
            mclog::tagWarn(_tag, "drop invalid alarm storage entry {}, hour={}, minute={}, enabled={}", index,
                           entry.hour, entry.minute, entry.enabled);
            continue;
        }

        auto& out    = sanitized.alarms[sanitized.count++];
        out.hour     = entry.hour;
        out.minute   = entry.minute;
        out.enabled  = entry.enabled != 0 ? 1 : 0;
        out.reserved = 0;

        changed = changed || entry.reserved != 0;
    }

    return sanitized;
}

class AlarmController {
public:
    void start()
    {
        ensureTask();

        bool already_active = false;
        {
            std::lock_guard<std::mutex> lock(_mutex);
            already_active = _active;
            _active        = true;
        }

        if (_task_handle != nullptr) {
            xTaskNotifyGive(_task_handle);
        }

        if (already_active) {
            mclog::tagInfo(_tag, "alarm already active");
            return;
        }

        mclog::tagInfo(_tag, "alarm started");
    }

    void stop()
    {
        ensureTask();

        bool was_active = false;
        {
            std::lock_guard<std::mutex> lock(_mutex);
            was_active = _active;
            _active    = false;
        }

        GetHAL().stopVibrate();
        std::vector<int16_t> empty_audio;
        GetHAL().audioPlay(empty_audio, true);

        if (_task_handle != nullptr) {
            xTaskNotifyGive(_task_handle);
        }

        if (was_active) {
            mclog::tagInfo(_tag, "alarm stopped");
        }
    }

private:
    void ensureTask()
    {
        std::lock_guard<std::mutex> lock(_mutex);
        if (_task_handle != nullptr) {
            return;
        }

        BaseType_t result = xTaskCreate([](void* context) { static_cast<AlarmController*>(context)->task(); },
                                        "alarm_task", 4 * 1024, this, 5, &_task_handle);
        if (result != pdPASS) {
            _task_handle = nullptr;
            mclog::tagError(_tag, "failed to create alarm task");
        }
    }

    void task()
    {
        mclog::tagInfo(_tag, "start alarm task");
        std::size_t beep_index = 0;

        while (true) {
            bool active = false;
            {
                std::lock_guard<std::mutex> lock(_mutex);
                active = _active;
            }

            if (!active) {
                beep_index = 0;
                ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
                continue;
            }

            audio::play_tone(_alarm_tone_frequency_hz, _alarm_tone_duration_sec);
            GetHAL().vibrate(_alarm_vibrate_duration_ms, _alarm_vibrate_strength);

            beep_index = (beep_index + 1) % _alarm_beep_count;

            const TickType_t wait_ticks = (beep_index == 0) ? _alarm_cycle_interval : _alarm_beep_interval;
            ulTaskNotifyTake(pdTRUE, wait_ticks);
        }
    }

    std::mutex _mutex;
    TaskHandle_t _task_handle = nullptr;
    bool _active              = false;
};

AlarmController& get_alarm_controller()
{
    static AlarmController controller;
    return controller;
}

}  // namespace

bool Hal::loadAlarmStorage(AlarmStorageSnapshot& snapshot)
{
    snapshot = make_default_snapshot();

    Settings settings(_alarm_settings_namespace);
    size_t blob_size = 0;
    esp_err_t ret    = settings.GetBlob(_alarm_storage_key, nullptr, &blob_size);
    if (ret == ESP_ERR_NVS_NOT_FOUND) {
        mclog::tagInfo(_tag, "alarm storage missing, using defaults");
        return true;
    }

    if (ret != ESP_OK) {
        mclog::tagError(_tag, "failed to query alarm storage blob: {}", esp_err_to_name(ret));
        return false;
    }

    if (blob_size != sizeof(AlarmStorageSnapshot)) {
        mclog::tagWarn(_tag, "invalid alarm storage size: {}, expected: {}", blob_size, sizeof(AlarmStorageSnapshot));
        return true;
    }

    AlarmStorageSnapshot raw_snapshot;
    blob_size = sizeof(raw_snapshot);
    ret       = settings.GetBlob(_alarm_storage_key, &raw_snapshot, &blob_size);
    if (ret != ESP_OK) {
        mclog::tagError(_tag, "failed to read alarm storage blob: {}", esp_err_to_name(ret));
        return false;
    }

    bool repaired = false;
    snapshot      = sanitize_snapshot(raw_snapshot, repaired);
    if (repaired) {
        mclog::tagWarn(_tag, "alarm storage repaired during load, count: {}", snapshot.count);
    }

    return true;
}

bool Hal::saveAlarmStorage(const AlarmStorageSnapshot& snapshot)
{
    bool changed                   = false;
    AlarmStorageSnapshot sanitized = sanitize_snapshot(snapshot, changed);
    Settings settings(_alarm_settings_namespace, true);
    const esp_err_t ret = settings.SetBlob(_alarm_storage_key, &sanitized, sizeof(sanitized));
    if (ret != ESP_OK) {
        mclog::tagError(_tag, "failed to write alarm storage blob: {}", esp_err_to_name(ret));
        return false;
    }

    if (changed) {
        mclog::tagWarn(_tag, "alarm storage sanitized before save, count: {}", sanitized.count);
    }

    return true;
}

void Hal::startAlarm()
{
    get_alarm_controller().start();
}

void Hal::stopAlarm()
{
    get_alarm_controller().stop();
}
