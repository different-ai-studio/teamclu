import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { RuntimeCommandEnvelope } from "@teamclu/app/proto/amux_pb";
import {
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeCommandResultSchema,
} from "@teamclu/app/proto/teamclu_pb";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeCommandSender,
  NotDispatchedError,
  resolvePermissionRuntimeTarget,
} from "../lib/teamclu/runtime-command";
import { createRuntimeRpcClient } from "../lib/teamclu/runtime-rpc";

type Call = { targetActorId: string; sessionId: string; envelope: RuntimeCommandEnvelope };

function fakeRpc(dispatched = true) {
  const calls: Call[] = [];
  return {
    calls,
    rpc: {
      runtimeCommand: vi.fn(async (args: Call) => {
        calls.push(args);
        return { dispatched };
      }),
    },
  };
}

function sender(rpc: ReturnType<typeof fakeRpc>["rpc"], senderActorId: string | null = "member-1") {
  return createRuntimeCommandSender({
    rpc,
    peerId: "teamclu-expo-member-1",
    senderActorId,
    commandId: () => "command-1",
    nowSeconds: () => 1_779_430_400,
  });
}

const target = { targetActorId: "agent-1", sessionId: "session-1" };

describe("runtime command sender", () => {
  it("sends grant_permission by (actor, session) over RPC", async () => {
    const { rpc, calls } = fakeRpc();
    await sender(rpc).sendPermissionResponse({ ...target, requestId: "perm-1", granted: true, optionId: "allow" });

    expect(calls).toHaveLength(1);
    expect(calls[0].targetActorId).toBe("agent-1");
    expect(calls[0].sessionId).toBe("session-1");
    const env = calls[0].envelope;
    expect(env.actorId).toBe("agent-1");
    expect(env.peerId).toBe("teamclu-expo-member-1");
    expect(env.senderActorId).toBe("member-1");
    expect(env.commandId).toBe("command-1");
    expect(env.timestamp).toBe(1_779_430_400n);
    expect(env.acpCommand?.command.case).toBe("grantPermission");
    if (env.acpCommand?.command.case === "grantPermission") {
      expect(env.acpCommand.command.value.requestId).toBe("perm-1");
      expect(env.acpCommand.command.value.optionId).toBe("allow");
    }
  });

  it("sends deny_permission and leaves a blank sender actor id empty", async () => {
    const { rpc, calls } = fakeRpc();
    await sender(rpc, "  ").sendPermissionResponse({ ...target, requestId: "perm-2", granted: false });
    expect(calls[0].envelope.acpCommand?.command.case).toBe("denyPermission");
    expect(calls[0].envelope.senderActorId).toBe("");
  });

  it("sends cancel — the stop button", async () => {
    const { rpc, calls } = fakeRpc();
    await sender(rpc).sendCancel(target);
    expect(calls[0].envelope.acpCommand?.command.case).toBe("cancel");
  });

  it("sends answer_question with the JSON answer matrix, and drops answers when rejecting", async () => {
    const { rpc, calls } = fakeRpc();
    await sender(rpc).sendAnswerQuestion({ ...target, requestId: "q-1", answers: [["A"], ["B", "C"]] });
    await sender(rpc).sendAnswerQuestion({ ...target, requestId: "q-2", answers: [["A"]], reject: true });
    const [answered, rejected] = calls.map((c) => c.envelope.acpCommand?.command);
    expect(answered?.case).toBe("answerQuestion");
    if (answered?.case === "answerQuestion") {
      expect(JSON.parse(answered.value.answersJson)).toEqual([["A"], ["B", "C"]]);
      expect(answered.value.reject).toBe(false);
    }
    if (rejected?.case === "answerQuestion") {
      expect(JSON.parse(rejected.value.answersJson)).toEqual([]);
      expect(rejected.value.reject).toBe(true);
    }
  });

  it("sends request_turn_history", async () => {
    const { rpc, calls } = fakeRpc();
    await sender(rpc).sendRequestTurnHistory({ ...target, turnId: "turn-9", requestId: "r-1" });
    const cmd = calls[0].envelope.acpCommand?.command;
    expect(cmd?.case).toBe("requestTurnHistory");
    if (cmd?.case === "requestTurnHistory") expect(cmd.value.turnId).toBe("turn-9");
  });

  it("throws NotDispatchedError when the agent holds no attachment for the session", async () => {
    const { rpc } = fakeRpc(false);
    await expect(sender(rpc).sendCancel(target)).rejects.toBeInstanceOf(NotDispatchedError);
  });

  it("rejects before sending when the session or request id is missing", async () => {
    const { rpc } = fakeRpc();
    await expect(sender(rpc).sendCancel({ targetActorId: "agent-1", sessionId: " " })).rejects.toThrow(
      "session id is required",
    );
    await expect(
      sender(rpc).sendAnswerQuestion({ ...target, requestId: "", answers: [] }),
    ).rejects.toThrow("request id is required");
    expect(rpc.runtimeCommand).not.toHaveBeenCalled();
  });
});

