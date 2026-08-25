import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AddWorkspaceRequestSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RemoveWorkspaceRequestSchema,
  RuntimeStartRequestSchema,
  RuntimeStopRequestSchema,
  SetModelRequestSchema,
  type AddWorkspaceResult,
  type RemoveWorkspaceResult,
  type RpcResponse,
  type RuntimeStartResult,
  type RuntimeStopResult,
} from "@teamclu/app/proto/teamclu_pb";

import type { TeamMqttClient } from "../mqtt/team-mqtt";
import { uuidV4 } from "../uuid";

export type RuntimeRpcMqtt = Pick<TeamMqttClient, "publish" | "subscribe">;

export type RuntimeStartArgs = {
  targetActorId: string;
  workspaceId: string;
  worktree: string;
  sessionId: string;
  agentType: number;
  initialPrompt?: string;
  modelId?: string;
  resetBackendBinding?: boolean;
  timeoutMs?: number;
};

export type RuntimeStopArgs = {
  targetActorId: string;
  runtimeId: string;
  purgeBinding?: boolean;
  workspaceId?: string;
  timeoutMs?: number;
};

export type AddWorkspaceArgs = {
  targetActorId: string;
  path: string;
  timeoutMs?: number;
};

export type RemoveWorkspaceArgs = {
  targetActorId: string;
  workspaceId: string;
  timeoutMs?: number;
};

export type SetModelArgs = {
  targetActorId: string;
  runtimeId: string;
  modelId: string;
  timeoutMs?: number;
};

type RuntimeRpcClientDeps = {
  mqtt: RuntimeRpcMqtt;
  teamId: string;
  requesterActorId: string;
  requestId?: () => string;
  requesterClientId?: (requestId: string) => string;
};

export type RuntimeRpcClient = {
  runtimeStart: (args: RuntimeStartArgs) => Promise<RuntimeStartResult>;
  runtimeStop: (args: RuntimeStopArgs) => Promise<RuntimeStopResult>;
  addWorkspace: (args: AddWorkspaceArgs) => Promise<AddWorkspaceResult>;
  removeWorkspace: (args: RemoveWorkspaceArgs) => Promise<RemoveWorkspaceResult>;
  /**
   * Switches an agent runtime's ACP model. Replaces
   * `PATCH /v1/runtime/:id/model`, which pointed at the dropped
   * `agent_runtimes` table and answers 404.
   *
   * Resolves on the daemon's accept gate. The new model is observable on the
   * retained runtime state topic, so there is no value to return here.
   */
  setModel: (args: SetModelArgs) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function defaultRequesterClientId(actorId: string, requestId: string): string {
  const actorPart = actorId.trim().slice(0, 8) || "mobile";
  return `teamclu-expo-${actorPart}-${requestId.slice(0, 8)}`;
}

function responseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || "runtime_start rejected");
  }
  if (response.result.case !== "runtimeStartResult") {
    return new Error(`unexpected result variant: ${response.result.case}`);
  }
  if (!response.result.value.accepted) {
    return new Error(response.result.value.rejectedReason || response.error || "runtime_start rejected");
  }
  return null;
}

function stopResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || "runtime_stop rejected");
  }
  if (response.result.case !== "runtimeStopResult") {
    return new Error(`unexpected result variant: ${response.result.case}`);
  }
  if (!response.result.value.accepted) {
    return new Error(response.result.value.rejectedReason || response.error || "runtime_stop rejected");
  }
  return null;
}

function addWorkspaceResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || "add_workspace rejected");
  }
  if (response.result.case !== "addWorkspaceResult") {
    return new Error(`unexpected result variant: ${response.result.case}`);
  }
  if (!response.result.value.accepted) {
    return new Error(response.result.value.error || response.error || "add_workspace rejected");
  }
  return null;
}

function removeWorkspaceResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || "remove_workspace rejected");
  }
  if (response.result.case !== "removeWorkspaceResult") {
    return new Error(`unexpected result variant: ${response.result.case}`);
  }
  if (!response.result.value.accepted) {
    return new Error(response.result.value.error || response.error || "remove_workspace rejected");
  }
  return null;
}

/**
 * `SetModelResult` carries `{success, error}` rather than the
 * `{accepted, rejectedReason}` the other four use, so it needs its own check.
 */
function setModelResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || "set_model rejected");
  }
  if (response.result.case !== "setModelResult") {
    return new Error(`unexpected result variant: ${response.result.case}`);
  }
  if (!response.result.value.success) {
    return new Error(response.result.value.error || response.error || "set_model rejected");
  }
  return null;
}

