import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionPermissionMode: vi.fn(),
  runtimeTargetsForSession: vi.fn(() => [] as Array<{ agent_id: string | null; runtime_id: string | null }>),
}));

vi.mock("@/lib/daemon/teamclu-rpc", () => ({
  sessionPermissionMode: mocks.sessionPermissionMode,
}));

vi.mock("@/lib/agent/runtime-state-resolve", () => ({
  runtimeTargetsForSession: mocks.runtimeTargetsForSession,
}));

import {
  resetSessionPermissionModesForTests,
  setSessionDefaultPermissionMode,
  setSessionPermissionMode,
} from "@/lib/session/session-permission-mode";
import {
  resolveSessionPermissionModeTargetActorIds,
  syncDefaultPermissionModeToLiveSessions,
  syncSessionPermissionModeToDaemon,
} from "@/lib/teamclu/sync-session-permission-mode";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";

describe("resolveSessionPermissionModeTargetActorIds", () => {
  beforeEach(() => {
    mocks.runtimeTargetsForSession.mockReturnValue([]);
    useSessionParticipantStore.setState({ participantsBySession: {} });
  });

  it("prefers live runtime retain targets", () => {
    mocks.runtimeTargetsForSession.mockReturnValue([
      { agent_id: "69306260-cfbd-4c5b-90a3-76e3f4278f91", runtime_id: "sess-1" },
    ]);
    expect(resolveSessionPermissionModeTargetActorIds("sess-1")).toEqual([
      "69306260-cfbd-4c5b-90a3-76e3f4278f91",
    ]);
  });

  it("falls back to agent participants when retain is empty", () => {
    useSessionParticipantStore.setState({
      participantsBySession: {
        "sess-1": [
          {
            actorId: "69306260-cfbd-4c5b-90a3-76e3f4278f91",
            displayName: "xiaomei",
            avatarUrl: null,
            isAgent: true,
            isExternal: false,
          },
        ],
      },
    });
    expect(resolveSessionPermissionModeTargetActorIds("sess-1")).toEqual([
      "69306260-cfbd-4c5b-90a3-76e3f4278f91",
    ]);
  });
});

describe("syncSessionPermissionModeToDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeTargetsForSession.mockReturnValue([
      { agent_id: "69306260-cfbd-4c5b-90a3-76e3f4278f91", runtime_id: "sess-1" },
    ]);
    useRuntimeStateStore.setState({ byRuntimeId: {} });
    mocks.sessionPermissionMode.mockResolvedValue({
      accepted: true,
      effectiveMode: "full_access",
      rejectedReason: "",
    });
  });

  it("routes SessionPermissionMode RPC to session runtime owner, not local daemon only", async () => {
    const result = await syncSessionPermissionModeToDaemon("sess-1", "fullAccess");
    expect(result.accepted).toBe(true);
    expect(mocks.sessionPermissionMode).toHaveBeenCalledWith({
      targetActorId: "69306260-cfbd-4c5b-90a3-76e3f4278f91",
      sessionId: "sess-1",
      permissionMode: "full_access",
    });
  });

  it("requires every hosting daemon to accept", async () => {
    mocks.runtimeTargetsForSession.mockReturnValue([
      { agent_id: "agent-a", runtime_id: "sess-1" },
      { agent_id: "agent-b", runtime_id: "sess-1" },
    ]);
    mocks.sessionPermissionMode
      .mockResolvedValueOnce({ accepted: true, effectiveMode: "full_access", rejectedReason: "" })
      .mockResolvedValueOnce({ accepted: false, effectiveMode: "", rejectedReason: "no session" });

    const result = await syncSessionPermissionModeToDaemon("sess-1", "fullAccess");
    expect(result.accepted).toBe(false);
    expect(mocks.sessionPermissionMode).toHaveBeenCalledTimes(2);
  });
});

describe("syncDefaultPermissionModeToLiveSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionPermissionModesForTests();
    useSessionParticipantStore.setState({ participantsBySession: {} });
    mocks.sessionPermissionMode.mockResolvedValue({
      accepted: true,
      effectiveMode: "full_access",
      rejectedReason: "",
    });
    mocks.runtimeTargetsForSession.mockImplementation(
      (sessionId: string) =>
        [
          {
            agent_id: `agent-${sessionId}`,
            runtime_id: sessionId,
          },
        ] as Array<{ agent_id: string | null; runtime_id: string | null }>,
    );
    useRuntimeStateStore.setState({
      byRuntimeId: {
        "agent-sess-plain::sess-plain": {
          info: {} as never,
          daemonActorId: "agent-sess-plain",
          lastUpdated: 0,
        },
        "agent-sess-picked::sess-picked": {
          info: {} as never,
          daemonActorId: "agent-sess-picked",
          lastUpdated: 0,
        },
      } as never,
    });
  });

  it("syncs the resolved mode to live sessions without an explicit pick", async () => {
    setSessionPermissionMode("sess-picked", "fullAccess");
    setSessionDefaultPermissionMode("fullAccess");

    await syncDefaultPermissionModeToLiveSessions();

    // sess-picked keeps its explicit pick — no RPC for it.
    expect(mocks.sessionPermissionMode).toHaveBeenCalledTimes(1);
    expect(mocks.sessionPermissionMode).toHaveBeenCalledWith({
      targetActorId: "agent-sess-plain",
      sessionId: "sess-plain",
      permissionMode: "full_access",
    });
  });

  it("skips everything when every live session has an explicit pick", async () => {
    setSessionPermissionMode("sess-plain", "default");
    setSessionPermissionMode("sess-picked", "fullAccess");

    await syncDefaultPermissionModeToLiveSessions();

    expect(mocks.sessionPermissionMode).not.toHaveBeenCalled();
  });
});
