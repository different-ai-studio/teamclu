import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server config", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves cloudApiUrl from the build config / env, never from the bootstrap cache", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://build.example.com");

    const { getEffectiveServerConfig, getEffectiveServerConfigSync, saveServerConfig } = await import(
      "@/lib/config/server-config"
    );

    // A persisted cloudApiUrl must be ignored — the build config is the single
    // source of truth, so a stale value can never shadow it.
    await saveServerConfig({ cloudApiUrl: "https://stale.example.com" });

    expect(getEffectiveServerConfigSync().cloudApiUrl).toBe("https://build.example.com");
    expect((await getEffectiveServerConfig()).cloudApiUrl).toBe("https://build.example.com");
  });

  it("an explicit cloudApiUrl override wins over the build config / env", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://build.example.com");

    const { getEffectiveServerConfigSync, setCloudApiUrlOverride, getCloudApiUrlOverride } =
      await import("@/lib/config/server-config");

    setCloudApiUrlOverride("https://self-hosted.example.com/");

    // Trailing slash is normalized away so the value matches what callers build
    // base URLs from.
    expect(getCloudApiUrlOverride()).toBe("https://self-hosted.example.com");
    expect(getEffectiveServerConfigSync().cloudApiUrl).toBe("https://self-hosted.example.com");
  });

  it("clearing the override falls back to the build config", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://build.example.com");

    const { getEffectiveServerConfigSync, setCloudApiUrlOverride } = await import("@/lib/config/server-config");

    setCloudApiUrlOverride("https://self-hosted.example.com");
    setCloudApiUrlOverride(null);

    expect(getEffectiveServerConfigSync().cloudApiUrl).toBe("https://build.example.com");
  });

  it("rejects a cloudApiUrl override that is not an http(s) URL", async () => {
    const { setCloudApiUrlOverride, getCloudApiUrlOverride } = await import("@/lib/config/server-config");

    expect(() => setCloudApiUrlOverride("not a url")).toThrow();
    expect(() => setCloudApiUrlOverride("ftp://example.com")).toThrow();
    // A rejected value must not be persisted.
    expect(getCloudApiUrlOverride()).toBeNull();
  });

  it("the bootstrap cache cannot write a cloudApiUrl override", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://build.example.com");

    const { getEffectiveServerConfigSync, saveServerConfig } = await import("@/lib/config/server-config");

    // saveServerConfig is the bootstrap path; only setCloudApiUrlOverride may
    // touch the backend URL, so this must not shadow the build config.
    await saveServerConfig({ cloudApiUrl: "https://sneaky.example.com" });

    expect(getEffectiveServerConfigSync().cloudApiUrl).toBe("https://build.example.com");
  });

  it("persists MQTT broker config delivered by bootstrap", async () => {
    const { getEffectiveServerConfigSync, saveServerConfig } = await import("@/lib/config/server-config");

    await saveServerConfig({
      mqttHost: " mqtt.example.com ",
      mqttPort: 1883,
      mqttUseTls: false,
    });

    const config = getEffectiveServerConfigSync();
    expect(config.mqttHost).toBe("mqtt.example.com");
    expect(config.mqttPort).toBe(1883);
    expect(config.mqttUseTls).toBe(false);
  });

  it("VITE_MQTT_WS_URL override wins over bootstrap-cached host/port/tls", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "ws://ai.ucar.cc:8083/mqtt");

    localStorage.setItem(
      "teamclu.serverConfig",
      JSON.stringify({
        mqttHost: "bootstrap.example.com",
        mqttPort: 1883,
        mqttUseTls: false,
        mqttUsername: "user1",
        mqttPassword: "pass1",
      }),
    );

    const { getEffectiveServerConfigSync } = await import("@/lib/config/server-config");
    const config = getEffectiveServerConfigSync();

    // Override wins for connection params
    expect(config.mqttHost).toBe("ai.ucar.cc");
    expect(config.mqttPort).toBe(8083);
    expect(config.mqttUseTls).toBe(false);
    // Credentials still come from bootstrap cache
    expect(config.mqttUsername).toBe("user1");
    expect(config.mqttPassword).toBe("pass1");
  });

  it("VITE_MQTT_WS_URL with wss:// sets mqttUseTls to true", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "wss://ai.ucar.cc:8084/mqtt");

    const { getEffectiveServerConfigSync } = await import("@/lib/config/server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttHost).toBe("ai.ucar.cc");
    expect(config.mqttPort).toBe(8084);
    expect(config.mqttUseTls).toBe(true);
  });

  it("VITE_MQTT_WS_URL without a port defaults to 443 for wss (reverse proxy)", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "wss://mqtt.teamclu-dev.ucar.cc/mqtt");

    localStorage.setItem(
      "teamclu.serverConfig",
      JSON.stringify({ mqttHost: "mqtt.teamclu-dev.ucar.cc", mqttPort: 1883, mqttUseTls: false }),
    );

    const { getEffectiveServerConfigSync } = await import("@/lib/config/server-config");
    const config = getEffectiveServerConfigSync();

    // Must NOT inherit the bootstrap TCP port (1883); a portless wss URL means 443.
    expect(config.mqttHost).toBe("mqtt.teamclu-dev.ucar.cc");
    expect(config.mqttPort).toBe(443);
    expect(config.mqttUseTls).toBe(true);
  });

  it("VITE_MQTT_WS_URL without a port defaults to 80 for ws", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "ws://broker.local/mqtt");

    const { getEffectiveServerConfigSync } = await import("@/lib/config/server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttPort).toBe(80);
    expect(config.mqttUseTls).toBe(false);
  });


  it("without VITE_MQTT_WS_URL, bootstrap-cached values still win over env", async () => {
    vi.stubEnv("VITE_MQTT_HOST", "env.example.com");
    vi.stubEnv("VITE_MQTT_PORT", "9999");

    localStorage.setItem(
      "teamclu.serverConfig",
      JSON.stringify({
        mqttHost: "bootstrap.example.com",
        mqttPort: 1883,
        mqttUseTls: false,
      }),
    );

    const { getEffectiveServerConfigSync } = await import("@/lib/config/server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttHost).toBe("bootstrap.example.com");
    expect(config.mqttPort).toBe(1883);
  });

  it("does not fall back to env MQTT credentials when saved config explicitly clears them", async () => {
    vi.stubEnv("VITE_MQTT_USERNAME", "teamclu");
    vi.stubEnv("VITE_MQTT_PASSWORD", "teamclu2026");

    localStorage.setItem(
      "teamclu.serverConfig",
      JSON.stringify({
        mqttHost: "ai.ucar.cc",
        mqttPort: 1883,
        mqttUseTls: false,
        mqttUsername: null,
        mqttPassword: null,
      }),
    );

    const { getEffectiveServerConfigSync } = await import("@/lib/config/server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttUsername).toBeUndefined();
    expect(config.mqttPassword).toBeUndefined();
  });

  // Both onboarding footers and the server-entry row print the address, and
  // they have to agree on what it looks like.
  it("prints a Cloud API URL without its scheme or trailing slashes", async () => {
    const { displayHost } = await import("@/lib/config/server-config");

    expect(displayHost("https://api.example.com/")).toBe("api.example.com");
    expect(displayHost("http://127.0.0.1:9000")).toBe("127.0.0.1:9000");
    expect(displayHost("https://host.example.com:8443/gateway//")).toBe(
      "host.example.com:8443/gateway",
    );
  });
});
