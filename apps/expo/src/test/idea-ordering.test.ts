import { describe, expect, it } from "vitest";

import {
  compareIdeas,
  reorderIdeaIds,
  sortOrderForIndex,
  type Idea,
} from "../features/ideas/idea-types";

function makeIdea(partial: Partial<Idea> & { ideaId: string }): Idea {
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

describe("compareIdeas", () => {
  it("orders by sortOrder first", () => {
    const ideas = [
      makeIdea({ ideaId: "b", sortOrder: 2000 }),
      makeIdea({ ideaId: "a", sortOrder: 1000 }),
    ];
    expect([...ideas].sort(compareIdeas).map((i) => i.ideaId)).toEqual(["a", "b"]);
  });

  it("falls back to most-recently-updated, then newest-created", () => {
    const ideas = [
      makeIdea({ ideaId: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeIdea({ ideaId: "new", updatedAt: "2026-03-01T00:00:00.000Z" }),
      makeIdea({
        ideaId: "tie-newer",
        updatedAt: "2026-03-01T00:00:00.000Z",
        createdAt: "2026-02-02T00:00:00.000Z",
      }),
    ];
    expect([...ideas].sort(compareIdeas).map((i) => i.ideaId)).toEqual([
      "tie-newer",
      "new",
      "old",
    ]);
  });
});

describe("reorderIdeaIds", () => {
  const ideas = ["a", "b", "c", "d"].map((id) => makeIdea({ ideaId: id }));

  it("moves an idea to the destination index", () => {
    expect(reorderIdeaIds(ideas, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorderIdeaIds(ideas, "a", 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("clamps out-of-range destinations and no-ops on unknown ids", () => {
    expect(reorderIdeaIds(ideas, "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(reorderIdeaIds(ideas, "a", -5)).toEqual(["a", "b", "c", "d"]);
    expect(reorderIdeaIds(ideas, "zz", 0)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("sortOrderForIndex", () => {
  it("matches the iOS (index + 1) * 1000 renumbering", () => {
    expect([0, 1, 2].map(sortOrderForIndex)).toEqual([1000, 2000, 3000]);
  });
});
