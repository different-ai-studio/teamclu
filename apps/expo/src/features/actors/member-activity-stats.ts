import type { Idea } from "../ideas/idea-types";
import type { LeaderboardEntry, LeaderboardPeriod } from "./leaderboard-api";

/**
 * The numbers on a person's profile, ported from iOS `MemberActivityStats`
 * (#1568).
 *
 * An agent's page counts what is installed on it — skills, MCP servers, env.
 * A person installs none of those, so their page counts what they did instead:
 * tokens over the last month, and the ideas they still have on the board.
 */
export type MemberActivityStats = {
  /** Tokens the leaderboard attributes to them over `MEMBER_TOKEN_PERIOD`. */
  tokens: number;
  /** Ideas they posted that are still on the board. */
  ideaCount: number;
};

/**
 * A month, because a day mostly reads zero. The leaderboard has no lifetime
 * total, so the label carries the window (the MONTH tag) rather than letting a
 * bare number be read as all-time.
 */
export const MEMBER_TOKEN_PERIOD: LeaderboardPeriod = "month";

/**
 * Tokens for one actor. An actor who did nothing in the window has no row,
 * which is a real zero.
 */
export function memberTokens(
  entries: ReadonlyArray<LeaderboardEntry>,
  actorId: string,
): number {
  const entry = entries.find((row) => row.actorId === actorId);
  return entry ? Math.trunc(entry.tokensUsed) : 0;
}

/**
 * The ideas behind the count, newest first. The count and the list it opens
 * both come from here, so they cannot disagree. Archived ideas are off the
 * board and are not counted — this is "what they have up", not "what they have
 * ever written".
 */
export function memberIdeas(ideas: ReadonlyArray<Idea>, actorId: string): Idea[] {
  return ideas
    .filter((idea) => idea.createdByActorId === actorId && !idea.archived)
    .sort((lhs, rhs) => {
      if (lhs.createdAt === rhs.createdAt) {
        return lhs.ideaId > rhs.ideaId ? -1 : lhs.ideaId < rhs.ideaId ? 1 : 0;
      }
      return lhs.createdAt > rhs.createdAt ? -1 : 1;
    });
}

/**
 * Both numbers, fetched concurrently. A failing leg contributes 0 rather than
 * failing the pair (iOS `MemberActivityStatsLoader.load`): one number missing
 * beats a row of dashes, and a team with no telemetry genuinely has no rows.
 */
export async function loadMemberActivityStats(args: {
  actorId: string;
  loadLeaderboard: () => Promise<ReadonlyArray<LeaderboardEntry>>;
  loadIdeas: () => Promise<ReadonlyArray<Idea>>;
}): Promise<MemberActivityStats> {
  const [entries, ideas] = await Promise.all([
    args.loadLeaderboard().catch(() => [] as LeaderboardEntry[]),
    args.loadIdeas().catch(() => [] as Idea[]),
  ]);
  return {
    tokens: memberTokens(entries, args.actorId),
    ideaCount: memberIdeas(ideas, args.actorId).length,
  };
}
