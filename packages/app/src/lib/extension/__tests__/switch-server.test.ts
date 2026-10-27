import { beforeEach, describe, expect, it, vi } from "vitest";

describe("switchExtensionServer", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.stubEnv("VITE_CLOUD_API_URL", "https://official.example.com");
    vi.stubEnv("VITE_MQTT_WS_URL", "wss://official-mqtt.example.com/mqtt");
  });

  it("signs out, drops the previous broker, then reloads onto the custom server", async () => {
    localStorage.setItem(
      "teamclu.serverConfig",
      JSON.stringify({
        mqttHost: "old-broker.example.com",
        mqttPort: 1883,
        mqttUsername: "old-user",
        webSsoLoginUrl: "https://sso.old.example.com",
      }),
    );

    const { switchExtensionServer } = await import("@/lib/extension/switch-server");
    const { getCloudApiUrlOverride, getEffectiveServerConfigSync } = await import(
      "@/lib/config/server-config"
    );
    const overrideDuringSignOut: Array<string | null> = [];
    const signOut = vi.fn(async () => {
      overrideDuringSignOut.push(getCloudApiUrlOverride());
    });
    const reload = vi.fn();

    await switchExtensionServer({
      url: "https://custom.example.com/",
      signedIn: true,
      signOut,
      reload,
    });

    expect(overrideDuringSignOut).toEqual([null]);

    expect(signOut).toHaveBeenCalledOnce();
    expect(getCloudApiUrlOverride()).toBe("https://custom.example.com");
    expect(localStorage.getItem("teamclu.serverConfig")).toBeNull();
    const config = getEffectiveServerConfigSync();
    expect(config.cloudApiUrl).toBe("https://custom.example.com");
    expect(config.mqttHost).toBeUndefined();
    expect(config.webSsoLoginUrl).toBeUndefined();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("returns to the baked broker when the official server is chosen", async () => {
    const { setCloudApiUrlOverride, getEffectiveServerConfigSync } = await import(
      "@/lib/config/server-config"
    );
    setCloudApiUrlOverride("https://custom.example.com");
    localStorage.setItem(
      "teamclu.serverConfig",
      JSON.stringify({ mqttHost: "custom-broker.example.com", mqttPort: 443, mqttUseTls: true }),
    );

    const { switchExtensionServer } = await import("@/lib/extension/switch-server");
    const signOut = vi.fn(async () => {});
    const reload = vi.fn();

    await switchExtensionServer({ url: null, signedIn: false, signOut, reload });

    expect(signOut).not.toHaveBeenCalled();
    const config = getEffectiveServerConfigSync();
    expect(config.cloudApiUrl).toBe("https://official.example.com");
    expect(config.mqttHost).toBe("official-mqtt.example.com");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("treats the baked URL typed into the custom field as the official server", async () => {
    const { setCloudApiUrlOverride } = await import("@/lib/config/server-config");
    setCloudApiUrlOverride("https://custom.example.com");

    const { switchExtensionServer } = await import("@/lib/extension/switch-server");
    const reload = vi.fn();

    await switchExtensionServer({
      url: "https://official.example.com/",
      signedIn: false,
      reload,
    });

    const { getCloudApiUrlOverride } = await import("@/lib/config/server-config");
    expect(getCloudApiUrlOverride()).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing when the target is already in effect", async () => {
    const { switchExtensionServer } = await import("@/lib/extension/switch-server");
    const signOut = vi.fn(async () => {});
    const reload = vi.fn();

    const result = await switchExtensionServer({
      url: "https://official.example.com",
      signedIn: true,
      signOut,
      reload,
    });

    expect(result).toBe("unchanged");
    expect(signOut).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("rejects an unusable URL before signing out", async () => {
    const { switchExtensionServer } = await import("@/lib/extension/switch-server");
    const signOut = vi.fn(async () => {});
    const reload = vi.fn();

    await expect(
      switchExtensionServer({ url: "not a url", signedIn: true, signOut, reload }),
    ).rejects.toThrow(/http/);
    expect(signOut).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
