import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";

export interface IncomingEnvelope {
  topic: string;
  bytes: Uint8Array;
}

interface RawBatchedEnvelope {
  topic: string;
  b64: string;
}

export async function mqttConnect(args: {
  brokerUrl?: string;
  brokerHost: string;
  brokerPort: number;
  username: string;
  password: string;
  clientId: string;
  teamId: string;
  useTls: boolean;
}): Promise<void> {
  await invoke("mqtt_connect", {
    ...(args.brokerUrl ? { brokerUrl: args.brokerUrl } : {}),
    brokerHost: args.brokerHost,
    brokerPort: args.brokerPort,
    username: args.username,
    password: args.password,
    clientId: args.clientId,
    teamId: args.teamId,
    useTls: args.useTls,
  });
}

export async function mqttSubscribe(topic: string): Promise<void> {
  await invoke("mqtt_subscribe", { topic });
}

export async function mqttUnsubscribe(topic: string): Promise<void> {
  await invoke("mqtt_unsubscribe", { topic });
}

export async function mqttPublish(topic: string, bytes: Uint8Array, retain = false): Promise<void> {
  // PERF-16: base64, not `Array.from(bytes)` — a `Vec<u8>` argument is a JSON
  // array of decimal numbers on the wire, three to four times the payload.
  await invoke("mqtt_publish", {
    topic,
    payloadB64: bytesToBase64(bytes),
    retain,
  });
}

export async function mqttStatus(): Promise<{ connected: boolean; subscribedTopics: string[] }> {
  const raw = await invoke<{
    connected: boolean
    subscribed_topics?: string[]
    subscribedTopics?: string[]
  }>("mqtt_status");
  return {
    connected: raw.connected,
    subscribedTopics: raw.subscribedTopics ?? raw.subscribed_topics ?? [],
  };
}

/** Local daemon SSE fast-path status (`daemon-live:connected` from Rust). */
export async function listenForDaemonLiveStatus(
  handler: (connected: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("daemon-live:connected", (msg) => handler(msg.payload));
}

export async function listenForEnvelopes(
  handler: (env: IncomingEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<RawBatchedEnvelope[]>("mqtt:envelopes", (msg) => {
    for (const raw of msg.payload) {
      try {
        handler({ topic: raw.topic, bytes: base64ToBytes(raw.b64) });
      } catch (e) {
        console.warn("[mqtt-bridge] skipping bad envelope b64:", raw.topic, e);
      }
    }
  });
}
