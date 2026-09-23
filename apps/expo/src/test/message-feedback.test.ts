import { describe, expect, it, vi } from "vitest";

import { createCloudSessionsApi } from "../features/sessions/cloud-api";
import { myFeedbackByMessageId, nextFeedback } from "../features/sessions/message-feedback";

describe("message feedback", () => {
  it("keeps only my feedback", () => {
    const mine = myFeedbackByMessageId(
      [
        { messageId: "m1", actorId: "me", kind: "positive" },
        { messageId: "m1", actorId: "other", kind: "negative" },
        { messageId: "m2", actorId: "me", kind: "negative" },
      ],
      "me",
    );
    expect([...mine.entries()]).toEqual([["m1", "positive"], ["m2", "negative"]]);
  });

  it("toggles off the active choice and switches between choices", () => {
    expect(nextFeedback(undefined, "positive")).toBe("positive");
    expect(nextFeedback("positive", "positive")).toBeNull();
    expect(nextFeedback("positive", "negative")).toBe("negative");
  });
});

describe("feedback API", () => {
  function api() {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const payload =
        url.includes("/v1/feedback?")
          ? { items: [{ messageId: "m1", actorId: "me", kind: "positive" }, { messageId: "bad", kind: "meh" }] }
          : {};
      return new Response(JSON.stringify(payload), { status: init?.method === "DELETE" ? 200 : 200, headers: { "content-type": "application/json" } });
    });
    const sessions = createCloudSessionsApi({
      getAccessToken: async () => "tok",
      baseUrl: "https://api.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { sessions, calls };
  }

  it("lists, submits and deletes with the contract's shapes", async () => {
    const { sessions, calls } = api();
    expect(await sessions.listFeedback("s1")).toEqual([{ messageId: "m1", actorId: "me", kind: "positive" }]);
    await sessions.submitFeedback({ messageId: "m1", actorId: "me", teamId: "t1", sessionId: "s1", kind: "negative" });
    await sessions.deleteFeedback("m1", "me");

    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.test/v1/feedback?sessionId=s1" });
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.test/v1/feedback",
      body: { messageId: "m1", actorId: "me", teamId: "t1", sessionId: "s1", kind: "negative" },
    });
    expect(calls[2]).toMatchObject({ method: "DELETE", url: "https://api.test/v1/feedback/m1?actorId=me" });
  });
});
