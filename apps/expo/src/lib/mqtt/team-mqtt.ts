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
  /**
   * Fresh broker password for a reconnect. The password is the Supabase access
   * token, which expires, so a reconnect an hour in must not reuse the one the
   * client started with. Falls back to `password`.
   */
  refreshPassword?: () => Promise<string | null>;
  /** Reconnect delay for the given attempt (1-based). Tests pass 0. */
  reconnectDelayMs?: (attempt: number) => number;
};

const MAX_RECONNECT_DELAY_MS = 30_000;

function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
}

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
  // The broker drops a connection for plenty of ordinary reasons — a network
  // switch, the app backgrounded, another client taking the id — and nothing
  // below the adapter reconnects, so a dropped client stayed offline until the
  // app was restarted. Once `start()` has connected, a drop schedules a
  // reconnect with backoff until it succeeds or the client is disposed.
  let started = false;
  let disposed = false;
  let reconnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const reconnectDelayMs = deps.reconnectDelayMs ?? defaultReconnectDelayMs;

  const connectOnce = async (password: string) => {
    await adapter.connect({
      url: deps.url,
      options: {
        clientId: deps.clientId,
        username: deps.username,
        password,
        clean: true,
        reconnectPeriod: 0,
      },
    });
  };

  const scheduleReconnect = () => {
    if (!started || disposed || reconnecting || reconnectTimer) return;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, reconnectDelayMs(reconnectAttempt));
  };

  const reconnect = async () => {
    if (disposed) return;
    reconnecting = true;
    try {
      const password = (await deps.refreshPassword?.().catch(() => null)) ?? deps.password;
      if (disposed) return;
      await connectOnce(password);
      if (disposed) {
        await adapter.disconnect().catch(() => {});
        return;
      }
      reconnectAttempt = 0;
      setConnectionState("connected");
      // A new connection starts with no subscriptions (clean session).
      for (const filter of brokerSubscriptions) {
        void adapter.subscribe(filter).catch(() => {});
      }
    } catch {
      setConnectionState("disconnected");
      reconnecting = false;
      scheduleReconnect();
      return;
    }
    reconnecting = false;
  };

  adapter.onConnectionState((next) => {
    setConnectionState(next);
    if (next === "disconnected") scheduleReconnect();
  });

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
      await connectOnce(deps.password);
      // A resolved connect is a connection, whether or not the adapter said so.
      setConnectionState("connected");
      started = true;
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
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      messageUnsubscribe?.();
      messageUnsubscribe = null;
      handlers.clear();
      brokerSubscriptions.clear();
      await adapter.disconnect();
    },
  };
}
