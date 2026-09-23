import type { SessionsCache } from "./session-cache";
import { groupSessionsByRecency, type SessionGroup, type SessionSummary } from "./session-types";
import { setUnreadSessionCount } from "./unread-store";

type SessionsApi = ReturnType<(typeof import("./cloud-api"))["createCloudSessionsApi"]>;

type SessionsControllerListener = () => void;

export type SessionsControllerStatus = "idle" | "loading" | "empty" | "loaded" | "error" | "refreshing";

export interface SessionsControllerState {
  status: SessionsControllerStatus;
  sessions: SessionSummary[];
  groups: SessionGroup[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
}

const INITIAL_STATE: SessionsControllerState = {
  status: "idle",
  sessions: [],
  groups: [],
  isLoading: false,
  isRefreshing: false,
  errorMessage: null,
};

function buildDerivedState(sessions: SessionSummary[]): SessionsControllerState {
  const groups = groupSessionsByRecency(sessions);

  return {
    status: sessions.length === 0 ? "empty" : "loaded",
    sessions,
    groups,
    isLoading: false,
    isRefreshing: false,
    errorMessage: null,
  };
}

function buildLoadingState(previousState: SessionsControllerState, preserveRows: boolean, refreshing: boolean): SessionsControllerState {
  return {
    status: refreshing ? "refreshing" : "loading",
    sessions: preserveRows ? previousState.sessions : [],
    groups: preserveRows ? previousState.groups : [],
    isLoading: !refreshing,
    isRefreshing: refreshing,
    errorMessage: null,
  };
}

function buildErrorState(previousState: SessionsControllerState, preserveRows: boolean, message: string): SessionsControllerState {
  return {
    status: "error",
    sessions: preserveRows ? previousState.sessions : [],
    groups: preserveRows ? previousState.groups : [],
    isLoading: false,
    isRefreshing: false,
    errorMessage: message,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export function createSessionsController(
  api: SessionsApi,
  teamId: string,
  currentActorId?: string | null,
  cache?: SessionsCache,
) {
  let state = INITIAL_STATE;
  let requestId = 0;
  let hydratedFromCache = false;
  const listeners = new Set<SessionsControllerListener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (nextState: SessionsControllerState) => {
    state = nextState;
    notify();
  };

  const beginRequest = (mode: "load" | "refresh") => {
    requestId += 1;
    const currentRequestId = requestId;
    const preserveRows = mode === "refresh" && state.sessions.length > 0;
    setState(buildLoadingState(state, preserveRows, mode === "refresh" && preserveRows));
    return { currentRequestId, preserveRows };
  };

  const isCurrentRequest = (id: number) => id === requestId;

  const hydrateFromCache = async (currentRequestId: number) => {
    if (!cache || hydratedFromCache || !teamId) return;
    hydratedFromCache = true;
    try {
      const cached = await cache.load(teamId);
      if (!cached || !isCurrentRequest(currentRequestId)) return;
      // Don't clobber rows that arrived from the network while disk I/O
      // was in flight — the network is authoritative.
      if (state.sessions.length > 0) return;
      setUnreadSessionCount(cached.filter((s) => s.hasUnread).length, teamId);
      setState(buildDerivedState(cached));
    } catch {
      // best-effort
    }
  };

  const load = async () => {
    const { currentRequestId } = beginRequest("load");

    // Kick off the cache hydration in parallel — first paint comes from
    // disk while the network fetch is still pending.
    void hydrateFromCache(currentRequestId);

    try {
      const sessions = await api.listSessions(teamId, currentActorId ?? undefined);
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setUnreadSessionCount(sessions.filter((s) => s.hasUnread).length, teamId);
      setState(buildDerivedState(sessions));
      void cache?.save(teamId, sessions);
    } catch (error) {
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      // If the cache already hydrated rows, keep them visible and just
      // surface the error message inline rather than blanking the list.
      const preserveRows = state.sessions.length > 0;
      setState(buildErrorState(state, preserveRows, toErrorMessage(error)));
    }
  };

  const refresh = async () => {
    const { currentRequestId, preserveRows } = beginRequest("refresh");

    try {
      const sessions = await api.listSessions(teamId, currentActorId ?? undefined);
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setUnreadSessionCount(sessions.filter((s) => s.hasUnread).length, teamId);
      setState(buildDerivedState(sessions));
      void cache?.save(teamId, sessions);
    } catch (error) {
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setState(buildErrorState(state, preserveRows, toErrorMessage(error)));
    }
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener: SessionsControllerListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    refresh,
  };
}
