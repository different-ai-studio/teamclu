#include "cst820.h"
#include <esp_log.h>
#include <cstring>

static const char* TAG = "CST820";

Cst820::Cst820()
{
}

Cst820::~Cst820()
{
    if (_i2c_dev) {
        i2c_master_bus_rm_device(_i2c_dev);
    }
}

bool Cst820::begin(i2c_master_bus_handle_t bus_handle, uint8_t addr)
{
    _addr = addr;

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = _addr,
        .scl_speed_hz    = 100000,  // Original driver used 100kHz
    };

    esp_err_t ret = i2c_master_bus_add_device(bus_handle, &dev_cfg, &_i2c_dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to add device to I2C bus");
        return false;
    }

    if (!check_communication()) {
        ESP_LOGE(TAG, "Failed to communicate with CST820");
        return false;
    }

    return true;
}

bool Cst820::check_communication()
{
    if (!read_register(REG_CHIP_ID, &_chip_id, 1)) return false;
    if (!read_register(REG_SOFT_VER, &_soft_ver, 1)) return false;

    ESP_LOGI(TAG, "Chip ID: 0x%02x, Soft Ver: 0x%02x", _chip_id, _soft_ver);

    // Basic check: non-zero values usually indicate valid read
    return (_chip_id != 0 && _soft_ver != 0);
}

bool Cst820::read()
{
    uint8_t buf[7];  // Reading from REG_STATUS (0x00) for 7 bytes (up to 0x06 y_l)

    if (!read_register(REG_STATUS, buf, 7)) {
        return false;
    }

    // buf[0] = Status, buf[1] = Gesture, buf[2] = Finger Num
    // buf[3] = X_H, buf[4] = X_L
    // buf[5] = Y_H, buf[6] = Y_L

    _finger_num        = buf[2];
    uint8_t status_raw = buf[3] & 0xC0;  // High bits of X_H might contain status info in some variants,
                                         // but original code used:
    // cst820_status = (i2c_buf[3] & 0xC0) >> 6;
    // cst820_x = ((uint16_t)(i2c_buf[3] & 0x0F) << 8) | i2c_buf[4];

    uint8_t event_status = (buf[3] & 0xC0) >> 6;

    // Update coordinates
    _x = ((uint16_t)(buf[3] & 0x0F) << 8) | buf[4];
    _y = ((uint16_t)(buf[5] & 0x0F) << 8) | buf[6];

    // Determine pressed state
    // 0: Down, 1: Up, 2: Contact
    // If finger_num > 0 and status is Down or Contact
    if (_finger_num > 0 && (event_status == 0 || event_status == 2)) {
        _pressed = true;
    } else {
        _pressed = false;
    }

    return true;
}

void Cst820::sleep()
{
    uint8_t cmd[] = {0x03};  // Enter sleep command value
    // Original: i2c_bus_write_bytes(cst820_dev, 0xE5, 1, i2c_buf);
    // Writes value 0x03 to register 0xE5

    // In i2c_master_transmit, we send [RegAddr, Data]
    uint8_t write_buf[2] = {REG_SLEEP, 0x03};
    i2c_master_transmit(_i2c_dev, write_buf, sizeof(write_buf), -1);
}

bool Cst820::read_register(uint8_t reg, uint8_t* data, size_t len)
{
    return i2c_master_transmit_receive(_i2c_dev, &reg, 1, data, len, -1) == ESP_OK;
}

bool Cst820::write_register(uint8_t reg, uint8_t data)
{
    uint8_t write_buf[2] = {reg, data};
    return i2c_master_transmit(_i2c_dev, write_buf, sizeof(write_buf), -1) == ESP_OK;
}
