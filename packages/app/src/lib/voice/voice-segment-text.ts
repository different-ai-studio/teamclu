import type { VoiceRoute, VoiceSegment } from "./local-voice-input";

const DEFAULT_SPEAKER_LABEL = "speaker_01";

/**
 * Convert the diarizer's cluster id into the stable label shown in chat.
 * FunASR commonly emits zero-based `spk` values; TeamClu's public label is
 * one-based so it reads naturally when copied into a transcript.
 */
export function voiceSpeakerLabel(clusterId?: string | null): string {
  const value = clusterId?.trim();
  if (!value) return DEFAULT_SPEAKER_LABEL;

  const teamcluLabel = /^speaker_(\d+)$/i.exec(value);
  if (teamcluLabel) {
    const number = Number.parseInt(teamcluLabel[1], 10);
    return Number.isSafeInteger(number) && number > 0
      ? `speaker_${String(number).padStart(2, "0")}`
      : DEFAULT_SPEAKER_LABEL;
  }

  const funAsrLabel = /^(?:spk)?(\d+)$/i.exec(value);
  if (funAsrLabel) {
    const zeroBased = Number.parseInt(funAsrLabel[1], 10);
    return Number.isSafeInteger(zeroBased)
      ? `speaker_${String(zeroBased + 1).padStart(2, "0")}`
      : DEFAULT_SPEAKER_LABEL;
  }

  return DEFAULT_SPEAKER_LABEL;
}

/** Prefix anonymous speaker labels only for silent recordings. */
export function voiceSegmentTextForSend(segment: VoiceSegment, route: VoiceRoute): string {
  if (route.mode !== "silent") return segment.text;
  return `${voiceSpeakerLabel(segment.speakerClusterId)}: ${segment.text}`;
}
