import { AgentType } from "@teamclu/app/proto/amux_pb";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeStartPlan } from "../features/sessions/runtime-start";
import {
  autoMentionAgentIds,
  deriveSessionTitle,
  firstMessageWithMentions,
  seatWorkspaceByActorId,
  startSessionWithAgents,
  type StartSessionDeps,
} from "../features/sessions/start-session";

function fakeDeps(overrides: Partial<StartSessionDeps> = {}) {
  const calls: string[] = [];
  const sessionsApi = {
    createSession: vi.fn(async () => {
      calls.push("createSession");
      return "session-1";
    }),
    addParticipants: vi.fn(async () => {
      calls.push("addParticipants");
    }),
    insertOutgoingMessage: vi.fn(async () => {
      calls.push("insertOutgoingMessage");
    }),
  };
  const runtimeRpc = {
    runtimeStart: vi.fn(async () => {
      calls.push("runtimeStart");
      return {} as never;
    }),
  };
  const deps: StartSessionDeps = {
    sessionsApi,
    runtimeRpc,
    newMessageId: () => "msg-1",
    onRuntimeStartError: vi.fn(),
    ...overrides,
  };
  return { deps, sessionsApi, runtimeRpc, calls };
}

const plan: RuntimeStartPlan = {
  agentActorId: "agent-1",
  targetActorId: "agent-1",
  workspaceId: "ws-1",
  worktree: "/work",
  agentType: AgentType.PI,
};

const baseInput = {
  teamId: "team-1",
  memberActorId: "me",
  title: "Hello",
  message: "  Hello there  ",
  primaryAgentActorId: "agent-1",
  ideaId: null,
  collaboratorActorIds: ["agent-1"],
  mentionActorIds: ["agent-1"],
  runtimePlans: [plan],
};

describe("deriveSessionTitle", () => {
  it("uses the first line, clipped to 60 characters", () => {
    expect(deriveSessionTitle("  first line\nsecond", "New")).toBe("first line");
    expect(deriveSessionTitle("x".repeat(80), "New")).toBe(`${"x".repeat(57)}…`);
  });

  it("falls back when the message is blank", () => {
    expect(deriveSessionTitle("   ", "New Session")).toBe("New Session");
  });
});

describe("startSessionWithAgents", () => {
  it("creates, sends the trimmed first message, then starts runtimes", async () => {
    const { deps, sessionsApi, runtimeRpc, calls } = fakeDeps();
    const id = await startSessionWithAgents(deps, baseInput);

    expect(id).toBe("session-1");
    expect(calls).toEqual(["createSession", "insertOutgoingMessage", "runtimeStart"]);
    expect(sessionsApi.createSession).toHaveBeenCalledWith({
      teamId: "team-1",
      title: "Hello",
      mode: "collab",
      primaryAgentId: "agent-1",
      ideaId: null,
      participantActorIds: ["agent-1"],
    });
    expect(sessionsApi.insertOutgoingMessage).toHaveBeenCalledWith({
      id: "msg-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "me",
      content: "Hello there",
      metadata: { mention_actor_ids: ["agent-1"] },
    });
    expect(runtimeRpc.runtimeStart).toHaveBeenCalledWith({
      targetActorId: "agent-1",
      workspaceId: "ws-1",
      worktree: "/work",
      sessionId: "session-1",
      agentType: AgentType.PI,
      initialPrompt: "",
    });
  });

  // FC seeds only the caller plus participantActorIds — never the primary
  // agent on its own — so the agent has to be in the list, or the session has
  // no agent member to mention or answer.
  it("seeds every collaborator, primary agent first, but not the caller", async () => {
    const { deps, sessionsApi } = fakeDeps();
    await startSessionWithAgents(deps, {
      ...baseInput,
      collaboratorActorIds: ["me", "agent-2", "agent-1", "human-2"],
    });
    expect(sessionsApi.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ participantActorIds: ["agent-1", "agent-2", "human-2"] }),
    );
    expect(sessionsApi.addParticipants).not.toHaveBeenCalled();
  });

  it("skips the first message when it is blank", async () => {
    const { deps, sessionsApi } = fakeDeps();
    await startSessionWithAgents(deps, { ...baseInput, message: "   " });
    expect(sessionsApi.insertOutgoingMessage).not.toHaveBeenCalled();
  });

  it("skips runtime starts without an RPC client", async () => {
    const { deps, calls } = fakeDeps({ runtimeRpc: null });
    await startSessionWithAgents(deps, baseInput);
    expect(calls).not.toContain("runtimeStart");
  });

  it("reports a failed runtime start instead of rejecting", async () => {
    const onRuntimeStartError = vi.fn();
    const failure = new Error("daemon said no");
    const { deps } = fakeDeps({
      onRuntimeStartError,
      runtimeRpc: { runtimeStart: vi.fn(async () => Promise.reject(failure)) },
    });
    await expect(startSessionWithAgents(deps, baseInput)).resolves.toBe("session-1");
    await vi.waitFor(() => expect(onRuntimeStartError).toHaveBeenCalledWith(plan, failure));
  });
});

