import { describe, expect, it } from "vitest";
import { createCloudApiBackend, hasCloudApiBackendConfig } from "@/lib/backend/cloud-api/index";

describe("cloud api backend", () => {
  it("requires only cloudApiUrl for config to be considered valid", () => {
    expect(hasCloudApiBackendConfig({
      backendKind: "cloud_api",
      cloudApiUrl: "https://fc.example.com",
    })).toBe(true);
    expect(hasCloudApiBackendConfig({ backendKind: "cloud_api" })).toBe(false);
    expect(hasCloudApiBackendConfig({})).toBe(false);
  });

  it("routes Phase 1 sessions/messages/teams through Cloud API", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> = [];
    const backend = createCloudApiBackend(
      { backendKind: "cloud_api", cloudApiUrl: "https://fc.example.com" },
      {
        client: {
          async get(path) {
            calls.push({ method: "GET", path });
            if (path.startsWith("/v1/sessions?")) {
              return {
                items: [{
                  id: "session-1",
                  teamId: "team-1",
                  title: "Plan",
                  mode: "collab",
                  ideaId: null,
                  lastMessageAt: "2026-05-27T01:00:00Z",
                  lastMessagePreview: "hello",
                  hasUnread: true,
                  createdAt: "2026-05-27T00:00:00Z",
                  updatedAt: "2026-05-27T01:00:00Z",
                }],
                nextCursor: null,
              };
            }
            if (path === "/v1/sessions/session-1/messages") {
              return {
                items: [{
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
                  createdAt: "2026-05-27T01:00:00Z",
                  updatedAt: null,
                }],
                nextCursor: null,
              };
            }
            if (path === "/v1/teams?limit=1") {
              return { items: [{ id: "team-1", name: "Team", slug: null, createdAt: null }], nextCursor: null };
            }
            throw new Error(`unexpected GET ${path}`);
          },
          async post(path, body, options) {
            calls.push({ method: "POST", path, body, idempotencyKey: options?.idempotencyKey });
            if (path === "/v1/sessions/session-1/messages") {
              return {
                id: "message-2",
                teamId: "team-1",
                sessionId: "session-1",
                turnId: null,
                senderActorId: "actor-1",
                replyToMessageId: null,
                kind: "text",
                content: "sent",
                metadata: null,
                model: null,
                createdAt: "2026-05-27T01:01:00Z",
                updatedAt: null,
              };
            }
            if (path === "/v1/invites/claim") {
              return { actorId: "actor-1", teamId: "team-1", actorType: "member", displayName: "Alice", refreshToken: null };
            }
            throw new Error(`unexpected POST ${path}`);
          },
          async patch() { throw new Error("unexpected"); },
          async put() { throw new Error("unexpected"); },
          async delete() { throw new Error("unexpected"); },
          async postRaw() { throw new Error("unexpected"); },
          async getRaw() { throw new Error("unexpected"); },
        },
      },
    );

    expect(backend.kind).toBe("cloud_api");
    await expect(backend.sessions.listCurrentActorSessions({ limit: 50, cursor: null, teamId: "team-1" })).resolves.toMatchObject({
      rows: [{ id: "session-1", team_id: "team-1", has_unread: true }],
    });
    await expect(backend.messages.listMessages("session-1")).resolves.toMatchObject({
      rows: [{ id: "message-1", team_id: "team-1", sender_actor_id: "actor-1" }],
    });
    await expect(backend.messages.insertOutgoingMessage({
      id: "message-2",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      content: "sent",
    })).resolves.toMatchObject({ id: "message-2", team_id: "team-1" });
    await expect(backend.teams.listCurrentUserTeams({ limit: 1 })).resolves.toEqual([
      { id: "team-1", name: "Team", slug: null, created_at: null },
    ]);
    await expect(backend.auth.claimInvite("invite-token")).resolves.toMatchObject({ actorId: "actor-1" });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/sessions?limit=50&teamId=team-1&kind=all",
      "GET /v1/sessions/session-1/messages",
      "POST /v1/sessions/session-1/messages",
      "GET /v1/teams?limit=1",
      "POST /v1/invites/claim",
    ]);
    expect(calls[2].idempotencyKey).toBe("message-2");
  });
});
