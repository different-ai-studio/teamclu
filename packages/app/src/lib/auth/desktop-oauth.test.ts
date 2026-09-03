import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, shellOpen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  shellOpen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));
vi.mock("@/lib/auth/oauth-pkce", () => ({
  generatePkce: vi.fn().mockResolvedValue({ verifier: "VER", challenge: "CHA" }),
}));

import { runDesktopOAuth } from "@/lib/auth/desktop-oauth";

function fakeClient() {
  return {
    oauthAuthorizeUrl: vi.fn().mockReturnValue("https://auth.example/url"),
    exchangeOAuthCode: vi.fn().mockResolvedValue({ access_token: "at", user: { id: "u1" } }),
  } as any;
}

beforeEach(() => {
  invoke.mockReset();
  shellOpen.mockReset();
});

describe("runDesktopOAuth", () => {
  it("runs start → open → await → exchange in order", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "oauth_loopback_start" ? Promise.resolve({ port: 5123 }) : Promise.resolve({ code: "CODE" }),
    );
    const client = fakeClient();

    const session = await runDesktopOAuth(client, "wechat");

    expect(invoke).toHaveBeenNthCalledWith(1, "oauth_loopback_start");
    expect(client.oauthAuthorizeUrl).toHaveBeenCalledWith(
      "wechat",
      "http://127.0.0.1:5123/callback",
      "CHA",
    );
    expect(shellOpen).toHaveBeenCalledWith("https://auth.example/url");
    expect(invoke).toHaveBeenNthCalledWith(2, "oauth_loopback_await");
    expect(client.exchangeOAuthCode).toHaveBeenCalledWith("CODE", "VER");
    expect(session.access_token).toBe("at");
  });

  it("surfaces a cancelled error from the await step", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "oauth_loopback_start" ? Promise.resolve({ port: 1 }) : Promise.reject("oauth_cancelled"),
    );
    await expect(runDesktopOAuth(fakeClient(), "google")).rejects.toThrow(/cancel/i);
  });
});
