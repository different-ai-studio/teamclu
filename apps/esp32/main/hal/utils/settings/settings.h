// https://github.com/78/xiaozhi-esp32/blob/v2.1.0/main/settings.h
#ifndef SETTINGS_H
#define SETTINGS_H

#include <string>
#include <nvs_flash.h>

class Settings {
public:
    Settings(const std::string& ns, bool read_write = false);
    ~Settings();

    std::string GetString(const std::string& key, const std::string& default_value = "");
    void SetString(const std::string& key, const std::string& value);
    int32_t GetInt(const std::string& key, int32_t default_value = 0);
    void SetInt(const std::string& key, int32_t value);
    bool GetBool(const std::string& key, bool default_value = false);
    void SetBool(const std::string& key, bool value);
    esp_err_t GetBlob(const std::string& key, void* value, size_t* length);
    esp_err_t SetBlob(const std::string& key, const void* value, size_t length);
    void EraseKey(const std::string& key);
    void EraseAll();

private:
    std::string ns_;
    nvs_handle_t nvs_handle_ = 0;
    esp_err_t open_result_   = ESP_OK;
    bool read_write_         = false;
    bool dirty_              = false;
};

#endif