describe("RPC client runtimeCommand", () => {
  function fakeMqtt(respond: (req: ReturnType<typeof decodeRequest>) => Uint8Array | null) {
    const handlers = new Map<string, (payload: Uint8Array, topic: string) => void>();
    const published: string[] = [];
    return {
      published,
      subscribe(topic: string, handler: (payload: Uint8Array, topic: string) => void) {
        handlers.set(topic, handler);
        return () => { handlers.delete(topic); };
      },
      async publish(topic: string, payload: Uint8Array) {
        published.push(topic);
        const reply = respond(decodeRequest(payload));
        if (reply) handlers.get("amux/team-1/member-1/rpc/res")?.(reply, "amux/team-1/member-1/rpc/res");
      },
    };
  }
  function decodeRequest(payload: Uint8Array) {
    return fromBinary(RpcRequestSchema, payload);
  }
  function reply(requestId: string, dispatched: boolean, success = true, error = "") {
    return toBinary(
      RpcResponseSchema,
      create(RpcResponseSchema, {
        requestId,
        success,
        error,
        result: {
          case: "runtimeCommandResult",
          value: create(RuntimeCommandResultSchema, { dispatched }),
        },
      }),
    );
  }

  it("publishes runtime_command to the agent's rpc/req and resolves with dispatched", async () => {
    let seen: ReturnType<typeof decodeRequest> | null = null;
    const mqtt = fakeMqtt((req) => {
      seen = req;
      return reply(req.requestId, true);
    });
    const client = createRuntimeRpcClient({ mqtt, teamId: "team-1", requesterActorId: "member-1" });
    const { rpc } = { rpc: client };
    const result = await createRuntimeCommandSender({ rpc, peerId: "p" }).sendCancel(target).then(() => "ok");

    expect(result).toBe("ok");
    expect(mqtt.published).toEqual(["amux/team-1/agent-1/rpc/req"]);
    const req = seen as unknown as ReturnType<typeof decodeRequest>;
    expect(req.method.case).toBe("runtimeCommand");
    if (req.method.case === "runtimeCommand") {
      expect(req.method.value.sessionId).toBe("session-1");
      expect(req.method.value.envelope?.acpCommand?.command.case).toBe("cancel");
    }
  });

  it("surfaces the daemon's error when the RPC is refused", async () => {
    const mqtt = fakeMqtt((req) => reply(req.requestId, false, false, "permission denied"));
    const client = createRuntimeRpcClient({ mqtt, teamId: "team-1", requesterActorId: "member-1" });
    await expect(
      client.runtimeCommand({ ...target, envelope: {} as RuntimeCommandEnvelope }),
    ).rejects.toThrow("permission denied");
  });

  it("times out when nobody answers", async () => {
    const mqtt = fakeMqtt(() => null);
    const client = createRuntimeRpcClient({ mqtt, teamId: "team-1", requesterActorId: "member-1" });
    await expect(
      client.runtimeCommand({ ...target, envelope: {} as RuntimeCommandEnvelope, timeoutMs: 10 }),
    ).rejects.toThrow("timeout");
  });
});

describe("resolvePermissionRuntimeTarget", () => {
  it("routes to the requesting agent when it is a connected participant", () => {
    expect(
      resolvePermissionRuntimeTarget({
        requestingActorId: "agent-2",
        agentParticipantIds: ["agent-1", "agent-2"],
        connectedAgents: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
      }),
    ).toEqual({ agentId: "agent-2", actorId: "agent-2" });
  });

  it("falls back to the first connected agent participant", () => {
    expect(
      resolvePermissionRuntimeTarget({
        requestingActorId: "agent-offline",
        agentParticipantIds: ["agent-offline", "agent-1"],
        connectedAgents: [{ agentId: "agent-1" }],
      }),
    ).toEqual({ agentId: "agent-1", actorId: "agent-1" });
  });

  it("returns null when no agent participant is connected", () => {
    expect(
      resolvePermissionRuntimeTarget({
        requestingActorId: "agent-1",
        agentParticipantIds: ["agent-1"],
        connectedAgents: [],
      }),
    ).toBeNull();
  });
});
