import { describe, it, expect, vi } from "vitest";
import { createTelemetryModule } from "@/lib/backend/cloud-api/telemetry";

function fakeClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    post: vi.fn(async (path: string, body: unknown) => { calls.push({ method: "POST", path, body }); return undefined; }),
    get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { items: [] }; }),
    delete: vi.fn(async (path: string) => { calls.push({ method: "DELETE", path }); return undefined; }),
  };
}

describe("cloud-api telemetry paths", () => {
  it("hits the real /v1 routes (no telemetry/ prefix)", async () => {
    const client = fakeClient();
    const t = createTelemetryModule(client as never);
    await t.insertFeedback({ messageId: "m", actorId: "a", teamId: "t", kind: "positive" });
    await t.insertSessionReport({ actorId: "a", teamId: "t", sessionId: "s", tokensUsed: 1, costUsd: 0 });
    await t.insertSkillUsage({ actorId: "a", teamId: "t", skill: "foo" });
    await t.listLeaderboard("t");
    await t.listFeedbackSummary("t");
    await t.deleteFeedback({ messageId: "m" });
    const paths = client.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain("POST /v1/feedback");
    expect(paths).toContain("POST /v1/session-report");
    expect(paths).toContain("POST /v1/skill-usage");
    expect(paths).toContain("GET /v1/teams/t/leaderboard?period=week");
    expect(paths).toContain("GET /v1/feedback-summary?teamId=t");
    expect(paths).toContain("DELETE /v1/feedback/m");
    expect(paths.some((p) => p.includes("/v1/telemetry/"))).toBe(false);
  });
});
