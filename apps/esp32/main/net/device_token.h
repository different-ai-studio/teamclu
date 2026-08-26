/*
 * SPDX-License-Identifier: MIT
 *
 * Device pairing + MQTT credentials.
 *
 * Flow (plan §8.1): captive portal stores `pairing_code` -> device redeems code
 * for long-lived `deviceSecret` -> device exchanges `deviceSecret` for short-
 * lived MQTT JWTs and refreshes them before expiry.
 */
#pragma once
#include <cstdint>
#include <string>

namespace net {

struct DeviceIdentity {
    std::string token;    // the raw JWT, used as the MQTT password
    std::string teamId;   // from the token's claims
    std::string actorId;  // from the token's claims
    std::string broker;   // `broker` claim, e.g. "mqtt://host:1883"
    std::int64_t expiresAt = 0;  // `exp`, epoch seconds; 0 when absent

    bool valid() const { return !token.empty() && !teamId.empty() && !actorId.empty(); }
};

// Reads the cached MQTT JWT from NVS and decodes claims used to build topics.
bool loadDeviceIdentity(DeviceIdentity& out);

// True if a long-lived device secret is already stored.
bool hasDeviceSecret();

// Redeem pairing_code -> deviceSecret when needed. Safe to call repeatedly.
bool redeemPairingCodeIfNeeded(const std::string& deviceId);

// Exchange deviceSecret -> short-lived MQTT JWT and persist it in NVS.
bool refreshDeviceToken(const std::string& deviceId, DeviceIdentity& out);

// Should we refresh now (exp absent or inside refresh window)?
bool tokenExpiringSoon(const DeviceIdentity& id, std::int64_t refreshWindowSeconds = 300);

// Forget only the cached MQTT JWT (e.g. broker rejected it).
void clearDeviceToken();

// Wipe all pairing/device credentials (pairing code, device secret, JWT).
void clearDeviceCredentials();

}  // namespace net
