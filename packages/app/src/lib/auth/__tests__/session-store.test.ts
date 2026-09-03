import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSessionStoreForTests,
  configureSessionStore,
  getSession,
  refreshSession,
  setSession,
  subscribe,
} from "@/lib/auth/session-store";
import type { Session } from "@/lib/auth/types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "atk",
    refresh_token: "rtk",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "u1", email: "u@example.com" },
    ...overrides,
  };
}

beforeEach(() => {
  __resetSessionStoreForTests();
});

afterEach(() => {
  __resetSessionStoreForTests();
  vi.useRealTimers();
});

describe("session-store", () => {
  it("setSession persists to localStorage and getSession reads it back", () => {
    const s = makeSession();
    setSession(s);
    expect(getSession()).toEqual(s);
    expect(JSON.parse(window.localStorage.getItem("teamclu.session.v1")!)).toEqual(s);
  });

  it("setSession(null) clears the persisted session", () => {
    setSession(makeSession());
    setSession(null);
    expect(getSession()).toBeNull();
    expect(window.localStorage.getItem("teamclu.session.v1")).toBeNull();
  });

  it("subscribe receives change events", () => {
    const cb = vi.fn();
    subscribe(cb);
    const s = makeSession();
    setSession(s);
    expect(cb).toHaveBeenCalledWith("SIGNED_IN", s);
    setSession(null);
    expect(cb).toHaveBeenLastCalledWith("SIGNED_OUT", null);
  });

  it("concurrent refresh callers share the same in-flight promise", async () => {
    const refresher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return makeSession({ access_token: "atk2" });
    });
    configureSessionStore({ refresher });
    setSession(makeSession());

    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(getSession()?.access_token).toBe("atk2");
  });

  it("clears session when refresh fails with invalid_grant", async () => {
    const refresher = vi.fn(async () => {
      const err = Object.assign(new Error("invalid grant"), {
        status: 400,
        code: "invalid_grant",
      });
      throw err;
    });
    configureSessionStore({ refresher });
    setSession(makeSession());

    await expect(refreshSession()).rejects.toThrow("invalid grant");
    expect(getSession()).toBeNull();
  });

  it("does not resurrect the session when signOut happens during an in-flight refresh", async () => {
    let releaseRefresh!: (s: Session) => void;
    const refresher = vi.fn(
      () =>
        new Promise<Session>((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    configureSessionStore({ refresher });
    setSession(makeSession());

    const events: string[] = [];
    subscribe((event) => events.push(event));

    const pending = refreshSession();
    // User signs out while the refresh network call is still outstanding.
    setSession(null, "SIGNED_OUT");
    // Refresh resolves late with a fresh session for the OLD identity.
    releaseRefresh(makeSession({ access_token: "atk-late" }));

    await expect(pending).rejects.toThrow("session changed during refresh");
    // Must remain signed out — no TOKEN_REFRESHED resurrecting the old session.
    expect(getSession()).toBeNull();
    expect(events).toContain("SIGNED_OUT");
    expect(events).not.toContain("TOKEN_REFRESHED");
  });

  it("allows a fresh refresh after a sign-out interrupted an earlier one", async () => {
    let calls = 0;
    let releaseFirst!: (s: Session) => void;
    const refresher = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Session>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(makeSession({ access_token: "atk-new-identity" }));
    });
    configureSessionStore({ refresher });
    setSession(makeSession());

    const first = refreshSession();
    setSession(null, "SIGNED_OUT");
    releaseFirst(makeSession({ access_token: "atk-stale" }));
    await expect(first).rejects.toThrow();

    // A new identity signs in and refreshes normally.
    setSession(makeSession({ access_token: "atk-b", refresh_token: "rtk-b" }));
    const next = await refreshSession();
    expect(next.access_token).toBe("atk-new-identity");
    expect(getSession()?.access_token).toBe("atk-new-identity");
  });

  it("migrates legacy supabase-js auth-token into teamclu.session.v1 and clears sb-* keys", () => {
    const legacy = {
      access_token: "legacy-atk",
      refresh_token: "legacy-rtk",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "legacy-user", email: "legacy@example.com" },
    };
    window.localStorage.setItem("sb-abcdef-auth-token", JSON.stringify(legacy));
    window.localStorage.setItem("sb-abcdef-provider-token", "provider-token-value");

    const out = getSession();
    expect(out).not.toBeNull();
    expect(out?.access_token).toBe("legacy-atk");
    expect(out?.refresh_token).toBe("legacy-rtk");
    expect(out?.user.id).toBe("legacy-user");
    // new key populated
    const stored = window.localStorage.getItem("teamclu.session.v1");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).access_token).toBe("legacy-atk");
    // legacy keys removed
    expect(window.localStorage.getItem("sb-abcdef-auth-token")).toBeNull();
    expect(window.localStorage.getItem("sb-abcdef-provider-token")).toBeNull();
  });

  it("re-keys a pre-rebrand teamclaw.session.v1 session instead of signing out", () => {
    const legacy = makeSession();
    window.localStorage.setItem("teamclaw.session.v1", JSON.stringify(legacy));

    const out = getSession();
    expect(out).toEqual(legacy);
    expect(JSON.parse(window.localStorage.getItem("teamclu.session.v1")!)).toEqual(legacy);
    expect(window.localStorage.getItem("teamclaw.session.v1")).toBeNull();
  });

  it("drops a malformed pre-rebrand session without throwing", () => {
    window.localStorage.setItem("teamclaw.session.v1", "not json");
    expect(getSession()).toBeNull();
    expect(window.localStorage.getItem("teamclu.session.v1")).toBeNull();
  });

  it("clears malformed legacy supabase-js data and returns signed-out", () => {
    window.localStorage.setItem("sb-bad-auth-token", "not json");
    window.localStorage.setItem("sb-bad-provider-token", "x");
    const out = getSession();
    expect(out).toBeNull();
    expect(window.localStorage.getItem("sb-bad-auth-token")).toBeNull();
    expect(window.localStorage.getItem("sb-bad-provider-token")).toBeNull();
    expect(window.localStorage.getItem("teamclu.session.v1")).toBeNull();
  });

  it("auto-refresh fires shortly before expires_at", async () => {
    vi.useFakeTimers();
    const next = makeSession({ access_token: "fresh" });
    const refresher = vi.fn(async () => next);

    const expiresAt = Math.floor(Date.now() / 1000) + 120; // 2 min from now
    configureSessionStore({ refresher });
    setSession(makeSession({ expires_at: expiresAt }));

    // 60-second leeway means the timer fires at expires_at - 60s = ~60s from now.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refresher).toHaveBeenCalledTimes(1);
  });
});
