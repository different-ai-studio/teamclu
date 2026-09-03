import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/oauth-pkce", () => ({
  generatePkce: vi.fn().mockResolvedValue({ verifier: "VER", challenge: "CHA" }),
}));

import { cancelExtensionOAuth, runExtensionOAuth } from "@/lib/auth/extension-oauth";

const REDIRECT = "https://abcdefghijklmnop.chromiumapp.org/";

function fakeClient() {
  return {
    oauthAuthorizeUrl: vi.fn().mockReturnValue("https://auth.example/url"),
    exchangeOAuthCode: vi.fn().mockResolvedValue({ access_token: "at", user: { id: "u1" } }),
  } as any;
}

/** Install a chrome.identity double. `flow` drives the launchWebAuthFlow callback. */
function installChrome(flow: (cb: (responseUrl?: string) => void) => void, lastError?: { message?: string }) {
  const launchWebAuthFlow = vi.fn((_details: unknown, cb: (responseUrl?: string) => void) => {
    // lastError is only readable from inside the callback, matching Chrome.
    (globalThis as any).chrome.runtime.lastError = lastError;
    flow(cb);
    (globalThis as any).chrome.runtime.lastError = undefined;
  });
  (globalThis as any).chrome = {
    identity: { getRedirectURL: vi.fn().mockReturnValue(REDIRECT), launchWebAuthFlow },
    runtime: { id: "abcdefghijklmnop", lastError: undefined },
  };
  return launchWebAuthFlow;
}

beforeEach(() => {
  delete (globalThis as any).chrome;
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("runExtensionOAuth", () => {
  it("authorizes with the chrome redirect, then exchanges the code", async () => {
    const launch = installChrome(cb => cb(`${REDIRECT}?code=CODE`));
    const client = fakeClient();

    const session = await runExtensionOAuth(client, "google");

    expect(client.oauthAuthorizeUrl).toHaveBeenCalledWith("google", REDIRECT, "CHA");
    expect(launch).toHaveBeenCalledWith(
      { url: "https://auth.example/url", interactive: true },
      expect.any(Function),
    );
    expect(client.exchangeOAuthCode).toHaveBeenCalledWith("CODE", "VER");
    expect(session.access_token).toBe("at");
  });

  it("fails cleanly when the identity permission is absent", async () => {
    (globalThis as any).chrome = { runtime: { id: "x" } };
    await expect(runExtensionOAuth(fakeClient(), "google")).rejects.toThrow(/identity permission/i);
  });

  it("maps a dismissed auth window to oauth_cancelled", async () => {
    installChrome(cb => cb(undefined), { message: "The user did not approve access." });
    await expect(runExtensionOAuth(fakeClient(), "google")).rejects.toMatchObject({
      code: "oauth_cancelled",
    });
  });

  it("treats an empty response url as a cancel", async () => {
    installChrome(cb => cb(undefined));
    await expect(runExtensionOAuth(fakeClient(), "google")).rejects.toMatchObject({
      code: "oauth_cancelled",
    });
  });

  it("keeps a genuine provider failure distinguishable from a cancel", async () => {
    installChrome(cb => cb(undefined), { message: "Authorization page could not be loaded." });
    await expect(runExtensionOAuth(fakeClient(), "google")).rejects.toMatchObject({
      code: "oauth_failed",
    });
  });

  it("surfaces an error carried on the redirect url", async () => {
    installChrome(cb => cb(`${REDIRECT}?error=access_denied&error_description=Nope`));
    await expect(runExtensionOAuth(fakeClient(), "google")).rejects.toThrow(/nope/i);
  });

  it("rejects when the redirect carries neither code nor error", async () => {
    installChrome(cb => cb(REDIRECT));
    await expect(runExtensionOAuth(fakeClient(), "google")).rejects.toMatchObject({
      code: "oauth_failed",
    });
  });

  it("does not exchange a code once cancelled", async () => {
    // Never invokes the callback: the flow stays pending until cancelled, which
    // is what a user staring at an abandoned Chrome window actually hits.
    installChrome(() => {});
    const client = fakeClient();

    const pending = runExtensionOAuth(client, "google");
    await Promise.resolve();
    cancelExtensionOAuth();

    await expect(pending).rejects.toMatchObject({ code: "oauth_cancelled" });
    expect(client.exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("cancel is a no-op when no flow is in flight", () => {
    expect(() => cancelExtensionOAuth()).not.toThrow();
  });
});
