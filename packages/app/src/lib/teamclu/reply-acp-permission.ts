import { mqttPublish } from "@/lib/mqtt/mqtt-bridge";
import { sessionFlowError, sessionFlowLog } from "@/lib/session/session-flow-log";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { acpOptionIdForDecision } from "@/lib/teamclu/acp-permission-option";
import { createRuntimeCommandSender } from "@/lib/teamclu/runtime-command";
import { runtimeCommand } from "@/lib/daemon/teamclu-rpc";

export type AcpPermissionDecision = "allow" | "deny" | "always";

export type PermissionReplyResult =
  | { status: "sent" }
  | { status: "cold" }
  | { status: "error"; message: string };

export function isPermissionColdSessionError(error: unknown): boolean {
  return error instanceof Error && /no live attachment for session/.test(error.message);
}

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
}): Promise<PermissionReplyResult> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) {
    return { status: "error", message: "No active team" };
  }

  const sessionId = args.sessionId.trim();
  const agentActorId = args.agentActorId.trim();
  if (!sessionId || !agentActorId) {
    return { status: "error", message: "Session id and agent actor id are required" };
  }

  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";
  const granted = args.decision !== "deny";
  const located = findV2PendingPermission(args.requestId);
  const pendingReq = located?.request ?? null;
  const optionId = granted
    ? args.optionId?.trim() ||
      acpOptionIdForDecision(args.decision, { options: pendingReq?.options })
    : undefined;

  // Session-addressed RPC only — the daemon resolves the live attachment by
  // session_id. Local MQTT retain is not consulted (see interrupt-agent.ts).
  const targetActorId = agentActorId;
  const runtimeId = sessionId;

  sessionFlowLog("permission.reply.begin", {
    sessionId,
    agentActorId,
    requestId: args.requestId,
    granted,
    targetActorId,
    runtimeId,
    sessionRuntimeId: sessionId,
  });

  const peerId = `teamclu-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    rpc: ({ targetActorId: actor, sessionId: sid, envelope }) =>
      runtimeCommand({ targetActorId: actor, sessionId: sid, envelope }),
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendPermissionResponse({
      targetActorId,
      runtimeId,
      sessionId,
      requestId: args.requestId,
      granted,
      optionId,
    });
  } catch (error) {
    if (isPermissionColdSessionError(error)) {
      sessionFlowLog("permission.reply.cold", {
        sessionId,
        agentActorId,
        requestId: args.requestId,
      });
      return { status: "cold" };
    }
    sessionFlowError("permission.reply.failed", error, {
      sessionId,
      agentActorId,
      requestId: args.requestId,
      runtimeId,
    });
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", message };
  }

  sessionFlowLog("permission.reply.ok", {
    sessionId,
    requestId: args.requestId,
    runtimeId,
  });

  return { status: "sent" };
}

export async function replyPermissionById(
  permissionId: string,
  decision: AcpPermissionDecision,
): Promise<PermissionReplyResult> {
  const located = findV2PendingPermission(permissionId);
  if (!located) {
    return { status: "error", message: `Unknown permission request: ${permissionId}` };
  }
  return replyAcpPermission({
    sessionId: located.sessionId,
    agentActorId: located.actorId,
    requestId: permissionId,
    decision,
  });
}
