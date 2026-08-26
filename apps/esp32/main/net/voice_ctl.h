/*
 * SPDX-License-Identifier: MIT
 *
 * Device half of the `voice/ctl` protocol.
 *
 * The wire format is defined by amuxd in apps/daemon/src/voice/ctl.rs; this
 * builds the four messages its router acts on (adapter.rs):
 *
 *   turn_start  → opens an STT stream. Carries the intent and boot_id
 *                 (per-boot random id for amuxd dedup — seq alone resets).
 *   turn_end    → end of utterance; the provider drains a final transcript.
 *   barge_in    → close the stream, expect no final.
 *   error       → same, plus a machine code for the log.
 *
 * INTENT LIVES HERE, NOT ON THE MIC FRAMES. The plan (§7) originally put
 * `intent=chat|note` alongside the Opus payload; amuxd moved it onto
 * `turn_start` so `voice/mic` stays pure Opus bytes and the routing decision
 * (chat→TTS, note→store) is one ctl parse rather than a per-frame check. At
 * 50 frames/s that is the right call, and this follows it.
 */
#pragma once
#include <cstdint>

#include "../face/face_state.h"
#include "ctl_parse.h"

namespace net {

// All four return false when MQTT is not connected — the caller decides
// whether that is worth surfacing. They are cheap and allocation-light, and
// are safe to call from the main loop (never from a Wi-Fi event callback).

bool sendTurnStart(face::Mode mode);
bool sendTurnEnd();
bool sendBargeIn();
bool sendError(const char* code, const char* message);

// Monotonic per-boot counter stamped on every message, for QoS-1 dedup on the
// amuxd side. It resets across a reboot: amuxd keys as
// esp32:{device}:{boot_id}:{seq} so the pair stays unique across reboots.
std::uint64_t ctlSeq();

// Per-boot random id (never 0). Call once when MQTT/net starts; stamped only
// on turn_start (not turn_end / barge_in / error).
void initBootId();
std::uint32_t bootId();

// ---- Incoming (amuxd → device) ----
//
// The MQTT event task calls ctlPushIncoming; the main loop drains via
// ctlPopIncoming and dispatches to FaceState. Same split as net_link's
// g_link atomic: the MQTT callback must not touch the face directly (its task
// stack is small and FaceState is not thread-safe).
void ctlPushIncoming(IncomingCtl ev);
bool ctlPopIncoming(IncomingCtl& out);  // false if empty

}  // namespace net
