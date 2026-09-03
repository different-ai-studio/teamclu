import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudApiClient } from "@/lib/backend/cloud-api/http";

const sessionMocks = vi.hoisted(() => ({
  accessToken: "token-a",
  getFreshAccessToken: vi.fn(async () => sessionMocks.accessToken),
  refreshSession: vi.fn(async () => {
    sessionMocks.accessToken = "token-b";
    return {
      access_token: "token-b",
      refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "user-1" },
    };
  }),
}));

vi.mock("@/lib/auth/session-store", () => ({
  getFreshAccessToken: sessionMocks.getFreshAccessToken,
  refreshSession: sessionMocks.refreshSession,
}));

describe("createCloudApiClient auth recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.accessToken = "token-a";
    sessionMocks.getFreshAccessToken.mockImplementation(async () => sessionMocks.accessToken);
  });

  it("retries once after refreshing when the first response is 401", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      if (auth === "Bearer token-a") {
        return new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "JWT expired" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = createCloudApiClient({
      baseUrl: "https://fc.example.com",
      auth: { getSession: async () => null },
      fetchImpl,
    });

    await expect(client.get<{ ok: boolean }>("/v1/sync/actor-directory?teamId=t1")).resolves.toEqual({
      ok: true,
    });
    expect(sessionMocks.refreshSession).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces 401 when refresh also fails", async () => {
    sessionMocks.refreshSession.mockRejectedValueOnce(new Error("refresh dead"));
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "JWT expired" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createCloudApiClient({
      baseUrl: "https://fc.example.com",
      auth: { getSession: async () => null },
      fetchImpl,
    });

    await expect(client.get("/v1/teams")).rejects.toMatchObject({ status: 401, message: "JWT expired" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
