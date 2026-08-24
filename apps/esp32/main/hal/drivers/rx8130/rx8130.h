/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "i2c_bus.h"
#include <time.h>

class RX8130_Class {
public:
    RX8130_Class() {};

    bool begin(i2c_bus_handle_t bus_handle, uint8_t i2c_addr = 0x32);

    void initBat();
    void setTime(struct tm *time);
    void getTime(struct tm *time);
    void clearIrqFlags();
    void disableIrq();

private:
    i2c_bus_device_handle_t _i2c_dev = nullptr;
    uint8_t _addr;
};