describe("autoMentionAgentIds (iOS #1601)", () => {
  it("mentions the only agent when the viewer can reach it", () => {
    expect(autoMentionAgentIds(["a1"], ["a1", "a2"])).toEqual(["a1"]);
    expect(autoMentionAgentIds(["a1", "a1"], new Set(["a1"]))).toEqual(["a1"]);
  });

  it("mentions nobody with several agents", () => {
    expect(autoMentionAgentIds(["a1", "a2"], ["a1", "a2"])).toEqual([]);
  });

  it("mentions nobody when the single agent is not on the viewer's roster", () => {
    expect(autoMentionAgentIds(["a1"], ["a2"])).toEqual([]);
  });

  it("mentions nobody without agents", () => {
    expect(autoMentionAgentIds([], ["a1"])).toEqual([]);
  });
});

describe("firstMessageWithMentions", () => {
  it("prepends the mentioned agent", () => {
    expect(firstMessageWithMentions("top 10 news", ["a1"], { a1: "mini" })).toBe("@mini top 10 news");
  });

  it("does not repeat a mention the user already typed", () => {
    expect(firstMessageWithMentions("hey @Mini top 10", ["a1"], { a1: "mini" })).toBe(
      "hey @Mini top 10",
    );
  });

  it("leaves the text alone without a mention or a name", () => {
    expect(firstMessageWithMentions("top 10 news", [], { a1: "mini" })).toBe("top 10 news");
    expect(firstMessageWithMentions("top 10 news", ["a1"], {})).toBe("top 10 news");
  });
});

describe("startSessionWithAgents · mentions and apps", () => {
  it("addresses the first message to the mentioned agent when names are given", async () => {
    const { deps, sessionsApi } = fakeDeps();
    await startSessionWithAgents(deps, {
      ...baseInput,
      mentionDisplayNameById: { "agent-1": "mini" },
    });
    expect(sessionsApi.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "@mini Hello there",
        metadata: { mention_actor_ids: ["agent-1"] },
      }),
    );
  });

  it("sends appId and binds each agent's seat to its plan's workspace for an app session", async () => {
    const { deps, sessionsApi } = fakeDeps();
    await startSessionWithAgents(deps, {
      ...baseInput,
      appId: "app-1",
      runtimePlans: [{ ...plan, workspaceId: "ws-checkout", worktree: "/apps/shop" }],
    });
    expect(sessionsApi.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "app-1",
        workspaceByActorId: { "agent-1": "ws-checkout" },
      }),
    );
  });

  it("binds no seats for a plain session", async () => {
    const { deps, sessionsApi } = fakeDeps();
    await startSessionWithAgents(deps, baseInput);
    const body = (sessionsApi.createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("appId");
    expect(body).not.toHaveProperty("workspaceByActorId");
    expect(seatWorkspaceByActorId(null, [plan])).toEqual({});
  });
});
