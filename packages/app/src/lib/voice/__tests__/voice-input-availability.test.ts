import { describe, expect, it } from "vitest";
import { isVoiceInputMainDisabled } from "../voice-input-availability";
import { VOICE_MODEL_OPTIONS } from "../voice-models";

describe("isVoiceInputMainDisabled", () => {
  it("allows a device-level model install before a chat exists", () => {
    expect(
      isVoiceInputMainDisabled({
        hasSession: false,
        installed: false,
        installing: false,
        recordingElsewhere: false,
        supported: true,
      }),
    ).toBe(false);
  });

  it("requires a chat only after the model is installed", () => {
    expect(
      isVoiceInputMainDisabled({
        hasSession: false,
        installed: true,
        installing: false,
        recordingElsewhere: false,
        supported: true,
      }),
    ).toBe(true);
  });

  it("stays disabled while installing or unsupported", () => {
    const base = {
      hasSession: true,
      installed: false,
      recordingElsewhere: false,
      supported: true,
    };
    expect(isVoiceInputMainDisabled({ ...base, installing: true })).toBe(true);
    expect(isVoiceInputMainDisabled({ ...base, installing: false, supported: false })).toBe(true);
  });
});

describe("VOICE_MODEL_OPTIONS", () => {
  it("offers the pinned Q8 and F16 downloads with Q8 recommended", () => {
    expect(VOICE_MODEL_OPTIONS).toEqual([
      {
        id: "q8",
        modelBytes: 254_208_320,
        downloadBytes: 284_209_970,
        recommended: true,
      },
      {
        id: "f16",
        modelBytes: 470_197_600,
        downloadBytes: 500_199_250,
        recommended: false,
      },
    ]);
  });
});
