/*
 * SPDX-License-Identifier: MIT
 *
 * Voice audio: mic → Opus → `voice/mic`, and `voice/spk` → Opus → speaker.
 *
 * ## The sample-rate problem, and why a turn reopens the codec
 *
 * The board's ES8311 is opened at 44.1 kHz for the UI sounds. Opus does not
 * support 44.1 kHz at all — only 8/12/16/24/48 kHz — and 44100→16000 is not an
 * integer ratio, so it cannot be decimated with a cheap FIR. Rather than carry
 * a resampler, a voice turn reopens the codec at 16 kHz (the rate plan §1
 * pins) and restores 44.1 kHz when the turn ends. The cost is one close/open
 * pair per turn; the alternative is a resampler on the audio hot path.
 *
 * ## Threading
 *
 * Capture runs on its own task, not the main loop: `esp_codec_dev_read` blocks
 * until the DMA has the samples, and blocking the main loop would freeze the
 * face and the sleep policy for the duration of a turn. Playback decodes on
 * the MQTT task but hands PCM to the HAL's existing async play task.
 *
 * ## What is NOT verified
 *
 * None of this has run on hardware — it was written while the device was
 * unavailable. Specifically unproven: whether back-to-back 20 ms
 * `esp_codec_dev_read` calls are gap-free in practice (they should be, since
 * the codec stays open and DMA buffers between calls), the CPU headroom of
 * Opus encode at 16 kHz on this part, and whether the codec tolerates
 * close/open per turn without an audible click.
 */
#pragma once
#include <cstddef>
#include <cstdint>

#include "../face/face_state.h"

namespace audio {

// Wire format, fixed by plan §1 and by what amuxd's decoder will expect.
inline constexpr int kVoiceSampleRate = 16000;
inline constexpr int kFrameMs = 20;
inline constexpr int kFrameSamples = kVoiceSampleRate * kFrameMs / 1000;  // 320
inline constexpr int kBitrate = 24000;
inline constexpr int kIdleSampleRate = 44100;  // what the UI sounds want

// One-time setup. Allocates the Opus encoder/decoder. Safe to call before the
// network is up; returns false if either codec could not be created, in which
// case capture/playback become no-ops rather than crashing.
bool init();

// PTT pressed / released. startCapture spawns the capture task; stopCapture
// asks it to finish the frame in flight and exit.
void startCapture(face::Mode mode);
void stopCapture();
bool isCapturing();

// An Opus frame from `voice/spk`. Called on the MQTT task — decodes and queues
// for the HAL's play task. Dropped silently when playback is not active.
void onSpkFrame(const std::uint8_t* data, std::size_t len);

// Reply started / finished, from the ctl channel. Brackets the period in which
// spk frames are accepted and the codec is held at the voice rate.
void beginPlayback();
void endPlayback();

// Counters, for the log line at the end of a turn — the cheapest way to see
// whether frames are actually flowing without a scope.
struct Stats {
    std::uint32_t framesCaptured = 0;
    std::uint32_t framesPublished = 0;
    std::uint32_t framesDroppedTx = 0;  // publish refused (link down / queue full)
    std::uint32_t framesPlayed = 0;
    std::uint32_t framesDroppedRx = 0;  // decode failed
};
Stats stats();

}  // namespace audio
