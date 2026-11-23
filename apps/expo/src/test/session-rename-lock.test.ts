import { describe, expect, it, vi } from "vitest";
import { createCloudSessionsApi } from "../features/sessions/cloud-api";

describe("createCloudSessionsApi rename", () => {
  it("sends titleLocked on a manual rename", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = createCloudSessionsApi({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "token",
      fetchImpl,
    });

    await api.renameSession("session 1", "Standup (09:30)");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/sessions/session%201");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Standup (09:30)",
      titleLocked: true,
    });
  });
});
