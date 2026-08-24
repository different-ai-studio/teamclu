/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <memory>
#include <mooncake_log.h>
#include <nvs_flash.h>

static std::unique_ptr<Hal> _hal_instance;
static const std::string_view _tag = "HAL";

Hal& GetHAL()
{
    if (!_hal_instance) {
        mclog::tagInfo(_tag, "creating hal instance");
        _hal_instance = std::make_unique<Hal>();
    }
    return *_hal_instance.get();
}

void Hal::init()
{
    mclog::tagInfo(_tag, "init");

    // Initialize NVS
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    i2c_init();
    pmic_init();
    ioe_init();
    delay(50);
    display_init();
    touchpad_init();
    lvgl_init();
    audio_init();
    imu_init();
    rtc_init();
    button_init();
    fs_init();
}

/* -------------------------------------------------------------------------- */
/*                                   System                                   */
/* -------------------------------------------------------------------------- */
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <esp_mac.h>

void Hal::delay(std::uint32_t ms)
{
    vTaskDelay(pdMS_TO_TICKS(ms));
}

std::uint32_t Hal::millis()
{
    return esp_timer_get_time() / 1000;
}

void Hal::feedTheDog()
{
    vTaskDelay(1);
}

std::array<uint8_t, 6> Hal::getFactoryMac()
{
    std::array<uint8_t, 6> mac;
    esp_efuse_mac_get_default(mac.data());
    return mac;
}

std::string Hal::getFactoryMacString(std::string divider)
{
    auto mac = getFactoryMac();
    return fmt::format("{:02X}{}{:02X}{}{:02X}{}{:02X}{}{:02X}{}{:02X}", mac[0], divider, mac[1], divider, mac[2],
                       divider, mac[3], divider, mac[4], divider, mac[5]);
}

void Hal::reboot()
{
    esp_restart();
}

void Hal::factoryReset()
{
    mclog::tagInfo(_tag, "start factory reset");
    ESP_ERROR_CHECK(nvs_flash_erase());
    reboot();
}

/* -------------------------------------------------------------------------- */
/*                                     I2C                                    */
/* -------------------------------------------------------------------------- */
#include <i2c_bus.h>

#define I2C_SCL_PIN (gpio_num_t)48
#define I2C_SDA_PIN (gpio_num_t)47

void Hal::i2c_init()
{
    mclog::tagInfo(_tag, "i2c init");

    i2c_config_t conf = {
        .mode          = I2C_MODE_MASTER,
        .sda_io_num    = I2C_SDA_PIN,
        .scl_io_num    = I2C_SCL_PIN,
        .sda_pullup_en = true,
        .scl_pullup_en = true,
        .master =
            {
                .clk_speed = 100000,
            },
        .clk_flags = 0,
    };
    _i2c_bus = i2c_bus_create(I2C_NUM_0, &conf);

    i2c_detect();
}

void Hal::i2c_detect()
{
    uint8_t address;
    uint8_t buf[128];
    uint8_t count = i2c_bus_scan(_i2c_bus, buf, 128);

    printf("     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f\r\n");
    for (int i = 0; i < 128; i += 16) {
        printf("%02x: ", i);
        for (int j = 0; j < 16; j++) {
            fflush(stdout);
            address    = i + j;
            bool found = false;
            for (int k = 0; k < count; k++) {
                if (buf[k] == address) {
                    found = true;
                    break;
                }
            }
            if (found) {
                printf("%02x ", address);
            } else {
                printf("-- ");
            }
        }
        printf("\r\n");
    }
}

/* -------------------------------------------------------------------------- */
/*                                    Guide                                   */
/* -------------------------------------------------------------------------- */
#include "utils/settings/settings.h"

namespace {

constexpr const char* _guide_launch_count_key = "launch_count";
constexpr int _guide_show_limit               = 5;

}  // namespace

bool Hal::shouldShowGuide()
{
    Settings settings(std::string(Hal::SettingsNs), true);
    const int launch_count = settings.GetInt(_guide_launch_count_key, 0);
    if (launch_count >= _guide_show_limit) {
        mclog::tagInfo(_tag, "skip guide, launch count: {}", launch_count);
        return false;
    }

    settings.SetInt(_guide_launch_count_key, launch_count + 1);
    mclog::tagInfo(_tag, "show guide, launch count: {} -> {}", launch_count, launch_count + 1);
    return true;
}
