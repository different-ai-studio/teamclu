/*
 * SPDX-FileCopyrightText: 2025 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include <vector>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <algorithm>
#include <hal/hal.h>
#include <random>

namespace audio {

static std::vector<int> c_major_scale = {60, 62, 64, 65, 67, 69, 71};  // C大调音阶（C D E F G A B）

static float get_effective_volume_scale(float volumeScale)
{
    return std::max(0.0f, volumeScale);
}

void play_tone(int frequency, float durationSec, float volumeScale)
{
    if (GetHAL().getSpeakerVolume() <= 0) {
        return;
    }

    const int sample_rate = GetHAL().getAudioSampleRate();
    const int samples     = static_cast<int>(sample_rate * durationSec);
    std::vector<int16_t> buffer(samples);

    const int fade_len        = 200;
    const float amplitude     = 32767.0f / 5;
    const float scaled_volume = get_effective_volume_scale(volumeScale);

    // Optimization: Use float (sinf) and incremental phase to avoid double precision math and division inside loop
    const float angle_step = 2.0f * (float)M_PI * frequency / sample_rate;
    float current_angle    = 0.0f;

    for (int i = 0; i < samples; ++i) {
        float amp = amplitude * scaled_volume;

        if (i >= samples - fade_len) {
            float fade_factor = static_cast<float>(samples - i) / fade_len;
            amp *= fade_factor;
        }

        // Use sinf instead of sin
        int16_t value = static_cast<int16_t>(amp * sinf(current_angle));
        buffer[i]     = value;

        current_angle += angle_step;
        // Keep angle within reasonable bounds to preserve precision (though for short clips it matters less)
        if (current_angle > 2.0f * (float)M_PI) {
            current_angle -= 2.0f * (float)M_PI;
        }
    }

    GetHAL().audioPlay(buffer);
}

void play_melody(const std::vector<int>& midiList, float durationSec, float volumeScale)
{
    if (GetHAL().getSpeakerVolume() <= 0) {
        return;
    }

    const int sample_rate      = GetHAL().getAudioSampleRate();
    const int samples_per_note = static_cast<int>(sample_rate * durationSec);
    const int fade_len         = 200;  // 每个音符结尾的淡出长度
    const float amplitude      = 32767.0f / 5;
    const float scaled_volume  = get_effective_volume_scale(volumeScale);

    std::vector<int16_t> buffer;  // 大 buffer 存放整首旋律
    buffer.reserve(midiList.size() * samples_per_note);

    for (int midiNote : midiList) {
        float angle_step = 0.0f;
        if (midiNote >= 0) {
            // Optimization: Calculate frequency and step outside the inner loop
            float freq = 440.0f * powf(2.0f, (midiNote - 69) / 12.0f);
            angle_step = 2.0f * (float)M_PI * freq / sample_rate;
        }

        float current_angle = 0.0f;

        for (int i = 0; i < samples_per_note; ++i) {
            float amp = amplitude * scaled_volume;

            // 应用淡出（仅每个音符的结尾）
            if (i >= samples_per_note - fade_len) {
                float fade_factor = static_cast<float>(samples_per_note - i) / fade_len;
                amp *= fade_factor;
            }

            int16_t sample = 0;
            if (midiNote >= 0) {
                sample = static_cast<int16_t>(amp * sinf(current_angle));

                current_angle += angle_step;
                if (current_angle > 2.0f * (float)M_PI) {
                    current_angle -= 2.0f * (float)M_PI;
                }
            }

            buffer.push_back(sample);
        }
    }

    GetHAL().audioPlay(buffer);
}

void play_tone_from_midi(int midi, float durationSec, float volumeScale)
{
    if (GetHAL().getSpeakerVolume() <= 0) {
        return;
    }

    // Optimization: Use float math
    float freq = 440.0f * powf(2.0f, (midi - 69) / 12.0f);
    play_tone(static_cast<int>(freq), durationSec, volumeScale);
}

void play_random_tone(int semitoneShift, float durationSec, float volumeScale)
{
    if (GetHAL().getSpeakerVolume() <= 0) {
        return;
    }

    static std::random_device rd;
    static std::mt19937 gen(rd());
    std::uniform_int_distribution<> dist(0, static_cast<int>(c_major_scale.size()) - 1);

    int index = dist(gen);
    int midi  = c_major_scale[index] + semitoneShift;

    play_tone_from_midi(midi, durationSec, volumeScale);
}

}  // namespace audio
