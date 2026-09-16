import { describe, it, expect, vi } from "vitest";
import { fetchTeamLeaderboard } from "@/lib/telemetry/cloud-leaderboard";

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    telemetry: {
      listLeaderboard: async () => [
        { actorId: "a1", displayName: "Alice", tokensUsed: 1000, costUsd: 0.25,
          positiveFeedback: 3, negativeFeedback: 1, sessionCount: 5, skillUsage: { "sentry-fix": 2 },
          skillsPublished: 4, appsCreated: 2 },
        // A Cloud API build from before the contribution counts.
        { actorId: "a2", displayName: "Bob", tokensUsed: 0, costUsd: 0,
          positiveFeedback: 0, negativeFeedback: 0, sessionCount: 0, skillUsage: {} },
      ],
    },
  }),
}));

describe("fetchTeamLeaderboard", () => {
  it("maps cloud rows into the TeamLeaderboard members shape", async () => {
    const lb = await fetchTeamLeaderboard("t1", "week");
    expect(lb.members).toHaveLength(2);
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

  it("carries published skills and created apps, zero when the API does not send them", async () => {
    const lb = await fetchTeamLeaderboard("t1", "week");
    expect(lb.members.map((m) => [m.memberId, m.skillsPublished, m.appsCreated])).toEqual([
      ["a1", 4, 2],
      ["a2", 0, 0],
    ]);
  });
});
