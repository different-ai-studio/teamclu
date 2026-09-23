import { describe, expect, it } from "vitest";

import type { Actor } from "../features/actors/actor-types";
import type { LeaderboardEntry } from "../features/actors/leaderboard-api";
import {
  actorIdHash,
  buildTeamStats,
  formatTokens,
  leaderboardPeriodFor,
  statInitials,
  TEAM_STATS_PERIODS,
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

function entry(
  partial: Partial<LeaderboardEntry> & { actorId: string },
): LeaderboardEntry {
  return {
    displayName: null,
    tokensUsed: 0,
    costUsd: 0,
    sessionCount: 0,
    positiveFeedback: 0,
    negativeFeedback: 0,
    skillUsage: {},
    ...partial,
  };
}

describe("buildTeamStats", () => {
  it("aggregates totals from the leaderboard rows, nothing invented", () => {
    const stats = buildTeamStats({
      actors: [],
      entries: [
        entry({ actorId: "a", tokensUsed: 1_500.9, sessionCount: 3, skillUsage: { Read: 4 } }),
        entry({ actorId: "b", tokensUsed: 200, sessionCount: 2, skillUsage: { Read: 1, Bash: 2 } }),
      ],
    });
    // Swift `Int(tokensUsed)` truncates.
    expect(stats.totalTokens).toBe(1_700);
    expect(stats.totalSessions).toBe(5);
    expect(stats.totalSkills).toBe(7);
  });

  it("reports zeros and empty sections for a team with no telemetry", () => {
    expect(buildTeamStats({ actors: [], entries: [] })).toEqual({
      totalTokens: 0,
      totalSessions: 0,
      totalSkills: 0,
      actors: [],
      skills: [],
    });
  });

  it("ranks actors by tokens and resolves names directory → row → id prefix", () => {
    const stats = buildTeamStats({
      actors: [
        actor({ actorId: "agent-1", displayName: "Bot", actorType: "agent", defaultAgentType: "pi" }),
        actor({ actorId: "member-1", displayName: "Ada" }),
      ],
      entries: [
        entry({ actorId: "member-1", displayName: "stale name", tokensUsed: 10 }),
        entry({ actorId: "agent-1", tokensUsed: 500 }),
        entry({ actorId: "left-the-team-1234", displayName: "Gone", tokensUsed: 50 }),
        entry({ actorId: "abcdef0123456789", tokensUsed: 1 }),
      ],
    });
    expect(stats.actors).toEqual([
      { actorId: "agent-1", name: "Bot", isAgent: true, agentType: "pi", tokens: 500 },
      { actorId: "left-the-team-1234", name: "Gone", isAgent: false, agentType: null, tokens: 50 },
      { actorId: "member-1", name: "Ada", isAgent: false, agentType: null, tokens: 10 },
      { actorId: "abcdef0123456789", name: "abcdef01", isAgent: false, agentType: null, tokens: 1 },
    ]);
  });

  it("merges skill usage across actors and keeps the top five", () => {
    const stats = buildTeamStats({
      actors: [],
      entries: [
        entry({ actorId: "a", skillUsage: { Read: 5, Edit: 3, Bash: 1, Grep: 1 } }),
        entry({ actorId: "b", skillUsage: { Read: 2, Write: 4, Plan: 2, Todo: 1 } }),
      ],
    });
    expect(stats.skills).toEqual([
      { name: "Read", count: 7 },
      { name: "Write", count: 4 },
      { name: "Edit", count: 3 },
      { name: "Plan", count: 2 },
      // Ties break by name so the list does not reshuffle between loads.
      { name: "Bash", count: 1 },
    ]);
    // The SKILLS total counts every invocation, not just the listed five.
    expect(stats.totalSkills).toBe(19);
  });
});

describe("leaderboardPeriodFor", () => {
  it("maps the picker's Today onto the wire's day", () => {
    expect(TEAM_STATS_PERIODS.map((p) => leaderboardPeriodFor(p.value))).toEqual([
      "day",
      "week",
      "month",
    ]);
  });
});

describe("actorIdHash", () => {
  it("sums code points like Swift's unicodeScalars reduce", () => {
    expect(actorIdHash("a")).toBe(97);
    expect(actorIdHash("ab")).toBe(195);
  });
});

describe("formatTokens", () => {
  it("matches the iOS K / M thresholds", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(112_300)).toBe("112.3K");
    expect(formatTokens(1_443_857)).toBe("1.4M");
    // iOS `formattedTokenCount` edge, recorded by its tests too.
    expect(formatTokens(999_999)).toBe("1000.0K");
  });
});

describe("statInitials", () => {
  it("takes up to two initials and falls back to the first character", () => {
    expect(statInitials("Ada Lovelace")).toBe("AL");
    expect(statInitials("Ada Byron Lovelace")).toBe("AB");
    expect(statInitials("opencode")).toBe("O");
  });
});
