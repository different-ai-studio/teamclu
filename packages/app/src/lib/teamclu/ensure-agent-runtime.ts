import { getBackend } from "@/lib/backend";
import i18n from "@/lib/i18n";
import {
  resolveAgentDevicePresence,
  type AgentDevicePresence,
} from "@/lib/agent-device-reachability";
import { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";
import {
  startAgentRuntimesAsync,
  type RuntimeStartFailure,
  type RuntimeStartFailureCode,
} from "@/lib/session-create";
import {
  setModel,
  waitForTeamcluRpcIdentity,
  waitForTeamcluRpcReady,
} from "@/lib/teamclu-rpc";
import {
  isFullyLocal,
  planAgentTransports,
  resolveAgentTransport,
} from "@/lib/teamclu/agent-transport";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import {
  resolveRuntimeStateEntryForAgent,
  runtimeTargetsForSession,
} from "@/lib/runtime-state-resolve";
import { resolveSessionWorkspaceHintForRuntimeStart } from "@/lib/teamclu/resolve-runtime-start-workspace";
import {
  recordRuntimeEnsureAttempt,
  isRuntimeEnsureWakeReason,
  shouldSkipAlreadyReadyRuntimeEnsure,
} from "@/lib/teamclu/runtime-ensure-scheduler";
import {
  DEVICE_PRESENCE_GATE_TIMEOUT_MS,
  RUNTIME_START_RPC_TIMEOUT_MS,
} from "@/lib/teamclu/runtime-rpc-timeouts";
import { sessionFlowError, sessionFlowLog } from "@/lib/session-flow-log";
import {
  isCancelledRuntimeFailure,
  isTransientRuntimeNetworkFailure,
  reportRuntimeEnsureCrash,
  reportRuntimeRpcNotReady,
  reportRuntimeStartFailure,
  type RuntimeErrorContext,
} from "@/lib/telemetry/runtime-error-report";
import { useWorkspaceStore } from "@/stores/workspace";
import { useMqttReconnectStore } from "@/stores/mqtt-reconnect";

export type { AgentDevicePresence };
export { resolveAgentDevicePresence };

type InFlightEntry = { promise: Promise<void>; startedAt: number };
const inFlight = new Map<string, InFlightEntry>();

function logDebug(
  eventCase: string,
  payload: unknown,
  opts?: { sessionId?: string; topic?: string; actorId?: string },
): void {
  void import("@/stores/acp-debug-store").then(({ useAcpDebugStore }) => {
    useAcpDebugStore.getState().append({
      sessionId: opts?.sessionId ?? "",
      topic: opts?.topic ?? "(client)",
      actorId: opts?.actorId ?? "",
      eventCase,
      payload,
    });
  });
}

async function ensureAgentIsSessionParticipant(sessionId: string, agentActorId: string): Promise<void> {
  const participants = await getBackend().sessionMembers.listParticipants(sessionId);
  if (participants.some((p) => p.id === agentActorId)) return;
  await getBackend().sessionMembers.addParticipant(sessionId, agentActorId);
  sessionFlowLog("ensure_agent_runtime.participant_added", { sessionId, agentActorId });
  logDebug("client:participant_added", { sessionId, agentActorId }, { sessionId, actorId: agentActorId });
}

function failureDescription(failure: RuntimeStartFailure): string {
  const shortId = failure.agentActorId.slice(0, 8);
  const trimmed = failure.reason.trim();
  // Stable daemon marker (opencode supervisor / pi process spawn): the
  // configured runtime for the daemon's team is not installed on that device.
  // Localize into an actionable message instead of showing the raw ENOENT.
  const binaryMissing = /agent_binary_missing\(([a-z0-9_.-]+)\)/i.exec(trimmed);
  if (binaryMissing) {
    return i18n.t("daemon.agentRuntime.binaryMissingDesc", { agent: binaryMissing[1] });
  }
  switch (failure.code) {
    case "device_offline":
      return i18n.t("daemon.agentRuntime.deviceOfflineDesc", { shortId });
    case "transport_offline":
      return i18n.t("daemon.agentRuntime.transportOfflineDesc");
    case "workspace_rpc_timeout":
      return trimmed || i18n.t("daemon.agentRuntime.workspaceRpcTimeoutDesc", { shortId });
    case "workspace_ensure_failed":
      return trimmed || i18n.t("daemon.agentRuntime.workspaceEnsureFailedDesc", { shortId });
    case "session_participant_failed":
      return i18n.t("daemon.agentRuntime.sessionParticipantFailedDesc", {
        shortId,
        reason: trimmed || i18n.t("errors.unknownError", "Unknown error"),
      });
    case "runtime_rejected":
      return trimmed || i18n.t("daemon.agentRuntime.notStartedDesc", { shortId });
    case "runtime_rpc_failed":
      return trimmed || i18n.t("daemon.agentRuntime.notStartedDesc", { shortId });
    case "host_capacity_timeout":
      return i18n.t("daemon.agentRuntime.hostCapacityDesc");
    default:
      return trimmed || i18n.t("daemon.agentRuntime.notStartedDesc", { shortId });
  }
}

/** Exported for tests; every production call site is in this module. */
export function notifyRuntimeStartFailures(
  failures: RuntimeStartFailure[],
  context: RuntimeErrorContext = {},
): void {
  if (failures.length === 0) return;
  for (const failure of failures) {
    reportRuntimeStartFailure(failure, context);
    logDebug(
      "client:runtime_start_failed",
      failure,
      { actorId: failure.agentActorId },
    );
  }
  // Offline presence is already persistent in the selected-agent status.
  // Client-cancelled requests and daemon → Cloud API network failures are
  // retried by the recoverable-runtime tick. Keep these in telemetry/debug,
  // but do not duplicate expected transient states as error toasts.
  const toastable = failures.filter(
    (f) =>
      f.code !== "device_offline" &&
      !isCancelledRuntimeFailure(f.reason) &&
      !isTransientRuntimeNetworkFailure(f.reason),
  );
  if (toastable.length === 0) return;
  void import("sonner").then(({ toast }) => {
    for (const failure of toastable) {
      const titleKey =
        failure.code === "host_capacity_timeout"
          ? "daemon.agentRuntime.hostCapacityTitle"
          : "daemon.agentRuntime.notStartedTitle";
      toast.error(i18n.t(titleKey), {
        id: `runtime-start-failed-${failure.agentActorId}`,
        description: failureDescription(failure),
        duration: 8000,
      });
    }
  });
}

async function gateAgentsForRuntimeStart(
  agentActorIds: string[],
): Promise<{ eligible: string[]; failures: RuntimeStartFailure[] }> {
  const failures: RuntimeStartFailure[] = [];
  const eligible: string[] = [];

  for (const agentActorId of agentActorIds) {
    const presence = await resolveAgentDevicePresence(agentActorId, {
      timeoutMs: DEVICE_PRESENCE_GATE_TIMEOUT_MS,
    });
    if (presence === "offline") {
      failures.push({
        agentActorId,
        code: "device_offline",
        reason: "device offline",
      });
      continue;
    }
    eligible.push(agentActorId);
  }

  return { eligible, failures };
}

export type EnsureAgentRuntimeArgs = {
  sessionId: string;
  teamId: string;
  agentActorIds: string[];
  modelId?: string;
  modelIdByAgent?: Record<string, string>;
  /** Cloud workspace UUID captured at send time — passed through to runtimeStart. */
  workspaceIdHint?: string;
  reason?: string;
  /**
   * Session-scoped agent → runtime_id bindings. Wake/skip uses these so a
   * live spawn on another session cannot suppress ensure for this session.
   */
  sessionRuntimeByAgent?: ReadonlyMap<string, string>;
};

export type EnsureRuntimeThenSetModelArgs = {
  sessionId: string;
  teamId: string;
  agentActorId: string;
  modelId: string;
};

/**
 * Model-picker path: ask the daemon for the live spawn via runtimeStart
 * (dedup reuse when still alive), then setModel with that authoritative
 * runtimeId. Never resolves spawn id from MQTT/DB hints — those go stale
 * across daemon restarts while the UI still looks "ready".
 */
export async function ensureRuntimeThenSetModel(
  args: EnsureRuntimeThenSetModelArgs,
): Promise<{ runtimeId: string }> {
  try {
    return await runEnsureRuntimeThenSetModel(args);
  } catch (error) {
    reportRuntimeEnsureCrash(error, {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorId: args.agentActorId,
      trigger: "set_model",
    });
    throw error;
  }
}

async function runEnsureRuntimeThenSetModel(
  args: EnsureRuntimeThenSetModelArgs,
): Promise<{ runtimeId: string }> {
  const agentActorId = args.agentActorId.trim();
  const modelId = args.modelId.trim();
  if (!args.sessionId || !args.teamId || !agentActorId || !modelId) {
    throw new Error("sessionId, teamId, agentActorId, and modelId are required");
  }

  // Decide the transport ONCE, before any gate. A local agent is driven over
  // loopback `/v1/rpc`, so none of the broker preconditions below apply to it.
  const transport = await resolveAgentTransport(agentActorId);

  if (transport !== "local") {
    const mqttConnected = useMqttReconnectStore.getState().connected;
    if (mqttConnected === false) {
      throw new Error("mqtt disconnected");
    }
  }

  // The loopback path needs an identity to build the request, but not the MQTT
  // response subscription — which is wired behind the broker connection and so
  // never becomes ready when the broker is unreachable.
  const rpcReady =
    transport === "local"
      ? await waitForTeamcluRpcIdentity(20_000)
      : await waitForTeamcluRpcReady(20_000);
  if (!rpcReady) {
    throw new Error("teamclu RPC not ready");
  }

  const { eligible, failures: gateFailures } = await gateAgentsForRuntimeStart([agentActorId]);
  if (gateFailures.length > 0) {
    throw new Error(gateFailures[0]!.reason || "device offline");
  }
  if (eligible.length === 0) {
    throw new Error("agent not eligible for runtimeStart");
  }

  try {
    await ensureAgentIsSessionParticipant(args.sessionId, agentActorId);
  } catch (error) {
    // Do NOT continue to runtimeStart. `sessions` is participant-only RLS, so a
    // daemon that is not a participant cannot read the session and the start
    // fails with "session not found" — which reads as data loss rather than a
    // permission step that did not happen.
    sessionFlowError("ensure_runtime_then_set_model.add_participant_failed", error, {
      sessionId: args.sessionId,
      agentActorId,
    });
    const failure: RuntimeStartFailure = {
      agentActorId,
      code: "session_participant_failed",
      reason: error instanceof Error ? error.message : String(error),
    };
    reportRuntimeStartFailure(failure, { sessionId: args.sessionId, teamId: args.teamId });
    throw new Error(failureDescription(failure), { cause: error });
  }

  const localWorkspacePath = useWorkspaceStore.getState().workspacePath?.trim() || null;
  let localDaemonActorId: string | null = null;
  const { isTauri } = await import("@/lib/utils");
  if (isTauri()) {
    try {
      const { getLocalDaemonActorId } = await import("@/lib/daemon-agent-admin");
      localDaemonActorId = await getLocalDaemonActorId();
    } catch {
      localDaemonActorId = null;
    }
  }
  const workspaceIdHint =
    (await resolveSessionWorkspaceHintForRuntimeStart({
      teamId: args.teamId,
      localWorkspacePath,
      sessionId: args.sessionId,
      agentActorIds: [agentActorId],
      localDaemonActorId,
    })) || undefined;

  sessionFlowLog("ensure_runtime_then_set_model.begin", {
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorId,
    modelId,
    workspaceIdHint: workspaceIdHint ?? null,
  });

  const { failures, runtimeIdsByAgent } = await startAgentRuntimesAsync({
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorIds: [agentActorId],
    modelId,
    workspaceIdHint,
    rpcTimeoutMs: RUNTIME_START_RPC_TIMEOUT_MS,
    suppressWorkspaceToast: true,
    // Apply below so callers observe setModel failures (start path swallows them).
    skipModelApply: true,
  });
  if (failures.length > 0) {
    throw new Error(failures[0]!.reason || "runtimeStart failed");
  }

  const runtimeId = runtimeIdsByAgent[agentActorId]?.trim();
  if (!runtimeId) {
    throw new Error("runtimeStart did not return a runtime id");
  }

  await setModel({
    targetActorId: agentActorId,
    runtimeId,
    modelId,
    timeoutMs: RUNTIME_START_RPC_TIMEOUT_MS,
  });

  sessionFlowLog("ensure_runtime_then_set_model.ok", {
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorId,
    runtimeId,
    modelId,
  });
  return { runtimeId };
}

/**
 * Idempotent: ensure session live subscription, session membership, and
 * daemon runtimeStart for each agent. Safe to call on @-mention and on send.
 *
 * Wake/focus/reconnect reasons skip only when THIS session's bound spawn is
 * already ACTIVE with models. Create/send paths always proceed so a new
 * session can bind. When the caller omits sessionRuntimeByAgent on a wake
 * path, we load runtime-targets before deciding to skip.
 */
export async function ensureAgentRuntimesForSession(args: EnsureAgentRuntimeArgs): Promise<void> {
  // Narrowed below to the locally-reachable subset when the broker is down.
  let agentActorIds = [...new Set(args.agentActorIds.map((id) => id.trim()).filter(Boolean))];
  if (!args.sessionId || !args.teamId || agentActorIds.length === 0) return;

  const key = `${args.sessionId}::${agentActorIds.slice().sort().join(",")}`;
  const reason = args.reason ?? "unknown";

  let sessionRuntimeByAgent = args.sessionRuntimeByAgent;
  if (!sessionRuntimeByAgent && isRuntimeEnsureWakeReason(reason)) {
    try {
      const rows = runtimeTargetsForSession(
        args.sessionId,
        useRuntimeStateStore.getState().byRuntimeId,
      );
      const map = new Map<string, string>();
      for (const row of rows) {
        const agentId = row.agent_id?.trim();
        const runtimeId = row.runtime_id?.trim();
        if (agentId && runtimeId && !map.has(agentId)) {
          map.set(agentId, runtimeId);
        }
      }
      sessionRuntimeByAgent = map;
    } catch (error) {
      sessionFlowError("ensure_agent_runtime.runtime_targets_failed", error, {
        sessionId: args.sessionId,
        reason,
      });
      // Fail open: without bindings we must not skip on a global-live guess.
      sessionRuntimeByAgent = new Map();
    }
  }

  if (shouldSkipAlreadyReadyRuntimeEnsure(agentActorIds, reason, sessionRuntimeByAgent)) {
    sessionFlowLog("ensure_agent_runtime.skip_already_ready", {
      sessionId: args.sessionId,
      teamId: args.teamId,
      reason,
      agentActorIds,
    });
    return;
  }

  const existing = inFlight.get(key);
  if (existing) return existing.promise;

  const errorContext: RuntimeErrorContext = {
    sessionId: args.sessionId,
    teamId: args.teamId,
    trigger: reason,
  };

  const work = (async () => {
    logDebug(
      "client:ensure_runtime_begin",
      { reason, agentActorIds, teamId: args.teamId },
      { sessionId: args.sessionId, topic: `ensure/${args.sessionId}` },
    );

    // Resolve the transport for the whole batch up front, so a run cannot be
    // half-local. Agents on loopback are unaffected by the broker being down.
    const transportPlan = await planAgentTransports(agentActorIds);
    const allLocal = isFullyLocal(transportPlan);

    try {
      const mqttConnected = useMqttReconnectStore.getState().connected;
      if (mqttConnected === false && transportPlan.mqtt.length > 0) {
        // Fail only the agents that actually need the broker. When some are
        // local, they continue below — reporting them as transport_offline
        // would be false, and stopping the batch would strand a daemon that is
        // running on this very machine.
        const transportFailures: RuntimeStartFailure[] = transportPlan.mqtt.map((agentActorId) => ({
          agentActorId,
          code: "transport_offline" as RuntimeStartFailureCode,
          reason: "mqtt disconnected",
        }));
        notifyRuntimeStartFailures(transportFailures, errorContext);
        logDebug(
          "client:transport_offline",
          { mqttConnected, blocked: transportPlan.mqtt, proceedingLocal: transportPlan.local },
          { sessionId: args.sessionId },
        );
        if (transportPlan.local.length === 0) return;
        agentActorIds = transportPlan.local;
      }

      // Live subscriptions ride MQTT; a local-only run has no broker to
      // subscribe on and must not be blocked waiting for one.
      if (!allLocal) {
        await ensureSessionLiveSubscribed(args.teamId, args.sessionId);
      }
    } catch (error) {
      sessionFlowError("ensure_agent_runtime.live_subscribe_failed", error, args);
      logDebug("client:live_subscribe_failed", { error: String(error) }, { sessionId: args.sessionId });
    }

    const rpcReady = allLocal
      ? await waitForTeamcluRpcIdentity(20_000)
      : await waitForTeamcluRpcReady(20_000);
    if (!rpcReady) {
      logDebug("client:rpc_not_ready", { waitedMs: 20_000 }, { sessionId: args.sessionId });
      reportRuntimeRpcNotReady(20_000, errorContext);
      void import("sonner").then(({ toast }) => {
        toast.error(i18n.t("daemon.agentRuntime.rpcNotReadyTitle"), {
          description: i18n.t("daemon.agentRuntime.rpcNotReadyDesc"),
        });
      });
      return;
    }

    const { eligible: gatedAgents, failures: gateFailures } =
      await gateAgentsForRuntimeStart(agentActorIds);
    if (gateFailures.length > 0) {
      notifyRuntimeStartFailures(gateFailures, errorContext);
    }
    if (gatedAgents.length === 0) {
      logDebug("client:ensure_runtime_all_gated", { gateFailures }, { sessionId: args.sessionId });
      return;
    }

    // Agents whose participant row could not be created are dropped from the
    // batch rather than started anyway. `sessions` is participant-only RLS, so
    // starting them would fail in the daemon as "session not found", blaming the
    // session instead of the permission step that actually failed.
    const participantFailures: RuntimeStartFailure[] = [];
    const eligible = (
      await Promise.all(
        gatedAgents.map(async (agentActorId) => {
          try {
            await ensureAgentIsSessionParticipant(args.sessionId, agentActorId);
            return agentActorId;
          } catch (error) {
            sessionFlowError("ensure_agent_runtime.add_participant_failed", error, {
              sessionId: args.sessionId,
              agentActorId,
            });
            logDebug("client:add_participant_failed", { agentActorId, error: String(error) }, {
              sessionId: args.sessionId,
              actorId: agentActorId,
            });
            participantFailures.push({
              agentActorId,
              code: "session_participant_failed",
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        }),
      )
    ).filter((agentActorId): agentActorId is string => agentActorId !== null);

    if (participantFailures.length > 0) {
      notifyRuntimeStartFailures(participantFailures, errorContext);
    }
    if (eligible.length === 0) {
      logDebug(
        "client:ensure_runtime_all_participant_failed",
        { participantFailures },
        { sessionId: args.sessionId },
      );
      return;
    }

    const localWorkspacePath = useWorkspaceStore.getState().workspacePath?.trim() || null
    let localDaemonActorId: string | null = null
    const { isTauri } = await import("@/lib/utils")
    if (isTauri()) {
      try {
        const { getLocalDaemonActorId } = await import("@/lib/daemon-agent-admin")
        localDaemonActorId = await getLocalDaemonActorId()
      } catch {
        localDaemonActorId = null
      }
    }
    const workspaceIdHint =
      args.workspaceIdHint?.trim() ||
      (await resolveSessionWorkspaceHintForRuntimeStart({
        teamId: args.teamId,
        localWorkspacePath,
        sessionId: args.sessionId,
        agentActorIds: eligible,
        localDaemonActorId,
      })) ||
      undefined

    recordRuntimeEnsureAttempt(args.sessionId, eligible);

    logDebug(
      "client:runtime_start_batch",
      {
        agentActorIds: eligible,
        modelId: args.modelId ?? null,
        workspaceIdHint: workspaceIdHint ?? null,
        localWorkspacePath,
      },
      { sessionId: args.sessionId, topic: `rpc/runtimeStart/${args.sessionId}` },
    );
    sessionFlowLog("ensure_agent_runtime.workspace_resolved", {
      sessionId: args.sessionId,
      teamId: args.teamId,
      reason,
      workspaceIdHint: workspaceIdHint ?? null,
      localWorkspacePath,
    });

    const { failures: runtimeFailures } = await startAgentRuntimesAsync({
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: eligible,
      modelId: args.modelId,
      modelIdByAgent: args.modelIdByAgent,
      workspaceIdHint,
      rpcTimeoutMs: RUNTIME_START_RPC_TIMEOUT_MS,
      suppressWorkspaceToast: true,
    });
    notifyRuntimeStartFailures(runtimeFailures, errorContext);

    const retainDeadline = Date.now() + 12_000;
    while (Date.now() < retainDeadline) {
      const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
      const missing = eligible.filter((id) => {
        const entry = resolveRuntimeStateEntryForAgent(id, byRuntimeId);
        return !entry || entry.info.availableModels.length === 0;
      });
      if (missing.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const agentActorId of eligible) {
      const entry = resolveRuntimeStateEntryForAgent(
        agentActorId,
        useRuntimeStateStore.getState().byRuntimeId,
      );
      logDebug(
        entry ? "client:runtime_state_observed" : "client:runtime_state_missing",
        entry
          ? {
              agentActorId,
              runtimeId: entry.info.runtimeId,
              agentType: entry.info.agentType,
              availableModelIds: entry.info.availableModels.map((m) => m.id),
            }
          : { agentActorId, waitedMs: 12_000 },
        { sessionId: args.sessionId, actorId: agentActorId },
      );
    }

    logDebug(
      "client:runtime_start_batch_done",
      { agentActorIds: eligible },
      { sessionId: args.sessionId, topic: `rpc/runtimeStart/${args.sessionId}` },
    );
  })().catch((error) => {
    sessionFlowError("ensure_agent_runtime.failed", error, args);
    reportRuntimeEnsureCrash(error, errorContext);
    logDebug("client:ensure_runtime_failed", { error: String(error) }, { sessionId: args.sessionId });
    void import("sonner").then(({ toast }) => {
      toast.error(i18n.t("daemon.agentRuntime.startFailedTitle"), {
        description: error instanceof Error ? error.message : String(error),
      });
    });
    throw error;
  });

  const entry: InFlightEntry = { promise: work, startedAt: Date.now() };
  inFlight.set(key, entry);
  try {
    await work;
  } finally {
    if (inFlight.get(key) === entry) {
      inFlight.delete(key);
    }
  }
}
