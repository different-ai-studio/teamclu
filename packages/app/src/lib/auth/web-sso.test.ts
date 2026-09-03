import { describe, it, expect, vi, beforeEach } from "vitest";

// webSSO is a Cloud-API flag now, not a baked one — mock the resolver the
// module actually reads rather than the build config.
vi.mock("@/lib/config/remote-features", () => ({
  getFeatures: () => ({ auth: { webSSO: true } }),
}));

// ssoConfig now reads the FC-delivered Web SSO target out of server-config
// (cached from /v1/config/bootstrap) — nothing is hardcoded.
const serverCfgMock = vi.fn<[], { webSsoLoginUrl?: string; webSsoStorageKey?: string }>();
vi.mock("@/lib/config/server-config", () => ({
  getEffectiveServerConfigSync: () => serverCfgMock(),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const fetchPublicConfigMock = vi.fn(async () => {});
vi.mock("@/lib/config/bootstrap", () => ({ fetchPublicConfig: (...a: unknown[]) => fetchPublicConfigMock(...a) }));

import { ssoConfig, runWebSso, cancelWebSso } from "@/lib/auth/web-sso";

const TEST_CFG = {
  webSsoLoginUrl: "https://admin.example.test/sign-in",
  webSsoStorageKey: "sb-test-supa-auth-token",
};

describe("ssoConfig", () => {
  beforeEach(() => serverCfgMock.mockReset());

  it("returns the FC-delivered login URL + storage key, with host derived from the URL", () => {
    serverCfgMock.mockReturnValue(TEST_CFG);
    expect(ssoConfig()).toEqual({
      loginUrl: "https://admin.example.test/sign-in",
      host: "admin.example.test",
      storageKey: "sb-test-supa-auth-token",
    });
  });

  it("returns null when the FC didn't deliver a login URL", () => {
    serverCfgMock.mockReturnValue({ webSsoStorageKey: "sb-test-supa-auth-token" });
    expect(ssoConfig()).toBeNull();
  });

  it("returns null when the storage key is missing", () => {
    serverCfgMock.mockReturnValue({ webSsoLoginUrl: "https://admin.example.test/sign-in" });
    expect(ssoConfig()).toBeNull();
  });
});

describe("runWebSso", () => {
  beforeEach(() => {
    serverCfgMock.mockReturnValue(TEST_CFG);
    invokeMock.mockReset();
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("opens the webview (clearing stale session), polls scoped to the host, returns the refresh_token", async () => {
    const session = JSON.stringify({ access_token: "AT", refresh_token: "RT", user: { id: "u1" } });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "webview_create") return Promise.resolve();
      if (cmd === "webview_close") return Promise.resolve();
      if (cmd === "webview_read_local_storage") return Promise.resolve(session);
      return Promise.resolve(null);
    });
    const rt = await runWebSso({ pollMs: 1, timeoutMs: 1000 });
    expect(rt).toBe("RT");
    expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.objectContaining({
      label: "websso-login",
      url: "https://admin.example.test/sign-in",
      clearStorageKey: "sb-test-supa-auth-token",
    }));
    expect(invokeMock).toHaveBeenCalledWith("webview_read_local_storage", expect.objectContaining({
      label: "websso-login",
      key: "sb-test-supa-auth-token",
      expectedHost: "admin.example.test",
    }));
    expect(invokeMock).toHaveBeenCalledWith("webview_close", { label: "websso-login" });
  });

  it("keeps polling while localStorage is empty, then resolves", async () => {
    const session = JSON.stringify({ access_token: "AT", refresh_token: "RT", user: { id: "u1" } });
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "webview_read_local_storage") {
        calls += 1;
        return Promise.resolve(calls < 3 ? null : session);
      }
      return Promise.resolve();
    });
    const rt = await runWebSso({ pollMs: 1, timeoutMs: 1000 });
    expect(rt).toBe("RT");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("rejects with websso_cancelled when cancelled", async () => {
    invokeMock.mockResolvedValue(null);
    const p = runWebSso({ pollMs: 5, timeoutMs: 1000 });
    cancelWebSso();
    await expect(p).rejects.toMatchObject({ code: "websso_cancelled" });
    expect(invokeMock).toHaveBeenCalledWith("webview_close", { label: "websso-login" });
  });

  it("rejects with websso_timeout when the deadline passes", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(runWebSso({ pollMs: 1, timeoutMs: 10 })).rejects.toMatchObject({ code: "websso_timeout" });
  });

  it("fetches the public config on demand when the target isn't cached yet", async () => {
    // Pre-login: ssoConfig is null until fetchPublicConfig populates the cache.
    serverCfgMock.mockReturnValueOnce({}).mockReturnValue(TEST_CFG);
    fetchPublicConfigMock.mockResolvedValueOnce(undefined);
    const session = JSON.stringify({ access_token: "AT", refresh_token: "RT", user: { id: "u1" } });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "webview_read_local_storage" ? session : undefined),
    );
    const rt = await runWebSso({ pollMs: 1, timeoutMs: 1000 });
    expect(fetchPublicConfigMock).toHaveBeenCalled();
    expect(rt).toBe("RT");
  });
});
