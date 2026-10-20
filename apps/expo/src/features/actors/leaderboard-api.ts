import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

/**
 * `GET /v1/teams/:teamId/leaderboard?period=` — the per-actor telemetry
 * aggregates behind Team Statistics and a member's token count. Mirrors iOS
 * `CloudAPITelemetryRepository.leaderboard`.
 *
 * The server only offers three windows; there is no lifetime total.
 */
export type LeaderboardPeriod = "day" | "week" | "month";

export type LeaderboardEntry = {
  actorId: string;
  displayName: string | null;
  tokensUsed: number;
  costUsd: number;
  sessionCount: number;
  positiveFeedback: number;
  negativeFeedback: number;
  /** Skill name → invocation count over the window. */
  skillUsage: Record<string, number>;
};

type WireLeaderboardEntry = {
  actorId?: string | null;
  displayName?: string | null;
  tokensUsed?: number | null;
  costUsd?: number | null;
  sessionCount?: number | null;
  positiveFeedback?: number | null;
  negativeFeedback?: number | null;
  skillUsage?: Record<string, unknown> | null;
};

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Wire → domain, with iOS's defaults: every numeric field missing reads as 0,
 * a missing skill map as empty. Rows without an actor id are dropped — there
 * is nobody to attribute them to.
 */
export function toLeaderboardEntries(
  items: ReadonlyArray<WireLeaderboardEntry | null> | null | undefined,
): LeaderboardEntry[] {
  const result: LeaderboardEntry[] = [];
  for (const item of items ?? []) {
    if (!item?.actorId) continue;
    const skillUsage: Record<string, number> = {};
    for (const [skill, count] of Object.entries(item.skillUsage ?? {})) {
      const n = finite(count);
      if (skill && n > 0) skillUsage[skill] = n;
    }
    result.push({
      actorId: item.actorId,
      displayName: item.displayName?.trim() || null,
      tokensUsed: finite(item.tokensUsed),
      costUsd: finite(item.costUsd),
      sessionCount: finite(item.sessionCount),
      positiveFeedback: finite(item.positiveFeedback),
      negativeFeedback: finite(item.negativeFeedback),
      skillUsage,
    });
  }
  return result;
}

export function createLeaderboardApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}) {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  return {
    async getLeaderboard(
      teamId: string,
      period: LeaderboardPeriod,
    ): Promise<LeaderboardEntry[]> {
      const page = await client.get<{ items?: WireLeaderboardEntry[] } | null>(
        `/v1/teams/${encodeURIComponent(teamId)}/leaderboard?period=${encodeURIComponent(period)}`,
      );
      return toLeaderboardEntries(page?.items);
    },
  };
}

export type LeaderboardApi = ReturnType<typeof createLeaderboardApi>;
