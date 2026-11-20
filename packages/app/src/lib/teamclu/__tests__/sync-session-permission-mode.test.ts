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

import { noteLocalDaemonActorId } from "@/lib/daemon/local-daemon-identity";
import {
  hasExplicitSessionPermissionMode,
  resetSessionPermissionModesForTests,
  setSessionDefaultPermissionMode,
  setSessionPermissionMode,
} from "@/lib/session/session-permission-mode";
import {
  resolveSessionPermissionModeTargetActorIds,
  runtimePermissionStartFields,
  syncSessionPermissionModeToDaemon,
} from "@/lib/teamclu/sync-session-permission-mode";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import type { SessionListEntry } from "@/stores/session-list-store";

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
      remember: false,
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

function sessionRow(id: string, source: string | null): SessionListEntry {
  return {
    id,
    title: id,
    team_id: "team-1",
    last_message_at: null,
    last_message_preview: null,
    mode: "solo",
    idea_id: null,
    has_unread: false,
    has_mention: false,
    source,
    created_at: null,
    updated_at: null,
  };
}

describe("runtimePermissionStartFields", () => {
  beforeEach(() => {
    resetSessionPermissionModesForTests();
    noteLocalDaemonActorId("local-daemon");
    useRuntimeStateStore.setState({ byRuntimeId: {} });
    useSessionListStore.setState({ rows: [sessionRow("sess-new", "user")] });
  });

  it("records the current default on the first start and keeps it", () => {
    setSessionDefaultPermissionMode("default");

    expect(runtimePermissionStartFields("sess-new", "local-daemon")).toEqual({
      permissionMode: "default",
      rememberPermission: true,
      defaultPermissionMode: "default",
    });
    expect(hasExplicitSessionPermissionMode("sess-new")).toBe(true);

    setSessionDefaultPermissionMode("fullAccess");
    expect(runtimePermissionStartFields("sess-new", "local-daemon")).toEqual({
      permissionMode: "default",
      rememberPermission: true,
      defaultPermissionMode: "full_access",
    });
  });

  it("does not record a session that is already running", () => {
    setSessionDefaultPermissionMode("fullAccess");
    useRuntimeStateStore.setState({
      byRuntimeId: {
        "local-daemon::sess-new": {
          info: {} as never,
          daemonActorId: "local-daemon",
          lastUpdated: 0,
        },
      } as never,
    });

    expect(runtimePermissionStartFields("sess-new", "local-daemon")).toEqual({
      permissionMode: "",
      rememberPermission: false,
      defaultPermissionMode: "full_access",
    });
    expect(hasExplicitSessionPermissionMode("sess-new")).toBe(false);
  });

  it("leaves a channel session unrecorded", () => {
    useSessionListStore.setState({ rows: [sessionRow("gw-1", "gateway")] });
    setSessionDefaultPermissionMode("default");

    expect(runtimePermissionStartFields("gw-1", "local-daemon")).toEqual({
      permissionMode: "",
      rememberPermission: false,
      defaultPermissionMode: "default",
    });
    expect(hasExplicitSessionPermissionMode("gw-1")).toBe(false);
  });
});
