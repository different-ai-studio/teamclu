import { describe, expect, it } from "vitest";

import type { LeaderboardEntry } from "../features/actors/leaderboard-api";
import {
  loadMemberActivityStats,
  MEMBER_TOKEN_PERIOD,
  memberIdeas,
  memberTokens,
} from "../features/actors/member-activity-stats";
import type { Idea } from "../features/ideas/idea-types";

function idea(partial: Partial<Idea> & { ideaId: string }): Idea {
  return {
    teamId: "t1",
    workspaceId: null,
    workspaceName: null,
    createdByActorId: "me",
    title: partial.ideaId,
    description: "",
    status: "open",
    archived: false,
    sortOrder: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...partial,
  };
}

function entry(actorId: string, tokensUsed: number): LeaderboardEntry {
  return {
    actorId,
    displayName: null,
    tokensUsed,
    costUsd: 0,
    sessionCount: 0,
    positiveFeedback: 0,
    negativeFeedback: 0,
    skillUsage: {},
  };
}

describe("memberTokens", () => {
  it("reads the actor's row, truncating like Swift Int()", () => {
    expect(memberTokens([entry("other", 5), entry("me", 1234.9)], "me")).toBe(1234);
  });

  it("is a real zero when the actor has no row in the window", () => {
    expect(memberTokens([entry("other", 5)], "me")).toBe(0);
  });

  it("asks for a month — the leaderboard has no lifetime window", () => {
    expect(MEMBER_TOKEN_PERIOD).toBe("month");
  });
});

describe("memberIdeas", () => {
  it("keeps only the actor's unarchived ideas, newest first, ties by id desc", () => {
    const rows = [
      idea({ ideaId: "old", createdAt: "2026-08-01T00:00:00.000Z" }),
      idea({ ideaId: "b", createdAt: "2026-09-10T00:00:00.000Z" }),
      idea({ ideaId: "c", createdAt: "2026-09-10T00:00:00.000Z" }),
      idea({ ideaId: "archived", archived: true, createdAt: "2026-09-20T00:00:00.000Z" }),
      idea({ ideaId: "theirs", createdByActorId: "other" }),
    ];
    expect(memberIdeas(rows, "me").map((row) => row.ideaId)).toEqual(["c", "b", "old"]);
  });
});

describe("loadMemberActivityStats", () => {
  it("counts from the same selection the list shows", async () => {
    const stats = await loadMemberActivityStats({
      actorId: "me",
      loadLeaderboard: async () => [entry("me", 42_000)],
      loadIdeas: async () => [
        idea({ ideaId: "1" }),
        idea({ ideaId: "2", archived: true }),
        idea({ ideaId: "3", createdByActorId: "other" }),
      ],
    });
    expect(stats).toEqual({ tokens: 42_000, ideaCount: 1 });
  });

  it("a failing leg contributes 0 instead of failing the pair", async () => {
    const stats = await loadMemberActivityStats({
      actorId: "me",
      loadLeaderboard: async () => {
        throw new Error("telemetry down");
      },
      loadIdeas: async () => [idea({ ideaId: "1" }), idea({ ideaId: "2" })],
    });
    expect(stats).toEqual({ tokens: 0, ideaCount: 2 });
  });
});
