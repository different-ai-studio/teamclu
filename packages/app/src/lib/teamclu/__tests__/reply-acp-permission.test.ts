import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { AgentType } from "@/lib/proto/amux_pb";

const mocks = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  mqttPublish: vi.fn(),
  runtimeCommand: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: { listParticipants: mocks.listParticipants },
  }),
}));

vi.mock("@/lib/mqtt/mqtt-bridge", () => ({
  mqttPublish: mocks.mqttPublish,
}));

// ADR-0004: a command carrying a session id is dispatched over RPC, not by
// publishing to the per-spawn `runtime/{runtimeId}/commands` topic. Stubbing
// the RPC keeps this test on its actual subject — which attachment gets
// addressed — instead of the transport underneath it.
vi.mock("@/lib/daemon/teamclu-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/daemon/teamclu-rpc")>()),
  runtimeCommand: (...args: unknown[]) => mocks.runtimeCommand(...args),
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: { id: "team-1" },
      currentMember: { id: "member-actor-1" },
    }),
  },
}));

vi.mock("@/stores/v2-streaming-store", () => ({
  useV2StreamingStore: {
    getState: () => ({
      byKey: {
        "sess-1::agent-live": {
          sessionId: "sess-1",
          actorId: "agent-live",
          pendingPermissionsByRequestId: {
            "perm-uuid-1": {
              requestId: "perm-uuid-1",
              toolName: "bash",
              description: "run",
              params: {},
            },
          },
        },
      },
      clearPermissionRequest: vi.fn(),
    }),
  },
}));

describe("replyAcpPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeStateStore.getState().clear();
    mocks.listParticipants.mockResolvedValue([
      { id: "agent-live", actor_type: "agent" },
    ]);
    mocks.mqttPublish.mockResolvedValue(undefined);
    // `true` = the daemon holds a live attachment for the session. Returning
    // `false` here would make the caller throw "no live attachment".
    mocks.runtimeCommand.mockResolvedValue(true);
  });

  it("addresses the attachment filed under this session, ignoring others", async () => {
    // Replaces "prefers session-bound runtime over stale MQTT retain": with the
    // retain keyed by session there is no second candidate to prefer over, which
    // is the whole point of dropping the per-spawn table (ADR-0004).
    useRuntimeStateStore.getState().upsert("agent-live::other-session", "agent-live", {
      runtimeId: "wrong-spawn",
      agentType: AgentType.OPENCODE,
      currentModel: "",
      availableModels: [],
      availableCommands: [],
      state: 0,
      status: 0,
    });
    useRuntimeStateStore.getState().upsert("agent-live::sess-1", "agent-live", {
      runtimeId: "live-spawn",
      agentType: AgentType.OPENCODE,
      currentModel: "",
      availableModels: [],
      availableCommands: [],
      state: 0,
      status: 0,
    });

    const { replyPermissionById } = await import("@/lib/teamclu/reply-acp-permission");
    await replyPermissionById("perm-uuid-1", "allow");

    expect(mocks.runtimeCommand).toHaveBeenCalledTimes(1);
    const [call] = mocks.runtimeCommand.mock.calls[0] as [
      { targetActorId: string; sessionId: string; envelope: { runtimeId: string; acpCommand?: { command: { case: string } } } },
    ];
    expect(call.targetActorId).toBe("agent-live");
    expect(call.sessionId).toBe("sess-1");
    // The point of the test: the attachment filed under `sess-1`, not the
    // `other-session` one that is also in the store.
    expect(call.envelope.runtimeId).toBe("live-spawn");
    expect(call.envelope.acpCommand?.command.case).toBe("grantPermission");

    // Session-addressed dispatch goes over RPC only — the legacy per-spawn
    // topic must not also be published to, or a cold session is a silent miss.
    expect(mocks.mqttPublish).not.toHaveBeenCalled();
  });
});
