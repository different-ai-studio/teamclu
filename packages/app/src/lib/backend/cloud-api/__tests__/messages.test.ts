import { describe, expect, it } from "vitest";
import { createMessagesModule } from "@/lib/backend/cloud-api/messages";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

function mockClient(responses: Record<string, unknown>): CloudApiClient {
  return {
    async get(path) {
      const key = `GET ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path) {
      const key = `PATCH ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected PATCH ${path}`);
    },
    async put() { throw new Error("unexpected put"); },
    async delete() { throw new Error("unexpected delete"); },
    async postRaw() { throw new Error("not impl"); },
    async getRaw() { throw new Error("not impl"); },
  } as unknown as CloudApiClient;
}

const cloudMessage = {
  id: "message-1",
  teamId: "team-1",
  sessionId: "session-1",
  turnId: null,
  senderActorId: "actor-1",
  replyToMessageId: null,
  kind: "text",
  content: "hello",
  metadata: null,
  model: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: null,
};

describe("messages module", () => {
  it("listMessages calls /v1/sessions/:id/messages and maps fields", async () => {
    const client = mockClient({ "GET /v1/sessions/session-1/messages": { items: [cloudMessage], nextCursor: null } });
    const mod = createMessagesModule(client);
    const out = await mod.listMessages("session-1");
    expect(out.rows[0].id).toBe("message-1");
    expect(out.rows[0].team_id).toBe("team-1");
    expect(out.rows[0].sender_actor_id).toBe("actor-1");
    expect(out.nextCursor).toBeNull();
  });

  it("listMessages forwards limit and cursor, and returns nextCursor", async () => {
    const client = mockClient({
      "GET /v1/sessions/session-1/messages?limit=2&cursor=abc": {
        items: [cloudMessage],
        nextCursor: "older-page",
      },
    });
    const mod = createMessagesModule(client);
    const out = await mod.listMessages("session-1", { limit: 2, cursor: "abc" });
    expect(out.rows).toHaveLength(1);
    expect(out.nextCursor).toBe("older-page");
  });

  it("insertOutgoingMessage calls POST and returns mapped message", async () => {
    const client = mockClient({ "POST /v1/sessions/session-1/messages": cloudMessage });
    const mod = createMessagesModule(client);
    const out = await mod.insertOutgoingMessage({
      id: "message-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      content: "hello",
    });
    expect(out.id).toBe("message-1");
  });

  it("updateMessageContent calls PATCH /v1/messages/:id", async () => {
    const client = mockClient({ "PATCH /v1/messages/message-1": cloudMessage });
    const mod = createMessagesModule(client);
    await expect(mod.updateMessageContent("message-1", "updated")).resolves.toBeUndefined();
  });
});
