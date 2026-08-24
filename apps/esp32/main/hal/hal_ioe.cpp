/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <mooncake_log.h>
#include <driver/gpio.h>
#include <M5IOE1.h>
#include <memory>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mutex>

static const std::string_view _tag = "HAL-IOE";
static std::unique_ptr<M5IOE1> _ioe;

namespace {

constexpr uint8_t _ioe_addr_primary   = 0x4F;
constexpr uint8_t _ioe_addr_secondary = 0x6F;
int _l3b_en_retry_count               = 0;

}  // namespace

// PY32 IO Expander
#define PY32_MOTOR_EN_PIN      M5IOE1_PIN_9   // GPIO_PIN_9 (PA0-IO9): MOTOR ENABLE (PWM)
#define PY32_L3B_EN_PIN        M5IOE1_PIN_8   // GPIO_PIN_8 (PB0-IO8): L3B ENABLE
#define PY32_SPK_PA_PIN        M5IOE1_PIN_10  // GPIO_PIN_10 (PA1-IO10): SPEAKER PA
#define PY32_TP_RST_PIN        M5IOE1_PIN_4   // GPIO_PIN_4 (PA3-IO4): TOUCH RESET
#define PY32_OLED_RST_PIN      M5IOE1_PIN_5   // GPIO_PIN_5 (PA4-IO5): OLED RESET
#define PY32_MUX_CTR_PIN       M5IOE1_PIN_1   // GPIO_PIN_1 (PB5-IO1): CH442E MUX CONTROL
#define PY32_AU_EN_PIN         M5IOE1_PIN_3   // GPIO_PIN_3 (PA1-IO3): AUDIO ENABLE
#define PY32_MOTOR_PWM_CHANNEL 0
#define SPK_PA_PIN             (gpio_num_t)14

void _vibrator_init();

