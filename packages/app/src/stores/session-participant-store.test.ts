import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionParticipantStore } from "./session-participant-store";

const { mockListParticipants, mockIsTauri } = vi.hoisted(() => ({
  mockListParticipants: vi.fn(async () => [] as Array<{
    id: string;
    actor_type: string | null;
    display_name: string | null;
    avatar_url: string | null;
  }>),
  mockIsTauri: vi.fn(() => true),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: mockIsTauri,
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: mockListParticipants,
    },
  }),
}));

vi.mock("@/lib/cache/local-cache", () => ({
  loadSessionParticipants: vi.fn(async (sessionId: string) => {
    if (sessionId === "s1") return [{ actorId: "a1" }, { actorId: "agent-1" }];
    return [];
  }),
  loadActorsByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      displayName: id === "agent-1" ? "Agent One" : "Alice",
      avatarUrl: null,
      actorType: id.startsWith("agent") ? "agent" : "member",
    })),
  ),
}));

vi.mock("@/lib/sync/session-participant-sync", () => ({
  syncParticipantsForSession: vi.fn(async () => 1),
}));

beforeEach(() => {
  mockIsTauri.mockReturnValue(true);
  mockListParticipants.mockResolvedValue([]);
  useSessionParticipantStore.setState({
    participantsBySession: {},
    loadingBySession: {},
    errorBySession: {},
  });
  vi.clearAllMocks();
  mockIsTauri.mockReturnValue(true);
});

