import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { savedConfigRef, effectiveConfigRef, saveSpy, getSavedSpy, getEffectiveSpy } = vi.hoisted(() => {
  const savedConfigRef = { value: {} as Record<string, unknown> };
  const effectiveConfigRef = { value: {} as Record<string, unknown> };
  return {
    savedConfigRef,
    effectiveConfigRef,
    saveSpy: vi.fn(async (config: Record<string, unknown>) => {
      savedConfigRef.value = { ...config };
      return config;
    }),
    getSavedSpy: vi.fn(async () => savedConfigRef.value),
    getEffectiveSpy: vi.fn(async () => effectiveConfigRef.value),
  };
});

vi.mock("@/lib/config/server-config", () => ({
  getSavedServerConfig: getSavedSpy,
  getEffectiveServerConfig: getEffectiveSpy,
  saveServerConfig: saveSpy,
}));

import { clearBootstrapAppliedFields, fetchAndApplyBootstrap, probeCloudApi } from "@/lib/config/bootstrap";

beforeEach(() => {
  savedConfigRef.value = { cloudApiUrl: "https://cloud.example.com" };
  effectiveConfigRef.value = { cloudApiUrl: "https://cloud.example.com" };
  saveSpy.mockClear();
  getSavedSpy.mockClear();
  getEffectiveSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchAndApplyBootstrap", () => {
  it("is a no-op when access token is missing", async () => {
    const fetchImpl = vi.fn();
    await fetchAndApplyBootstrap({ accessToken: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when cloud API URL is not configured", async () => {
    effectiveConfigRef.value = {};
    const fetchImpl = vi.fn();
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("merges parsed MQTT broker URL into the saved config", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        mqtt: { url: "mqtts://mqtt.example.com:8883", username: "u", password: "p" },
      }),
    );
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    // The request carries brand/platform/version so a per-brand or
    // version-gated rollout is a server-side change later.
    const [requestedUrl, requestInit] = fetchImpl.mock.calls[0];
    const url = new URL(requestedUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://cloud.example.com/v1/config/bootstrap");
    expect(url.searchParams.get("brand")).toBeTruthy();
    expect(url.searchParams.get("platform")).toBeTruthy();
    expect(requestInit).toEqual(
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      cloudApiUrl: "https://cloud.example.com",
      mqttHost: "mqtt.example.com",
      mqttPort: 8883,
      mqttUseTls: true,
      mqttUrl: "mqtts://mqtt.example.com:8883",
      mqttUsername: "u",
      mqttPassword: "p",
    });
  });

  it("prefers the canonical WebSocket URL when bootstrap also includes tcpUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        mqtt: {
          url: "ws://claw.example.com:8080/mqtt",
          tcpUrl: "mqtt://claw.example.com:8080",
          useTls: false,
        },
      }),
    );
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      mqttHost: "claw.example.com",
      mqttPort: 8080,
      mqttUseTls: false,
      mqttUrl: "ws://claw.example.com:8080/mqtt",
    });
  });

  it("marks the applied broker as coming from bootstrap", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ mqtt: { url: "mqtt://mqtt.example.com:1883" } }));
    const outcome = await fetchAndApplyBootstrap({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toBe("applied");
    expect(saveSpy.mock.calls[0][0]).toMatchObject({ mqttSource: "bootstrap" });
  });

  it("does not touch saved config when the payload is empty and nothing is cached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const outcome = await fetchAndApplyBootstrap({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toBe("cloud-empty");
    expect(saveSpy).not.toHaveBeenCalled();
  });

  // The issue #634 shape: FC answers 200 with no `mqtt` block. The address we
  // already hold is the only working one left, so it must survive — flagged as
  // cached rather than silently passed off as fresh.
  it("keeps a cached broker and demotes it to `cache` when the cloud returns no mqtt", async () => {
    savedConfigRef.value = {
      cloudApiUrl: "https://cloud.example.com",
      mqttUrl: "mqtt://last-known.example.com:1883",
      mqttHost: "last-known.example.com",
      mqttPort: 1883,
      mqttSource: "bootstrap",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const outcome = await fetchAndApplyBootstrap({
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toBe("cloud-empty");
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      mqttUrl: "mqtt://last-known.example.com:1883",
      mqttHost: "last-known.example.com",
      mqttSource: "cache",
    });
  });

  it("clearBootstrapAppliedFields drops credentials but keeps the broker address", async () => {
    savedConfigRef.value = {
      cloudApiUrl: "https://cloud.example.com",
      mqttUrl: "mqtt://mqtt.old.example.com:8883",
      mqttHost: "mqtt.old.example.com",
      mqttPort: 8883,
      mqttUseTls: true,
      mqttUsername: "u",
      mqttPassword: "p",
      mqttSource: "bootstrap",
    };
    await clearBootstrapAppliedFields();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toEqual({
      cloudApiUrl: "https://cloud.example.com",
      // Deployment topology, not account data — wiping it on sign-out is what
      // made "sign out and back in" a reliable way to lose MQTT entirely.
      mqttUrl: "mqtt://mqtt.old.example.com:8883",
      mqttHost: "mqtt.old.example.com",
      mqttPort: 8883,
      mqttUseTls: true,
      mqttSource: "cache",
      mqttUsername: undefined,
      mqttPassword: undefined,
    });
  });

  it("clearBootstrapAppliedFields leaves mqttSource unset when there was no address", async () => {
    savedConfigRef.value = { cloudApiUrl: "https://cloud.example.com", mqttUsername: "u" };
    await clearBootstrapAppliedFields();
    expect(saveSpy.mock.calls[0][0]).toEqual({
      cloudApiUrl: "https://cloud.example.com",
      mqttUsername: undefined,
      mqttPassword: undefined,
      mqttSource: undefined,
    });
  });

  it("swallows network and HTTP errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe("unreachable");
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("probeCloudApi", () => {
  it("accepts a Cloud API that answers with a JSON object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ features: { auth: {} } }));

    expect(await probeCloudApi("https://api.example.com", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ ok: true });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/v1/config/public");
  });

  it("accepts an empty object — that means 'this deployment overrides nothing'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));

    expect(await probeCloudApi("https://api.example.com", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ ok: true });
  });

  it("reports an unreachable host rather than throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    // The typo case: https://api.teamclu-dev.ucar.cc111 parses fine and
    // resolves to nothing.
    expect(await probeCloudApi("https://api.example.com111", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ ok: false, reason: "unreachable" });
  });

  it("rejects a server that answers but is not a Cloud API", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>nope</html>", { status: 404 }));

    expect(await probeCloudApi("https://example.com", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ ok: false, reason: "not-cloud-api", status: 404 });
  });

  it("rejects a 200 that is not a JSON object — a parked page or a proxy", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('"hello"', { status: 200, headers: { "Content-Type": "application/json" } }));

    // A liveness check would have passed this. It is still useless to the app.
    expect(await probeCloudApi("https://parked.example.com", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ ok: false, reason: "not-cloud-api", status: 200 });
  });

  it("gives up rather than hanging when the server never answers", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    expect(await probeCloudApi("https://blackhole.example.com", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    })).toEqual({ ok: false, reason: "unreachable" });
  });
});
