import { describe, expect, it, vi } from "vitest";

import { createCloudSessionsApi } from "../features/sessions/cloud-api";

function api(sessionRow: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url);
    const payload = url.includes("/participants")
      ? { items: [{ actorId: "me" }, { actorId: "agent" }] }
      : sessionRow;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const sessions = createCloudSessionsApi({
    getAccessToken: async () => "tok",
    baseUrl: "https://api.test",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { sessions, urls };
}

describe("getSession participants", () => {
  it("counts the members when the single-session read leaves the count out", async () => {
    const { sessions, urls } = api({ id: "s1", teamId: "t1", title: "x", mode: "collab" });
    const session = await sessions.getSession("t1", "s1");
    expect(session?.participantCount).toBe(2);
    expect(urls).toContain("https://api.test/v1/sessions/s1/participants");
  });

  it("uses the server's count when it is present", async () => {
    const { sessions } = api({ id: "s1", teamId: "t1", title: "x", mode: "collab", participantCount: 5 });
    const session = await sessions.getSession("t1", "s1");
    expect(session?.participantCount).toBe(5);
  });

  it("fills the participant ids that mentions and the agent chips key off", async () => {
    const { sessions } = api({ id: "s1", teamId: "t1", title: "x", mode: "collab" });
    const session = await sessions.getSession("t1", "s1");
    expect(session?.participantActorIds).toEqual(["me", "agent"]);
  });
});
