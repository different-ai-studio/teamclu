import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mqttPublish: vi.fn(),
  runtimeCommand: vi.fn(),
  clearPermissionRequest: vi.fn(),
}));

vi.mock("@/lib/mqtt/mqtt-bridge", () => ({
  mqttPublish: mocks.mqttPublish,
}));

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
      clearPermissionRequest: mocks.clearPermissionRequest,
    }),
  },
}));

describe("replyAcpPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mqttPublish.mockResolvedValue(undefined);
    mocks.runtimeCommand.mockResolvedValue(true);
  });

  it("sends session-addressed grant without local runtime retain", async () => {
    const { replyPermissionById } = await import("@/lib/teamclu/reply-acp-permission");
    const result = await replyPermissionById("perm-uuid-1", "allow");

    expect(result).toEqual({ status: "sent" });
    expect(mocks.runtimeCommand).toHaveBeenCalledTimes(1);
    const [call] = mocks.runtimeCommand.mock.calls[0] as [
      {
        targetActorId: string;
        sessionId: string;
        envelope: { runtimeId: string; acpCommand?: { command: { case: string } } };
      },
    ];
    expect(call.targetActorId).toBe("agent-live");
    expect(call.sessionId).toBe("sess-1");
    expect(call.envelope.runtimeId).toBe("sess-1");
    expect(call.envelope.acpCommand?.command.case).toBe("grantPermission");
    expect(mocks.mqttPublish).not.toHaveBeenCalled();
    expect(mocks.clearPermissionRequest).not.toHaveBeenCalled();
  });

  it("returns cold when daemon holds no attachment", async () => {
    mocks.runtimeCommand.mockResolvedValue(false);
    const { replyPermissionById } = await import("@/lib/teamclu/reply-acp-permission");
    const result = await replyPermissionById("perm-uuid-1", "allow");
    expect(result).toEqual({ status: "cold" });
  });
});
