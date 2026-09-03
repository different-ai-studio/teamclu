import { mqttPublish } from "@/lib/mqtt/mqtt-bridge";
import {
  resolvePermissionCommandTarget,
  runtimeTargetsForSession,
} from "@/lib/agent/runtime-state-resolve";
import { sessionFlowError, sessionFlowLog } from "@/lib/session/session-flow-log";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { acpOptionIdForDecision } from "@/lib/teamclu/acp-permission-option";
import { createRuntimeCommandSender } from "@/lib/teamclu/runtime-command";
import { runtimeCommand } from "@/lib/daemon/teamclu-rpc";

export type AcpPermissionDecision = "allow" | "deny" | "always";


export function findV2PendingPermission(requestId: string): {
  sessionId: string;
  actorId: string;
  request: import("@/stores/v2-streaming-store").StreamingPermissionRequest;
} | null {
  const trimmed = requestId.trim();
  if (!trimmed) return null;
  for (const entry of Object.values(useV2StreamingStore.getState().byKey)) {
    const pending = entry.pendingPermissionsByRequestId[trimmed];
    if (pending?.requestId === trimmed) {
      return { sessionId: entry.sessionId, actorId: entry.actorId, request: pending };
    }
  }
  return null;
}

export async function replyAcpPermission(args: {
  sessionId: string;
  agentActorId: string;
  requestId: string;
  decision: AcpPermissionDecision;
  /** When omitted, resolved from v2 pending permission options. */
  optionId?: string;
}): Promise<void> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) throw new Error("No active team");

  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";
  const granted = args.decision !== "deny";
  const located = findV2PendingPermission(args.requestId);
  const pendingReq = located?.request ?? null;
  const optionId = granted
    ? args.optionId?.trim() ||
      acpOptionIdForDecision(args.decision, { options: pendingReq?.options })
    : undefined;

  // The participant lookup that used to live here only existed to narrow
  // `listRuntimeTargetsForSession`. With targets read off the retain there is
  // nothing to narrow, so this is one fewer network round trip per command.

  // Straight off the retain: one attachment per session, no cloud round trip
  // and nothing stale to choose between.
  const sessionRuntimeRows = runtimeTargetsForSession(
    args.sessionId,
    useRuntimeStateStore.getState().byRuntimeId,
  );

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const target = resolvePermissionCommandTarget({
    agentActorId: args.agentActorId,
    sessionRuntimeRows,
    byRuntimeId,
  });

  if (!target) {
    throw new Error("Could not resolve agent runtime for permission response");
  }

  sessionFlowLog("permission.reply.begin", {
    sessionId: args.sessionId,
    agentActorId: args.agentActorId,
    requestId: args.requestId,
    granted,
    targetActorId: target.actorId,
    runtimeId: target.runtimeId,
    sessionRuntimeId:
      sessionRuntimeRows.find((row) => row.agent_id?.trim() === args.agentActorId)?.runtime_id ??
      null,
  });

  const peerId = `teamclu-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    // Session-addressed RPC; on transport failure the sender retries once
    // then publishes to the spawn-keyed commands topic (issue #783).
    rpc: ({ targetActorId, sessionId: sid, envelope }) =>
      runtimeCommand({ targetActorId, sessionId: sid, envelope }),
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendPermissionResponse({
      targetActorId: target.actorId,
      runtimeId: target.runtimeId,
      sessionId: args.sessionId,
      requestId: args.requestId,
      granted,
      optionId,
    });
  } catch (error) {
    sessionFlowError("permission.reply.failed", error, {
      sessionId: args.sessionId,
      agentActorId: args.agentActorId,
      requestId: args.requestId,
      runtimeId: target.runtimeId,
    });
    throw error;
  }

  sessionFlowLog("permission.reply.ok", {
    sessionId: args.sessionId,
    requestId: args.requestId,
    runtimeId: target.runtimeId,
  });

  useV2StreamingStore
    .getState()
    .clearPermissionRequest(args.sessionId, args.agentActorId, args.requestId);
}

export async function replyPermissionById(
  permissionId: string,
  decision: AcpPermissionDecision,
): Promise<void> {
  const located = findV2PendingPermission(permissionId);
  if (!located) {
    throw new Error(`Unknown permission request: ${permissionId}`);
  }
  await replyAcpPermission({
    sessionId: located.sessionId,
    agentActorId: located.actorId,
    requestId: permissionId,
    decision,
  });
}