describe("session-participant-store", () => {
  it("loads participants from the local cache on desktop", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "a1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
        isExternal: false,
      },
      {
        actorId: "agent-1",
        displayName: "Agent One",
        avatarUrl: null,
        isAgent: true,
        isExternal: false,
      },
    ]);
  });

  it("loads participants from Cloud API on extension/web", async () => {
    mockIsTauri.mockReturnValue(false);
    mockListParticipants.mockResolvedValue([
      {
        id: "member-1",
        actor_type: "member",
        display_name: "Alice",
        avatar_url: null,
      },
      {
        id: "daemon-1",
        actor_type: "agent",
        display_name: "MACPRO",
        avatar_url: null,
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(mockListParticipants).toHaveBeenCalledWith("s1");
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "member-1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
        isExternal: false,
      },
      {
        actorId: "daemon-1",
        displayName: "MACPRO",
        avatarUrl: null,
        isAgent: true,
        isExternal: false,
      },
    ]);
  });

  it("keeps the gateway's own sender in the roster", async () => {
    // The person on the other end of a WeCom chat is an `external` actor. They
    // were always in session_participants; the mention filter used to drop
    // them, which is what made them un-@-mentionable from the desktop.
    mockIsTauri.mockReturnValue(false);
    mockListParticipants.mockResolvedValue([
      { id: "daemon-1", actor_type: "agent", display_name: "MACPRO", avatar_url: null },
      { id: "ext-1", actor_type: "external", display_name: "LiangLiang", avatar_url: null },
      { id: "bot-1", actor_type: "service", display_name: "not mentionable", avatar_url: null },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s9"]);

    expect(useSessionParticipantStore.getState().participantsBySession.s9).toEqual([
      { actorId: "daemon-1", displayName: "MACPRO", avatarUrl: null, isAgent: true, isExternal: false },
      { actorId: "ext-1", displayName: "LiangLiang", avatarUrl: null, isAgent: false, isExternal: true },
    ]);
  });

  it("falls back to the cloud when the desktop local cache has no rows", async () => {
    // A cron-created session is never synced into libsql just by being opened,
    // so its local roster is empty while the cloud has the agent. Treating that
    // empty read as the answer is what left the agent unmentionable and left
    // messages with no target.
    mockListParticipants.mockResolvedValue([
      {
        id: "daemon-1",
        actor_type: "agent",
        display_name: "MACPRO",
        avatar_url: null,
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["cron-session"]);

    expect(mockListParticipants).toHaveBeenCalledWith("cron-session");
    expect(useSessionParticipantStore.getState().participantsBySession["cron-session"]).toEqual([
      {
        actorId: "daemon-1",
        displayName: "MACPRO",
        avatarUrl: null,
        isAgent: true,
        isExternal: false,
      },
    ]);
  });

  it("prefers the local cache and never calls the cloud when it has rows", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(mockListParticipants).not.toHaveBeenCalled();
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toHaveLength(2);
  });

  it("retries an empty roster on the next ensure", async () => {
    mockIsTauri.mockReturnValue(false);
    useSessionParticipantStore.setState({
      participantsBySession: { s1: [] },
      loadingBySession: {},
      errorBySession: {},
    });
    mockListParticipants.mockResolvedValue([
      {
        id: "daemon-1",
        actor_type: "agent",
        display_name: "MACPRO",
        avatar_url: null,
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(mockListParticipants).toHaveBeenCalledWith("s1");
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "daemon-1",
        displayName: "MACPRO",
        avatarUrl: null,
        isAgent: true,
        isExternal: false,
      },
    ]);
  });

  it("setParticipants publishes a roster resolved elsewhere and clears loading", async () => {
    useSessionParticipantStore.setState({
      participantsBySession: {},
      loadingBySession: { s2: true },
      errorBySession: { s2: "stale error" },
    });

    useSessionParticipantStore.getState().setParticipants("s2", [
      { actorId: "agent-1", displayName: "MACPRO", avatarUrl: null, isAgent: true, isExternal: false },
    ]);

    const state = useSessionParticipantStore.getState();
    expect(state.participantsBySession.s2).toEqual([
      { actorId: "agent-1", displayName: "MACPRO", avatarUrl: null, isAgent: true, isExternal: false },
    ]);
    expect(state.loadingBySession.s2).toBe(false);
    expect(state.errorBySession.s2).toBeNull();
  });

  it("setParticipants keeps an external the caller does not manage", async () => {
    // The actor sheet lists team membership and filters its rows to
    // member/agent, so publishing from it must not read as "the WeCom user
    // left" — they would vanish from the mention list on sheet open.
    useSessionParticipantStore.setState({
      participantsBySession: {
        s3: [
          { actorId: "agent-1", displayName: "MACPRO", avatarUrl: null, isAgent: true, isExternal: false },
          { actorId: "ext-1", displayName: "LiangLiang", avatarUrl: null, isAgent: false, isExternal: true },
        ],
      },
      loadingBySession: {},
      errorBySession: {},
    });

    useSessionParticipantStore.getState().setParticipants("s3", [
      { actorId: "agent-1", displayName: "MACPRO", avatarUrl: null, isAgent: true, isExternal: false },
    ]);

    expect(useSessionParticipantStore.getState().participantsBySession.s3).toEqual([
      { actorId: "agent-1", displayName: "MACPRO", avatarUrl: null, isAgent: true, isExternal: false },
      { actorId: "ext-1", displayName: "LiangLiang", avatarUrl: null, isAgent: false, isExternal: true },
    ]);
  });

  it("setParticipants keeps an avatar the caller does not carry", async () => {
    // The sheet's Row shape has no avatar_url; publishing from it must not blank
    // an avatar this store already resolved from the actor cache.
    useSessionParticipantStore.setState({
      participantsBySession: {
        s2: [{ actorId: "a1", displayName: "Alice", avatarUrl: "https://img/a1.png", isAgent: false, isExternal: false }],
      },
      loadingBySession: {},
      errorBySession: {},
    });

    useSessionParticipantStore.getState().setParticipants("s2", [
      { actorId: "a1", displayName: "Alice", avatarUrl: null, isAgent: false, isExternal: false },
    ]);

    expect(useSessionParticipantStore.getState().participantsBySession.s2[0].avatarUrl).toBe(
      "https://img/a1.png",
    );
  });

  it("clears loading on invalidate while keeping cached roster", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);
    useSessionParticipantStore.setState({
      loadingBySession: { s1: true },
    });

    useSessionParticipantStore.getState().invalidateSessions(["s1"]);

    const state = useSessionParticipantStore.getState();
    expect(state.participantsBySession.s1).toHaveLength(2);
    expect(state.loadingBySession.s1).toBe(false);
  });

  it("clears loading when refreshSession fails", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);
    const sync = await import("@/lib/sync/session-participant-sync");
    vi.mocked(sync.syncParticipantsForSession).mockRejectedValueOnce(new Error("sync failed"));

    await useSessionParticipantStore.getState().refreshSession("s1", "team-1");

    const state = useSessionParticipantStore.getState();
    expect(state.loadingBySession.s1).toBe(false);
    expect(state.errorBySession.s1).toBe("sync failed");
    expect(state.participantsBySession.s1).toHaveLength(2);
  });

  it("syncs before refreshing when team id is available", async () => {
    const sync = await import("@/lib/sync/session-participant-sync");

    await useSessionParticipantStore.getState().refreshSession("s1", "team-1");

    expect(sync.syncParticipantsForSession).toHaveBeenCalledWith("s1", "team-1", {
      full: true,
    });
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toHaveLength(2);
  });

  it("loads participants from Cloud API in extension/web mode", async () => {
    mockIsTauri.mockReturnValue(false);
    mockListParticipants.mockResolvedValue([
      {
        id: "member-1",
        team_id: "team-1",
        display_name: "Alice",
        actor_type: "member",
      },
      {
        id: "agent-1",
        team_id: "team-1",
        display_name: "MACPRO",
        actor_type: "agent",
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(mockListParticipants).toHaveBeenCalledWith("s1");
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "member-1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
        isExternal: false,
      },
      {
        actorId: "agent-1",
        displayName: "MACPRO",
        avatarUrl: null,
        isAgent: true,
        isExternal: false,
      },
    ]);
  });
});
