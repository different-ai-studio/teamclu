/**
 * Pure arithmetic behind the recording waveform, kept out of the component so
 * it can be tested without pulling React Native's Flow sources into vitest.
 */

import { t } from "../../lib/i18n";

/**
 * Convert `expo-audio`'s decibel metering to the 0…1 level iOS derives.
 *
 * iOS sums the raw buffer's absolute sample values, takes the mean, and scales
 * by 5 (`VoiceRecorder.swift`) — a *linear amplitude*. `expo-audio` reports dBFS
 * instead, so undo the log first (`10^(dB/20)`) and then apply the same ×5, or
 * the bars would sit pinned at either end.
 */
export function normalizeMeteringLevel(decibels: number | undefined): number {
  if (decibels === undefined || Number.isNaN(decibels)) return 0;
  // -160 dBFS is the conventional floor for "silence".
  if (decibels <= -160) return 0;
  const amplitude = Math.pow(10, Math.min(0, decibels) / 20);
  return Math.min(1, Math.max(0, amplitude * 5));
}

/**
 * Convert `expo-speech-recognition`'s `volumechange` value (-2…10, below 0 is
 * inaudible) to the same 0…1 level the waveform takes.
 */
export function normalizeSpeechVolume(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value) || value <= 0) return 0;
  return Math.min(1, value / 10);
}

/**
 * The recognizer language for this device: Chinese for any Chinese locale,
 * otherwise US English. Mirrors iOS, which lets `SFSpeechRecognizer` follow the
 * system language.
 */
export function dictationLanguage(localeTag: string | null | undefined): string {
  return (localeTag ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/**
 * What to tell someone when the recognizer gives up mid-take. The codes are
 * expo-speech-recognition's `error` event (Web Speech API names). Returns an
 * English i18n key; "aborted" is our own cancel and says nothing.
 */
export function speechErrorMessage(code: string | null | undefined): string | null {
  switch (code) {
    case "aborted":
    case "no-speech":
      return null;
    case "not-allowed":
      return "Microphone or speech recognition permission denied.";
    case "language-not-supported":
    case "service-not-allowed":
      return "Speech recognition isn't available on this device right now.";
    case "network":
      return "Speech recognition needs a network connection.";
    case "audio-capture":
    case "interrupted":
      return "Couldn't access microphone.";
    default:
      return "Speech recognition stopped unexpectedly.";
  }
}

/**
 * Words the recognizer should expect — iOS `SessionDetailView`'s
 * `VoiceRecorder(contextualStrings:)`, kept in step.
 */
export const DICTATION_CONTEXTUAL_STRINGS = [
  "Claude", "Claude Code", "Sonnet", "Opus", "Haiku",
  "MQTT", "protobuf", "SwiftUI", "SwiftData",
  "agent", "daemon", "worktree", "workspace",
  "commit", "push", "merge", "pull request",
  "API", "JSON", "YAML", "REST", "gRPC",
];

/**
 * Height of one waveform bar, matching the iOS `RecordingWaveform.barHeight`
 * arithmetic exactly so both apps swing the same amount for the same input:
 * a continuous sine per bar, biased and scaled by the live level, so silence
 * still pulses and loud moments swing wider.
 */
export function waveformBarHeight(args: {
  index: number;
  barCount: number;
  level: number;
  time: number;
}): number {
  const level = Math.min(1, Math.max(0, args.level));
  const phase = (args.index / args.barCount) * Math.PI * 2;
  const wave = Math.sin(args.time * 6 + phase) * 0.4;
  const amplitude = 0.25 + level * 0.6;
  const height = Math.max(0.15, Math.min(1, amplitude + wave * (0.4 + level * 0.6)));
  return 4 + height * 22;
}

export type DaemonConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

/** Mirrors the iOS `DaemonStatusBanner.label`. */
export function daemonStatusLabel(state: DaemonConnectionState): string {
  if (state === "connected") return t("daemon online");
  if (state === "connecting" || state === "reconnecting") return t("daemon connecting");
  return t("daemon offline");
}
