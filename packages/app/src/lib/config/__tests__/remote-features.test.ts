import { beforeEach, describe, expect, it, vi } from "vitest";

// The module reads localStorage at import time, so every test re-imports it
// after seeding storage rather than sharing one instance.
async function loadModule() {
  vi.resetModules();
  return import("@/lib/config/remote-features");
}

const ORIGIN = "https://api.example.test";

function seed(scope: "public" | "session", value: unknown, origin = ORIGIN) {
  window.localStorage.setItem(
    `teamclu.remoteFeatures.${scope}:${origin}`,
    JSON.stringify(value),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_CLOUD_API_URL", ORIGIN);
});

describe("resolution without any remote data", () => {
  it("falls back to OFF — the build config no longer supplies flags", async () => {
    const { getFeatures } = await loadModule();
    const features = getFeatures();
    // Every flag is the Cloud API's to set. With nothing cached and nothing
    // fetched, the client offers only what needs no flag (email OTP).
    expect(features.apps).toBe(false);
    expect(features.lockLlmConfig).toBe(false);
    expect(features.auth).toEqual({
      google: false, wechat: false, phone: false, password: false, webSSO: false,
    });
    expect(Object.values(features.channels).every((v) => v === false)).toBe(true);
  });

  it("still takes `updater` from the build, defaulting to on", async () => {
    const { getFeatures } = await loadModule();
    const { buildConfig } = await import("@/lib/config/build-config");
    expect(getFeatures().updater).toBe(buildConfig.features?.updater ?? true);
  });

  it("treats an empty remote block as 'no overrides', NOT as 'everything off'", async () => {
    const { applyRemoteFeatures, getFeatures } = await loadModule();
    const before = getFeatures();
    applyRemoteFeatures("session", {});
    applyRemoteFeatures("public", {});
    // A server that answers 200 with nothing is a normal, healthy state. Reading
    // it as "disable everything" is how a quiet server became an outage (#634).
    expect(getFeatures()).toEqual(before);
  });
});

describe("merging", () => {
  it("takes channels only from what the server names — the rest are off", async () => {
    const { applyRemoteFeatures, getFeatures } = await loadModule();
    // `channels` is session-scope only (see scopeToOwnedKeys), so this is the
    // whole story for them: named keys apply, unnamed ones are off. There is
    // no build config left to inherit an answer from.
    applyRemoteFeatures("session", { channels: { discord: true, feishu: false } });
    const { channels } = getFeatures();
    expect(channels.discord).toBe(true);
    expect(channels.feishu).toBe(false);
    expect(channels.wecom).toBe(false);
  });

  it("ignores channels sent to the public scope (auth-only endpoint)", async () => {
    const { applyRemoteFeatures, getFeatures } = await loadModule();
    applyRemoteFeatures("public", { channels: { discord: true } });
    expect(getFeatures().channels.discord).toBe(false);
  });

  it("lets the session scope override booleans", async () => {
    const { applyRemoteFeatures, getFeatures } = await loadModule();
    applyRemoteFeatures("session", { apps: true, lockLlmConfig: true });
    expect(getFeatures().apps).toBe(true);
    expect(getFeatures().lockLlmConfig).toBe(true);
  });

  it("lets the server decide webSSO in both directions", async () => {
    const { applyRemoteFeatures, getFeatures } = await loadModule();
    // No longer ANDed with a build flag, and there is no build-time host list
    // behind it any more either — WEBSSO_LOGIN_URL decides where the flow
    // points, and it is server-side too.
    applyRemoteFeatures("public", { auth: { webSSO: true } });
    expect(getFeatures().auth.webSSO).toBe(true);

    applyRemoteFeatures("public", { auth: { webSSO: false } });
    expect(getFeatures().auth.webSSO).toBe(false);
  });

  it("never lets the server enable the updater flag", async () => {
    const { applyRemoteFeatures, getFeatures } = await loadModule();
    const before = getFeatures().updater;
    applyRemoteFeatures("session", { updater: !before } as unknown as Record<string, unknown>);
    // Remotely disabling the updater would strand the fleet with no way to
    // update out of the mistake.
    expect(getFeatures().updater).toBe(before);
  });
});

