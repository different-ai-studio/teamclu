import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLocalDaemonSignalCacheForTest,
  mergeAgentDevicePresence,
  noteLocalDaemonSignals,
  presenceOnlineFlag,
  resolveAgentDevicePresenceSync,
} from "@/lib/agent/agent-device-reachability";
import { __resetLocalDaemonIdentityForTest, noteLocalDaemonActorId } from "@/lib/daemon/local-daemon-identity";
import { useActorPresenceStore } from "@/stores/actor-presence-store";

describe("mergeAgentDevicePresence", () => {
  it("returns online when MQTT says online for a remote agent", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: true,
        isLocalDaemon: false,
      }),
    ).toBe("online");
  });

  it("returns offline for remote agents when MQTT says offline", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: false,
        isLocalDaemon: false,
        daemonMqttConnected: true,
        localHttpOk: true,
      }),
    ).toBe("offline");
  });

  it("overrides stale offline retain when local daemon mqtt is connected", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: false,
        isLocalDaemon: true,
        daemonMqttConnected: true,
      }),
    ).toBe("online");
  });

  it("overrides ghost online retain when local daemon mqtt is down", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: true,
        isLocalDaemon: true,
        daemonMqttConnected: false,
        localHttpOk: true,
      }),
    ).toBe("offline");
  });

  it("keeps offline when local daemon mqtt reports disconnected", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: false,
        isLocalDaemon: true,
        daemonMqttConnected: false,
        localHttpOk: true,
      }),
    ).toBe("offline");
  });

  it("returns unknown for local daemon when offline retain and only HTTP is up", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: false,
        isLocalDaemon: true,
        daemonMqttConnected: null,
        localHttpOk: true,
      }),
    ).toBe("unknown");
  });

  it("bootstraps local daemon to online when retain is missing and HTTP is up", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: undefined,
        isLocalDaemon: true,
        localHttpOk: true,
      }),
    ).toBe("online");
  });

  it("returns unknown when retain is missing for a remote agent", () => {
    expect(
      mergeAgentDevicePresence({
        mqttOnline: undefined,
        isLocalDaemon: false,
      }),
    ).toBe("unknown");
  });
});

describe("resolveAgentDevicePresenceSync", () => {
  beforeEach(() => {
    __resetLocalDaemonSignalCacheForTest();
    __resetLocalDaemonIdentityForTest();
    useActorPresenceStore.setState({ byActorId: {} });
  });

  it("maps MQTT online/offline for remote agents", () => {
    useActorPresenceStore.getState().upsert("remote", {
      online: true,
      displayName: "r",
      lastUpdated: Date.now(),
    });
    expect(resolveAgentDevicePresenceSync("remote")).toBe("online");
    expect(presenceOnlineFlag("online")).toBe(true);

    useActorPresenceStore.getState().upsert("remote", {
      online: false,
      displayName: "r",
      lastUpdated: Date.now(),
    });
    expect(resolveAgentDevicePresenceSync("remote")).toBe("offline");
  });

  it("uses cached local daemon mqtt to override stale offline retain", () => {
    noteLocalDaemonActorId("local-agent");
    noteLocalDaemonSignals({ actorId: "local-agent", daemonMqttConnected: true });
    useActorPresenceStore.getState().upsert("local-agent", {
      online: false,
      displayName: "b001",
      lastUpdated: Date.now(),
    });
    expect(resolveAgentDevicePresenceSync("local-agent")).toBe("online");
  });
});

describe("resolveAgentDevicePresence fast-path", () => {
  beforeEach(() => {
    __resetLocalDaemonSignalCacheForTest();
    __resetLocalDaemonIdentityForTest();
    useActorPresenceStore.setState({ byActorId: {} });
  });

  it("returns sync online immediately for a known-remote agent", async () => {
    const { resolveAgentDevicePresence } = await import("@/lib/agent/agent-device-reachability");
    noteLocalDaemonActorId("local-agent");
    useActorPresenceStore.getState().upsert("remote", {
      online: true,
      displayName: "r",
      lastUpdated: Date.now(),
    });
    await expect(resolveAgentDevicePresence("remote", { timeoutMs: 2_000 })).resolves.toBe("online");
  });
});
