import { AgentType } from "@teamclu/app/proto/amux_pb";
import { describe, expect, it, vi } from "vitest";

import type { ConnectedAgent } from "../features/actors/connected-agent-types";
import type { StartSessionDeps } from "../features/sessions/start-session";
import {
  formatVoiceClock,
  initialVoiceCaptureState,
  resolveVoiceTarget,
  startVoiceSession,
  voiceCaptureReducer,
  voiceMeterBarHeight,
  voiceRuntimeAgent,
  VoiceSessionError,
  type VoiceCaptureEvent,
  type VoiceCaptureState,
} from "../features/sessions/voice-session";

function agent(agentId: string, extra: Partial<ConnectedAgent> = {}): ConnectedAgent {
  return {
    agentId,
    displayName: agentId,
    agentTypes: ["pi"],
    defaultAgentType: "pi",
    permissionLevel: "full",
    visibility: "team",
    isOwner: true,
    lastActiveAt: null,
    ...extra,
  };
}

function run(events: VoiceCaptureEvent[], from = initialVoiceCaptureState): VoiceCaptureState {
  return events.reduce(voiceCaptureReducer, from);
}

describe("voiceCaptureReducer", () => {
  it("walks preparing → recording → startingSession → done", () => {
    const recording = run([{ type: "recordingStarted" }]);
    expect(recording.phase).toBe("recording");

    const starting = voiceCaptureReducer(recording, { type: "stopped", transcript: "  fix the build  " });
    expect(starting.phase).toBe("startingSession");
    expect(starting.transcript).toBe("fix the build");

    const done = voiceCaptureReducer(starting, { type: "sessionStarted", sessionId: "s-1" });
    expect(done.phase).toBe("done");
    expect(done.sessionId).toBe("s-1");
  });

  it("fails an empty take without creating anything", () => {
    const state = run([{ type: "recordingStarted" }, { type: "stopped", transcript: "  \n " }]);
    expect(state.phase).toBe("failed");
    expect(state.error).toEqual({ kind: "emptyTranscript" });
  });

  it("parks on the picker and resumes after a pick", () => {
    const agents = [agent("a1"), agent("a2")];
    const parked = run([
      { type: "recordingStarted" },
      { type: "stopped", transcript: "hello" },
      { type: "needsPick", agents },
    ]);
    expect(parked.phase).toBe("awaitingAgent");
    expect(parked.pickableAgents).toEqual(agents);
    expect(parked.transcript).toBe("hello");

    const resumed = voiceCaptureReducer(parked, { type: "agentPicked" });
    expect(resumed.phase).toBe("startingSession");
  });

  it("can be cancelled from any live phase, and ignores late results", () => {
    for (const events of [
      [] as VoiceCaptureEvent[],
      [{ type: "recordingStarted" }] as VoiceCaptureEvent[],
      [
        { type: "recordingStarted" },
        { type: "stopped", transcript: "hi" },
        { type: "needsPick", agents: [agent("a1")] },
      ] as VoiceCaptureEvent[],
    ]) {
      const cancelled = run([...events, { type: "cancel" }]);
      expect(cancelled.phase).toBe("cancelled");
      expect(voiceCaptureReducer(cancelled, { type: "sessionStarted", sessionId: "late" })).toBe(
        cancelled,
      );
      expect(
        voiceCaptureReducer(cancelled, { type: "failed", error: { kind: "notReady" } }),
      ).toBe(cancelled);
    }
  });

  it("ignores events that don't fit the phase", () => {
    // Done is disabled while preparing, but a stray sessionStarted must not
    // skip the take.
    expect(run([{ type: "sessionStarted", sessionId: "x" }]).phase).toBe("preparing");
    expect(run([{ type: "agentPicked" }]).phase).toBe("preparing");
    const recording = run([{ type: "recordingStarted" }]);
    expect(voiceCaptureReducer(recording, { type: "needsPick", agents: [] })).toBe(recording);
  });

  it("records failures with their reason", () => {
    const failed = run([{ type: "failed", error: { kind: "permissionDenied" } }]);
    expect(failed.phase).toBe("failed");
    expect(failed.error).toEqual({ kind: "permissionDenied" });
  });
});

describe("resolveVoiceTarget", () => {
  it("uses the effective default when the viewer can reach it", () => {
    const target = resolveVoiceTarget({
      agents: [agent("a1"), agent("a2")],
      effectiveDefaultAgentId: "a2",
    });
    expect(target).toEqual({ kind: "agent", agent: agent("a2") });
  });

  it("asks when there is no default", () => {
    const agents = [agent("a1"), agent("a2")];
    expect(resolveVoiceTarget({ agents, effectiveDefaultAgentId: null })).toEqual({
      kind: "needsPick",
      agents,
    });
  });

  it("treats a default pointing at an unreachable agent as no default", () => {
    expect(
      resolveVoiceTarget({ agents: [agent("a1")], effectiveDefaultAgentId: "gone" }).kind,
    ).toBe("needsPick");
  });

  it("reports when there is no agent at all", () => {
    expect(resolveVoiceTarget({ agents: [], effectiveDefaultAgentId: "a1" })).toEqual({
      kind: "noAgents",
    });
  });
});

