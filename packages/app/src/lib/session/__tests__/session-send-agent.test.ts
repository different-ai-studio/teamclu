import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeSessionId: "sess-1" as string | null,
  authSession: { user: { id: "user-1" } } as { user: { id: string } } | null,
  rows: [{ id: "sess-1", team_id: "team-row" }] as Array<{ id: string; team_id: string }>,
  engaged: { id: "agent-1", displayName: "Agent" } as { id: string; displayName: string } | null,
  appendMessage: vi.fn(),
  enqueue: vi.fn(() => Promise.resolve()),
  clearSessionError: vi.fn(),
  errorSessionId: null as string | null,
  resolveCurrentMemberActorId: vi.fn(() => Promise.resolve("member-actor")),
  resolveSessionMentionActorIds: vi.fn(() => Promise.resolve(["agent-1"])),
  resolveAgentRuntimeIdsForSend: vi.fn(() => ["agent-1"]),
  resolveAgentSessionModel: vi.fn(() => ({ selected: { modelId: "provider/model-x" } })),
  notePendingAgentReplyTo: vi.fn(),
  bumpSessionListLastMessage: vi.fn(),
}));

vi.mock("@/stores/session-selection-store", () => ({
  useSessionSelectionStore: { getState: () => ({ activeSessionId: mocks.activeSessionId }) },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ session: mocks.authSession }) },
}));
vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: "team-current" }, currentMember: { id: "member-1" } }),
  },
}));
vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: { getState: () => ({ rows: mocks.rows }) },
}));
vi.mock("@/stores/session-message-store", () => ({
  useSessionMessageStore: {
    getState: () => ({ appendMessage: mocks.appendMessage, messages: {} }),
  },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      errorSessionId: mocks.errorSessionId,
      clearSessionError: mocks.clearSessionError,
    }),
  },
}));
vi.mock("@/stores/engaged-agent-store", () => ({
  useEngagedAgentStore: { getState: () => ({ get: () => mocks.engaged }) },
}));
vi.mock("@/stores/outbox-store", () => ({
  useOutboxStore: { getState: () => ({ enqueue: mocks.enqueue }) },
}));
vi.mock("@/stores/runtime-state-store", () => ({
  useRuntimeStateStore: { getState: () => ({ byRuntimeId: {} }) },
}));
vi.mock("@/lib/actor/current-actor", () => ({
  resolveCurrentMemberActorId: mocks.resolveCurrentMemberActorId,
}));
vi.mock("@/lib/actor/resolve-session-mention-ids", () => ({
  resolveSessionMentionActorIds: mocks.resolveSessionMentionActorIds,
}));
vi.mock("@/lib/messages/send-path-resolve", () => ({
  resolveAgentRuntimeIdsForSend: mocks.resolveAgentRuntimeIdsForSend,
}));
vi.mock("@/lib/session/session-established-model", () => ({
  resolveSessionEstablishedModel: () => null,
}));
vi.mock("@/lib/agent/resolve-agent-session-model", () => ({
  resolveAgentSessionModel: mocks.resolveAgentSessionModel,
}));
vi.mock("@/lib/agent/agent-backend-type", () => ({
  resolveAgentBackendType: () => "opencode",
}));
vi.mock("@/lib/daemon/local-daemon-identity", () => ({
  getKnownLocalDaemonActorId: () => null,
}));
vi.mock("@/lib/messages/pending-agent-reply-to", () => ({
  notePendingAgentReplyTo: mocks.notePendingAgentReplyTo,
}));
vi.mock("@/lib/session/session-list-preview", () => ({
  bumpSessionListLastMessage: mocks.bumpSessionListLastMessage,
}));

import { sendAgentPromptInActiveSession } from "@/lib/session/session-send-agent";

describe("sendAgentPromptInActiveSession (outbox path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeSessionId = "sess-1";
    mocks.authSession = { user: { id: "user-1" } };
    mocks.rows = [{ id: "sess-1", team_id: "team-row" }];
    mocks.engaged = { id: "agent-1", displayName: "Agent" };
    mocks.errorSessionId = null;
  });

  it("does nothing without an active session", async () => {
    mocks.activeSessionId = null;
    expect(await sendAgentPromptInActiveSession("explain this")).toBeNull();
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does nothing for a blank prompt or without auth", async () => {
    expect(await sendAgentPromptInActiveSession("   ")).toBeNull();
    mocks.authSession = null;
    expect(await sendAgentPromptInActiveSession("hello")).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("appends an optimistic bubble and enqueues to the outbox with the session's team", async () => {
    const id = await sendAgentPromptInActiveSession("  explain this diff  ");
    expect(id).toBeTruthy();

    expect(mocks.appendMessage).toHaveBeenCalledTimes(1);
    const [sid, msg] = mocks.appendMessage.mock.calls[0] as [string, { messageId: string; content: string; model: string; senderActorId: string }];
    expect(sid).toBe("sess-1");
    expect(msg.messageId).toBe(id);
    expect(msg.content).toBe("explain this diff");
    expect(msg.senderActorId).toBe("member-actor");
    expect(msg.model).toBe("provider/model-x");

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: id,
        teamId: "team-row",
        sessionId: "sess-1",
        senderActorId: "member-actor",
        content: "explain this diff",
        model: "provider/model-x",
        mentionActorIds: ["agent-1"],
        displayMentionActorIds: ["agent-1"],
        attachmentUrls: [],
      }),
    );
    expect(mocks.notePendingAgentReplyTo).toHaveBeenCalledWith("sess-1", ["agent-1"], id);
    expect(mocks.bumpSessionListLastMessage).toHaveBeenCalledWith(
      "sess-1",
      "explain this diff",
      expect.objectContaining({ markUnread: false }),
    );
  });

  it("falls back to the current team when the session row is unknown and stamps no model without an agent", async () => {
    mocks.rows = [];
    mocks.engaged = null;
    mocks.resolveSessionMentionActorIds.mockResolvedValueOnce([]);
    mocks.resolveAgentRuntimeIdsForSend.mockReturnValueOnce([]);

    await sendAgentPromptInActiveSession("hi");

    expect(mocks.resolveAgentSessionModel).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-current", model: null, mentionActorIds: [] }),
    );
    expect(mocks.notePendingAgentReplyTo).not.toHaveBeenCalled();
  });

  it("clears a lingering turn error for the same session before sending", async () => {
    mocks.errorSessionId = "sess-1";
    await sendAgentPromptInActiveSession("retry");
    expect(mocks.clearSessionError).toHaveBeenCalledTimes(1);
  });
});
