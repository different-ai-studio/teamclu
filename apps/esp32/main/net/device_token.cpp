/*
 * SPDX-License-Identifier: MIT
 */
#include "device_token.h"

#include <mbedtls/base64.h>
#include <mooncake_log.h>
#include <nvs.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>

#include <cJSON.h>

#include <cstring>
#include <ctime>
#include <vector>

namespace net {
namespace {

constexpr const char* kTag = "token";
constexpr const char* kNvsNamespace = "teamclu";
constexpr const char* kNvsPairingCodeKey = "pair_code";   // portal writes this
constexpr const char* kNvsDeviceSecretKey = "dev_secret"; // set by redeem
constexpr const char* kNvsTokenKey = "dev_jwt";           // set by /devices/token
constexpr const char* kApiBase = "https://api.teamclu-dev.ucar.cc";
constexpr const char* kDeviceModel = "m5stack-stopwatch";
constexpr const char* kFirmwareVersion = "0.1.0";

std::string nvsGetString(const char* key, std::size_t maxLen)
{
    nvs_handle_t nvs;
    if (nvs_open(kNvsNamespace, NVS_READONLY, &nvs) != ESP_OK) {
        return {};
    }
    std::size_t len = 0;
    std::string out;
    if (nvs_get_str(nvs, key, nullptr, &len) == ESP_OK && len > 1 && len <= maxLen) {
        out.resize(len);
        if (nvs_get_str(nvs, key, out.data(), &len) == ESP_OK) {
            out.resize(len > 0 ? len - 1 : 0);  // nvs counts the NUL
        } else {
            out.clear();
        }
    }
    nvs_close(nvs);
    return out;
}

bool nvsSetString(const char* key, const std::string& value)
{
    nvs_handle_t nvs;
    if (nvs_open(kNvsNamespace, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }
    const bool ok = nvs_set_str(nvs, key, value.c_str()) == ESP_OK && nvs_commit(nvs) == ESP_OK;
    nvs_close(nvs);
    return ok;
}

void nvsErase(const char* key)
{
    nvs_handle_t nvs;
    if (nvs_open(kNvsNamespace, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_erase_key(nvs, key);
    nvs_commit(nvs);
    nvs_close(nvs);
}

// JWT payloads are base64url without padding; mbedtls wants standard base64
// with padding, so translate before decoding.
bool base64UrlDecode(const std::string& in, std::string& out)
{
    std::string b64;
    b64.reserve(in.size() + 3);
    for (char c : in) {
        if (c == '-') {
            b64 += '+';
        } else if (c == '_') {
            b64 += '/';
        } else {
            b64 += c;
        }
    }
    while (b64.size() % 4 != 0) {
        b64 += '=';
    }

    std::size_t needed = 0;
    // First call reports the required size via the olen out-param.
    mbedtls_base64_decode(nullptr, 0, &needed,
                          reinterpret_cast<const unsigned char*>(b64.data()), b64.size());
    if (needed == 0 || needed > 4096) {
        return false;
    }
    std::vector<unsigned char> buf(needed + 1, 0);
    std::size_t written = 0;
    if (mbedtls_base64_decode(buf.data(), needed, &written,
                              reinterpret_cast<const unsigned char*>(b64.data()),
                              b64.size()) != 0) {
        return false;
    }
    out.assign(reinterpret_cast<char*>(buf.data()), written);
    return true;
}

// Accumulates the response body as it arrives.
//
// `esp_http_client_perform` drains the whole body itself — it loops
// `esp_http_client_get_data` until `content_length` is reached and then clears
// the buffer — so reading with `esp_http_client_read` afterwards always returns
// 0 and the body is gone. That is how redeem and token-mint could log
// "failed status=200": a successful request whose payload was never seen.
// The event handler is the supported way to keep it.
esp_err_t collectBody(esp_http_client_event_t* evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->user_data != nullptr && evt->data_len > 0) {
        auto* out = static_cast<std::string*>(evt->user_data);
        out->append(static_cast<const char*>(evt->data), static_cast<std::size_t>(evt->data_len));
    }
    return ESP_OK;
}

std::string httpPostJson(const std::string& url, const std::string& body, int& statusOut)
{
    std::string out;

    esp_http_client_config_t cfg = {};
    cfg.url = url.c_str();
    cfg.timeout_ms = 10000;
    cfg.transport_type = HTTP_TRANSPORT_OVER_SSL;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.skip_cert_common_name_check = false;
    cfg.event_handler = collectBody;
    cfg.user_data = &out;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == nullptr) {
        statusOut = 0;
        return {};
    }
    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body.c_str(), static_cast<int>(body.size()));

    if (esp_http_client_perform(client) != ESP_OK) {
        esp_http_client_cleanup(client);
        statusOut = 0;
        return {};
    }

    statusOut = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    return out;
}

bool parseIdentityFromToken(const std::string& token, DeviceIdentity& out)
{
    out = DeviceIdentity{};
    const auto first = token.find('.');
    const auto second = token.find('.', first == std::string::npos ? 0 : first + 1);
    if (first == std::string::npos || second == std::string::npos) {
        mclog::tagError(kTag, "stored token is not a JWT");
        return false;
    }

    std::string payload;
    if (!base64UrlDecode(token.substr(first + 1, second - first - 1), payload)) {
        mclog::tagError(kTag, "token payload is not valid base64url");
        return false;
    }

    cJSON* json = cJSON_Parse(payload.c_str());
    if (json == nullptr) {
        mclog::tagError(kTag, "token payload is not JSON");
        return false;
    }

    const cJSON* team = cJSON_GetObjectItemCaseSensitive(json, "team");
    const cJSON* actor = cJSON_GetObjectItemCaseSensitive(json, "actor");
    // Accept snake_case aliases from the Cloud API JWT as well.
    if (!cJSON_IsString(team)) team = cJSON_GetObjectItemCaseSensitive(json, "team_id");
    if (!cJSON_IsString(actor)) actor = cJSON_GetObjectItemCaseSensitive(json, "actor_id");
    const cJSON* exp = cJSON_GetObjectItemCaseSensitive(json, "exp");
    const cJSON* broker = cJSON_GetObjectItemCaseSensitive(json, "broker");

    if (cJSON_IsString(team) && team->valuestring != nullptr) out.teamId = team->valuestring;
    if (cJSON_IsString(actor) && actor->valuestring != nullptr) out.actorId = actor->valuestring;
    if (cJSON_IsString(broker) && broker->valuestring != nullptr) out.broker = broker->valuestring;
    if (cJSON_IsNumber(exp)) out.expiresAt = static_cast<std::int64_t>(exp->valuedouble);
    cJSON_Delete(json);

    out.token = token;
    if (!out.valid()) {
        mclog::tagError(kTag, "token lacks team/actor claims; cannot build topics");
        return false;
    }
    return true;
}

}  // namespace

bool loadDeviceIdentity(DeviceIdentity& out)
{
    const std::string token = nvsGetString(kNvsTokenKey, 1024);
    if (token.empty()) {
        return false;
    }
    const bool ok = parseIdentityFromToken(token, out);
    if (ok) {
        mclog::tagInfo(kTag, "identity team={} actor={} broker={} exp={}", out.teamId,
                       out.actorId, out.broker.empty() ? "<none>" : out.broker,
                       static_cast<long long>(out.expiresAt));
    }
    return ok;
}

bool hasDeviceSecret()
{
    return !nvsGetString(kNvsDeviceSecretKey, 256).empty();
}

bool redeemPairingCodeIfNeeded(const std::string& deviceId)
{
    if (hasDeviceSecret()) return true;
    const std::string pairingCode = nvsGetString(kNvsPairingCodeKey, 128);
    if (pairingCode.empty()) return false;

    const std::string body =
        "{\"code\":\"" + pairingCode + "\",\"deviceId\":\"" + deviceId +
        "\",\"model\":\"" + kDeviceModel + "\",\"fw\":\"" + kFirmwareVersion + "\"}";
    int status = 0;
    const std::string resp = httpPostJson(std::string(kApiBase) + "/v1/devices/redeem", body, status);
    if (status < 200 || status >= 300 || resp.empty()) {
        mclog::tagWarn(kTag, "redeem failed status={}", status);
        return false;
    }
    cJSON* json = cJSON_Parse(resp.c_str());
    if (json == nullptr) return false;
    const cJSON* secret = cJSON_GetObjectItemCaseSensitive(json, "deviceSecret");
    const bool ok = cJSON_IsString(secret) && secret->valuestring != nullptr &&
                    std::strlen(secret->valuestring) >= 32 &&
                    nvsSetString(kNvsDeviceSecretKey, secret->valuestring);
    cJSON_Delete(json);
    if (!ok) return false;

    nvsErase(kNvsPairingCodeKey);
    mclog::tagInfo(kTag, "pairing code redeemed and device secret stored");
    return true;
}

bool refreshDeviceToken(const std::string& deviceId, DeviceIdentity& out)
{
    const std::string secret = nvsGetString(kNvsDeviceSecretKey, 256);
    if (secret.empty()) return false;

    const std::string body =
        "{\"deviceSecret\":\"" + secret + "\",\"deviceId\":\"" + deviceId + "\"}";
    int status = 0;
    const std::string resp = httpPostJson(std::string(kApiBase) + "/v1/devices/token", body, status);
    if (status < 200 || status >= 300 || resp.empty()) {
        mclog::tagWarn(kTag, "token mint failed status={}", status);
        return false;
    }
    cJSON* json = cJSON_Parse(resp.c_str());
    if (json == nullptr) return false;
    const cJSON* token = cJSON_GetObjectItemCaseSensitive(json, "accessToken");
    const bool ok = cJSON_IsString(token) && token->valuestring != nullptr &&
                    nvsSetString(kNvsTokenKey, token->valuestring);
    cJSON_Delete(json);
    if (!ok) return false;

    return loadDeviceIdentity(out);
}

bool tokenExpiringSoon(const DeviceIdentity& id, std::int64_t refreshWindowSeconds)
{
    if (id.expiresAt <= 0) return true;
    const std::int64_t now = static_cast<std::int64_t>(std::time(nullptr));
    return id.expiresAt <= (now + refreshWindowSeconds);
}

void clearDeviceToken()
{
    nvsErase(kNvsTokenKey);
    mclog::tagInfo(kTag, "device token cleared");
}

void clearDeviceCredentials()
{
    nvsErase(kNvsPairingCodeKey);
    nvsErase(kNvsDeviceSecretKey);
    nvsErase(kNvsTokenKey);
    mclog::tagInfo(kTag, "device pairing credentials cleared");
}

}  // namespace net
