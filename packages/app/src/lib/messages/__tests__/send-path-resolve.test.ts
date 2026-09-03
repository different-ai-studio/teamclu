import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mentionsOnlyExternals,
  resolveAgentRuntimeIdsForSend,
  resolveSendTeamId,
  trySyncMentionActorIds,
} from "@/lib/messages/send-path-resolve";

const mocks = vi.hoisted(() => ({
  participantsBySession: {} as Record<
    string,
    Array<{ actorId: string; displayName: string; avatarUrl: null; isAgent: boolean }>
  >,
  engaged: null as { id: string; displayName: string } | null,
}));

vi.mock("@/stores/session-participant-store", () => ({
  useSessionParticipantStore: {
    getState: () => ({
      participantsBySession: mocks.participantsBySession,
    }),
  },
}));

vi.mock("@/stores/engaged-agent-store", () => ({
  useEngagedAgentStore: {
    getState: () => ({
      get: () => mocks.engaged,
    }),
  },
}));

describe("mentionsOnlyExternals", () => {
  const roster = [
    { actorId: "agent-1", displayName: "Mac-mini-3", isAgent: true, isExternal: false },
    { actorId: "member-1", displayName: "周金亮", isAgent: false, isExternal: false },
    { actorId: "ext-1", displayName: "LiangLiang", isAgent: false, isExternal: true },
  ];

  it("is true when the message names only a channel contact", () => {
    expect(mentionsOnlyExternals(["ext-1"], roster, "下班了吗")).toBe(true);
  });

  it("is false when a member is named too", () => {
    expect(mentionsOnlyExternals(["ext-1", "member-1"], roster, "hi")).toBe(false);
  });

  it("is false when the body also names the agent", () => {
    // Typing the agent's name is an explicit ask; the mention picker is not
    // the only way to address it.
    expect(mentionsOnlyExternals(["ext-1"], roster, "@Mac-mini-3 看一下")).toBe(false);
  });

  it("is false for an id the roster cannot place", () => {
    // Guessing "external" for an unknown id would drop the agent from a
    // message meant for it.
    expect(mentionsOnlyExternals(["who-1"], roster, "hi")).toBe(false);
    expect(mentionsOnlyExternals(["ext-1"], [], "hi")).toBe(false);
  });

  it("is false when nobody is mentioned", () => {
    expect(mentionsOnlyExternals([], roster, "hi")).toBe(false);
  });
});

describe("trySyncMentionActorIds", () => {
  it("returns sync ids when pill agent is set and body has no @Name", () => {
    expect(trySyncMentionActorIds(["m1"], ["a1"], "hello")).toEqual(["m1", "a1"]);
  });

  it("returns null when body has @Name tokens", () => {
    expect(trySyncMentionActorIds([], ["a1"], "hi @Bob")).toBeNull();
  });

  it("returns null when no agent pill (solo fallback needs async)", () => {
    expect(trySyncMentionActorIds([], [], "hello")).toBeNull();
  });
});

describe("resolveSendTeamId", () => {
  it("uses the session-list row when it has one", () => {
    expect(
      resolveSendTeamId({
        teamIdFromSessionList: "team-row",
        currentTeamId: () => "team-selected",
      }),
    ).toBe("team-row");
  });

  // The by-id backend lookup that used to sit between these two is gone:
  // session reads are team-scoped, and a composer only exists inside the team
  // you are looking at, so the current team is the right answer when the list
  // row has not loaded yet. It also keeps a round-trip off the send path.
  it("falls back to the selected team when the list row is missing", () => {
    expect(
      resolveSendTeamId({
        teamIdFromSessionList: null,
        currentTeamId: () => "team-selected",
      }),
    ).toBe("team-selected");
  });

  it("returns null when neither is known", () => {
    expect(
      resolveSendTeamId({
        teamIdFromSessionList: null,
        currentTeamId: () => null,
      }),
    ).toBeNull();
  });
});

describe("resolveAgentRuntimeIdsForSend", () => {
  beforeEach(() => {
    mocks.participantsBySession = {};
    mocks.engaged = null;
  });

  it("prefers the engaged / preselected agent id", () => {
    expect(resolveAgentRuntimeIdsForSend("s1", "a1", ["a1", "m1"])).toEqual(["a1"]);
  });

  it("filters mention ids through the roster cache", () => {
    mocks.participantsBySession = {
      s1: [
        { actorId: "a1", displayName: "Bot", avatarUrl: null, isAgent: true },
        { actorId: "m1", displayName: "Me", avatarUrl: null, isAgent: false },
      ],
    };
    expect(resolveAgentRuntimeIdsForSend("s1", null, ["a1", "m1"])).toEqual(["a1"]);
  });
});
