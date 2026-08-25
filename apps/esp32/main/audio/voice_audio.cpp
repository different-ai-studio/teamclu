/*
 * SPDX-License-Identifier: MIT
 */
#include "voice_audio.h"

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <hal/hal.h>
#include <mooncake_log.h>
#include <opus.h>

#include <atomic>
#include <cstring>
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
TaskHandle_t g_playback_task = nullptr;

// One undecoded frame, sized so a slot is a plain value the queue can copy.
// Opus is decoded off this queue, never on the task that fills it — see
// `onSpkFrame`.
struct SpkPacket {
    std::uint16_t len = 0;
    std::uint8_t bytes[kMaxPacket] = {};
};

// ~1.3 s of audio, ~16 kB. Sized from a measurement, not a guess: at 32 slots
// (640 ms) a real reply lost 43 of 433 frames — the sender paces at wall-clock
// speed and this task drains at wall-clock speed, but the link is a phone
// hotspot and MQTT arrives in bursts, so the buffer has to cover a stall plus
// the catch-up that follows it. Created once in `init` rather than per
// turn, so a frame that arrives *before* the `spk_start` ctl has somewhere to
// land instead of being dropped — audio comes off the MQTT task while the ctl
// that arms playback goes through the main loop, so that ordering is not
// guaranteed and used to cost the first syllables.
constexpr std::size_t kSpkQueueDepth = 64;
QueueHandle_t g_spk_queue = nullptr;

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

        // Once per turn, after the first encode — that is the high-water point,
        // and guessing this number is what produced the scheduler corruption
        // above. Reported in bytes of headroom LEFT; a small figure here means
        // the stack above needs raising again.
        static bool reported = false;
        if (!reported) {
            reported = true;
            mclog::tagInfo(kTag, "capture stack headroom: {} bytes",
                           uxTaskGetStackHighWaterMark(nullptr));
        }

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

    mclog::tagInfo(kTag, "capture task done: captured={} published={} dropped={} stack_headroom={}",
                   g_captured.load(), g_published.load(), g_dropped_tx.load(),
                   uxTaskGetStackHighWaterMark(nullptr));
    g_capture_task = nullptr;
    vTaskDelete(nullptr);
}

