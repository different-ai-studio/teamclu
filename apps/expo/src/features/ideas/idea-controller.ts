import { createIdeasApi } from "./idea-api";
import { applyLikeState, createLikeSequencer, likeStateOf } from "./idea-likes";
import {
  compareIdeas,
  initialIdeasListState,
  sortOrderForIndex,
  type Idea,
  type IdeasListState,
} from "./idea-types";

type IdeasApi = ReturnType<typeof createIdeasApi>;

export type IdeasController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => IdeasListState;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Renumber `sortOrder` from the given id order and re-sort, so a reorder
   * shows up before the round-trip lands. Mirrors the optimistic half of iOS
   * `IdeaStore.moveIdeas`; the caller reverts by refreshing on failure.
   */
  applyReorder: (orderedIds: ReadonlyArray<string>) => void;
  /**
   * Like or unlike, optimistically (iOS `IdeaStore.setLiked`): the count
   * moves at once, the server's answer corrects it, a failure restores the
   * old values and resolves to the error message for the caller to surface
   * (null on success). Sends the desired state, not a toggle. Never touches
   * the cache — counts are not persisted.
   */
  setLiked: (ideaId: string, liked: boolean) => Promise<string | null>;
};

/** The slice of `TeamCache<CachedIdea>` this controller needs. */
export type IdeasCache = {
  load: (teamId: string) => Promise<Idea[] | null>;
  save: (teamId: string, ideas: ReadonlyArray<Idea>) => Promise<void>;
};

export function createIdeasController(
  api: Pick<IdeasApi, "listIdeas" | "setLike">,
  teamId: string,
  cache?: IdeasCache,
): IdeasController {
  let state: IdeasListState = initialIdeasListState;
  const listeners = new Set<() => void>();
  const runLike = createLikeSequencer();

  function setState(next: IdeasListState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function fetch(mode: "load" | "refresh") {
    if (!teamId) {
      setState({ ...state, status: "ready", ideas: [] });
      return;
    }
    setState({
      ...state,
      isLoading: mode === "load",
      isRefreshing: mode === "refresh",
      errorMessage: null,
      status: state.status === "ready" ? state.status : "loading",
    });
    // Paint last-known ideas while the fetch is in flight, the way iOS reads
    // SwiftData before its refresh lands. Only on a cold load: during a
    // pull-to-refresh the list on screen is already newer than the cache.
    if (mode === "load" && cache && state.ideas.length === 0) {
      try {
        const cached = await cache.load(teamId);
        if (cached && state.ideas.length === 0) {
          setState({ ...state, ideas: [...cached].sort(compareIdeas), status: "ready" });
        }
      } catch {
        // A cache miss is not an error worth showing.
      }
    }
    try {
      const ideas = await api.listIdeas(teamId);
      setState({
        status: "ready",
        ideas,
        isLoading: false,
        isRefreshing: false,
        errorMessage: null,
      });
      void cache?.save(teamId, ideas);
    } catch (error) {
      setState({
        ...state,
        status: state.ideas.length > 0 ? "ready" : "error",
        isLoading: false,
        isRefreshing: false,
        errorMessage: error instanceof Error ? error.message : "Couldn't load ideas.",
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    load: () => fetch("load"),
    refresh: () => fetch("refresh"),
    applyReorder(orderedIds) {
      const position = new Map(orderedIds.map((id, index) => [id, index]));
      const ideas = state.ideas
        .map((idea) => {
          const index = position.get(idea.ideaId);
          return index === undefined ? idea : { ...idea, sortOrder: sortOrderForIndex(index) };
        })
        .sort(compareIdeas);
      setState({ ...state, ideas });
    },
    async setLiked(ideaId, liked) {
      const result = await runLike({
        ideaId,
        liked,
        read: () => {
          const idea = state.ideas.find((row) => row.ideaId === ideaId);
          return idea ? likeStateOf(idea) : null;
        },
        write: (likeState) => {
          setState({ ...state, ideas: applyLikeState(state.ideas, ideaId, likeState) });
        },
        send: (id, value) => api.setLike(id, value),
      });
      if (result.ok !== false) return null;
      return result.error instanceof Error && result.error.message
        ? result.error.message
        : "Couldn't update the like.";
    },
  };
}
