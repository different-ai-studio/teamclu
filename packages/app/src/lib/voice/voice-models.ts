export type VoiceModelVariant = "q8" | "f16";

export const VOICE_MODEL_OPTIONS = [
  { id: "q8", modelBytes: 254_208_320, recommended: true },
  { id: "f16", modelBytes: 470_197_600, recommended: false },
] as const satisfies ReadonlyArray<{
  id: VoiceModelVariant;
  modelBytes: number;
  recommended: boolean;
}>;
