/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <mooncake_log.h>
#include <bmi270_bmm150.h>

#ifndef BMI2_I2C_PRIM_ADDR
#define BMI2_I2C_PRIM_ADDR 0x68
#endif

static const std::string_view _tag        = "HAL-IMU";
static bmi270_bmm150_handle_t _imu_sensor = NULL;

void Hal::imu_init()
{
    mclog::tagInfo(_tag, "init");

    bmi270_bmm150_config_t sensor_conf = {
        .i2c_addr        = BMI2_I2C_PRIM_ADDR,
        .config_file_ptr = NULL,
        // .mode            = BOSCH_ACCEL_AND_MAGN,
        .mode = BOSCH_ACCELEROMETER_ONLY,
    };

    if (bmi270_bmm150_sensor_create(_i2c_bus, &_imu_sensor, &sensor_conf) != ESP_OK) {
        mclog::tagError(_tag, "init failed");
        _imu_sensor = NULL;
    }
}

void Hal::updateImuData()
{
    if (_imu_sensor != NULL) {
        int available = 0;
        if (bmi270_bmm150_sensor_acceleration_available(_imu_sensor, &available) == ESP_OK && available > 0) {
            bmi270_bmm150_sensor_read_acceleration(_imu_sensor, &_imu_data.accelY, &_imu_data.accelX,
                                                   &_imu_data.accelZ);
        }
        if (bmi270_bmm150_sensor_gyroscope_available(_imu_sensor, &available) == ESP_OK && available > 0) {
            bmi270_bmm150_sensor_read_gyroscope(_imu_sensor, &_imu_data.gyroY, &_imu_data.gyroX, &_imu_data.gyroZ);
        }
    } else {
        mclog::tagError(_tag, "imu invalid");
    }
}
