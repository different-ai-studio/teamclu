import { getBackend } from "@/lib/backend";
import type { TeamLeaderboard } from "@/components/settings/LeaderboardSection";

type Period = "day" | "week" | "month";

/**
 * Fetch the team leaderboard from the Cloud API and reshape per-actor cloud rows
 * into the `TeamLeaderboard.members[].workspaces` shape both cards already render.
 * The cloud aggregates per actor (no per-workspace split), so each actor maps to a
 * single synthetic "cloud" workspace entry.
 */
export async function fetchTeamLeaderboard(teamId: string, period: Period = "week"): Promise<TeamLeaderboard> {
  const rows = await getBackend().telemetry.listLeaderboard(teamId, period);
  const members = (rows ?? []).map((r: any) => {
    const positive = Number(r.positiveFeedback ?? 0);
    const negative = Number(r.negativeFeedback ?? 0);
    return {
      memberId: String(r.actorId ?? ""),
      memberName: (r.displayName as string | null) ?? String(r.actorId ?? "Unknown"),
      exportedAt: "",
      updateAt: "",
      // All-time, not windowed by `period`; absent from Cloud API builds that
      // predate them.
      skillsPublished: Number(r.skillsPublished ?? 0),
      appsCreated: Number(r.appsCreated ?? 0),
      workspaces: {
        cloud: {
          totalFeedbacks: positive + negative,
          positiveCount: positive,
          negativeCount: negative,
          totalTokens: Number(r.totalTokens ?? r.tokensUsed ?? 0),
          totalCost: Number(r.totalCost ?? r.costUsd ?? 0),
          sessionCount: Number(r.sessionCount ?? 0),
          skillUsage: (r.skillUsage as Record<string, number> | undefined) ?? {},
        },
      },
    };
  });
  return { members };
}
