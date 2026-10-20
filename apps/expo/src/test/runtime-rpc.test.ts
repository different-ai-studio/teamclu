import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentType } from "@teamclu/app/proto/amux_pb";
import {
  AddWorkspaceResultSchema,
  RemoveWorkspaceResultSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeStartResultSchema,
  RuntimeStopResultSchema,
} from "@teamclu/app/proto/teamclu_pb";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeRpcClient } from "../lib/teamclu/runtime-rpc";

function createFakeMqtt() {
  const handlers = new Map<string, (payload: Uint8Array, topic: string) => void>();
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((filter: string, handler: (payload: Uint8Array, topic: string) => void) => {
      handlers.set(filter, handler);
      return () => handlers.delete(filter);
    }),
    emit(filter: string, payload: Uint8Array, topic = filter) {
      handlers.get(filter)?.(payload, topic);
    },
  };
}

describe("runtime rpc client", () => {
  it("publishes runtime_start to the target actor and listens on the requester's reply topic", async () => {
    const mqtt = createFakeMqtt();
    const rpc = createRuntimeRpcClient({
      mqtt,
      teamId: "team-1",
      requesterActorId: "member-1",
      requestId: () => "request-1",
      requesterClientId: () => "client-1",
    });

    const promise = rpc.runtimeStart({
      targetActorId: "actor-1",
      workspaceId: "workspace-1",
      worktree: "/tmp/repo",
      sessionId: "session-1",
      agentType: AgentType.CODEX,
      initialPrompt: "",
    });

    // The daemon replies on the requester's actor namespace, not the target's.
    expect(mqtt.subscribe).toHaveBeenCalledWith(
      "amux/team-1/member-1/rpc/res",
      expect.any(Function),
    );
    expect(mqtt.publish).toHaveBeenCalledTimes(1);

    const [topic, bytes, retain] = mqtt.publish.mock.calls[0] as [
      string,
      Uint8Array,
      boolean,
    ];
    expect(topic).toBe("amux/team-1/actor-1/rpc/req");
    expect(retain).toBe(false);

    const request = fromBinary(RpcRequestSchema, bytes);
    expect(request.requestId).toBe("request-1");
    expect(request.requesterActorId).toBe("member-1");
    expect(request.requesterClientId).toBe("client-1");
    expect(request.method.case).toBe("runtimeStart");
    if (request.method.case !== "runtimeStart") {
      throw new Error("expected runtimeStart request");
    }
    expect(request.method.value).toMatchObject({
      workspaceId: "workspace-1",
      worktree: "/tmp/repo",
      sessionId: "session-1",
      agentType: AgentType.CODEX,
    });

    const result = create(RuntimeStartResultSchema, {
      accepted: true,
      runtimeId: "runtime-1",
      sessionId: "session-1",
    });
    const response = create(RpcResponseSchema, {
      requestId: "request-1",
      success: true,
      result: { case: "runtimeStartResult", value: result },
    });
    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(RpcResponseSchema, response),
    );

    await expect(promise).resolves.toMatchObject({
      accepted: true,
      runtimeId: "runtime-1",
      sessionId: "session-1",
    });
  });

  it("rejects a daemon runtime_start refusal", async () => {
    const mqtt = createFakeMqtt();
    const rpc = createRuntimeRpcClient({
      mqtt,
      teamId: "team-1",
      requesterActorId: "member-1",
      requestId: () => "request-2",
      requesterClientId: () => "client-1",
    });

    const promise = rpc.runtimeStart({
      targetActorId: "actor-1",
      workspaceId: "workspace-1",
      worktree: "/tmp/repo",
      sessionId: "session-1",
      agentType: AgentType.CLAUDE_CODE,
    });

    const result = create(RuntimeStartResultSchema, {
      accepted: false,
      rejectedReason: "workspace missing",
    });
    const response = create(RpcResponseSchema, {
      requestId: "request-2",
      success: true,
      result: { case: "runtimeStartResult", value: result },
    });
    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(RpcResponseSchema, response),
    );

    await expect(promise).rejects.toThrow("workspace missing");
  });

  it("publishes runtime_stop to the target actor and resolves the matching response", async () => {
    const mqtt = createFakeMqtt();
    const rpc = createRuntimeRpcClient({
      mqtt,
      teamId: "team-1",
      requesterActorId: "member-1",
      requestId: () => "request-stop-1",
      requesterClientId: () => "client-1",
    });

    const promise = rpc.runtimeStop({
      targetActorId: "actor-1",
      runtimeId: "rt-abcd",
    });

    expect(mqtt.subscribe).toHaveBeenCalledWith(
      "amux/team-1/member-1/rpc/res",
      expect.any(Function),
    );
    expect(mqtt.publish).toHaveBeenCalledTimes(1);

    const [topic, bytes, retain] = mqtt.publish.mock.calls[0] as [
      string,
      Uint8Array,
      boolean,
    ];
    expect(topic).toBe("amux/team-1/actor-1/rpc/req");
    expect(retain).toBe(false);

    const request = fromBinary(RpcRequestSchema, bytes);
    expect(request.requestId).toBe("request-stop-1");
    expect(request.method.case).toBe("runtimeStop");
    if (request.method.case !== "runtimeStop") {
      throw new Error("expected runtimeStop request");
    }
    expect(request.method.value.runtimeId).toBe("rt-abcd");

    const result = create(RuntimeStopResultSchema, { accepted: true });
    const response = create(RpcResponseSchema, {
      requestId: "request-stop-1",
      success: true,
      result: { case: "runtimeStopResult", value: result },
    });
    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(RpcResponseSchema, response),
    );

    await expect(promise).resolves.toMatchObject({ accepted: true });
  });

  it("publishes add_workspace to the target actor and resolves the matching response", async () => {
    const mqtt = createFakeMqtt();
    const rpc = createRuntimeRpcClient({
      mqtt,
      teamId: "team-1",
      requesterActorId: "member-1",
      requestId: () => "request-workspace-1",
      requesterClientId: () => "client-1",
    });

    const promise = rpc.addWorkspace({
      targetActorId: "actor-1",
      path: "/tmp/repo",
    });

    const [topic, bytes, retain] = mqtt.publish.mock.calls[0] as [
      string,
      Uint8Array,
      boolean,
    ];
    expect(topic).toBe("amux/team-1/actor-1/rpc/req");
    expect(retain).toBe(false);

    const request = fromBinary(RpcRequestSchema, bytes);
    expect(request.requestId).toBe("request-workspace-1");
    expect(request.method.case).toBe("addWorkspace");
    if (request.method.case !== "addWorkspace") {
      throw new Error("expected addWorkspace request");
    }
    expect(request.method.value.path).toBe("/tmp/repo");

    const result = create(AddWorkspaceResultSchema, { accepted: true });
    const response = create(RpcResponseSchema, {
      requestId: "request-workspace-1",
      success: true,
      result: { case: "addWorkspaceResult", value: result },
    });
    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(RpcResponseSchema, response),
    );

    await expect(promise).resolves.toMatchObject({ accepted: true });
  });

  it("rejects a daemon remove_workspace refusal", async () => {
    const mqtt = createFakeMqtt();
    const rpc = createRuntimeRpcClient({
      mqtt,
      teamId: "team-1",
      requesterActorId: "member-1",
      requestId: () => "request-workspace-2",
      requesterClientId: () => "client-1",
    });

    const promise = rpc.removeWorkspace({
      targetActorId: "actor-1",
      workspaceId: "workspace-1",
    });

    const result = create(RemoveWorkspaceResultSchema, {
      accepted: false,
      error: "workspace missing",
    });
    const response = create(RpcResponseSchema, {
      requestId: "request-workspace-2",
      success: true,
      result: { case: "removeWorkspaceResult", value: result },
    });
    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(RpcResponseSchema, response),
    );

    await expect(promise).rejects.toThrow("workspace missing");
  });
});

