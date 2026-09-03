import { create } from "@bufbuild/protobuf";
import {
  AgentStatus,
  RuntimeInfoSchema,
  RuntimeLifecycle,
  type RuntimeInfo,
} from "@/lib/proto/amux_pb";
import {
  attachmentKey,
  useRuntimeStateStore,
} from "@/stores/runtime-state-store";

/**
 * After runtimeStart RPC succeeds, seed a minimal local runtime-state entry so
 * lifecycle/status UI can render before MQTT retain arrives. Model options are
 * not seeded here — they arrive on the retain (`availableModels`) and/or via
 * the loopback catalog (`mergeLocalDaemonModels`).
 */
export function seedRuntimeStateAfterStart(args: {
  daemonActorId: string;
  /** Spawn handle returned by runtimeStart — kept for logging only. */
  runtimeId: string;
  sessionId?: string | null;
  agentType: number;
}): void {
  const daemonActorId = args.daemonActorId.trim();
  const sessionId = args.sessionId?.trim() ?? "";
  if (!daemonActorId) return;

  const storeKey = sessionId
    ? attachmentKey(daemonActorId, sessionId)
    : args.runtimeId.trim();
  if (!storeKey) return;

  const store = useRuntimeStateStore.getState();
  const existing = store.byRuntimeId[storeKey];
  const infoRuntimeId = sessionId || args.runtimeId.trim();
  if (existing?.info.runtimeId === infoRuntimeId && existing.daemonActorId === daemonActorId) {
    return;
  }

  const info: RuntimeInfo = create(RuntimeInfoSchema, {
    runtimeId: infoRuntimeId,
    agentType: args.agentType,
    state: RuntimeLifecycle.ACTIVE,
    status: AgentStatus.IDLE,
    availableModels: [],
  });

  store.upsert(storeKey, daemonActorId, info);
}
