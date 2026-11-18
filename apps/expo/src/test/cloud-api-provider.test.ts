import { afterEach, describe, expect, it, vi } from "vitest";

describe("Expo Cloud API provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses FC /v1 for configured session list and message insert paths", async () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_KIND", "cloud_api");
    vi.stubEnv("EXPO_PUBLIC_CLOUD_API_URL", "https://fc.example.com");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/v1/sessions?")) {
        return response({
          items: [{
            id: "session-1",
            teamId: "team-1",
            title: "Plan",
            mode: "collab",
            ideaId: null,
            primaryAgentId: null,
            createdByActorId: null,
            summary: null,
            participantCount: 0,
            lastMessageAt: "2026-05-27T01:00:00Z",
            lastMessagePreview: "hello",
            hasUnread: true,
            createdAt: "2026-05-27T00:00:00Z",
            updatedAt: "2026-05-27T01:00:00Z",
          }],
          // Short page → no cursor, so the pager stops after one request.
          nextCursor: null,
        });
      }
      if (String(url).endsWith("/v1/sessions/session-1/messages") && init?.method === "POST") {
        return response({
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
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    const { createConfiguredSessionsApi } = await import("../features/sessions/api-provider");
    const api = createConfiguredSessionsApi(authClient() as never);

    await expect(api.listSessions("team-1")).resolves.toMatchObject([
      { sessionId: "session-1", teamId: "team-1", hasUnread: true },
    ]);
    // The team filter has to reach the server: post-filtering a paginated list
    // in the client would drop matches that land on a later page.
    expect(String(fetchMock.mock.calls[0][0])).toContain("teamId=team-1");
    // Cron runs are filtered by the server; Expo has no view for them.
    expect(String(fetchMock.mock.calls[0][0])).toContain("kind=regular");
    await expect(api.insertOutgoingMessage({
      id: "message-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      content: "hello",
    })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Idempotency-Key": "message-1",
    });
  });

  it("uses FC /v1 for configured invite claim path", async () => {
    vi.stubEnv("EXPO_PUBLIC_BACKEND_KIND", "cloud_api");
    vi.stubEnv("EXPO_PUBLIC_CLOUD_API_URL", "https://fc.example.com");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: null,
    }) as never);

    const { createConfiguredInviteApi } = await import("../features/onboarding/invite-api");
    const api = createConfiguredInviteApi(authClient() as never);

    await expect(api.claim("invite-token")).resolves.toMatchObject({ actorId: "actor-1" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://fc.example.com/v1/invites/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "invite-token" }),
      }),
    );
  });
});

function authClient() {
  return {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            access_token: "access-token",
          },
        },
      }),
    },
    from() {
      throw new Error("should use cloud api");
    },
    rpc() {
      throw new Error("should use cloud api");
    },
  };
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}
