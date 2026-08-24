/*
 * SPDX-License-Identifier: MIT
 */
#include "device_token.h"

#include <mbedtls/base64.h>
#include <mooncake_log.h>
#include <nvs.h>

#include <cJSON.h>

#include <vector>

namespace net {
namespace {

constexpr const char* kTag = "token";
constexpr const char* kNvsNamespace = "teamclu";
constexpr const char* kNvsTokenKey = "dev_token";  // written by the portal patch

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

}  // namespace

bool loadDeviceIdentity(DeviceIdentity& out)
{
    out = DeviceIdentity{};

    const std::string token = nvsGetString(kNvsTokenKey, 1024);
    if (token.empty()) {
        return false;
    }

    // header.payload.signature — we only want the payload.
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
    const cJSON* exp = cJSON_GetObjectItemCaseSensitive(json, "exp");
    const cJSON* broker = cJSON_GetObjectItemCaseSensitive(json, "broker");

    if (cJSON_IsString(team) && team->valuestring != nullptr) {
        out.teamId = team->valuestring;
    }
    if (cJSON_IsString(actor) && actor->valuestring != nullptr) {
        out.actorId = actor->valuestring;
    }
    if (cJSON_IsString(broker) && broker->valuestring != nullptr) {
        out.broker = broker->valuestring;
    }
    if (cJSON_IsNumber(exp)) {
        out.expiresAt = static_cast<std::int64_t>(exp->valuedouble);
    }
    cJSON_Delete(json);

    out.token = token;

    if (!out.valid()) {
        // A token EMQX would accept but that carries no team/actor is useless to
        // us: we would connect and then have no topics to speak on. Say so
        // clearly rather than failing later at publish time.
        mclog::tagError(kTag, "token lacks team/actor claims; cannot build topics");
        return false;
    }

    mclog::tagInfo(kTag, "identity team={} actor={} broker={} exp={}", out.teamId,
                   out.actorId, out.broker.empty() ? "<none>" : out.broker,
                   static_cast<long long>(out.expiresAt));
    return true;
}

void clearDeviceToken()
{
    nvs_handle_t nvs;
    if (nvs_open(kNvsNamespace, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_erase_key(nvs, kNvsTokenKey);
    nvs_commit(nvs);
    nvs_close(nvs);
    mclog::tagInfo(kTag, "device token cleared");
}

}  // namespace net
