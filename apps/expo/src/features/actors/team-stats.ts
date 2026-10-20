import type { Actor } from "./actor-types";
import type { LeaderboardEntry, LeaderboardPeriod } from "./leaderboard-api";

/**
 * Team statistics, ported from the iOS `TeamStatsSheet`: every figure is
 * aggregated from `GET /v1/teams/:id/leaderboard` — the same rows the desktop
 * leaderboard reads. Nothing is fabricated: a team with no telemetry shows
 * zeros and empty sections.
 */

/** The sheet's period picker. The server has no lifetime window. */
export type TeamStatsPeriod = "today" | "week" | "month";

export const TEAM_STATS_PERIODS: ReadonlyArray<{
  value: TeamStatsPeriod;
  /** i18n key — translated where it is rendered. */
  labelKey: string;
}> = [
  { value: "today", labelKey: "Today" },
  { value: "week", labelKey: "Week" },
  { value: "month", labelKey: "Month" },
];

/** iOS `Period.apiValue`: the picker says Today, the wire says `day`. */
export function leaderboardPeriodFor(period: TeamStatsPeriod): LeaderboardPeriod {
  return period === "today" ? "day" : period;
}

export type ActorTokenStat = {
  actorId: string;
  name: string;
  isAgent: boolean;
  agentType: string | null;
  tokens: number;
};

export type SkillStat = {
  name: string;
  count: number;
};

export type TeamStats = {
  totalTokens: number;
  totalSessions: number;
  totalSkills: number;
  actors: ActorTokenStat[];
  skills: SkillStat[];
};

/** How many skills the usage section lists (iOS `topSkills.prefix(5)`). */
export const TOP_SKILL_LIMIT = 5;

/**
 * Swift's `actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }`, then
 * `abs`. Used to pick a stable avatar colour per actor.
 */
export function actorIdHash(actorId: string): number {
  let sum = 0;
  for (const char of actorId) sum += char.codePointAt(0) ?? 0;
  return Math.abs(sum);
}

/**
 * Aggregates leaderboard rows into the sheet's figures.
 *
 * Names come from the team directory when the actor is still in it, then the
 * row's own `displayName`, then the id prefix — the leaderboard keeps rows for
 * actors that have since left. Swift `Int(tokensUsed)` truncates, so this does.
 */
export function buildTeamStats(args: {
  entries: ReadonlyArray<LeaderboardEntry>;
  actors: ReadonlyArray<Actor>;
}): TeamStats {
  const actorsById = new Map<string, Actor>();
  for (const actor of args.actors) {
    if (!actorsById.has(actor.actorId)) actorsById.set(actor.actorId, actor);
  }

  const actors = args.entries
    .map<ActorTokenStat>((entry) => {
      const known = actorsById.get(entry.actorId);
      return {
        actorId: entry.actorId,
        name: known?.displayName ?? entry.displayName ?? entry.actorId.slice(0, 8),
        isAgent: known?.actorType === "agent",
        agentType: known?.defaultAgentType ?? null,
        tokens: Math.trunc(entry.tokensUsed),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const merged = new Map<string, number>();
  for (const entry of args.entries) {
    for (const [skill, count] of Object.entries(entry.skillUsage)) {
      merged.set(skill, (merged.get(skill) ?? 0) + count);
    }
  }
  const allSkills = [...merged.entries()].map<SkillStat>(([name, count]) => ({ name, count }));
  const skills = [...allSkills]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_SKILL_LIMIT);

  return {
    totalTokens: actors.reduce((sum, actor) => sum + actor.tokens, 0),
    totalSessions: args.entries.reduce((sum, entry) => sum + entry.sessionCount, 0),
    totalSkills: allSkills.reduce((sum, skill) => sum + skill.count, 0),
    actors,
    skills,
  };
}

/**
 * `112300 → "112.3K"`, `1_200_000 → "1.2M"`. Mirrors iOS `formattedTokenCount`,
 * including its `999_999 → "1000.0K"` edge.
 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

/** Up to two whitespace-separated initials, else the first character. */
export function statInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = parts
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
  return initials || name.charAt(0).toUpperCase();
}
