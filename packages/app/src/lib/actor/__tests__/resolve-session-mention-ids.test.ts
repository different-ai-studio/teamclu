import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  participantStoreState: {
    participantsBySession: {} as Record<
      string,
      Array<{ actorId: string; displayName: string; avatarUrl: null; isAgent: boolean }>
    >,
    loadingBySession: {} as Record<string, boolean>,
  },
}));

vi.mock("@/stores/session-participant-store", () => ({
  useSessionParticipantStore: {
    getState: () => mocks.participantStoreState,
  },
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: { listParticipants: mocks.listParticipants },
  }),
}));

vi.mock("@/lib/actor/resolve-text-mentions", () => ({
  resolveActorIdsFromAtText: vi.fn(async () => ({
    agentIds: [] as string[],
    memberIds: [] as string[],
  })),
}));

import { resolveActorIdsFromAtText } from "@/lib/actor/resolve-text-mentions";
import { resolveSessionMentionActorIds } from "@/lib/actor/resolve-session-mention-ids";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";

describe("resolveSessionMentionActorIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEngagedAgentStore.setState({ bySession: {} });
    mocks.participantStoreState.participantsBySession = {};
    mocks.participantStoreState.loadingBySession = {};
    mocks.listParticipants.mockResolvedValue([]);
  });

  it("returns engaged pill agent id when provided", async () => {
    const ids = await resolveSessionMentionActorIds(
      "session-1",
      [],
      ["agent-1"],
    );
    expect(ids).toEqual(["agent-1"]);
  });

  it("returns member ids from explicit mentions", async () => {
    const ids = await resolveSessionMentionActorIds(
      "session-1",
      ["member-1"],
      [],
    );
    expect(ids).toEqual(["member-1"]);
  });

  it("does not fallback to sole session agent when nothing is explicit", async () => {
    mocks.listParticipants.mockResolvedValue([
      { id: "agent-1", actor_type: "agent", display_name: "Bot" },
      { id: "member-1", actor_type: "member", display_name: "Alice" },
      { id: "member-2", actor_type: "member", display_name: "Bob" },
    ]);

    const ids = await resolveSessionMentionActorIds("session-1", [], []);
    expect(ids).toEqual([]);
  });

  it("fallbacks to the sole agent in solo sessions when nothing is explicit", async () => {
    mocks.participantStoreState.participantsBySession = {
      "session-1": [
        { actorId: "member-1", displayName: "Alice", avatarUrl: null, isAgent: false },
        { actorId: "agent-1", displayName: "Bot", avatarUrl: null, isAgent: true },
      ],
    };

    const ids = await resolveSessionMentionActorIds("session-1", [], []);
    expect(ids).toEqual(["agent-1"]);
    expect(mocks.listParticipants).not.toHaveBeenCalled();
  });

  it("fallbacks to the sole agent in solo sessions via backend when roster is uncached", async () => {
    mocks.listParticipants.mockResolvedValue([
      { id: "member-1", actor_type: "member", display_name: "Alice" },
      { id: "agent-1", actor_type: "agent", display_name: "Bot" },
    ]);

    const ids = await resolveSessionMentionActorIds("session-1", [], []);
    expect(ids).toEqual(["agent-1"]);
  });

  it("falls back to the backend when the cached roster is empty", async () => {
    // A cron-created session has no local participant rows until something
    // syncs them, and nothing does that on open. Reading the empty array as
    // "no agent here" is what made those sessions silent: the message went out
    // with no mention_actor_ids and nobody answered.
    mocks.participantStoreState.participantsBySession = { "session-1": [] };
    mocks.listParticipants.mockResolvedValue([
      { id: "member-1", actor_type: "member", display_name: "Alice" },
      { id: "agent-1", actor_type: "agent", display_name: "Bot" },
    ]);

    const ids = await resolveSessionMentionActorIds("session-1", [], []);

    expect(ids).toEqual(["agent-1"]);
    expect(mocks.listParticipants).toHaveBeenCalledWith("session-1");
  });

  it("ignores stale solo cache while roster refresh is in flight", async () => {
    mocks.participantStoreState.participantsBySession = {
      "session-1": [
        { actorId: "member-1", displayName: "Alice", avatarUrl: null, isAgent: false },
        { actorId: "agent-1", displayName: "Bot", avatarUrl: null, isAgent: true },
      ],
    };
    mocks.participantStoreState.loadingBySession = { "session-1": true };
    mocks.listParticipants.mockResolvedValue([
      { id: "member-1", actor_type: "member", display_name: "Alice" },
      { id: "member-2", actor_type: "member", display_name: "Bob" },
      { id: "agent-1", actor_type: "agent", display_name: "Bot" },
    ]);

    const ids = await resolveSessionMentionActorIds("session-1", [], []);
    expect(ids).toEqual([]);
    expect(mocks.listParticipants).toHaveBeenCalledWith("session-1");
  });

  it("merges typed @agent from message text", async () => {
    vi.mocked(resolveActorIdsFromAtText).mockResolvedValueOnce({
      agentIds: ["agent-2"],
      memberIds: [],
    });
    mocks.listParticipants.mockResolvedValue([
      { id: "agent-2", actor_type: "agent", display_name: "MAC" },
    ]);

    const ids = await resolveSessionMentionActorIds(
      "session-1",
      [],
      [],
      "@MAC hello",
    );
    expect(ids).toEqual(["agent-2"]);
    expect(useEngagedAgentStore.getState().bySession["session-1"]).toEqual([
      { id: "agent-2", displayName: "MAC" },
    ]);
  });
});
