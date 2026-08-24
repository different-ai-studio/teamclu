/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "rx8130.h"

// RX-8130 Register definitions
#define RX8130_REG_SEC   0x10
#define RX8130_REG_MIN   0x11
#define RX8130_REG_HOUR  0x12
#define RX8130_REG_WDAY  0x13
#define RX8130_REG_MDAY  0x14
#define RX8130_REG_MONTH 0x15
#define RX8130_REG_YEAR  0x16

#define RX8130_REG_ALMIN   0x17
#define RX8130_REG_ALHOUR  0x18
#define RX8130_REG_ALWDAY  0x19
#define RX8130_REG_TCOUNT0 0x1A
#define RX8130_REG_TCOUNT1 0x1B
#define RX8130_REG_EXT     0x1C
#define RX8130_REG_FLAG    0x1D
#define RX8130_REG_CTRL0   0x1E
#define RX8130_REG_CTRL1   0x1F

#define RX8130_REG_END 0x23

// Extension Register (1Ch) bit positions
#define RX8130_BIT_EXT_TSEL (7 << 0)
#define RX8130_BIT_EXT_WADA (1 << 3)
#define RX8130_BIT_EXT_TE   (1 << 4)
#define RX8130_BIT_EXT_USEL (1 << 5)
#define RX8130_BIT_EXT_FSEL (3 << 6)

// Flag Register (1Dh) bit positions
#define RX8130_BIT_FLAG_VLF (1 << 1)
#define RX8130_BIT_FLAG_AF  (1 << 3)
#define RX8130_BIT_FLAG_TF  (1 << 4)
#define RX8130_BIT_FLAG_UF  (1 << 5)

// Control 0 Register (1Еh) bit positions
#define RX8130_BIT_CTRL_TSTP (1 << 2)
#define RX8130_BIT_CTRL_AIE  (1 << 3)
#define RX8130_BIT_CTRL_TIE  (1 << 4)
#define RX8130_BIT_CTRL_UIE  (1 << 5)
#define RX8130_BIT_CTRL_STOP (1 << 6)
#define RX8130_BIT_CTRL_TEST (1 << 7)

static uint8_t bcd2dec(uint8_t val)
{
    return (val >> 4) * 10 + (val & 0x0f);
}

static uint8_t dec2bcd(uint8_t val)
{
    return ((val / 10) << 4) + (val % 10);
}