export function createRuntimeRpcClient(deps: RuntimeRpcClientDeps): RuntimeRpcClient {
  return {
    runtimeStart(args) {
      const teamId = deps.teamId.trim();
      if (!teamId) return Promise.reject(new Error("team id is required"));

      const targetActorId = args.targetActorId.trim();
      if (!targetActorId) {
        return Promise.reject(new Error("target actor id is required"));
      }

      const requestId = deps.requestId?.() ?? uuidV4();
      const requesterClientId =
        deps.requesterClientId?.(requestId) ??
        defaultRequesterClientId(deps.requesterActorId, requestId);
      const start = create(RuntimeStartRequestSchema, {
        workspaceId: args.workspaceId,
        worktree: args.worktree,
        sessionId: args.sessionId,
        agentType: args.agentType,
        initialPrompt: args.initialPrompt ?? "",
        modelId: args.modelId ?? "",
        resetBackendBinding: args.resetBackendBinding ?? false,
      });
      const request = create(RpcRequestSchema, {
        requestId,
        requesterClientId,
        requesterActorId: deps.requesterActorId,
        method: { case: "runtimeStart", value: start },
      });
      const requestTopic = `amux/${teamId}/${targetActorId}/rpc/req`;
      // The daemon replies on the REQUESTER's actor namespace (see
      // apps/daemon/src/teamclu/rpc.rs:50-53), not the target's, so subscribe
      // there. Fall back to the target actor when we have no requester actor id.
      const responseTopic = `amux/${teamId}/${deps.requesterActorId.trim() || targetActorId}/rpc/res`;

      return new Promise<RuntimeStartResult>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          fn();
        };

        unsubscribe = deps.mqtt.subscribe(responseTopic, (payload) => {
          let response: RpcResponse;
          try {
            response = fromBinary(RpcResponseSchema, payload);
          } catch {
            return;
          }
          if (response.requestId !== requestId) return;

          const error = responseError(response);
          if (error) {
            finish(() => reject(error));
            return;
          }
          const result =
            response.result.case === "runtimeStartResult"
              ? response.result.value
              : null;
          if (!result) return;
          finish(() => resolve(result));
        });

        timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `runtime_start timeout after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
              ),
            ),
          );
        }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        deps.mqtt
          .publish(requestTopic, toBinary(RpcRequestSchema, request), false)
          .catch((err) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
      });
    },
    runtimeStop(args) {
      const teamId = deps.teamId.trim();
      if (!teamId) return Promise.reject(new Error("team id is required"));

      const targetActorId = args.targetActorId.trim();
      if (!targetActorId) {
        return Promise.reject(new Error("target actor id is required"));
      }
      const runtimeId = args.runtimeId.trim();
      if (!runtimeId) {
        return Promise.reject(new Error("runtime id is required"));
      }

      const requestId = deps.requestId?.() ?? uuidV4();
      const requesterClientId =
        deps.requesterClientId?.(requestId) ??
        defaultRequesterClientId(deps.requesterActorId, requestId);
      const stop = create(RuntimeStopRequestSchema, {
        runtimeId,
        purgeBinding: args.purgeBinding ?? false,
        workspaceId: args.workspaceId ?? "",
      });
      const request = create(RpcRequestSchema, {
        requestId,
        requesterClientId,
        requesterActorId: deps.requesterActorId,
        method: { case: "runtimeStop", value: stop },
      });
      const requestTopic = `amux/${teamId}/${targetActorId}/rpc/req`;
      // Daemon replies on the requester's actor namespace (rpc.rs:50-53).
      const responseTopic = `amux/${teamId}/${deps.requesterActorId.trim() || targetActorId}/rpc/res`;

      return new Promise<RuntimeStopResult>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          fn();
        };

        unsubscribe = deps.mqtt.subscribe(responseTopic, (payload) => {
          let response: RpcResponse;
          try {
            response = fromBinary(RpcResponseSchema, payload);
          } catch {
            return;
          }
          if (response.requestId !== requestId) return;

          const error = stopResponseError(response);
          if (error) {
            finish(() => reject(error));
            return;
          }
          const result =
            response.result.case === "runtimeStopResult"
              ? response.result.value
              : null;
          if (!result) return;
          finish(() => resolve(result));
        });

        timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `runtime_stop timeout after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
              ),
            ),
          );
        }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        deps.mqtt
          .publish(requestTopic, toBinary(RpcRequestSchema, request), false)
          .catch((err) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          });
      });
    },
    addWorkspace(args) {
      const teamId = deps.teamId.trim();
      if (!teamId) return Promise.reject(new Error("team id is required"));

      const targetActorId = args.targetActorId.trim();
      if (!targetActorId) {
        return Promise.reject(new Error("target actor id is required"));
      }
      const path = args.path.trim();
      if (!path) {
        return Promise.reject(new Error("workspace path is required"));
      }

      const requestId = deps.requestId?.() ?? uuidV4();
      const requesterClientId =
        deps.requesterClientId?.(requestId) ??
        defaultRequesterClientId(deps.requesterActorId, requestId);
      const add = create(AddWorkspaceRequestSchema, { path });
      const request = create(RpcRequestSchema, {
        requestId,
        requesterClientId,
        requesterActorId: deps.requesterActorId,
        method: { case: "addWorkspace", value: add },
      });
      const requestTopic = `amux/${teamId}/${targetActorId}/rpc/req`;
      // Daemon replies on the requester's actor namespace (rpc.rs:50-53).
      const responseTopic = `amux/${teamId}/${deps.requesterActorId.trim() || targetActorId}/rpc/res`;

      return new Promise<AddWorkspaceResult>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          fn();
        };

        unsubscribe = deps.mqtt.subscribe(responseTopic, (payload) => {
          let response: RpcResponse;
          try {
            response = fromBinary(RpcResponseSchema, payload);
          } catch {
            return;
          }
          if (response.requestId !== requestId) return;

          const error = addWorkspaceResponseError(response);
          if (error) {
            finish(() => reject(error));
            return;
          }
          const result =
            response.result.case === "addWorkspaceResult"
              ? response.result.value
              : null;
          if (!result) return;
          finish(() => resolve(result));
        });

        timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `add_workspace timeout after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
              ),
            ),
          );
        }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        deps.mqtt
          .publish(requestTopic, toBinary(RpcRequestSchema, request), false)
          .catch((err) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          });
      });
    },
    removeWorkspace(args) {
      const teamId = deps.teamId.trim();
      if (!teamId) return Promise.reject(new Error("team id is required"));

      const targetActorId = args.targetActorId.trim();
      if (!targetActorId) {
        return Promise.reject(new Error("target actor id is required"));
      }
      const workspaceId = args.workspaceId.trim();
      if (!workspaceId) {
        return Promise.reject(new Error("workspace id is required"));
      }

      const requestId = deps.requestId?.() ?? uuidV4();
      const requesterClientId =
        deps.requesterClientId?.(requestId) ??
        defaultRequesterClientId(deps.requesterActorId, requestId);
      const remove = create(RemoveWorkspaceRequestSchema, { workspaceId });
      const request = create(RpcRequestSchema, {
        requestId,
        requesterClientId,
        requesterActorId: deps.requesterActorId,
        method: { case: "removeWorkspace", value: remove },
      });
      const requestTopic = `amux/${teamId}/${targetActorId}/rpc/req`;
      // Daemon replies on the requester's actor namespace (rpc.rs:50-53).
      const responseTopic = `amux/${teamId}/${deps.requesterActorId.trim() || targetActorId}/rpc/res`;

      return new Promise<RemoveWorkspaceResult>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          fn();
        };

        unsubscribe = deps.mqtt.subscribe(responseTopic, (payload) => {
          let response: RpcResponse;
          try {
            response = fromBinary(RpcResponseSchema, payload);
          } catch {
            return;
          }
          if (response.requestId !== requestId) return;

          const error = removeWorkspaceResponseError(response);
          if (error) {
            finish(() => reject(error));
            return;
          }
          const result =
            response.result.case === "removeWorkspaceResult"
              ? response.result.value
              : null;
          if (!result) return;
          finish(() => resolve(result));
        });

        timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `remove_workspace timeout after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
              ),
            ),
          );
        }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        deps.mqtt
          .publish(requestTopic, toBinary(RpcRequestSchema, request), false)
          .catch((err) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          });
      });
    },
    setModel(args) {
      const teamId = deps.teamId.trim();
      if (!teamId) return Promise.reject(new Error("team id is required"));

      const targetActorId = args.targetActorId.trim();
      if (!targetActorId) {
        return Promise.reject(new Error("target actor id is required"));
      }
      const runtimeId = args.runtimeId.trim();
      if (!runtimeId) {
        return Promise.reject(new Error("runtime id is required"));
      }
      const modelId = args.modelId.trim();
      if (!modelId) {
        return Promise.reject(new Error("model id is required"));
      }

      const requestId = deps.requestId?.() ?? uuidV4();
      const requesterClientId =
        deps.requesterClientId?.(requestId) ??
        defaultRequesterClientId(deps.requesterActorId, requestId);
      const setModel = create(SetModelRequestSchema, { runtimeId, modelId });
      const request = create(RpcRequestSchema, {
        requestId,
        requesterClientId,
        requesterActorId: deps.requesterActorId,
        method: { case: "setModel", value: setModel },
      });
      const requestTopic = `amux/${teamId}/${targetActorId}/rpc/req`;
      // Daemon replies on the requester's actor namespace (rpc.rs:50-53).
      const responseTopic = `amux/${teamId}/${deps.requesterActorId.trim() || targetActorId}/rpc/res`;

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          fn();
        };

        unsubscribe = deps.mqtt.subscribe(responseTopic, (payload) => {
          let response: RpcResponse;
          try {
            response = fromBinary(RpcResponseSchema, payload);
          } catch {
            return;
          }
          if (response.requestId !== requestId) return;

          const error = setModelResponseError(response);
          if (error) {
            finish(() => reject(error));
            return;
          }
          finish(() => resolve());
        });

        timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `set_model timeout after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
              ),
            ),
          );
        }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        deps.mqtt
          .publish(requestTopic, toBinary(RpcRequestSchema, request), false)
          .catch((err) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          });
      });
    },
  };
}