void Hal::ioe_init()
{
    mclog::tagInfo(_tag, "init");

    _ioe                  = std::make_unique<M5IOE1>();
    auto* bus             = i2c_bus_get_internal_bus_handle(_i2c_bus);
    uint8_t selected_addr = _ioe_addr_primary;
    auto ret              = _ioe->begin(bus, _ioe_addr_primary, M5IOE1_I2C_FREQ_400K);

    if (ret != M5IOE1_OK) {
        selected_addr = _ioe_addr_secondary;
        ret           = _ioe->begin(bus, _ioe_addr_secondary, M5IOE1_I2C_FREQ_400K);
    }

    if (ret != M5IOE1_OK) {
        mclog::tagInfo(_tag, "init failed");
        _ioe.reset();
        return;
    }

    mclog::tagInfo(_tag, "init success, addr: 0x{:02X}", selected_addr);

    _ioe->setI2cSleepTime(0);
    _ioe->setI2cSleepTime(0);

    _ioe->pinMode(PY32_MOTOR_EN_PIN, OUTPUT);
    _ioe->pinMode(PY32_L3B_EN_PIN, OUTPUT);
    _ioe->pinMode(PY32_SPK_PA_PIN, OUTPUT);
    _ioe->pinMode(PY32_TP_RST_PIN, OUTPUT);
    _ioe->pinMode(PY32_OLED_RST_PIN, OUTPUT);
    _ioe->pinMode(PY32_MUX_CTR_PIN, OUTPUT);
    _ioe->pinMode(PY32_AU_EN_PIN, OUTPUT);

    _ioe->digitalWrite(PY32_L3B_EN_PIN, 1);
    _ioe->digitalWrite(PY32_TP_RST_PIN, 1);
    _ioe->digitalWrite(PY32_SPK_PA_PIN, 0);
    _ioe->digitalWrite(PY32_OLED_RST_PIN, 1);
    _ioe->digitalWrite(PY32_MUX_CTR_PIN, 0);
    _ioe->digitalWrite(PY32_AU_EN_PIN, 1);

    _ioe->setPwmFrequency(5000);

    gpio_set_direction(SPK_PA_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(SPK_PA_PIN, 0);

    _vibrator_init();

    // Make sure PY32_L3B_EN_PIN is set to HIGH
    while (1) {
        delay(80);
        if (_ioe->digitalRead(PY32_L3B_EN_PIN) == 1) {
            break;
        }
        _ioe->digitalWrite(PY32_L3B_EN_PIN, 1);
        _l3b_en_retry_count++;
        mclog::tagInfo(_tag, "set L3B_EN HIGH, retry count: {}", _l3b_en_retry_count);
    }
}

void Hal::ioe_tp_reset()
{
    mclog::tagInfo(_tag, "touchpad reset");

    _ioe->digitalWrite(PY32_TP_RST_PIN, 0);
    delay(10);
    _ioe->digitalWrite(PY32_TP_RST_PIN, 1);
    delay(50);
}

void Hal::ioe_speaker_enable(bool enable)
{
    mclog::tagInfo(_tag, "set speaker {}", enable ? "enable" : "disable");

    if (enable) {
        _ioe->digitalWrite(PY32_SPK_PA_PIN, 1);
        gpio_set_level(SPK_PA_PIN, 1);
        vTaskDelay(10 / portTICK_PERIOD_MS);
    } else {
        _ioe->digitalWrite(PY32_SPK_PA_PIN, 0);
        gpio_set_level(SPK_PA_PIN, 0);
        vTaskDelay(10 / portTICK_PERIOD_MS);
    }
}

/* -------------------------------------------------------------------------- */
/*                                  Vibrator                                  */
/* -------------------------------------------------------------------------- */
// https://developer.android.com/reference/android/os/Vibrator

static class Vibrator {
public:
    void init()
    {
        xTaskCreate([](void* obj) { static_cast<Vibrator*>(obj)->task(); }, "vibrator", 4 * 1024, this, 5,
                    &_task_handle);
    }

    void vibrate(uint16_t durationMs, uint8_t strength)
    {
        {
            std::lock_guard<std::mutex> lock(_mutex);
            _enable   = true;
            _strength = strength;
            _end_tick = xTaskGetTickCount() + pdMS_TO_TICKS(durationMs);
        }
        if (_task_handle) {
            xTaskNotifyGive(_task_handle);
        }
    }

    void stop()
    {
        {
            std::lock_guard<std::mutex> lock(_mutex);
            _enable = false;
        }
        if (_task_handle) {
            xTaskNotifyGive(_task_handle);
        }
    }

private:
    uint8_t get_duty_cycle(uint8_t strength)
    {
        if (strength == 0) {
            return 0;
        }
        // Clamp strength to 100 as the PWM duty cycle is 0-100
        if (strength > 100) {
            strength = 100;
        }
        // Map strength (1-100) to duty (25-100)
        // 25 is the starting duty cycle
        return 25 + (static_cast<uint32_t>(strength) * (100 - 25)) / 100;
    }

    void task()
    {
        mclog::tagInfo(_tag, "start vibrator task");

        _ioe->setPwmDuty(PY32_MOTOR_PWM_CHANNEL, 0, false, true);
        uint8_t current_strength = 0;

        while (1) {
            TickType_t now          = xTaskGetTickCount();
            TickType_t wait_ticks   = portMAX_DELAY;
            bool should_vibrate     = false;
            uint8_t target_strength = 0;

            {
                std::lock_guard<std::mutex> lock(_mutex);
                if (_enable) {
                    if (now < _end_tick) {
                        wait_ticks      = _end_tick - now;
                        should_vibrate  = true;
                        target_strength = _strength;
                    } else {
                        _enable        = false;
                        should_vibrate = false;
                    }
                }
            }

            if (should_vibrate) {
                if (current_strength != target_strength) {
                    _ioe->setPwmDuty(PY32_MOTOR_PWM_CHANNEL, get_duty_cycle(target_strength), false, true);
                    current_strength = target_strength;
                }
            } else {
                if (current_strength != 0) {
                    _ioe->setPwmDuty(PY32_MOTOR_PWM_CHANNEL, 0, false, true);
                    current_strength = 0;
                }
                wait_ticks = portMAX_DELAY;
            }

            ulTaskNotifyTake(pdTRUE, wait_ticks);
        }
    }

    std::mutex _mutex;
    TaskHandle_t _task_handle = nullptr;
    bool _enable              = false;
    TickType_t _end_tick      = 0;
    uint8_t _strength         = 0;
} _vibrator;

void _vibrator_init()
{
    _vibrator.init();
}

void Hal::vibrate(uint16_t durationMs, uint8_t strength)
{
    _vibrator.vibrate(durationMs, strength);
}

void Hal::stopVibrate()
{
    _vibrator.stop();
}
