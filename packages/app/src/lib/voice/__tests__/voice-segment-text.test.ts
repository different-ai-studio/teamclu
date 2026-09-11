import { describe, expect, it } from "vitest";
import type { VoiceSegment } from "../local-voice-input";
import { voiceSegmentTextForSend, voiceSpeakerLabel } from "../voice-segment-text";

const segment = (speakerClusterId?: string | null): VoiceSegment => ({
  recordingId: "recording-1",
  segmentId: "segment-1",
  text: "我们开始吧。",
  startedAtMs: 0,
  endedAtMs: 1_000,
  speakerClusterId,
});

describe("voice speaker labels", () => {
  it("uses speaker_01 until the diarizer resolves a cluster", () => {
    expect(voiceSpeakerLabel()).toBe("speaker_01");
    expect(voiceSegmentTextForSend(segment(), { mode: "silent" })).toBe(
      "speaker_01: 我们开始吧。",
    );
  });

  it("preserves TeamClu labels and converts zero-based FunASR labels", () => {
    expect(voiceSpeakerLabel("speaker_2")).toBe("speaker_02");
    expect(voiceSpeakerLabel("spk0")).toBe("speaker_01");
    expect(voiceSpeakerLabel("1")).toBe("speaker_02");
  });

  it("never prefixes trigger-mode segments", () => {
    expect(
      voiceSegmentTextForSend(segment("speaker_02"), {
        mode: "trigger",
        agent: { id: "agent-1", displayName: "Agent One" },
      }),
    ).toBe("我们开始吧。");
  });
});
