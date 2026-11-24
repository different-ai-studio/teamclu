import { beforeEach, describe, expect, it, vi } from "vitest";

const { effectiveConfigRef, savedConfigRef, applySpy, saveSpy } = vi.hoisted(() => ({
  effectiveConfigRef: { value: {} as Record<string, unknown> },
  savedConfigRef: { value: {} as Record<string, unknown> },
  applySpy: vi.fn(),
  saveSpy: vi.fn(async (config: unknown) => config),
}));

vi.mock("@/lib/config/server-config", async (importOriginal) => ({
  normalizePartnerConsoleHosts: (
    await importOriginal<typeof import("@/lib/config/server-config")>()
  ).normalizePartnerConsoleHosts,
  getSavedServerConfig: vi.fn(async () => savedConfigRef.value),
  getEffectiveServerConfig: vi.fn(async () => effectiveConfigRef.value),
  saveServerConfig: saveSpy,
}));

vi.mock("@/lib/config/remote-features", () => ({
  applyRemoteFeatures: applySpy,
}));

import { fetchPublicConfig } from "@/lib/config/bootstrap";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  effectiveConfigRef.value = { cloudApiUrl: "https://default.example.com" };
  savedConfigRef.value = {};
  applySpy.mockClear();
  saveSpy.mockClear();
  vi.unstubAllGlobals();
});

describe("fetchPublicConfig", () => {
  it("re-fetches the login flags when the Cloud API URL changes without a reload", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ features: { auth: { google: true } } }));
    vi.stubGlobal("fetch", fetchSpy);

    effectiveConfigRef.value = { cloudApiUrl: "https://custom.example.com" };
    window.dispatchEvent(new CustomEvent("teamclu:cloud-api-url-changed", { detail: "https://custom.example.com" }));

    await vi.waitFor(() => expect(applySpy).toHaveBeenCalledWith("public", { auth: { google: true } }));
    const [requestedUrl] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(new URL(requestedUrl).origin).toBe("https://custom.example.com");
  });

  it("drops a response from a server that was switched away from mid-flight", async () => {
    let respond!: (res: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)));

    const pending = fetchPublicConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    effectiveConfigRef.value = { cloudApiUrl: "https://custom.example.com" };
    respond(jsonResponse({ features: { auth: { google: false } } }));
    await pending;

    expect(applySpy).not.toHaveBeenCalled();
  });

  it("applies the response when the server is unchanged", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ features: { auth: { google: true } } }));
    await fetchPublicConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(applySpy).toHaveBeenCalledWith("public", { auth: { google: true } });
  });

  it("caches the partner console hosts, normalised", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ partnerConsoleHosts: [" Admin.Example.com ", "bad host", 7, "admin.example.com"] }),
    );
    await fetchPublicConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ partnerConsoleHosts: ["admin.example.com"] }),
    );
  });

  it("forgets cached partner console hosts when the server stops sending them", async () => {
    savedConfigRef.value = { partnerConsoleHosts: ["admin.example.com"] };
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await fetchPublicConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ partnerConsoleHosts: undefined }));
  });

  it("does not rewrite the cache when nothing changed", async () => {
    savedConfigRef.value = { partnerConsoleHosts: ["admin.example.com"] };
    const fetchImpl = vi.fn(async () => jsonResponse({ partnerConsoleHosts: ["admin.example.com"] }));
    await fetchPublicConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
