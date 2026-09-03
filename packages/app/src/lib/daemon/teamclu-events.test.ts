import { describe, it, expect } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
  MessageSchema,
  MessageKind,
} from "@/lib/proto/teamclu_pb";
import {
  EnvelopeSchema as AmuxEnvelopeSchema,
  AcpEventSchema,
  AcpOutputSchema,
  AcpThinkingSchema,
} from "@/lib/proto/amux_pb";
import {
  decodeLiveEvent,
  sessionIdFromLiveEvent,
  sessionIdFromTopic,
  streamActorIdFromLiveEvent,
} from "@/lib/daemon/teamclu-events";

describe("decodeLiveEvent", () => {
  it("decodes a message.created event", () => {
    const message = create(MessageSchema, {
      messageId: "m1",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.TEXT,
      content: "hello",
      createdAt: BigInt(1000),
    });
    const sessionMsg = create(SessionMessageEnvelopeSchema, {
      message,
      mentionActorIds: ["a2"],
    });
    const live = create(LiveEventEnvelopeSchema, {
      eventId: "e1",
      eventType: "message.created",
      sessionId: "s1",
      actorId: "a1",
      sentAt: BigInt(1000),
      body: toBinary(SessionMessageEnvelopeSchema, sessionMsg),
    });
    const bytes = toBinary(LiveEventEnvelopeSchema, live);

    const decoded = decodeLiveEvent(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded!.envelope.eventType).toBe("message.created");
    expect(decoded!.message?.content).toBe("hello");
    expect(decoded!.sessionMessage?.mentionActorIds).toEqual(["a2"]);
  });

  it("does not crash on garbage input", () => {
    const decoded = decodeLiveEvent(new Uint8Array([0xff, 0xff, 0xff]));
    expect(decoded === null || decoded!.message === undefined).toBe(true);
  });

  it("normalizes a legacy millisecond message timestamp to seconds", () => {
    const message = create(MessageSchema, {
      messageId: "m-ms",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.TEXT,
      createdAt: BigInt(1_754_058_252_000),
    });
    const live = create(LiveEventEnvelopeSchema, {
      eventType: "message.created",
      sessionId: "s1",
      body: toBinary(
        SessionMessageEnvelopeSchema,
        create(SessionMessageEnvelopeSchema, { message }),
      ),
    });

    expect(decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, live))?.message?.createdAt)
      .toBe(BigInt(1_754_058_252));
  });
});

describe("sessionIdFromTopic", () => {
  it("extracts session id", () => {
    expect(sessionIdFromTopic("amux/team1/session/sess42/live")).toBe("sess42");
  });
  it("does not treat a wildcard subscription token as a session id", () => {
    expect(sessionIdFromTopic("amux/team1/session/+/live")).toBeNull();
  });
  it("returns null for non-session topics", () => {
    expect(sessionIdFromTopic("amux/team1/d1/state")).toBeNull();
  });
});

describe("decodeLiveEvent – acp.event", () => {
  it("decodes acp.event with output variant", () => {
    const output = create(AcpOutputSchema, { text: "hello" });
    const acpEvent = create(AcpEventSchema, {
      event: { case: "output", value: output },
    });
    const amuxEnv = create(AmuxEnvelopeSchema, {
      payload: { case: "acpEvent", value: acpEvent },
    });
    const live = create(LiveEventEnvelopeSchema, {
      eventType: "acp.event",
      sessionId: "s1",
      actorId: "a1",
      body: toBinary(AmuxEnvelopeSchema, amuxEnv),
    });

    const decoded = decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, live));
    expect(decoded).toBeTruthy();
    expect(decoded!.acpEvent).toBeDefined();
    expect(decoded!.amuxEnvelope?.runtimeId).toBe("");
    expect(streamActorIdFromLiveEvent(decoded!)).toBe("a1");
    expect(sessionIdFromLiveEvent(decoded!, "amux/team1/session/+/live")).toBe("s1");
    expect(decoded!.acpEvent!.event.case).toBe("output");
    if (decoded!.acpEvent && decoded!.acpEvent.event.case === "output") {
      expect(decoded!.acpEvent.event.value.text).toBe("hello");
    }
  });

  it("keeps the inner amux envelope so streams can fall back to runtime id", () => {
    const output = create(AcpOutputSchema, { text: "hello" });
    const acpEvent = create(AcpEventSchema, {
      event: { case: "output", value: output },
    });
    const amuxEnv = create(AmuxEnvelopeSchema, {
      runtimeId: "runtime-1",
      payload: { case: "acpEvent", value: acpEvent },
    });
    const live = create(LiveEventEnvelopeSchema, {
      eventType: "acp.event",
      sessionId: "s1",
      actorId: "",
      body: toBinary(AmuxEnvelopeSchema, amuxEnv),
    });

    const decoded = decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, live));
    expect(decoded).toBeTruthy();
    expect(decoded!.acpEvent?.event.case).toBe("output");
    expect(decoded!.amuxEnvelope?.runtimeId).toBe("runtime-1");
    expect(streamActorIdFromLiveEvent(decoded!)).toBe("runtime-1");
  });

  it("decodes acp.event with thinking variant", () => {
    const thinking = create(AcpThinkingSchema, { text: "pondering..." });
    const acpEvent = create(AcpEventSchema, {
      event: { case: "thinking", value: thinking },
    });
    const amuxEnv = create(AmuxEnvelopeSchema, {
      payload: { case: "acpEvent", value: acpEvent },
    });
    const live = create(LiveEventEnvelopeSchema, {
      eventType: "acp.event",
      sessionId: "s1",
      actorId: "a1",
      body: toBinary(AmuxEnvelopeSchema, amuxEnv),
    });

    const decoded = decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, live));
    expect(decoded).toBeTruthy();
    expect(decoded!.acpEvent).toBeDefined();
    expect(decoded!.acpEvent!.event.case).toBe("thinking");
    if (decoded!.acpEvent && decoded!.acpEvent.event.case === "thinking") {
      expect(decoded!.acpEvent.event.value.text).toBe("pondering...");
    }
  });
});
