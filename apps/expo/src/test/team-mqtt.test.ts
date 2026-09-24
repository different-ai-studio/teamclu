import { describe, expect, it, vi } from "vitest";
import type { ExpoMqttAdapter, ExpoMqttMessage } from "../lib/mqtt/expo-mqtt";
import { createTeamMqttClient } from "../lib/mqtt/team-mqtt";

function createFakeAdapter(): ExpoMqttAdapter & {
  emitMessage: (m: ExpoMqttMessage) => void;
} {
  let messageHandler: ((m: ExpoMqttMessage) => void) | null = null;
  return {
    async connect() {},
    async disconnect() {},
    async subscribe() {},
    async publish() {},
    onConnectionState: () => () => {},
    onMessage: (handler) => {
      messageHandler = handler;
      return () => {
        messageHandler = null;
      };
    },
    emitMessage(message) {
      messageHandler?.(message);
    },
  };
}

describe("TeamMqttClient", () => {
  it("fans out a message to all handlers whose filter matches the topic", async () => {
    const adapter = createFakeAdapter();
    const client = createTeamMqttClient({
      adapter,
      url: "mqtt://x",
      username: "actor",
      password: "tok",
      clientId: "client",
    });
    await client.start();

    const aHandler = vi.fn();
    const bHandler = vi.fn();
    client.subscribe("amux/t/+/runtime/+/state", aHandler);
    client.subscribe("amux/t/session/s/live", bHandler);

    const payload = new Uint8Array([1, 2, 3]);
    adapter.emitMessage({ topic: "amux/t/actor-a/runtime/r/state", payload });

    expect(aHandler).toHaveBeenCalledWith(payload, "amux/t/actor-a/runtime/r/state");
    expect(bHandler).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe that stops further deliveries", async () => {
    const adapter = createFakeAdapter();
    const client = createTeamMqttClient({
      adapter, url: "mqtt://x", username: "u", password: "p", clientId: "c",
    });
    await client.start();

    const handler = vi.fn();
    const unsubscribe = client.subscribe("amux/t/x", handler);
    unsubscribe();

    adapter.emitMessage({ topic: "amux/t/x", payload: new Uint8Array() });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createTeamMqttClient connection state", () => {
  it("tells a listener the current state, including one that subscribes after connecting", async () => {
    const { createTeamMqttClient } = await import("../lib/mqtt/team-mqtt");
    let emit: ((s: "connecting" | "connected" | "disconnected") => void) | null = null;
    const adapter = {
      connect: async () => {},
      subscribe: async () => {},
      publish: async () => {},
      disconnect: async () => {},
      onMessage: () => () => {},
      onConnectionState: (h: (s: "connecting" | "connected" | "disconnected") => void) => {
        emit = h;
        return () => {};
      },
    };
    const client = createTeamMqttClient({ adapter: adapter as never, url: "mqtt://x", username: "u", password: "p", clientId: "c" });
    await client.start();

    const seen: string[] = [];
    client.onConnectionState((s) => seen.push(s));
    expect(seen).toEqual(["connected"]);

    emit!("disconnected");
    expect(seen).toEqual(["connected", "disconnected"]);
  });
});

describe("TeamMqttClient reconnect", () => {
  function createDroppableAdapter() {
    let stateHandler: ((s: "connecting" | "connected" | "disconnected") => void) | null = null;
    const connect = vi.fn(async (_args: { options?: { password?: string } }) => {});
    const subscribe = vi.fn(async (_topic: string) => {});
    const adapter: ExpoMqttAdapter = {
      connect: connect as ExpoMqttAdapter["connect"],
      async disconnect() {},
      subscribe,
      async publish() {},
      onConnectionState: (handler) => {
        stateHandler = handler;
        return () => {};
      },
      onMessage: () => () => {},
    };
    return { adapter, connect, subscribe, drop: () => stateHandler?.("disconnected") };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("reconnects after a drop with a fresh password and restores broker subscriptions", async () => {
    const { adapter, connect, subscribe, drop } = createDroppableAdapter();
    const client = createTeamMqttClient({
      adapter, url: "mqtt://x", username: "u", password: "old", clientId: "c",
      refreshPassword: async () => "fresh",
      reconnectDelayMs: () => 0,
    });
    const states: string[] = [];
    await client.start();
    client.onConnectionState((s) => states.push(s));
    client.subscribe("amux/t/+/state", () => {});
    subscribe.mockClear();

    drop();
    await flush();
    await flush();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]![0].options?.password).toBe("fresh");
    expect(subscribe).toHaveBeenCalledWith("amux/t/+/state");
    expect(states).toEqual(["connected", "disconnected", "connected"]);
  });

  it("keeps retrying while the broker refuses, and stops once disposed", async () => {
    const { adapter, connect, drop } = createDroppableAdapter();
    const client = createTeamMqttClient({
      adapter, url: "mqtt://x", username: "u", password: "p", clientId: "c",
      reconnectDelayMs: () => 0,
    });
    await client.start();
    connect.mockRejectedValueOnce(new Error("refused"));

    drop();
    for (let i = 0; i < 4; i += 1) await flush();
    expect(connect).toHaveBeenCalledTimes(3);

    await client.dispose();
    drop();
    for (let i = 0; i < 4; i += 1) await flush();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("does not reconnect a client that never started", async () => {
    const { adapter, connect, drop } = createDroppableAdapter();
    createTeamMqttClient({
      adapter, url: "mqtt://x", username: "u", password: "p", clientId: "c",
      reconnectDelayMs: () => 0,
    });
    drop();
    await flush();
    expect(connect).not.toHaveBeenCalled();
  });
});
