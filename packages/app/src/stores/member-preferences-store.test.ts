import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMemberDefaultAgent: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ actors: { getMemberDefaultAgent: mocks.getMemberDefaultAgent } }),
}));

describe("member-preferences-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("loads once per team", async () => {
    mocks.getMemberDefaultAgent.mockResolvedValue("agent-1");
    const { useMemberPreferencesStore } = await import("./member-preferences-store");
    await useMemberPreferencesStore.getState().ensureLoaded("team-1");
    await useMemberPreferencesStore.getState().ensureLoaded("team-1");
    expect(mocks.getMemberDefaultAgent).toHaveBeenCalledTimes(1);
    expect(useMemberPreferencesStore.getState().defaultAgentId).toBe("agent-1");
  });

  it("a failed load is retried, not remembered as loaded", async () => {
    // `reload` sets `teamId` before the request so it can detect a team switch
    // racing the response. The guard used to read that same field, so a
    // FAILURE left it set and `ensureLoaded` returned for that team forever —
    // the member's default agent silently stayed empty until a restart.
    mocks.getMemberDefaultAgent.mockRejectedValueOnce(new Error("offline"));
    const { useMemberPreferencesStore } = await import("./member-preferences-store");
    await useMemberPreferencesStore.getState().ensureLoaded("team-1");
    expect(useMemberPreferencesStore.getState().loadedTeamId).toBeNull();

    mocks.getMemberDefaultAgent.mockResolvedValueOnce("agent-1");
    await useMemberPreferencesStore.getState().ensureLoaded("team-1");
    expect(mocks.getMemberDefaultAgent).toHaveBeenCalledTimes(2);
    expect(useMemberPreferencesStore.getState().defaultAgentId).toBe("agent-1");
  });

  it("switching teams loads the new one", async () => {
    mocks.getMemberDefaultAgent.mockResolvedValue("agent-1");
    const { useMemberPreferencesStore } = await import("./member-preferences-store");
    await useMemberPreferencesStore.getState().ensureLoaded("team-1");
    await useMemberPreferencesStore.getState().ensureLoaded("team-2");
    expect(mocks.getMemberDefaultAgent).toHaveBeenCalledTimes(2);
    expect(useMemberPreferencesStore.getState().loadedTeamId).toBe("team-2");
  });
});
