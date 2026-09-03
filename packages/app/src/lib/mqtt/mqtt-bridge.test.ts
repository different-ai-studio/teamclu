import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@/lib/utils", async (orig) => ({ ...(await orig<typeof import("@/lib/utils")>()), isTauri: () => true }));

const { mqttConnect, mqttSubscribe, mqttUnsubscribe, mqttPublish, listenForEnvelopes } = await import("@/lib/mqtt/mqtt-bridge");

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("mqtt-bridge", () => {
  it("mqttConnect forwards args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttConnect({
      brokerHost: "h", brokerPort: 1883, username: "u", password: "p",
      clientId: "c", teamId: "t", useTls: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("mqtt_connect", {
      brokerHost: "h", brokerPort: 1883, username: "u", password: "p",
      clientId: "c", teamId: "t", useTls: false,
    });
  });

  it("mqttConnect forwards useTls true", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttConnect({
      brokerHost: "h", brokerPort: 8883, username: "u", password: "p",
      clientId: "c", teamId: "t", useTls: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("mqtt_connect", {
      brokerHost: "h", brokerPort: 8883, username: "u", password: "p",
      clientId: "c", teamId: "t", useTls: true,
    });
  });

  it("mqttConnect forwards a WebSocket broker URL unchanged", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttConnect({
      brokerUrl: "wss://copilot.example.test/mqtt",
      brokerHost: "copilot.example.test", brokerPort: 443, username: "u", password: "p",
      clientId: "c", teamId: "t", useTls: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("mqtt_connect", {
      brokerUrl: "wss://copilot.example.test/mqtt",
      brokerHost: "copilot.example.test", brokerPort: 443, username: "u", password: "p",
      clientId: "c", teamId: "t", useTls: true,
    });
  });

  it("mqttSubscribe forwards topic", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttSubscribe("amux/t1/session/s1/live");
    expect(invokeMock).toHaveBeenCalledWith("mqtt_subscribe", { topic: "amux/t1/session/s1/live" });
  });

  it("mqttUnsubscribe forwards topic", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttUnsubscribe("amux/t1/session/s1/live");
    expect(invokeMock).toHaveBeenCalledWith("mqtt_unsubscribe", { topic: "amux/t1/session/s1/live" });
  });

  it("mqttPublish base64-encodes the payload", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttPublish("topic", new Uint8Array([1, 2, 3]));
    expect(invokeMock).toHaveBeenCalledWith("mqtt_publish", {
      topic: "topic", payloadB64: "AQID", retain: false,
    });
  });

  it("listenForEnvelopes wires Tauri listen", async () => {
    listenMock.mockImplementation(async (_event, _cb) => () => {});
    const unlisten = await listenForEnvelopes(() => {});
    expect(typeof unlisten).toBe("function");
    expect(listenMock).toHaveBeenCalledWith("mqtt:envelopes", expect.any(Function));
  });

  it("listenForEnvelopes decodes base64 batch into Uint8Array per envelope", async () => {
    let captured: (msg: { payload: { topic: string; b64: string }[] }) => void = () => {};
    listenMock.mockImplementation(async (_event, cb) => {
      captured = cb;
      return () => {};
    });
    const received: { topic: string; bytes: Uint8Array }[] = [];
    await listenForEnvelopes((env) => received.push(env));
    // base64 of bytes [1,2,3] is "AQID"; [255] is "/w=="
    captured({
      payload: [
        { topic: "a", b64: "AQID" },
        { topic: "b", b64: "/w==" },
      ],
    });
    expect(received).toHaveLength(2);
    expect(received[0].topic).toBe("a");
    expect(Array.from(received[0].bytes)).toEqual([1, 2, 3]);
    expect(received[1].topic).toBe("b");
    expect(Array.from(received[1].bytes)).toEqual([255]);
  });

  it("listenForEnvelopes skips bad b64 and still delivers valid envelopes", async () => {
    let captured: (msg: { payload: { topic: string; b64: string }[] }) => void = () => {};
    listenMock.mockImplementation(async (_event, cb) => {
      captured = cb;
      return () => {};
    });
    const received: { topic: string; bytes: Uint8Array }[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listenForEnvelopes((env) => received.push(env));
    captured({
      payload: [
        { topic: "bad", b64: "!!!not-base64!!!" },
        { topic: "ok", b64: "AQID" },
      ],
    });
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe("ok");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
