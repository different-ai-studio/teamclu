import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "@/lib/auth/auth-client";
import {
  __resetSessionStoreForTests,
  getSession,
  refreshSession,
  setSession,
} from "@/lib/auth/session-store";
import type { Session } from "@/lib/auth/types";

const BASE = "https://fc.test";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "atk",
    refresh_token: "rtk",
    user: { id: "u1" },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  __resetSessionStoreForTests();
});

afterEach(() => {
  __resetSessionStoreForTests();
});

describe("auth-client", () => {

  it("signInWithPassword POSTs credentials and stores the session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, makeSession({ access_token: "password" })));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.signInWithPassword("person@example.com", "password123");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/auth/signin-password`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: "person@example.com",
      password: "password123",
    });
    expect(getSession()?.access_token).toBe("password");
  });

  it("sendOtp POSTs email + options without storing a session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendOtp("u@example.com", { shouldCreateUser: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: "u@example.com",
      options: { shouldCreateUser: true },
    });
    expect(getSession()).toBeNull();
  });

  it("verifyOtp stores the returned session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, makeSession({ access_token: "verified" })));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.verifyOtp("u@example.com", "123456");
    expect(getSession()?.access_token).toBe("verified");
  });

  it("sendPhoneOtp POSTs to phone/send-code with a captcha token, no session stored", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendPhoneOtp("+8613800138000", { shouldCreateUser: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/auth/phone/send-code`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      phone: "+8613800138000",
      captchaVerify: "desktop-captcha-pending",
    });
    expect(getSession()).toBeNull();
  });

  it("verifyPhoneOtp POSTs to phone/login and stores the returned session", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { session: makeSession({ access_token: "phone-verified" }) }),
    );
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.verifyPhoneOtp("+8613800138000", "123456");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/auth/phone/login`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      phone: "+8613800138000",
      code: "123456",
    });
    expect(getSession()?.access_token).toBe("phone-verified");
  });

  it("verifyPhoneOtp throws on a MULTI_USER response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { multiUser: true, users: [] }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.verifyPhoneOtp("+8613800138000", "123456")).rejects.toThrow(/多个账号/);
    expect(getSession()).toBeNull();
  });

  it("timer refresh accepts normalized Cloud API session fields and preserves the user", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt,
      }),
    );
    createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    setSession(
      makeSession({
        access_token: "old-at",
        refresh_token: "old-rt",
        user: { id: "u1", email: "u@example.com" },
      }),
    );

    await refreshSession();

    expect(getSession()).toMatchObject({
      access_token: "new-at",
      refresh_token: "new-rt",
      expires_at: expiresAt,
      user: { id: "u1", email: "u@example.com" },
    });
  });

  it("signOut clears local session even if the request fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { message: "expired" } }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    setSession(makeSession());
    await client.signOut();
    expect(getSession()).toBeNull();
  });

  it("updateUser forwards body verbatim with bearer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { user: { id: "u1", email: "new@example.com" } }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    setSession(makeSession());
    await client.updateUser({ email: "new@example.com" });
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).method).toBe("PATCH");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer atk");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: "new@example.com" });
  });

  it("non-2xx responses raise AuthError with the GoTrue message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { code: "validation_failed", message: "bad" } }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendOtp("nope@example.com")).rejects.toMatchObject({
      name: "AuthError",
      status: 400,
      code: "validation_failed",
      message: "bad",
    });
  });
});
