/*
 * SPDX-License-Identifier: MIT
 *
 * MQTT transport for the voice topics.
 *
 * Topic layout follows the daemon's own model (crates/teamclu-types/src/mqtt.rs):
 *
 *   amux/{team}/{actor}/voice/mic    device -> amuxd   Opus frames        QoS 0
 *   amux/{team}/{actor}/voice/spk    amuxd -> device   Opus frames        QoS 0
 *   amux/{team}/{actor}/voice/ctl    both              JSON control       QoS 1
 *   amux/{team}/{actor}/voice/state  device -> broker  retained + LWT     QoS 1
 *
 * Audio is QoS 0 on purpose: a retransmitted 20 ms frame arrives too late to
 * play and only adds jitter. Control is QoS 1 because a dropped barge-in flush
 * is exactly the failure that cannot be tolerated (plan §7).
 *
 * NOTE ON THE STATE TOPIC. The daemon's own retained actor state lives at
 * `amux/{team}/{actor}/state`. This deliberately does NOT write there: while
 * the device borrows an existing actor id, publishing to it retained would
 * overwrite a daemon's presence record. Keeping it under `voice/` makes a
 * collision impossible regardless of which actor the token names.
 */
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

#include "device_token.h"

namespace net {

enum class MqttState {
    Idle,        // not started
    Connecting,  // socket/CONNECT in flight, or retrying
    Connected,
    Rejected,    // broker refused the credential — retrying will not help
};

const char* mqttStateName(MqttState s);

// Starts the client and keeps it connected. Safe to call once identity is known.
void mqttStart(const DeviceIdentity& id);
void mqttStop();

MqttState mqttState();

// Incoming audio from the agent. Called on the MQTT task — copy, don't block.
void mqttOnSpk(std::function<void(const std::uint8_t*, std::size_t)> cb);

// Incoming control JSON. Called on the MQTT task.
void mqttOnCtl(std::function<void(const char*, std::size_t)> cb);

// Uplink. Both are no-ops unless connected, and say so via the return value.
bool mqttPublishMic(const std::uint8_t* data, std::size_t len);
bool mqttPublishCtl(const std::string& json);

}  // namespace net
