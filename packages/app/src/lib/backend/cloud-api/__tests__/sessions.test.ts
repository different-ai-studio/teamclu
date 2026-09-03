import { describe, expect, it } from "vitest";
import { createSessionsModule } from "@/lib/backend/cloud-api/sessions";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

function mockClient(responses: Record<string, unknown>): CloudApiClient {
  return {
    async get(path) {
      const key = Object.keys(responses).find((k) => k === `GET ${path}` || (k.startsWith("GET ") && path.startsWith(k.replace("GET ", ""))));
      if (key) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, _body) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch() { throw new Error("unexpected patch"); },
    async put() { throw new Error("unexpected put"); },
    async delete() { throw new Error("unexpected delete"); },
    async postRaw() { throw new Error("not impl"); },
    async getRaw() { throw new Error("not impl"); },
  } as unknown as CloudApiClient;
}

const cloudSession = {
  id: "session-1",
  teamId: "team-1",
  title: "Plan",
  mode: "collab",
  ideaId: null,
  lastMessageAt: "2026-05-01T00:00:00Z",
  lastMessagePreview: "hello",
  hasUnread: true,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T01:00:00Z",
};

describe("sessions module", () => {
  it("listCurrentActorSessions calls /v1/sessions and maps fields", async () => {
    const client = mockClient({ "GET /v1/sessions?limit=50&teamId=team-1&kind=all": { items: [cloudSession], nextCursor: "cursor-1" } });
    const mod = createSessionsModule(client);
    const out = await mod.listCurrentActorSessions({ limit: 50, cursor: null, teamId: "team-1" });
    expect(out.rows[0].id).toBe("session-1");
    expect(out.rows[0].team_id).toBe("team-1");
    expect(out.rows[0].has_unread).toBe(true);
    expect(out.nextCursor).toBe("cursor-1");
  });

  // A blank teamId used to serialize as the literal string "undefined", which
  // passes the server's truthiness guard and dies in Postgres as a bad uuid.
  it("listCurrentActorSessions refuses a blank teamId instead of sending 'undefined'", async () => {
    const client = mockClient({});
    const mod = createSessionsModule(client);
    await expect(
      mod.listCurrentActorSessions({ limit: 50, cursor: null, teamId: "" }),
    ).rejects.toThrow(/requires teamId/);
  });

  it("markCurrentActorSessionViewed calls POST /v1/sessions/:id/mark-viewed", async () => {
    let called = false;
    const client = {
      async get() { throw new Error("unexpected"); },
      async post(path: string) { called = true; expect(path).toBe("/v1/sessions/session-1/mark-viewed"); return null; },
      async patch() { throw new Error("unexpected"); },
      async put() { throw new Error("unexpected"); },
      async delete() { throw new Error("unexpected"); },
      async postRaw() { throw new Error("unexpected"); },
      async getRaw() { throw new Error("unexpected"); },
    } as unknown as CloudApiClient;
    const mod = createSessionsModule(client);
    await mod.markCurrentActorSessionViewed("session-1");
    expect(called).toBe(true);
  });

  it("createSessionShell POSTs /v1/sessions and returns sessionId", async () => {
    const client = mockClient({ "POST /v1/sessions": cloudSession });
    const mod = createSessionsModule(client);
    const out = await mod.createSessionShell({ id: "session-1", teamId: "team-1", createdByActorId: "a1", title: "T", additionalActorIds: [] });
    expect(out.sessionId).toBe("session-1");
  });

  it("createSessionShell forwards appId in the POST body when provided, omits otherwise", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = {
      async get() { throw new Error("unexpected"); },
      async post(_path: string, body: Record<string, unknown>) { bodies.push(body); return cloudSession as never; },
      async patch() { throw new Error("unexpected"); },
      async put() { throw new Error("unexpected"); },
      async delete() { throw new Error("unexpected"); },
      async postRaw() { throw new Error("unexpected"); },
      async getRaw() { throw new Error("unexpected"); },
    } as unknown as CloudApiClient;
    const mod = createSessionsModule(client);

    await mod.createSessionShell({ id: "s-app", teamId: "team-1", createdByActorId: "a1", title: "T", additionalActorIds: [], appId: "app-42" });
    expect(bodies[0].appId).toBe("app-42");

    await mod.createSessionShell({ id: "s-noapp", teamId: "team-1", createdByActorId: "a1", title: "T", additionalActorIds: [] });
    expect("appId" in bodies[1]).toBe(false);
  });

  it("getSession calls /v1/sessions/:id with teamId and maps detail fields", async () => {
    const client = mockClient({
      "GET /v1/sessions/session-1?teamId=team-1": {
        ...cloudSession,
        primaryAgentId: "agent-1",
        createdByActorId: "actor-1",
        summary: "planning",
        acpSessionId: "acp-1",
        binding: "bind-1",
      },
    });
    const mod = createSessionsModule(client);
    const out = await mod.getSession("session-1", "team-1");
    expect(out?.primary_agent_id).toBe("agent-1");
    expect(out?.created_by_actor_id).toBe("actor-1");
    expect(out?.summary).toBe("planning");
    expect(out?.acp_session_id).toBe("acp-1");
  });
});
