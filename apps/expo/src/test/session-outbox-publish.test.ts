import { describe, expect, it, vi } from "vitest";

import type { OutboxRow } from "../features/sessions/outbox-db";

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    messageId: "msg-1",
    sessionId: "session-1",
    teamId: "team-1",
    senderActorId: "member-1",
    content: "hello",
    mentionActorIds: ["agent-1"],
    replyToMessageId: null,
    attachments: [],
    state: "pending",
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    createdAt: 1_747_642_000_000,
    ...overrides,
  };
}

describe("publishOutboxRowViaOptionalMqtt", () => {
  it("rejects instead of pretending delivery when MQTT is unavailable", async () => {
    const { publishOutboxRowViaOptionalMqtt } = await import(
      "../features/sessions/session-outbox-publish"
    );

    await expect(publishOutboxRowViaOptionalMqtt(row(), null)).rejects.toThrow(
      /mqtt/i,
    );
  });

  it("publishes the row on the session live topic when MQTT is available", async () => {
    const { publishOutboxRowViaOptionalMqtt } = await import(
      "../features/sessions/session-outbox-publish"
    );
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };

    await publishOutboxRowViaOptionalMqtt(row(), mqtt);

    expect(mqtt.publish).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
      expect.any(Uint8Array),
      false,
    );
  });
});

describe("publishOutboxRowViaMqtt reply quote", () => {
  it("carries replyToMessageId so live receivers can render the quote", async () => {
    const { fromBinary } = await import("@bufbuild/protobuf");
    const { LiveEventEnvelopeSchema, SessionMessageEnvelopeSchema } = await import(
      "@teamclu/app/proto/teamclu_pb"
    );
    const { publishOutboxRowViaMqtt } = await import(
      "../features/sessions/session-outbox-publish"
    );
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };

    await publishOutboxRowViaMqtt(row({ replyToMessageId: "quoted-1" }), mqtt);

    const envelope = fromBinary(LiveEventEnvelopeSchema, mqtt.publish.mock.calls[0]![1]);
    const body = fromBinary(SessionMessageEnvelopeSchema, envelope.body);
    expect(body.message?.replyToMessageId).toBe("quoted-1");
  });
});

describe("publishOutboxRowViaMqtt attachments", () => {
  it("hands the agent the files' public URLs", async () => {
    const { fromBinary } = await import("@bufbuild/protobuf");
    const { LiveEventEnvelopeSchema, SessionMessageEnvelopeSchema } = await import(
      "@teamclu/app/proto/teamclu_pb"
    );
    const { publishOutboxRowViaMqtt } = await import(
      "../features/sessions/session-outbox-publish"
    );
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };

    await publishOutboxRowViaMqtt(
      row({ attachments: [{ url: "https://storage.test/attachments/t/s/a.png", path: "t/s/a.png", mime: "image/png" }] }),
      mqtt,
    );

    const live = fromBinary(LiveEventEnvelopeSchema, mqtt.publish.mock.calls[0]?.[1] as Uint8Array);
    const sent = fromBinary(SessionMessageEnvelopeSchema, live.body);
    expect(sent.message?.attachmentUrls).toEqual(["https://storage.test/attachments/t/s/a.png"]);
  });
});
