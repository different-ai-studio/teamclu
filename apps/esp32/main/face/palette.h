/*
 * SPDX-License-Identifier: MIT
 *
 * Design tokens for the StopWatch face.
 *
 * Source of truth is the Claude Design canvas "Stopwatch Agent 设备交互设计"
 * (StopWatch Agent.dc.html) and its Modernist design system. Values here are
 * transcribed from that canvas at 1:1 — the artboard's device screen is
 * 466x466, which is the panel's native resolution, so every geometry constant
 * is a literal pixel value and needs no scaling.
 *
 * Do not "tidy" these numbers. They are a design artifact, not a computed
 * layout; if the canvas changes, re-transcribe rather than re-derive.
 */
#pragma once
#include <cstdint>

namespace face {

/* ---------------------------------- Color --------------------------------- */
// Modernist palette, restricted to what the device screen actually uses.
// The panel is AMOLED: pure black is genuinely off, so it is the ground.
inline constexpr std::uint32_t ColorBg     = 0x000000;  // screen ground (pixels off)
inline constexpr std::uint32_t ColorAccent = 0xEC3013;  // --color-accent, the "alive" color
inline constexpr std::uint32_t ColorFg     = 0xF3F2F2;  // --color-bg inverted onto the device
inline constexpr std::uint32_t ColorMuted  = 0x9B9797;  // --color-neutral-500
inline constexpr std::uint32_t ColorMid    = 0x7D7979;  // --color-neutral-600
inline constexpr std::uint32_t ColorDim    = 0x605D5D;  // --color-neutral-700
inline constexpr std::uint32_t ColorSleep  = 0x2D2B2B;  // --color-neutral-900, barely-there eyes

/* --------------------------------- Screen --------------------------------- */
inline constexpr int ScreenW = 466;
inline constexpr int ScreenH = 466;

/* ---------------------------------- Eyes ---------------------------------- */
// The face is two eyes plus (sometimes) a mouth. Every state re-uses the same
// two eye slots at the same gap, only changing their shape — that continuity
// is what makes the states read as one character rather than eight screens.
inline constexpr int EyeGap      = 46;  // idle/listen/think/reply/saving
inline constexpr int EyeGapSaved = 44;
inline constexpr int EyeGapSleep = 40;

inline constexpr int EyeIdleW = 34, EyeIdleH = 60;  // tall bar — awake, neutral
inline constexpr int EyeListenW = 34, EyeListenH = 14;  // closed to a line — concentrating
inline constexpr int EyeSquareW = 34, EyeSquareH = 34;  // square — think/reply/saving/wifi
inline constexpr int EyeSavedW = 44, EyeSavedH = 14;    // slanted — the smile
inline constexpr int EyeSleepW = 34, EyeSleepH = 8;     // flat dash — asleep
inline constexpr int EyeSavedTiltDeg = 18;              // ±18°, mirrored per eye

/* --------------------------------- Details -------------------------------- */
inline constexpr int WaveBars = 5, WaveBarW = 16, WaveBarH = 118, WaveBarGap = 11;
inline constexpr int ThinkDots = 3, ThinkDotSize = 18, ThinkDotGap = 14;
inline constexpr int SavingDots = 2, SavingDotSize = 22, SavingDotGap = 12;
inline constexpr int MouthW = 132, MouthH = 26;  // the only mouth; chews while speaking
inline constexpr int SavedBlockSize = 74;

/* -------------------------------- Battery --------------------------------- */
// Not in the design canvas — added on request. Two constraints shaped it:
//
//   * The Modernist system sets every --radius to 0 and the face is strictly
//     rectilinear, so this is a BAR, not the arc a round watch would suggest.
//     An arc would read as a different design language.
//   * The idle screen's three-element column (eyes / clock / quip) is a
//     deliberate composition, so the bar is positioned absolutely against the
//     top of the circle instead of becoming a fourth flex child.
inline constexpr int BattBarW = 120;
inline constexpr int BattBarH = 6;
inline constexpr int BattBarTopY = 62;  // clears the round bezel at 466px
inline constexpr int BattLowPct = 20;   // below this the fill turns accent

/* -------------------------------- Animation ------------------------------- */
// Periods in milliseconds, transcribed from the canvas @keyframes.
inline constexpr int AnimBlinkMs   = 5000;  // eye 1
inline constexpr int AnimBlink2Ms  = 5000;  // eye 2, offset so they blink out of step
inline constexpr int AnimLeanMs    = 6000;  // idle sway, ±4px
inline constexpr int AnimBobMs     = 1100;  // think, -10px
inline constexpr int AnimDriftMs   = 900;   // think dots, +6px
inline constexpr int AnimDriftSaveMs = 800;
inline constexpr int AnimDriftWifiMs = 1600;
inline constexpr int AnimChewMs    = 460;   // mouth, scaleX 1 -> .45
inline constexpr int AnimWaveMs    = 800;   // waveform bar, scaleY .14 -> 1
inline constexpr int AnimWaveStaggerMs = 100;  // per-bar delay
inline constexpr int AnimPopMs     = 450;

inline constexpr int LeanAmplitudePx = 4;
inline constexpr int BobAmplitudePx  = 10;
inline constexpr int DriftAmplitudePx = 6;

}  // namespace face
