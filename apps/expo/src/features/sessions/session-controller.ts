import type { SessionsCache } from "./session-cache";
import { groupSessionsByRecency, type SessionGroup, type SessionSummary } from "./session-types";
import { unreadBadgeCount } from "../notifications/app-icon-badge";
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

  const beginRequest = (mode: "load" | "refresh", quiet = false) => {
    requestId += 1;
    const currentRequestId = requestId;
    const preserveRows = mode === "refresh" && state.sessions.length > 0;
    // A quiet refresh over rows already on screen changes nothing until the
    // answer lands: no "refreshing" state, so no pull-to-refresh spinner.
    if (!(quiet && preserveRows)) {
      setState(buildLoadingState(state, preserveRows, mode === "refresh" && preserveRows));
    }
    return { currentRequestId, preserveRows };
  };

  const isCurrentRequest = (id: number) => id === requestId;

  const hydrateFromCache = async () => {
    if (!cache || hydratedFromCache || !teamId) return;
    hydratedFromCache = true;
    try {
      const cached = await cache.load(teamId);
      // Not gated on the request id: launch fires `load` and the focus
      // effect's quiet `refresh` together, and the refresh made this result
      // "stale" — so the cached rows were dropped and the list sat on its
      // skeleton until the network answered. The controller serves one team,
      // so cached rows are never another team's; the one thing to avoid is
      // clobbering rows the network already delivered.
      if (!cached || cached.length === 0) return;
      if (state.sessions.length > 0) return;
      setUnreadSessionCount(unreadBadgeCount(cached, teamId), teamId);
      setState(buildDerivedState(cached));
    } catch {
      // best-effort
    }
  };

  const load = async () => {
    const { currentRequestId } = beginRequest("load");

    // Kick off the cache hydration in parallel — first paint comes from
    // disk while the network fetch is still pending.
    void hydrateFromCache();

    try {
      const sessions = await api.listSessions(teamId, currentActorId ?? undefined);
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setUnreadSessionCount(unreadBadgeCount(sessions, teamId), teamId);
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

  /**
   * `quiet`: a background refresh (the list regained focus, a message
   * arrived). It must not drive the pull-to-refresh control — set while the
   * screen is mid-transition, iOS shows the spinner and never takes it down.
   * Only a pull by hand shows it.
   */
  const refresh = async (options?: { quiet?: boolean }) => {
    const { currentRequestId, preserveRows } = beginRequest("refresh", options?.quiet === true);

    try {
      const sessions = await api.listSessions(teamId, currentActorId ?? undefined);
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setUnreadSessionCount(unreadBadgeCount(sessions, teamId), teamId);
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
