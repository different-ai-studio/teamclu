import {
  activityOf,
  applySignal,
  decodeLiveSignal,
  expireStaleRun,
  initialActivityState,
  isHot,
  type SessionActivityState,
  type SessionLiveActivity,
} from "./live-activity";

type Mqtt = {
  subscribe: (topic: string, handler: (payload: Uint8Array, topic: string) => void) => () => void;
};

type Deps = {
  mqtt: Mqtt;
  teamId: string;
  now?: () => number;
  quietGraceMs?: number;
  runWatchdogMs?: number;
  maxSubscriptions?: number;
};

export type LiveActivityStore = {
  /** The dot for a session; "quiet" for anything not being listened to. */
  activity: (sessionId: string) => SessionLiveActivity;
  /** Only sessions whose dot is lit — changes when a dot changes colour. */
  litSessions: () => ReadonlyMap<string, SessionLiveActivity>;
  subscribe: (listener: () => void) => () => void;
  /** An inbox ping or a prompt from this device: start (or keep) listening. */
  noteActivity: (sessionId: string) => void;
  /** Cold start: listen to the most recently active sessions. */
  seed: (sessionIds: ReadonlyArray<string>) => void;
  /** Expire stale runs and release quiet sessions. Runs on a timer. */
  sweep: () => void;
  dispose: () => void;
};

export function sessionLiveTopic(teamId: string, sessionId: string): string {
  return `amux/${teamId}/session/${sessionId}/live`;
}

/**
 * iOS `SessionLiveActivityStore`. `session/live` isn't retained, so this only
 * knows what arrived while subscribed — and subscribing to every session would
 * pull every agent's full output stream onto the phone for a 6pt dot. The set
 * is kept small and hot instead.
 */
export function createLiveActivityStore(deps: Deps): LiveActivityStore {
  const now = deps.now ?? Date.now;
  const quietGraceMs = deps.quietGraceMs ?? 120_000;
  const runWatchdogMs = deps.runWatchdogMs ?? 90_000;
  const maxSubscriptions = deps.maxSubscriptions ?? 32;

  const states = new Map<string, SessionActivityState>();
  const unsubscribes = new Map<string, () => void>();
  let lit = new Map<string, SessionLiveActivity>();
  const listeners = new Set<() => void>();

  const publish = (sessionId: string) => {
    const next = activityOf(states.get(sessionId));
    if ((lit.get(sessionId) ?? "quiet") === next) return;
    lit = new Map(lit);
    if (next === "quiet") lit.delete(sessionId);
    else lit.set(sessionId, next);
    for (const listener of listeners) listener();
  };

  const release = (sessionId: string) => {
    unsubscribes.get(sessionId)?.();
    unsubscribes.delete(sessionId);
    states.delete(sessionId);
    publish(sessionId);
  };

  const coldestReleasable = (): string | null => {
    let coldest: string | null = null;
    let coldestAt = Infinity;
    for (const id of unsubscribes.keys()) {
      const state = states.get(id);
      if (state && (state.isRunning || state.pendingRequestIds.size > 0)) continue;
      const at = state?.lastSignalAt ?? 0;
      if (at < coldestAt) {
        coldest = id;
        coldestAt = at;
      }
    }
    return coldest;
  };

  const ensureSubscribed = (sessionId: string) => {
    if (!sessionId) return;
    if (!unsubscribes.has(sessionId)) {
      if (unsubscribes.size >= maxSubscriptions) {
        const victim = coldestReleasable();
        if (!victim) return;
        release(victim);
      }
      unsubscribes.set(
        sessionId,
        deps.mqtt.subscribe(sessionLiveTopic(deps.teamId, sessionId), (payload) => {
          const signal = decodeLiveSignal(payload);
          if (!signal) return;
          const state = states.get(sessionId) ?? initialActivityState(now());
          states.set(sessionId, applySignal(state, signal, now()));
          publish(sessionId);
        }),
      );
    }
    // Stamp the quiet timer either way, so a fresh subscription isn't swept
    // straight back out before its first message.
    const state = states.get(sessionId) ?? initialActivityState(now());
    states.set(sessionId, { ...state, lastSignalAt: now() });
  };

  const store: LiveActivityStore = {
    activity: (sessionId) => lit.get(sessionId) ?? "quiet",
    litSessions: () => lit,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    noteActivity: ensureSubscribed,
    seed(sessionIds) {
      for (const id of sessionIds.slice(0, maxSubscriptions)) ensureSubscribed(id);
    },
    sweep() {
      const t = now();
      for (const [id, state] of states) {
        const expired = expireStaleRun(state, t, runWatchdogMs);
        if (expired) {
          states.set(id, expired);
          publish(id);
        }
      }
      for (const id of [...unsubscribes.keys()]) {
        const state = states.get(id);
        if (!state || !isHot(state, t, quietGraceMs)) release(id);
      }
    },
    dispose() {
      for (const off of unsubscribes.values()) off();
      unsubscribes.clear();
      states.clear();
      lit = new Map();
      listeners.clear();
    },
  };
  return store;
}

// The session detail screen reports prompts sent from this device, which the
// inbox ping never covers (FC excludes the sender). One store per signed-in
// team, owned by the sessions list route.
let active: LiveActivityStore | null = null;
export function setActiveLiveActivityStore(store: LiveActivityStore | null): void {
  active = store;
}
export function noteLocalPrompt(sessionId: string): void {
  active?.noteActivity(sessionId);
}