// Helper function to check if a year is a leap year
static bool isLeapYear(int year)
{
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

// Helper function to get the number of days in a given month
// Note: month is 1-12 for this function
static int getDaysInMonth(int month, int year)
{
    static const int daysInMonth[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};

    if (month == 2 && isLeapYear(year)) {
        return 29;
    }
    return daysInMonth[month - 1];
}

bool RX8130_Class::begin(i2c_bus_handle_t bus_handle, uint8_t i2c_addr)
{
    _addr = i2c_addr;
    if (_i2c_dev) {
        i2c_bus_device_delete(&_i2c_dev);
    }
    _i2c_dev = i2c_bus_device_create(bus_handle, _addr, 0);
    if (_i2c_dev == NULL) {
        return false;
    }
    return true;
}

void RX8130_Class::initBat()
{
    uint8_t data;
    i2c_bus_read_byte(_i2c_dev, RX8130_REG_CTRL1, &data);
    // Enable backup battery charging
    data |= 0b00110000;
    i2c_bus_write_byte(_i2c_dev, RX8130_REG_CTRL1, data);
}

void RX8130_Class::setTime(struct tm *time)
{
    uint8_t rbuf = 0;

    time->tm_year -= 100;

    // set STOP bit before changing clock/calendar
    i2c_bus_read_byte(_i2c_dev, RX8130_REG_CTRL0, &rbuf);
    rbuf = rbuf | RX8130_BIT_CTRL_STOP;
    i2c_bus_write_byte(_i2c_dev, RX8130_REG_CTRL0, rbuf);

    uint8_t date[7] = {dec2bcd(time->tm_sec),       dec2bcd(time->tm_min),  dec2bcd(time->tm_hour),
                       dec2bcd(time->tm_wday),      dec2bcd(time->tm_mday), dec2bcd(time->tm_mon + 1),
                       dec2bcd(time->tm_year % 100)};

    i2c_bus_write_bytes(_i2c_dev, RX8130_REG_SEC, 7, date);

    // clear STOP bit after changing clock/calendar
    i2c_bus_read_byte(_i2c_dev, RX8130_REG_CTRL0, &rbuf);
    rbuf = rbuf & ~RX8130_BIT_CTRL_STOP;
    i2c_bus_write_byte(_i2c_dev, RX8130_REG_CTRL0, rbuf);
}

void RX8130_Class::getTime(struct tm *time)
{
    uint8_t date[7];
    i2c_bus_read_bytes(_i2c_dev, RX8130_REG_SEC, 7, date);

    time->tm_sec  = bcd2dec(date[RX8130_REG_SEC - 0x10] & 0x7f);
    time->tm_min  = bcd2dec(date[RX8130_REG_MIN - 0x10] & 0x7f);
    time->tm_hour = bcd2dec(date[RX8130_REG_HOUR - 0x10] & 0x3f);  // only 24-hour clock
    time->tm_mday = bcd2dec(date[RX8130_REG_MDAY - 0x10] & 0x3f);
    time->tm_year = bcd2dec(date[RX8130_REG_YEAR - 0x10]);
    time->tm_wday = bcd2dec(date[RX8130_REG_WDAY - 0x10] & 0x7f);

    // Read month from RTC (1-12) and convert to tm_mon (0-11)
    int rtc_month = bcd2dec(date[RX8130_REG_MONTH - 0x10] & 0x1f);
    time->tm_mon  = rtc_month - 1;
    time->tm_year += 100;

    // Fix date overflow issues - RX8130 doesn't handle month/day overflow automatically
    // Only correct when we detect actual invalid dates
    bool dateChanged = false;

    // Check for invalid day (day > maximum days in current month)
    int maxDaysInMonth = getDaysInMonth(rtc_month, time->tm_year + 1900);
    if (time->tm_mday > maxDaysInMonth) {
        time->tm_mday = 1;
        rtc_month++;
        if (rtc_month > 12) {
            rtc_month = 1;
            time->tm_year++;
        }
        time->tm_mon = rtc_month - 1;
        dateChanged  = true;
    }

    // Check for invalid month (month > 12 or month < 1)
    else if (rtc_month > 12) {
        rtc_month = 1;
        time->tm_year++;
        time->tm_mon = rtc_month - 1;
        dateChanged  = true;
    } else if (rtc_month < 1) {
        rtc_month = 12;
        time->tm_year--;
        time->tm_mon = rtc_month - 1;
        dateChanged  = true;
    }

    // If we corrected the date, update the RTC to prevent future issues
    if (dateChanged) {
        // Set STOP bit before changing clock/calendar
        uint8_t rbuf;
        i2c_bus_read_byte(_i2c_dev, RX8130_REG_CTRL0, &rbuf);
        rbuf = rbuf | RX8130_BIT_CTRL_STOP;
        i2c_bus_write_byte(_i2c_dev, RX8130_REG_CTRL0, rbuf);

        // Only update date registers, preserve time
        uint8_t dateRegs[4] = {dec2bcd(time->tm_wday), dec2bcd(time->tm_mday), dec2bcd(rtc_month),
                               dec2bcd((time->tm_year - 100) % 100)};
        i2c_bus_write_bytes(_i2c_dev, RX8130_REG_WDAY, 4, dateRegs);

        // Clear STOP bit after changing clock/calendar
        i2c_bus_read_byte(_i2c_dev, RX8130_REG_CTRL0, &rbuf);
        rbuf = rbuf & ~RX8130_BIT_CTRL_STOP;
        i2c_bus_write_byte(_i2c_dev, RX8130_REG_CTRL0, rbuf);
    }
}

void RX8130_Class::clearIrqFlags()
{
    i2c_bus_write_byte(_i2c_dev, RX8130_REG_FLAG, 0);
}

void RX8130_Class::disableIrq()
{
    i2c_bus_write_byte(_i2c_dev, RX8130_REG_CTRL0, 0);
}
