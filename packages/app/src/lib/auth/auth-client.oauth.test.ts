import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "@/lib/auth/auth-client";
import { __resetSessionStoreForTests, getSession } from "@/lib/auth/session-store";

beforeEach(() => __resetSessionStoreForTests());

describe("auth-client OAuth", () => {
  it("builds the FC authorize URL with redirect + code_challenge", () => {
    const client = createAuthClient({ baseUrl: "https://cloud.ucar.cc/", fetchImpl: vi.fn() });
    const url = new URL(client.oauthAuthorizeUrl("wechat", "http://127.0.0.1:5123/callback", "CHALLENGE"));
    expect(url.pathname).toBe("/v1/auth/oauth/wechat/authorize");
    expect(url.searchParams.get("redirect")).toBe("http://127.0.0.1:5123/callback");
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
  });

  it("exchanges the code and stores the returned session", async () => {
    const session = {
      access_token: "at",
      refresh_token: "rt",
      expires_at: 123,
      token_type: "bearer",
      user: { id: "u1", email: "a@b.c" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const client = createAuthClient({ baseUrl: "https://cloud.ucar.cc", fetchImpl });
    const out = await client.exchangeOAuthCode("CODE", "VERIFIER");

    expect(out.access_token).toBe("at");
    expect(getSession()?.access_token).toBe("at");
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(String(calledUrl)).toBe("https://cloud.ucar.cc/v1/auth/oauth/exchange");
    expect(JSON.parse(init.body)).toEqual({ code: "CODE", codeVerifier: "VERIFIER" });
  });
});
