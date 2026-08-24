/*
 * SPDX-License-Identifier: MIT
 *
 * Wi-Fi bring-up, wrapping the 78/esp-wifi-connect component.
 *
 * Deliberately thin. That component already owns the hard parts — SoftAP with a
 * captive portal and DNS hijack, AP scanning, multi-network credentials in NVS
 * (SsidManager), station connect with exponential backoff. Re-implementing any
 * of it would be strictly worse.
 *
 * What this adds is the decision the component does not make for us: on boot,
 * provision or connect? And the translation of Wi-Fi events into the face's
 * `Link` vocabulary.
 *
 * NOTE: the M5Stack demo's `hal/utils/config_ap` is NOT this. Despite the name
 * it is a badge-image upload portal and never collects Wi-Fi credentials; it
 * was deleted. See plan §6.2.
 */
#pragma once
#include <cstdint>
#include <string>

#include "../face/face_state.h"

namespace net {

// Called from the Wi-Fi event task, not the main loop. The implementation only
// stores into an atomic, so the main loop can poll it safely.
void start(const std::string& deviceCode);

// Wipe stored Wi-Fi networks and the device token, forcing provisioning on the
// next start(). There is otherwise NO way back: a device holding credentials
// for a network it cannot see retries that network forever and never reopens
// the portal, which makes one mistyped setup unrecoverable without a reflash.
void forgetProvisioning();

// Latest link state. Poll from the main loop and push into FaceState.
face::Link linkState();

// Drive deferred work from the main loop. MUST be called regularly.
//
// Anything heavy triggered by a Wi-Fi event happens here rather than in the
// event callback: that callback runs on the `sys_evt` task, whose stack is
// 2304 bytes by default. Loading the device token (NVS read, base64 decode,
// JSON parse) and starting the MQTT client from there overflowed it and put the
// device in a reboot loop — associate, get an IP, crash, repeat — which looks
// exactly like a flaky network from the outside.
void poll();

// Populated once associated; empty otherwise. For logs and the wifi screen.
std::string ipAddress();
std::string ssid();

// SoftAP SSID while provisioning (e.g. "TeamClu-4F2A"), empty otherwise.
std::string apSsid();

// True when NVS already holds at least one network, i.e. we can skip
// provisioning entirely on this boot.
bool hasSavedCredentials();

// True once a usable device token is stored, i.e. the device knows which
// team/actor it speaks for. See device_token.h.
bool isBound();

}  // namespace net
