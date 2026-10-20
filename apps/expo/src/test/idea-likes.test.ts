import { describe, expect, it, vi } from "vitest";

import { createIdeasController } from "../features/ideas/idea-controller";
import {
  applyLikeState,
  createLikeSequencer,
  optimisticLikeState,
  type IdeaLikeState,
} from "../features/ideas/idea-likes";
import type { Idea } from "../features/ideas/idea-types";

function idea(partial: Partial<Idea> & { ideaId: string }): Idea {
  return {
    teamId: "t1",
    workspaceId: null,
    workspaceName: null,
    createdByActorId: null,
    title: partial.ideaId,
    description: "",
    status: "open",
    archived: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachmentUrls: [],
    commentCount: 0,
    likeCount: 0,
    likedByMe: false,
    ...partial,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("optimisticLikeState", () => {
  it("moves the count one step toward the desired state", () => {
    expect(optimisticLikeState({ likeCount: 2, likedByMe: false }, true)).toEqual({
      likeCount: 3,
      likedByMe: true,
    });
    expect(optimisticLikeState({ likeCount: 3, likedByMe: true }, false)).toEqual({
      likeCount: 2,
      likedByMe: false,
    });
  });

  it("never goes below zero", () => {
    expect(optimisticLikeState({ likeCount: 0, likedByMe: true }, false)).toEqual({
      likeCount: 0,
      likedByMe: false,
    });
  });

  it("does not double count a tap toward the state it is already in", () => {
    const before = { likeCount: 4, likedByMe: true };
    expect(optimisticLikeState(before, true)).toBe(before);
  });
});

describe("applyLikeState", () => {
  it("only touches the target idea", () => {
    const ideas = [idea({ ideaId: "a" }), idea({ ideaId: "b", likeCount: 9 })];
    const next = applyLikeState(ideas, "a", { likeCount: 1, likedByMe: true });
    expect(next[0]).toMatchObject({ likeCount: 1, likedByMe: true });
    expect(next[1]).toBe(ideas[1]);
  });
});

describe("createLikeSequencer", () => {
  function harness(initial: IdeaLikeState) {
    let current: IdeaLikeState | null = initial;
    const writes: IdeaLikeState[] = [];
    return {
      read: () => current,
      write: (s: IdeaLikeState) => {
        current = s;
        writes.push(s);
      },
      writes,
      get current() {
        return current;
      },
    };
  }

  it("paints optimistically, then adopts the server's (corrected) count", async () => {
    const run = createLikeSequencer();
    const h = harness({ likeCount: 1, likedByMe: false });
    const reply = deferred<IdeaLikeState>();
    const pending = run({ ideaId: "i1", liked: true, read: h.read, write: h.write, send: () => reply.promise });

    expect(h.current).toEqual({ likeCount: 2, likedByMe: true });
    // Someone else liked it in the meantime: the server's number wins.
    reply.resolve({ likeCount: 5, likedByMe: true });
    expect(await pending).toEqual({ ok: true });
    expect(h.current).toEqual({ likeCount: 5, likedByMe: true });
  });

  it("rolls back to the old values on failure", async () => {
    const run = createLikeSequencer();
    const h = harness({ likeCount: 3, likedByMe: true });
    const error = new Error("offline");
    const result = await run({
      ideaId: "i1",
      liked: false,
      read: h.read,
      write: h.write,
      send: () => Promise.reject(error),
    });

    expect(h.writes[0]).toEqual({ likeCount: 2, likedByMe: false });
    expect(h.current).toEqual({ likeCount: 3, likedByMe: true });
    expect(result).toEqual({ ok: false, error });
  });

  it("sends the desired state, not a toggle", async () => {
    const run = createLikeSequencer();
    const h = harness({ likeCount: 0, likedByMe: false });
    const send = vi.fn().mockResolvedValue({ likeCount: 1, likedByMe: true });
    await run({ ideaId: "i1", liked: true, read: h.read, write: h.write, send });
    expect(send).toHaveBeenCalledWith("i1", true);
  });

  it("ignores a superseded answer so a slow first tap can't undo the second", async () => {
    const run = createLikeSequencer();
    const h = harness({ likeCount: 0, likedByMe: false });
    const first = deferred<IdeaLikeState>();
    const second = deferred<IdeaLikeState>();
    const p1 = run({ ideaId: "i1", liked: true, read: h.read, write: h.write, send: () => first.promise });
    const p2 = run({ ideaId: "i1", liked: false, read: h.read, write: h.write, send: () => second.promise });
    expect(h.current).toEqual({ likeCount: 0, likedByMe: false });

    second.resolve({ likeCount: 0, likedByMe: false });
    await p2;
    first.resolve({ likeCount: 1, likedByMe: true });
    await p1;
    expect(h.current).toEqual({ likeCount: 0, likedByMe: false });
  });

  it("skips an idea that isn't loaded", async () => {
    const run = createLikeSequencer();
    const send = vi.fn();
    const result = await run({ ideaId: "x", liked: true, read: () => null, write: vi.fn(), send });
    expect(result).toEqual({ ok: "skipped" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("IdeasController.setLiked", () => {
  async function loaded(api: {
    listIdeas: () => Promise<Idea[]>;
    setLike: (ideaId: string, liked: boolean) => Promise<IdeaLikeState>;
  }) {
    const cache = { load: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const controller = createIdeasController(api, "t1", cache);
    await controller.load();
    cache.save.mockClear();
    return { controller, cache };
  }

  it("applies the server's answer and never writes counts to the cache", async () => {
    const setLike = vi.fn().mockResolvedValue({ likeCount: 7, likedByMe: true });
    const { controller, cache } = await loaded({
      listIdeas: async () => [idea({ ideaId: "i1", likeCount: 2 })],
      setLike,
    });

    const pending = controller.setLiked("i1", true);
    expect(controller.getState().ideas[0]).toMatchObject({ likeCount: 3, likedByMe: true });
    expect(await pending).toBeNull();

    expect(setLike).toHaveBeenCalledWith("i1", true);
    expect(controller.getState().ideas[0]).toMatchObject({ likeCount: 7, likedByMe: true });
    expect(cache.save).not.toHaveBeenCalled();
  });

  it("rolls back and reports the error on failure", async () => {
    const { controller, cache } = await loaded({
      listIdeas: async () => [idea({ ideaId: "i1", likeCount: 2, likedByMe: true })],
      setLike: vi.fn().mockRejectedValue(new Error("boom")),
    });

    expect(await controller.setLiked("i1", false)).toBe("boom");
    expect(controller.getState().ideas[0]).toMatchObject({ likeCount: 2, likedByMe: true });
    expect(cache.save).not.toHaveBeenCalled();
  });
});
