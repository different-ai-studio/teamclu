import { describe, it, expect, vi } from "vitest";

const insertFeedbackSpy = vi.fn(async () => {});
const insertSessionReportSpy = vi.fn(async () => {});
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ telemetry: { insertFeedback: insertFeedbackSpy, insertSessionReport: insertSessionReportSpy } }),
}));

import { insertFeedback } from "@/lib/telemetry/supabase-feedback";
import { insertSessionReport } from "@/lib/telemetry/supabase-session-report";

describe("telemetry wrappers post camelCase to the Cloud API", () => {
  it("insertFeedback forwards camelCase keys", async () => {
    await insertFeedback({ actorId: "a", teamId: "t", sessionId: "s", messageId: "m", kind: "positive", starRating: 4, skill: null });
    const body = insertFeedbackSpy.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(["actorId","kind","messageId","sessionId","skill","starRating","teamId"].sort());
    expect(body.messageId).toBe("m");
    expect("message_id" in body).toBe(false);
    expect("actor_id" in body).toBe(false);
  });
  it("insertSessionReport forwards camelCase keys", async () => {
    await insertSessionReport({ actorId: "a", teamId: "t", sessionId: "s", tokensUsed: 10, costUsd: 0.1, model: "m", agentKind: "code", endedAt: null });
    const body = insertSessionReportSpy.mock.calls[0][0];
    expect(body.tokensUsed).toBe(10);
    expect("tokens_used" in body).toBe(false);
    expect("agent_kind" in body).toBe(false);
    expect(body.agentKind).toBe("code");
  });
});
