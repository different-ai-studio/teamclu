export type VoiceModelVariant = "q8" | "f16";

export const VOICE_SPEAKER_MODEL_BYTES = 28_281_138;
export const VOICE_SEGMENTER_MODEL_BYTES = 643_854;

export const VOICE_MODEL_OPTIONS = [
  {
    id: "q8",
    modelBytes: 254_208_320,
    downloadBytes: 254_208_320
      + VOICE_SPEAKER_MODEL_BYTES
      + VOICE_SEGMENTER_MODEL_BYTES,
    recommended: true,
  },
  {
    id: "f16",
    modelBytes: 470_197_600,
    downloadBytes: 470_197_600
      + VOICE_SPEAKER_MODEL_BYTES
      + VOICE_SEGMENTER_MODEL_BYTES,
    recommended: false,
  },
] as const satisfies ReadonlyArray<{
  id: VoiceModelVariant;
  modelBytes: number;
  downloadBytes: number;
  recommended: boolean;
}>;
