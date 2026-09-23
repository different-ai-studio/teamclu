import { describe, expect, it } from "vitest";

import type { Actor } from "../features/actors/actor-types";
import {
  actorIdHash,
  buildTeamStats,
  formatTokens,
  statInitials,
} from "../features/actors/team-stats";
import {
  buildIdeaStats,
  periodCutoff,
  scopeIdeasToPeriod,
} from "../features/ideas/idea-stats";
import type { Idea } from "../features/ideas/idea-types";

const NOW = Date.parse("2026-05-20T12:00:00.000Z");

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
    createdAt: "2026-05-20T11:00:00.000Z",
    updatedAt: "2026-05-20T11:00:00.000Z",
    attachmentUrls: [],
    commentCount: 0,
    likeCount: 0,
    likedByMe: false,
    ...partial,
  };
}

function actor(partial: Partial<Actor> & { actorId: string }): Actor {
  return {
    teamId: "t1",
    actorType: "member",
    displayName: partial.actorId,
    role: null,
    lastActiveAt: null,
    avatarUrl: null,
    agentTypes: [],
    defaultAgentType: null,
    agentKind: null,
    ...partial,
  };
}

describe("periodCutoff", () => {
  it("returns null only for all-time", () => {
    expect(periodCutoff("all", NOW)).toBeNull();
    expect(periodCutoff("week", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(periodCutoff("month", NOW)).toBe(NOW - 30 * 86_400_000);
    expect(periodCutoff("today", NOW)).toBeLessThanOrEqual(NOW);
  });
});

describe("scopeIdeasToPeriod", () => {
  it("drops rows created before the cutoff but keeps unparseable timestamps", () => {
    const rows = [
      idea({ ideaId: "recent", createdAt: "2026-05-19T00:00:00.000Z" }),
      idea({ ideaId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      idea({ ideaId: "broken", createdAt: "" }),
    ];
    expect(scopeIdeasToPeriod(rows, "week", NOW).map((i) => i.ideaId)).toEqual([
      "recent",
      "broken",
    ]);
    expect(scopeIdeasToPeriod(rows, "all", NOW)).toHaveLength(3);
  });
});

describe("buildIdeaStats", () => {
  it("counts in-progress as open, and ranks contributors and workspaces", () => {
    const stats = buildIdeaStats({
      now: NOW,
      period: "week",
      actors: [
        actor({ actorId: "a1", displayName: "Ada" }),
        actor({ actorId: "a2", displayName: "Bot", actorType: "agent" }),
      ],
      ideas: [
        idea({ ideaId: "1", createdByActorId: "a1", status: "open", workspaceId: "w1", workspaceName: "Repo" }),
        idea({ ideaId: "2", createdByActorId: "a1", status: "in_progress", workspaceId: "w1", workspaceName: "Repo" }),
        idea({ ideaId: "3", createdByActorId: "a2", status: "done" }),
        idea({ ideaId: "4", createdByActorId: "gone", status: "done", workspaceId: "w2", workspaceName: "Docs" }),
      ],
    });

    expect(stats).toMatchObject({ total: 4, open: 2, done: 2 });
    expect(stats.contributors).toEqual([
      { actorId: "a1", name: "Ada", isAgent: false, isOnline: false, count: 2 },
      { actorId: "a2", name: "Bot", isAgent: true, isOnline: false, count: 1 },
      // An idea whose author has left the team still counts, under "Unknown".
      { actorId: "gone", name: "Unknown", isAgent: false, isOnline: false, count: 1 },
    ]);
    // Ties break by name, so Docs sorts ahead of Unassigned.
    expect(stats.workspaces).toEqual([
      { id: "w1", name: "Repo", count: 2 },
      { id: "w2", name: "Docs", count: 1 },
      { id: "_unassigned", name: "Unassigned", count: 1 },
    ]);
  });
});

describe("buildTeamStats", () => {
  it("derives token counts from the actor id hash, exactly as iOS does", () => {
    // "a" == 97, so the hash is 97 and 97 % 7 == 6 → the last base, 112_300.
    expect(actorIdHash("a")).toBe(97);
    const stats = buildTeamStats({
      period: "week",
      actors: [actor({ actorId: "a", displayName: "Ada" })],
    });
    // week is the baseline multiplier of 7, so the base passes through.
    expect(stats.actors[0]).toEqual({
      actorId: "a",
      name: "Ada",
      isAgent: false,
      agentType: null,
      tokens: 112_300,
    });
  });

  it("scales tokens and skills by the period, truncating like Swift", () => {
    const actors = [actor({ actorId: "a", displayName: "Ada" })];
    // 112300 * 1 / 7 == 16042.857… → 16042 (Swift Int division truncates).
    expect(buildTeamStats({ period: "today", actors }).actors[0].tokens).toBe(16_042);
    expect(buildTeamStats({ period: "month", actors }).actors[0].tokens).toBe(481_285);
    expect(buildTeamStats({ period: "all", actors }).actors[0].tokens).toBe(1_443_857);

    // Skills use the same multiplier over their own bases.
    expect(buildTeamStats({ period: "week", actors }).skills).toEqual([
      { name: "Read", count: 142 },
      { name: "Edit", count: 88 },
      { name: "Bash", count: 54 },
      { name: "Write", count: 32 },
      { name: "Grep", count: 24 },
    ]);
    expect(buildTeamStats({ period: "today", actors }).skills[0]).toEqual({
      name: "Read",
      count: 20,
    });
  });

  it("uses the per-period session and skill constants", () => {
    const actors: Actor[] = [];
    expect(buildTeamStats({ period: "today", actors })).toMatchObject({
      totalSessions: 6,
      totalSkills: 38,
      totalTokens: 0,
    });
    expect(buildTeamStats({ period: "week", actors })).toMatchObject({
      totalSessions: 42,
      totalSkills: 386,
    });
    expect(buildTeamStats({ period: "month", actors })).toMatchObject({
      totalSessions: 178,
      totalSkills: 1_642,
    });
    expect(buildTeamStats({ period: "all", actors })).toMatchObject({
      totalSessions: 534,
      totalSkills: 4_920,
    });
  });

  it("ranks by tokens and drops external actors", () => {
    const stats = buildTeamStats({
      period: "week",
      actors: [
        // "b" == 98, 98 % 7 == 0 → 8_200 (the smallest base).
        actor({ actorId: "b", displayName: "Low" }),
        actor({ actorId: "a", displayName: "High", actorType: "agent" }),
        actor({ actorId: "ext", displayName: "WeCom", actorType: "external" }),
      ],
    });
    expect(stats.actors.map((a) => a.name)).toEqual(["High", "Low"]);
    expect(stats.totalTokens).toBe(112_300 + 8_200);
  });
});

describe("formatTokens", () => {
  it("matches the iOS K / M thresholds", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(112_300)).toBe("112.3K");
    expect(formatTokens(1_443_857)).toBe("1.4M");
  });
});

describe("statInitials", () => {
  it("takes up to two initials and falls back to the first character", () => {
    expect(statInitials("Ada Lovelace")).toBe("AL");
    expect(statInitials("Ada Byron Lovelace")).toBe("AB");
    expect(statInitials("opencode")).toBe("O");
  });
});
