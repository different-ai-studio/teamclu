/*
 * SPDX-License-Identifier: MIT
 */
#include "voice_audio.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <hal/hal.h>
#include <mooncake_log.h>
#include <opus.h>

#include <atomic>
#include <vector>

#include "../net/mqtt_link.h"

namespace audio {
namespace {

constexpr const char* kTag = "audio";

// 20 ms at 24 kbps is ~60 bytes; 256 leaves room for a VBR peak or a DTX
// transition without ever truncating a frame.
constexpr int kMaxPacket = 256;

OpusEncoder* g_enc = nullptr;
OpusDecoder* g_dec = nullptr;

std::atomic<bool> g_capturing{false};
std::atomic<bool> g_playing{false};
TaskHandle_t g_capture_task = nullptr;

std::atomic<std::uint32_t> g_captured{0};
std::atomic<std::uint32_t> g_published{0};
std::atomic<std::uint32_t> g_dropped_tx{0};
std::atomic<std::uint32_t> g_played{0};
std::atomic<std::uint32_t> g_dropped_rx{0};

void captureTask(void*)
{
    mclog::tagInfo(kTag, "capture task up");

    std::vector<int16_t> pcm;
    std::vector<std::uint8_t> packet(kMaxPacket);

    while (g_capturing.load()) {
        // Blocks until the codec has 20 ms. Because the codec is left open,
        // consecutive reads come off the same running DMA stream and should be
        // contiguous — that is the assumption this whole design rests on, and
        // the first thing to check on hardware if audio sounds chopped.
        GetHAL().audioRecord(pcm, kFrameMs);
        if (pcm.size() < static_cast<std::size_t>(kFrameSamples)) {
            continue;  // short read; codec reconfiguring or an error already logged
        }
        g_captured.fetch_add(1);

        const int n = opus_encode(g_enc, pcm.data(), kFrameSamples, packet.data(), kMaxPacket);
        if (n <= 0) {
            g_dropped_tx.fetch_add(1);
            continue;
        }
        if (net::mqttPublishMic(packet.data(), static_cast<std::size_t>(n))) {
            g_published.fetch_add(1);
        } else {
            // QoS 0 and non-blocking by design: a full outbox drops the frame
            // rather than stalling capture. A retransmitted 20 ms frame would
            // arrive too late to play anyway.
            g_dropped_tx.fetch_add(1);
        }
    }

    mclog::tagInfo(kTag, "capture task done: captured={} published={} dropped={}",
                   g_captured.load(), g_published.load(), g_dropped_tx.load());
    g_capture_task = nullptr;
    vTaskDelete(nullptr);
}

}  // namespace

bool init()
{
    int err = OPUS_OK;
    // VOIP mode: tuned for speech intelligibility over音乐 fidelity, which is
    // the whole job here.
    g_enc = opus_encoder_create(kVoiceSampleRate, 1, OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK || g_enc == nullptr) {
        mclog::tagError(kTag, "opus encoder create failed: {}", err);
        g_enc = nullptr;
        return false;
    }
    opus_encoder_ctl(g_enc, OPUS_SET_BITRATE(kBitrate));
    // Complexity is the CPU/quality dial. 5 is mid-range; this is an S3 with a
    // display and LVGL to feed, so headroom matters more than the last dB.
    opus_encoder_ctl(g_enc, OPUS_SET_COMPLEXITY(5));
    opus_encoder_ctl(g_enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    // Let Opus shrink silence to a few bytes: PTT means the user is holding the
    // button through their own pauses.
    opus_encoder_ctl(g_enc, OPUS_SET_DTX(1));

    g_dec = opus_decoder_create(kVoiceSampleRate, 1, &err);
    if (err != OPUS_OK || g_dec == nullptr) {
        mclog::tagError(kTag, "opus decoder create failed: {}", err);
        opus_encoder_destroy(g_enc);
        g_enc = nullptr;
        g_dec = nullptr;
        return false;
    }

    mclog::tagInfo(kTag, "opus ready: {} Hz mono, {} ms frames, {} bps", kVoiceSampleRate,
                   kFrameMs, kBitrate);
    return true;
}

void startCapture(face::Mode mode)
{
    if (g_enc == nullptr || g_capturing.load()) {
        return;
    }
    if (!GetHAL().setAudioSampleRate(kVoiceSampleRate)) {
        mclog::tagError(kTag, "cannot switch codec to {} Hz; capture skipped", kVoiceSampleRate);
        return;
    }

    g_captured.store(0);
    g_published.store(0);
    g_dropped_tx.store(0);
    g_capturing.store(true);

    // 4 kB: the task holds a 320-sample PCM vector and a 256-byte packet, but
    // opus_encode itself is the real consumer and is not shy with stack.
    if (xTaskCreate(captureTask, "voice_cap", 8192, nullptr, 5, &g_capture_task) != pdPASS) {
        mclog::tagError(kTag, "capture task create failed");
        g_capturing.store(false);
        GetHAL().setAudioSampleRate(kIdleSampleRate);
        return;
    }
    mclog::tagInfo(kTag, "capture started ({})", mode == face::Mode::Chat ? "chat" : "note");
}

void stopCapture()
{
    if (!g_capturing.load()) {
        return;
    }
    g_capturing.store(false);
    // The task is blocked in a 20 ms read; give it a beat to notice and exit
    // before taking the codec out from under it.
    for (int i = 0; i < 20 && g_capture_task != nullptr; ++i) {
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    if (!g_playing.load()) {
        GetHAL().setAudioSampleRate(kIdleSampleRate);
    }
}

bool isCapturing()
{
    return g_capturing.load();
}

void beginPlayback()
{
    if (g_dec == nullptr) {
        return;
    }
    g_playing.store(true);
    GetHAL().setAudioSampleRate(kVoiceSampleRate);
}

void endPlayback()
{
    if (!g_playing.load()) {
        return;
    }
    g_playing.store(false);
    if (!g_capturing.load()) {
        GetHAL().setAudioSampleRate(kIdleSampleRate);
    }
    mclog::tagInfo(kTag, "playback done: played={} dropped={}", g_played.load(),
                   g_dropped_rx.load());
}

void onSpkFrame(const std::uint8_t* data, std::size_t len)
{
    if (g_dec == nullptr || !g_playing.load() || data == nullptr || len == 0) {
        return;
    }
    std::vector<int16_t> pcm(kFrameSamples);
    const int n = opus_decode(g_dec, data, static_cast<opus_int32>(len), pcm.data(), kFrameSamples, 0);
    if (n <= 0) {
        g_dropped_rx.fetch_add(1);
        return;
    }
    pcm.resize(static_cast<std::size_t>(n));
    // async: hands the buffer to the HAL's existing play task rather than
    // blocking the MQTT task on I2S writes.
    GetHAL().audioPlay(pcm, true);
    g_played.fetch_add(1);
}

Stats stats()
{
    Stats s;
    s.framesCaptured = g_captured.load();
    s.framesPublished = g_published.load();
    s.framesDroppedTx = g_dropped_tx.load();
    s.framesPlayed = g_played.load();
    s.framesDroppedRx = g_dropped_rx.load();
    return s;
}

}  // namespace audio