describe("runtime rpc client · remove_participant", () => {
  function client(mqtt: ReturnType<typeof createFakeMqtt>) {
    return createRuntimeRpcClient({
      mqtt,
      teamId: "team-1",
      requesterActorId: "member-1",
      requestId: () => "request-rp",
      requesterClientId: () => "client-1",
    });
  }

  it("publishes remove_participant to the agent's daemon and resolves on success", async () => {
    const mqtt = createFakeMqtt();
    const promise = client(mqtt).removeParticipant({
      targetActorId: "agent-1",
      sessionId: "session-1",
      actorId: "agent-1",
    });

    const [topic, bytes] = mqtt.publish.mock.calls[0] as [string, Uint8Array, boolean];
    expect(topic).toBe("amux/team-1/agent-1/rpc/req");
    const request = fromBinary(RpcRequestSchema, bytes);
    expect(request.method.case).toBe("removeParticipant");
    if (request.method.case !== "removeParticipant") throw new Error("wrong method");
    expect(request.method.value).toMatchObject({ sessionId: "session-1", actorId: "agent-1" });

    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(RpcResponseSchema, create(RpcResponseSchema, { requestId: "request-rp", success: true })),
    );
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the daemon's error", async () => {
    const mqtt = createFakeMqtt();
    const promise = client(mqtt).removeParticipant({
      targetActorId: "agent-1",
      sessionId: "session-1",
      actorId: "agent-1",
    });
    mqtt.emit(
      "amux/team-1/member-1/rpc/res",
      toBinary(
        RpcResponseSchema,
        create(RpcResponseSchema, { requestId: "request-rp", success: false, error: "not a participant" }),
      ),
    );
    await expect(promise).rejects.toThrow("not a participant");
  });
});
