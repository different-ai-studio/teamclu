import { describe, it, expect, vi } from "vitest";
import { fetchTeamLeaderboard } from "@/lib/telemetry/cloud-leaderboard";

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    telemetry: {
      listLeaderboard: async () => [
        { actorId: "a1", displayName: "Alice", tokensUsed: 1000, costUsd: 0.25,
          positiveFeedback: 3, negativeFeedback: 1, sessionCount: 5, skillUsage: { "sentry-fix": 2 } },
      ],
    },
  }),
}));

describe("fetchTeamLeaderboard", () => {
  it("maps cloud rows into the TeamLeaderboard members shape", async () => {
    const lb = await fetchTeamLeaderboard("t1", "week");
    expect(lb.members).toHaveLength(1);
    const m = lb.members[0];
    expect(m.memberId).toBe("a1");
    expect(m.memberName).toBe("Alice");
    const ws = Object.values(m.workspaces)[0];
    expect(ws.totalTokens).toBe(1000);
    expect(ws.totalFeedbacks).toBe(4);
    expect(ws.positiveCount).toBe(3);
    expect(ws.sessionCount).toBe(5);
    expect(ws.skillUsage).toEqual({ "sentry-fix": 2 });
  });
});
