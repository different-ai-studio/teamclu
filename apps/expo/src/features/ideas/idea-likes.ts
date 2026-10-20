import type { Idea } from "./idea-types";

/**
 * Like state for one idea as the server settles it — the body of
 * `PUT /v1/ideas/{id}/like`. Mirrors iOS `IdeaLikeState`.
 */
export type IdeaLikeState = {
  likeCount: number;
  likedByMe: boolean;
};

export function likeStateOf(idea: Pick<Idea, "likeCount" | "likedByMe">): IdeaLikeState {
  return { likeCount: idea.likeCount, likedByMe: idea.likedByMe };
}

/**
 * The state to show the instant the heart is tapped, before the server
 * answers: the count moves by one toward `liked`, never below zero. Ported
 * from iOS `IdeaStore.setLiked`.
 *
 * Tapping toward the state the idea is already in is a no-op rather than a
 * double count — the wire call sends the desired state, not a toggle, so the
 * server would not move either.
 */
export function optimisticLikeState(before: IdeaLikeState, liked: boolean): IdeaLikeState {
  if (before.likedByMe === liked) return before;
  return {
    likeCount: Math.max(0, before.likeCount + (liked ? 1 : -1)),
    likedByMe: liked,
  };
}

/** Write `state` onto the idea with `ideaId`; other ideas pass through untouched. */
export function applyLikeState<T extends Pick<Idea, "ideaId" | "likeCount" | "likedByMe">>(
  ideas: ReadonlyArray<T>,
  ideaId: string,
  state: IdeaLikeState,
): T[] {
  return ideas.map((idea) =>
    idea.ideaId === ideaId
      ? { ...idea, likeCount: state.likeCount, likedByMe: state.likedByMe }
      : idea,
  );
}

/**
 * The whole optimistic like, as a pure sequence over whatever holds the
 * idea(s): paint the optimistic state, send the desired state, then either
 * adopt the server's answer (which may correct the count — others liked in
 * the meantime) or put the old values back. A failure never leaves a like
 * that isn't there.
 *
 * Only the latest tap on an idea may settle it: when a second tap lands
 * before the first request answers, the first answer is ignored, so a slow
 * network can't flash the heart back to a state the user already left.
 */
export function createLikeSequencer() {
  const latest = new Map<string, number>();
  let counter = 0;

  return async function runLike(args: {
    ideaId: string;
    liked: boolean;
    /** Current state for the idea, or null when it isn't loaded. */
    read: () => IdeaLikeState | null;
    write: (state: IdeaLikeState) => void;
    send: (ideaId: string, liked: boolean) => Promise<IdeaLikeState>;
  }): Promise<{ ok: true } | { ok: false; error: unknown } | { ok: "skipped" }> {
    const before = args.read();
    if (!before) return { ok: "skipped" };
    const token = ++counter;
    latest.set(args.ideaId, token);
    args.write(optimisticLikeState(before, args.liked));
    try {
      const confirmed = await args.send(args.ideaId, args.liked);
      if (latest.get(args.ideaId) === token) {
        latest.delete(args.ideaId);
        args.write(confirmed);
      }
      return { ok: true };
    } catch (error) {
      if (latest.get(args.ideaId) === token) {
        latest.delete(args.ideaId);
        args.write(before);
      }
      return { ok: false, error };
    }
  };
}