// Decode + play. Exists so `opus_decode` never runs on the MQTT task.
//
// It used to. `onSpkFrame` decoded inline, the esp-mqtt task's default ~6 kB
// stack could not hold a CELT decode, and the device died the moment a reply
// started:
//
//     [HAL-Audio] codec reopened at 16000 Hz
//     ***ERROR*** A stack overflow in task mqtt_task has been detected.
//
// That reboot also explained everything downstream of it — no audio, the
// device vanishing from the broker mid-turn, and EMQX raising a congestion
// alarm against it (send_pend 8.6 kB) because a rebooting device stops reading
// its socket. One overflow, four symptoms.
//
// Keeping the MQTT task free of decode work matters beyond the stack: 20 ms of
// decode per frame is 20 ms nobody is draining TCP, which pushes back on the
// broker and drops QoS 0 audio. Same division of labour as the uplink, where
// the capture task encodes and MQTT only publishes.
void playbackTask(void*)
{
    mclog::tagInfo(kTag, "playback task up");

    std::vector<int16_t> pcm(kFrameSamples);
    SpkPacket packet;

    while (g_playing.load()) {
        // Timed so the loop notices `endPlayback` even with nothing arriving.
        if (xQueueReceive(g_spk_queue, &packet, pdMS_TO_TICKS(20)) != pdTRUE) {
            continue;
        }
        const int n = opus_decode(g_dec, packet.bytes, packet.len, pcm.data(), kFrameSamples, 0);
        if (n <= 0) {
            g_dropped_rx.fetch_add(1);
            continue;
        }

        // Same reasoning as the capture task: this is the stack high-water
        // point, and the number is worth having before the next overflow
        // rather than after.
        static bool reported = false;
        if (!reported) {
            reported = true;
            mclog::tagInfo(kTag, "playback stack headroom: {} bytes",
                           uxTaskGetStackHighWaterMark(nullptr));
        }

        // `audioWriteStream`, not `audioPlay`: the latter treats every call as
        // a new sound effect that cancels the last one, so 50 frames a second
        // cancel each other and the speaker stays silent — measured as
        // played=809 dropped=0 with nothing audible. Blocking here is correct:
        // back-pressure belongs in this task, where it costs a queued frame,
        // not on the MQTT task where it costs the whole connection.
        if (GetHAL().audioWriteStream(pcm.data(), static_cast<std::size_t>(n))) {
            g_played.fetch_add(1);
        } else {
            g_dropped_rx.fetch_add(1);
        }
    }

    // Push the last real samples out of the DMA with zeros before anyone
    // reconfigures the codec underneath them. Without this the tail of a reply
    // ends in noise: whatever is still in the buffer gets replayed, and then
    // `endPlayback` reopens at 44.1 kHz, so the residue comes out at the wrong
    // rate. This is the same trick `_write` applies after every one-shot sound
    // effect — it just belongs at the end of a *stream*, not after every 20 ms
    // frame, where it would be five parts silence to one part speech.
    //
    // Written here rather than in `endPlayback` because that runs on the main
    // loop, and blocking the UI for the length of the flush to fix an audio
    // artefact is a bad trade. This task is already the place where blocking
    // is free.
    {
        const std::vector<int16_t> silence(kVoiceSampleRate / 20, 0);  // 50 ms
        GetHAL().audioWriteStream(silence.data(), silence.size());
    }

    mclog::tagInfo(kTag, "playback task done: played={} dropped={} stack_headroom={}",
                   g_played.load(), g_dropped_rx.load(),
                   uxTaskGetStackHighWaterMark(nullptr));
    g_playback_task = nullptr;
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

    g_spk_queue = xQueueCreate(kSpkQueueDepth, sizeof(SpkPacket));
    if (g_spk_queue == nullptr) {
        mclog::tagError(kTag, "spk queue create failed");
        opus_encoder_destroy(g_enc);
        opus_decoder_destroy(g_dec);
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
    // Say why, once per attempt. A silent return here is how a device ends up
    // publishing turn_start/turn_end with zero mic frames in between: amuxd
    // opens an STT stream, gets nothing, and reports an empty transcript —
    // with nothing anywhere naming the cause.
    if (g_enc == nullptr) {
        mclog::tagError(kTag, "capture skipped: no Opus encoder (audio::init failed)");
        return;
    }
    if (g_capturing.load()) {
        mclog::tagWarn(kTag, "capture skipped: already capturing");
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
    // 32 KB. `opus_encode` is stack-hungry — CELT builds large arrays on the
    // stack — and this is a MEASURED figure, not a guess: at 24576 the task
    // reported 1248 bytes of headroom left, i.e. ~23 KB actually used. The
    // original 8192 overflowed into the adjacent TCB, and the symptom was not
    // a stack-overflow report but a crash inside the SCHEDULER
    // (prvSelectHighestPriorityTaskSMP reading 0xa5a5a5a5 out of a corrupted
    // ready list) — canary checking only runs at a context switch, by which
    // point the damage is done.
    //
    // The ~9 KB of margin over the measurement is deliberate: encoder stack use
    // varies with content and complexity, and the failure mode is not a clean
    // crash but silent corruption of another task.
    if (xTaskCreate(captureTask, "voice_cap", 32768, nullptr, 5, &g_capture_task) != pdPASS) {
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
    if (g_dec == nullptr || g_spk_queue == nullptr) {
        mclog::tagError(kTag, "playback skipped: no Opus decoder (audio::init failed)");
        return;
    }
    if (g_playing.load()) {
        return;  // spk_start repeated within a turn
    }

    g_played.store(0);
    g_dropped_rx.store(0);
    g_playing.store(true);
    GetHAL().setAudioSampleRate(kVoiceSampleRate);

    // 32 KB, matching the capture task and for the same reason: `opus_decode`
    // builds large arrays on the stack, and the previous arrangement died on
    // esp-mqtt's ~6 kB. Measured headroom is logged on the first frame — if
    // that number gets small, raise this rather than waiting for the overflow.
    if (xTaskCreate(playbackTask, "voice_spk", 32768, nullptr, 5, &g_playback_task) != pdPASS) {
        mclog::tagError(kTag, "playback task create failed");
        g_playing.store(false);
        if (!g_capturing.load()) {
            GetHAL().setAudioSampleRate(kIdleSampleRate);
        }
    }
}

void endPlayback()
{
    if (!g_playing.load()) {
        return;
    }
    g_playing.store(false);
    // The task is parked on a 20 ms queue read, and on the way out it writes a
    // 50 ms silence tail. Wait for both: reconfiguring the codec while that
    // flush is still draining reintroduces exactly the noise it prevents.
    for (int i = 0; i < 60 && g_playback_task != nullptr; ++i) {
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    // Whatever arrived after the sender stopped belongs to a turn that is over.
    // Left queued it would be spoken into the *next* reply.
    if (g_spk_queue != nullptr) {
        xQueueReset(g_spk_queue);
    }
    if (!g_capturing.load()) {
        GetHAL().setAudioSampleRate(kIdleSampleRate);
    }
    mclog::tagInfo(kTag, "playback done: played={} dropped={}", g_played.load(),
                   g_dropped_rx.load());
}

void onSpkFrame(const std::uint8_t* data, std::size_t len)
{
    // Runs on the MQTT task. Everything here is a bounded copy and a
    // non-blocking enqueue — no decode, no I2S, no waiting. See `playbackTask`
    // for what that rule is protecting.
    if (g_spk_queue == nullptr || data == nullptr || len == 0) {
        return;
    }
    if (len > kMaxPacket) {
        // Cannot be a frame this decoder produced; truncating would feed the
        // decoder garbage, so count it and move on.
        g_dropped_rx.fetch_add(1);
        return;
    }

    SpkPacket packet;
    packet.len = static_cast<std::uint16_t>(len);
    std::memcpy(packet.bytes, data, len);

    // Deliberately not gated on `g_playing`: audio arrives here while the
    // `spk_start` that arms playback is still queued for the main loop, and
    // dropping those frames clipped the first syllable of every reply.
    // `endPlayback` resets the queue, so nothing leaks into the next turn.
    if (xQueueSend(g_spk_queue, &packet, 0) != pdTRUE) {
        // Full: playback is not keeping up, or nothing is draining. Counted
        // rather than silent — a drop nobody records is a drop nobody finds.
        g_dropped_rx.fetch_add(1);
    }
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
