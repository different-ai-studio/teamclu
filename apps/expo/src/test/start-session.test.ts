import { AgentType } from "@teamclu/app/proto/amux_pb";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeStartPlan } from "../features/sessions/runtime-start";
import {
  deriveSessionTitle,
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

  it("adds only collaborators beyond the caller and the primary agent", async () => {
    const { deps, sessionsApi } = fakeDeps();
    await startSessionWithAgents(deps, {
      ...baseInput,
      collaboratorActorIds: ["agent-1", "me", "agent-2", "human-2"],
    });
    expect(sessionsApi.addParticipants).toHaveBeenCalledWith("session-1", ["agent-2", "human-2"]);
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