describe("startVoiceSession", () => {
  function deps(overrides: Partial<StartSessionDeps> = {}) {
    const sessionsApi = {
      createSession: vi.fn(async () => "session-9"),
      addParticipants: vi.fn(async () => {}),
      insertOutgoingMessage: vi.fn(async () => {}),
    };
    const runtimeRpc = { runtimeStart: vi.fn(async () => ({}) as never) };
    return {
      sessionsApi,
      runtimeRpc,
      deps: {
        sessionsApi,
        runtimeRpc,
        newMessageId: () => "m-1",
        onRuntimeStartError: vi.fn(),
        ...overrides,
      } satisfies StartSessionDeps,
    };
  }

  const input = {
    teamId: "team-1",
    memberActorId: "me",
    transcript: "  帮我看一下部署\n为什么失败  ",
    agent: voiceRuntimeAgent(agent("a1", { defaultAgentType: null, agentTypes: [] }), {
      defaultWorkspaceId: "ws-default",
    }),
    connectedAgentIds: ["a1"],
    workspaces: [
      { id: "ws-other", path: "/other", agentId: "a1" },
      { id: "ws-default", path: "/default", agentId: "a1" },
    ],
    fallbackTitle: "New Session",
  };

  it("creates a session with the transcript as first message and starts the agent", async () => {
    const { deps: d, sessionsApi, runtimeRpc } = deps();
    await expect(startVoiceSession(d, input)).resolves.toBe("session-9");

    expect(sessionsApi.createSession).toHaveBeenCalledWith({
      teamId: "team-1",
      title: "帮我看一下部署",
      mode: "collab",
      primaryAgentId: "a1",
      ideaId: null,
      participantActorIds: ["a1"],
    });
    expect(sessionsApi.addParticipants).not.toHaveBeenCalled();
    expect(sessionsApi.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "帮我看一下部署\n为什么失败",
        metadata: { mention_actor_ids: ["a1"] },
      }),
    );
    expect(runtimeRpc.runtimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: "a1",
        workspaceId: "ws-default",
        worktree: "/default",
        sessionId: "session-9",
        agentType: AgentType.PI,
      }),
    );
  });

  it("refuses an empty transcript", async () => {
    const { deps: d, sessionsApi } = deps();
    await expect(startVoiceSession(d, { ...input, transcript: "  " })).rejects.toEqual(
      new VoiceSessionError({ kind: "emptyTranscript" }),
    );
    expect(sessionsApi.createSession).not.toHaveBeenCalled();
  });

  it("refuses without a runtime RPC rather than creating a human-only session", async () => {
    const { deps: d, sessionsApi } = deps({ runtimeRpc: null });
    await expect(startVoiceSession(d, input)).rejects.toBeInstanceOf(VoiceSessionError);
    expect(sessionsApi.createSession).not.toHaveBeenCalled();
  });

  it("fails before creating anything when the agent is offline", async () => {
    const { deps: d, sessionsApi } = deps();
    await expect(startVoiceSession(d, { ...input, connectedAgentIds: [] })).rejects.toThrow(
      /offline/,
    );
    expect(sessionsApi.createSession).not.toHaveBeenCalled();
  });

  it("fails before creating anything when the agent has no workspace", async () => {
    const { deps: d, sessionsApi } = deps();
    await expect(
      startVoiceSession(d, {
        ...input,
        agent: voiceRuntimeAgent(agent("a1"), null),
        workspaces: [{ id: "ws-x", path: "/x", agentId: "someone-else" }],
      }),
    ).rejects.toThrow(/No workspace/);
    expect(sessionsApi.createSession).not.toHaveBeenCalled();
  });
});

describe("presentation helpers", () => {
  it("formats the elapsed clock as mm:ss", () => {
    expect(formatVoiceClock(0)).toBe("00:00");
    expect(formatVoiceClock(7_900)).toBe("00:07");
    expect(formatVoiceClock(125_000)).toBe("02:05");
    expect(formatVoiceClock(-5)).toBe("00:00");
  });

  it("keeps meter bars within [4, height] and taller for louder input", () => {
    const args = { index: 10, barCount: 21, time: 0.3, height: 132 };
    const quiet = voiceMeterBarHeight({ ...args, level: 0 });
    const loud = voiceMeterBarHeight({ ...args, level: 1 });
    expect(quiet).toBeGreaterThanOrEqual(4);
    expect(loud).toBeLessThanOrEqual(132);
    expect(loud).toBeGreaterThan(quiet);
    // Edges of the spindle stay at the floor.
    expect(voiceMeterBarHeight({ ...args, index: 0, level: 1 })).toBeCloseTo(0.06 * 132);
  });
});
