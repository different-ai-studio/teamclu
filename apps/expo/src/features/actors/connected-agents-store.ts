import type { AgentAccessApi } from "./agent-access-api";
import type { ConnectedAgentsCache } from "./connected-agents-cache";
import type { ActorPresenceSnapshot } from "./actor-presence";
import type { ConnectedAgent } from "./connected-agent-types";

export type ConnectedAgentsStoreState = {
  agents: ConnectedAgent[];
  /**
   * Each agent's retained `ActorPresence`. Per-session runtime facts come from
   * `runtimeInfoByAgentForSession(presenceByAgentId, sessionId)`: an agent can
   * hold attachments for several sessions at once, so there is no single
   * "the agent's runtime" any more.
   */
  presenceByAgentId: ReadonlyMap<string, ActorPresenceSnapshot>;
  isLoading: boolean;
  errorMessage: string | null;
};

type Subscriber = {
  watchActor: (actorId: string) => void;
  unwatchActor: (actorId: string) => void;
  watchedActors: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  teamId: string;
  api: Pick<AgentAccessApi, "listConnectedAgents" | "shareAgentToTeam" | "makeAgentPersonal">;
  subscriber: Subscriber;
  cache?: ConnectedAgentsCache;
};

export type ConnectedAgentsStore = {
  subscribe: (listener: () => void) => () => void;
  getState: () => ConnectedAgentsStoreState;
  reload: () => Promise<void>;
  shareToTeam: (agentId: string) => Promise<boolean>;
  makePersonal: (agentId: string) => Promise<boolean>;
  handlePresence: (actorId: string, presence: ActorPresenceSnapshot) => void;
  dispose: () => Promise<void>;
};

const EMPTY_MAP: ReadonlyMap<string, ActorPresenceSnapshot> = new Map();

export function createConnectedAgentsStore(deps: Deps): ConnectedAgentsStore {
  let state: ConnectedAgentsStoreState = {
    agents: [],
    presenceByAgentId: EMPTY_MAP,
    isLoading: false,
    errorMessage: null,
  };
  const listeners = new Set<() => void>();

  function setState(next: ConnectedAgentsStoreState) {
    state = next;
    for (const l of listeners) l();
  }

  function diffWatches(prev: ConnectedAgent[], next: ConnectedAgent[]) {
    // An agent's runtime-state topic is keyed by its actor id (== agentId).
    const prevActors = new Set(prev.map((a) => a.agentId).filter(Boolean) as string[]);
    const nextActors = new Set(next.map((a) => a.agentId).filter(Boolean) as string[]);
    for (const id of prevActors) if (!nextActors.has(id)) deps.subscriber.unwatchActor(id);
    for (const id of nextActors) if (!prevActors.has(id)) deps.subscriber.watchActor(id);
  }

  const store: ConnectedAgentsStore = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() { return state; },
    async reload() {
      setState({ ...state, isLoading: true, errorMessage: null });
      try {
        const fetched = await deps.api.listConnectedAgents(deps.teamId);
        // Keep what the broker has already said about who is online; the
        // list endpoint only knows `lastActiveAt`.
        const agents = fetched.map((a) => {
          const presence = state.presenceByAgentId.get(a.agentId);
          return presence ? { ...a, presenceOnline: presence.online } : a;
        });
        diffWatches(state.agents, agents);
        setState({ ...state, agents, isLoading: false, errorMessage: null });
        void deps.cache?.saveCache(deps.teamId, agents);
      } catch (err) {
        setState({
          ...state,
          isLoading: false,
          errorMessage: err instanceof Error ? err.message : "Couldn't load agents.",
        });
      }
    },
    async shareToTeam(agentId: string) {
      try {
        await deps.api.shareAgentToTeam(agentId);
        await store.reload();
        return true;
      } catch (err) {
        setState({ ...state, errorMessage: err instanceof Error ? err.message : "Failed." });
        return false;
      }
    },
    async makePersonal(agentId: string) {
      try {
        await deps.api.makeAgentPersonal(agentId);
        await store.reload();
        return true;
      } catch (err) {
        setState({ ...state, errorMessage: err instanceof Error ? err.message : "Failed." });
        return false;
      }
    },
    handlePresence(actorId: string, presence: ActorPresenceSnapshot) {
      const agentIdx = state.agents.findIndex((a) => a.agentId === actorId);
      if (agentIdx < 0) return;
      const next = state.agents.slice();
      next[agentIdx] = {
        ...next[agentIdx],
        presenceOnline: presence.online,
        ...(presence.online ? { lastActiveAt: new Date().toISOString() } : {}),
      };
      const map = new Map(state.presenceByAgentId);
      map.set(actorId, presence);
      setState({ ...state, agents: next, presenceByAgentId: map });
    },
    async dispose() {
      deps.subscriber.dispose();
      listeners.clear();
    },
  };
  return store;
}
