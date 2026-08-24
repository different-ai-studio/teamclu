/*
 * SPDX-License-Identifier: MIT
 *
 * The device's MQTT credential.
 *
 * WHY THIS IS A PASTED TOKEN AND NOT A PAIRING HANDSHAKE
 *
 * The full design (plan §8.1) has amuxd mint a single-use pairing code that the
 * device redeems with FC for a device secret, which it then exchanges for
 * short-lived MQTT JWTs. That is the right shape for a fleet, and it costs a
 * migration, three FC endpoints, a desktop surface, plus HTTPS, a TLS root
 * bundle and a refresh loop on the device.
 *
 * None of that reduces the project's actual open risk, which plan §9 states
 * plainly: the ~600–1100 ms latency budget has never been measured. So the
 * device instead takes a long-lived JWT pasted into the provisioning portal.
 * It keeps the shape that matters — the device is *configured*, not compiled
 * with credentials — so the real handshake can replace this later without the
 * portal or the firmware changing shape.
 *
 * The trade, stated plainly: a leaked token is valid until it expires, and
 * there is no per-device revocation. Revoking means rotating the signing
 * secret, which invalidates every device at once. Acceptable for one device on
 * a bench; not acceptable for anything shipped.
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

// Reads the token stashed in NVS by the provisioning portal and decodes the
// claims the topic namespace needs.
//
// The signature is deliberately NOT verified here. The device has no business
// validating a token it merely carries — EMQX is the party that verifies it,
// and duplicating that check on-device would only add a place for the two to
// disagree. We decode the payload purely to learn which topics to use.
bool loadDeviceIdentity(DeviceIdentity& out);

// Forget the credential (e.g. the broker rejected it as expired).
void clearDeviceToken();

}  // namespace net
