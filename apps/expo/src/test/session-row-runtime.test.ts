import { describe, expect, it } from "vitest";

import { OFFLINE_PRESENCE, type ActorPresenceSnapshot } from "../features/actors/actor-presence";
import type { RuntimeInfo } from "../features/actors/connected-agent-types";
import {
  buildSessionRuntimeMaps,
  runtimeStatusLabel,
  runtimeWorkspaceName,
} from "../features/sessions/session-row-runtime";
import type { SessionSummary } from "../features/sessions/session-types";

function runtime(partial: Partial<RuntimeInfo>): RuntimeInfo {
  return {
    runtimeId: "rt-1",
    agentType: 0,
    worktree: "",
    branch: "",
    status: 0,
    startedAt: 0,
    currentPrompt: "",
    workspaceId: "",
    sessionTitle: "",
    toolUseCount: 0,
    availableModels: [],
    currentModel: "",
    state: 0,
    stage: "",
    errorCode: "",
    errorMessage: "",
    failedStage: "",
    availableCommands: [],
    ...partial,
  };
}

function session(partial: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    teamId: "t1",
    title: partial.sessionId,
    summary: "",
    participantCount: 0,
    participantActorIds: [],
    lastMessagePreview: "",
    lastMessageAt: "",
    createdAt: "",
    createdBy: "",
    ...partial,
  };
}

describe("runtimeStatusLabel", () => {
  it("matches the iOS AgentAttachment.statusLabel mapping", () => {
    expect([1, 2, 3, 4, 5].map(runtimeStatusLabel)).toEqual([
      "Starting",
      "Active",
      "Idle",
      "Error",
      "Stopped",
    ]);
    // 0 / undefined means "no attachment" — the row shows no status at all,
    // rather than iOS's "Unknown" (which it also suppresses at the call site).
    expect(runtimeStatusLabel(0)).toBe("");
    expect(runtimeStatusLabel(undefined)).toBe("");
  });
});

describe("runtimeWorkspaceName", () => {
  it("prefers a cached workspace display name", () => {
    const name = runtimeWorkspaceName(
      runtime({ workspaceId: "w1", worktree: "/Users/me/repo" }),
      new Map([["w1", "Main repo"]]),
    );
    expect(name).toBe("Main repo");
  });

  it("falls back to the worktree's last path segment", () => {
    expect(runtimeWorkspaceName(runtime({ worktree: "/Users/me/projects/teamclu/" }))).toBe(
      "teamclu",
    );
    expect(runtimeWorkspaceName(runtime({ worktree: "" }))).toBe("");
  });
});

function presence(sessions: Array<{ sessionId: string; status: number; worktree?: string }>, activeAgentType = 4): ActorPresenceSnapshot {
  return {
    ...OFFLINE_PRESENCE,
    online: true,
    activeAgentType,
    liveSessions: sessions.map((s) => ({
      sessionId: s.sessionId, lifecycle: 2, status: s.status, stage: "", errorCode: "",
      errorMessage: "", failedStage: "", workspaceId: "", currentModel: "", worktree: s.worktree ?? "",
    })),
  };
}

describe("buildSessionRuntimeMaps", () => {
  it("attaches the agent's attachment for that session", () => {
    const { runtimeBySessionId, workspaceBySessionId } = buildSessionRuntimeMaps({
      sessions: [
        session({ sessionId: "s1", participantActorIds: ["human-1", "agent-1"] }),
        session({ sessionId: "s2", participantActorIds: ["human-1"] }),
      ],
      presenceByAgentId: new Map([
        ["agent-1", presence([{ sessionId: "s1", status: 2, worktree: "/srv/app" }])],
      ]),
      agentActorIds: new Set(["agent-1"]),
    });

    expect(runtimeBySessionId.get("s1")).toEqual({
      status: 2,
      agentType: 4,
      statusLabel: "Active",
    });
    expect(workspaceBySessionId.get("s1")).toBe("app");
    // No agent participant → no runtime, so the row renders cold.
    expect(runtimeBySessionId.has("s2")).toBe(false);
  });

  it("gives each session its own status, not one per agent", () => {
    const { runtimeBySessionId } = buildSessionRuntimeMaps({
      sessions: [
        session({ sessionId: "busy", participantActorIds: ["agent-1"] }),
        session({ sessionId: "quiet", participantActorIds: ["agent-1"] }),
        session({ sessionId: "cold", participantActorIds: ["agent-1"] }),
      ],
      presenceByAgentId: new Map([
        ["agent-1", presence([{ sessionId: "busy", status: 2 }, { sessionId: "quiet", status: 3 }])],
      ]),
      agentActorIds: new Set(["agent-1"]),
    });
    expect(runtimeBySessionId.get("busy")?.statusLabel).toBe("Active");
    expect(runtimeBySessionId.get("quiet")?.statusLabel).toBe("Idle");
    expect(runtimeBySessionId.has("cold")).toBe(false);
  });

  it("ignores participants that are not known agents", () => {
    const { runtimeBySessionId } = buildSessionRuntimeMaps({
      sessions: [session({ sessionId: "s1", participantActorIds: ["ghost"] })],
      presenceByAgentId: new Map([["ghost", presence([{ sessionId: "s1", status: 2 }])]]),
      agentActorIds: new Set(),
    });
    expect(runtimeBySessionId.size).toBe(0);
  });
});
