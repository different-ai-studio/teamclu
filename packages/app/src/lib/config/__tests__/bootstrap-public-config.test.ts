import { beforeEach, describe, expect, it, vi } from "vitest";

const { effectiveConfigRef, applySpy } = vi.hoisted(() => ({
  effectiveConfigRef: { value: {} as Record<string, unknown> },
  applySpy: vi.fn(),
}));

vi.mock("@/lib/config/server-config", () => ({
  getSavedServerConfig: vi.fn(async () => ({})),
  getEffectiveServerConfig: vi.fn(async () => effectiveConfigRef.value),
  saveServerConfig: vi.fn(async (config: unknown) => config),
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
  applySpy.mockClear();
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
});
