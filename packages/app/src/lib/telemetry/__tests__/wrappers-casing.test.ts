import { describe, it, expect, vi } from "vitest";

const insertFeedbackSpy = vi.fn(async () => {});
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ telemetry: { insertFeedback: insertFeedbackSpy } }),
}));

import { insertFeedback } from "@/lib/telemetry/supabase-feedback";

describe("telemetry wrappers post camelCase to the Cloud API", () => {
  it("insertFeedback forwards camelCase keys", async () => {
    await insertFeedback({ actorId: "a", teamId: "t", sessionId: "s", messageId: "m", kind: "positive", starRating: 4, skill: null });
    const body = insertFeedbackSpy.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(["actorId","kind","messageId","sessionId","skill","starRating","teamId"].sort());
    expect(body.messageId).toBe("m");
    expect("message_id" in body).toBe(false);
    expect("actor_id" in body).toBe(false);
  });
});
