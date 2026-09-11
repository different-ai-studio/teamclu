import { describe, expect, it } from "vitest";
import { isVoiceInputMainDisabled } from "../voice-input-availability";

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
