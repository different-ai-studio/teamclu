import { createExpoMqttAdapter, type ExpoMqttAdapter } from "./expo-mqtt";
import { topicMatches } from "./topic-match";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type TopicHandler = (payload: Uint8Array, topic: string) => void;

export type TeamMqttClient = {
  start: () => Promise<void>;
  subscribe: (filter: string, handler: TopicHandler) => () => void;
  publish: (topic: string, payload: Uint8Array, retain?: boolean) => Promise<void>;
  onConnectionState: (listener: (state: ConnectionState) => void) => () => void;
  dispose: () => Promise<void>;
};

type Deps = {
  adapter?: ExpoMqttAdapter;
  url: string;
  username: string;
  password: string;
  clientId: string;
};

export function createTeamMqttClient(deps: Deps): TeamMqttClient {
  const adapter = deps.adapter ?? createExpoMqttAdapter();
  const handlers = new Map<string, Set<TopicHandler>>();
  const brokerSubscriptions = new Set<string>();
  let messageUnsubscribe: (() => void) | null = null;
  // The current state, replayed to every new listener. Screens subscribe after
  // `start()` has already connected; forwarding only future changes left the
  // daemon pill (and session detail) on "disconnected" for a live connection.
  let connectionState: ConnectionState = "disconnected";
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const setConnectionState = (next: ConnectionState) => {
    if (next === connectionState) return;
    connectionState = next;
    for (const listener of stateListeners) listener(next);
  };
  adapter.onConnectionState(setConnectionState);

  function dispatch(message: { topic: string; payload: Uint8Array }) {
    for (const [filter, set] of handlers) {
      if (topicMatches(filter, message.topic)) {
        for (const handler of set) {
          handler(message.payload, message.topic);
        }
      }
    }
  }

  return {
    async start() {
      messageUnsubscribe = adapter.onMessage(dispatch);
      await adapter.connect({
        url: deps.url,
        options: {
          clientId: deps.clientId,
          username: deps.username,
          password: deps.password,
          clean: true,
          reconnectPeriod: 0,
        },
      });
      // A resolved connect is a connection, whether or not the adapter said so.
      setConnectionState("connected");
    },
    subscribe(filter, handler) {
      let set = handlers.get(filter);
      if (!set) {
        set = new Set();
        handlers.set(filter, set);
      }
      set.add(handler);

      if (!brokerSubscriptions.has(filter)) {
        brokerSubscriptions.add(filter);
        void adapter.subscribe(filter).catch(() => {
          // best-effort; surface via connection state if needed
        });
      }

      return () => {
        const current = handlers.get(filter);
        current?.delete(handler);
        if (current && current.size === 0) {
          handlers.delete(filter);
          // Note: we don't unsubscribe from the broker on the last handler
          // removal because the same filter often comes back moments later
          // (route re-entry). Broker subs are torn down on dispose.
        }
      };
    },
    publish(topic, payload, retain = false) {
      return adapter.publish(topic, payload, retain);
    },
    onConnectionState(listener) {
      stateListeners.add(listener);
      listener(connectionState);
      return () => {
        stateListeners.delete(listener);
      };
    },
    async dispose() {
      messageUnsubscribe?.();
      messageUnsubscribe = null;
      handlers.clear();
      brokerSubscriptions.clear();
      await adapter.disconnect();
    },
  };
}