describe("input validation", () => {
  it("drops unknown keys and non-boolean values", async () => {
    const { sanitizeRemoteFeatures } = await loadModule();
    expect(
      sanitizeRemoteFeatures({
        apps: "false",
        lockLlmConfig: true,
        // Retired flag: the team-share sidebar ships in every brand now, so a
        // server still sending it must not be able to reintroduce the gate.
        teamShareBrowser: false,
        nope: true,
        channels: { discord: 1, feishu: false },
      }),
    ).toEqual({ lockLlmConfig: true, channels: { feishu: false } });
  });

  it("survives a garbage payload without throwing", async () => {
    const { sanitizeRemoteFeatures } = await loadModule();
    expect(sanitizeRemoteFeatures(null)).toEqual({});
    expect(sanitizeRemoteFeatures("nope")).toEqual({});
    expect(sanitizeRemoteFeatures([1, 2])).toEqual({});
  });

  it("ignores a corrupt snapshot instead of failing to load", async () => {
    window.localStorage.setItem(`teamclu.remoteFeatures.session:${ORIGIN}`, "{not json");
    const { getFeatures } = await loadModule();
    const { buildConfig } = await import("@/lib/config/build-config");
    expect(getFeatures().apps).toBe(Boolean(buildConfig.features.apps));
  });
});

describe("origin partitioning", () => {
  it("reads the snapshot written for the current Cloud API origin", async () => {
    seed("session", { apps: true });
    const { getFeatures } = await loadModule();
    expect(getFeatures().apps).toBe(true);
  });

  it("does not inherit flags from a different server", async () => {
    seed("session", { apps: true }, "https://other.example.test");
    const { getFeatures } = await loadModule();
    // Pointing the app at another backend must not carry the previous one's
    // flags across — the storage key changes with the origin, so this holds
    // without an explicit invalidation step that could be forgotten.
    const { buildConfig } = await import("@/lib/config/build-config");
    expect(getFeatures().apps).toBe(Boolean(buildConfig.features.apps));
  });
});

describe("sign-out", () => {
  it("clears the session scope but keeps the public one", async () => {
    const { applyRemoteFeatures, clearSessionFeatures, getFeatures } = await loadModule();
    // Flip both away from whatever this build bakes, so the assertions below
    // hold for any build config.
    const baked = getFeatures();
    applyRemoteFeatures("public", { auth: { google: !baked.auth.google } });
    applyRemoteFeatures("session", { apps: !baked.apps });

    clearSessionFeatures();

    expect(getFeatures().apps).toBe(baked.apps);
    // Deployment-level login config survives: wiping it would send the next
    // launch's login screen back to the baked defaults.
    expect(getFeatures().auth.google).toBe(!baked.auth.google);
    expect(window.localStorage.getItem(`teamclu.remoteFeatures.public:${ORIGIN}`)).not.toBeNull();
    expect(window.localStorage.getItem(`teamclu.remoteFeatures.session:${ORIGIN}`)).toBeNull();
  });
});

describe("subscriptions", () => {
  it("notifies on a real change and stays quiet when the server repeats itself", async () => {
    const { applyRemoteFeatures, getFeatures, subscribeFeatures } = await loadModule();
    const flipped = !getFeatures().apps;
    const seen: number[] = [];
    const unsubscribe = subscribeFeatures(() => seen.push(1));

    applyRemoteFeatures("session", { apps: flipped });
    expect(seen.length).toBe(1);

    applyRemoteFeatures("session", { apps: flipped });
    // Re-rendering every gated surface because a poll returned the same answer
    // is pure churn.
    expect(seen.length).toBe(1);

    unsubscribe();
    applyRemoteFeatures("session", { apps: !flipped });
    expect(seen.length).toBe(1);
  });
});
