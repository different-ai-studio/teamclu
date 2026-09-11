import { describe, expect, it } from "vitest";
import {
  composerPayloadForSend,
  resolveVoiceSendAgent,
  type VoiceSendIntent,
} from "../voice-send-intent";

const agent = { id: "agent-1", displayName: "Agent One" };

describe("voice send intent", () => {
  it("forces silent segments to bypass the engaged agent", () => {
    expect(
      resolveVoiceSendAgent(
        { kind: "voice-silent", segmentId: "segment-1" },
        agent,
      ),
    ).toBeNull();
  });

  it("pins trigger segments to the recording-start agent", () => {
    const pinned = { id: "agent-2", displayName: "Agent Two" };
    const intent: VoiceSendIntent = {
      kind: "voice-trigger",
      segmentId: "segment-2",
      agent: pinned,
    };
    expect(resolveVoiceSendAgent(intent, agent)).toBe(pinned);
  });

  it("does not consume typed attachments for voice segments", () => {
    expect(
      composerPayloadForSend(["draft.pdf"], {
        kind: "voice-silent",
        segmentId: "segment-3",
      }),
    ).toEqual({ files: [], clearComposer: false });
    expect(composerPayloadForSend(["draft.pdf"])).toEqual({
      files: ["draft.pdf"],
      clearComposer: true,
    });
  });
});
