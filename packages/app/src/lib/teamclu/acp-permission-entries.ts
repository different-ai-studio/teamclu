import type { PendingPermissionEntry } from "@/stores/session-types";
import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import { shouldAutoAllowSessionPermissions } from "@/lib/session/session-permission-mode";
import { canCurrentMemberActOnPermission } from "@/lib/teamclu/handle-acp-permission-request";
import { useCurrentTeamStore } from "@/stores/current-team";

function inferPermissionType(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal") || n === "execute") {
    return "bash";
  }
  if (n.includes("write")) return "write";
  if (n.includes("edit")) return "edit";
  if (n.includes("read")) return "read";
  if (n.includes("skill")) return "skill";
  return n || "execute";
}

export function buildPendingEntryFromAcpPermission(
  sessionId: string,
  agentActorId: string,
  req: StreamingPermissionRequest,
): PendingPermissionEntry {
  const permType = inferPermissionType(req.toolName);
  const command =
    req.params.command ??
    req.params.cmd ??
    req.description ??
    req.toolName;
  const requesterActorId =
    req.requesterActorId?.trim() || req.params.requester_actor_id?.trim() || "";

  return {
    permission: {
      id: req.requestId,
      sessionID: sessionId,
      permission: permType,
      patterns: command ? [command] : [],
      metadata: {
        ...req.params,
        _acp_agent_actor_id: agentActorId,
        ...(requesterActorId ? { requester_actor_id: requesterActorId } : {}),
      },
      always: [],
    },
    childSessionId:
      (req.params.childSessionId as string | undefined)?.trim() || null,
    sourceToolName: req.toolName || null,
    sourceToolCallId:
      (req.params.toolCallId as string | undefined)?.trim() || null,
  };
}

type StreamKeyEntry = {
  sessionId: string;
  actorId: string;
  pendingPermissionsByRequestId: Record<string, StreamingPermissionRequest>;
};

function forEachPendingInSession(
  activeSessionId: string,
  byKey: Record<string, StreamKeyEntry>,
  visit: (entry: StreamKeyEntry, pending: StreamingPermissionRequest) => void,
): void {
  for (const entry of Object.values(byKey)) {
    if (entry.sessionId !== activeSessionId) continue;
    for (const pending of Object.values(entry.pendingPermissionsByRequestId)) {
      if (!pending.requestId?.trim()) continue;
      visit(entry, pending);
    }
  }
}

/**
 * Compact fingerprint of pending ACP permissions across all sessions.
 * Used as a Zustand selector so the session list does not re-render on
 * unrelated streaming deltas.
 */
export function selectStreamingPermissionSnapshot(
  byKey: Record<string, StreamKeyEntry>,
): string {
  const parts: string[] = [];
  for (const entry of Object.values(byKey)) {
    const ids = Object.keys(entry.pendingPermissionsByRequestId).sort();
    if (ids.length === 0) continue;
    parts.push(`${entry.sessionId}:${ids.join(",")}`);
  }
  return parts.sort().join("|");
}

/** All pending ACP permissions for sidebar activity badges (every session). */
export function collectAcpStreamingPermissionsForList(
  byKey: Record<string, StreamKeyEntry>,
): PendingPermissionEntry[] {
  const out: PendingPermissionEntry[] = [];
  for (const entry of Object.values(byKey)) {
    if (shouldAutoAllowSessionPermissions(entry.sessionId)) continue;
    for (const pending of Object.values(entry.pendingPermissionsByRequestId)) {
      if (!pending.requestId?.trim()) continue;
      out.push(buildPendingEntryFromAcpPermission(entry.sessionId, entry.actorId, pending));
    }
  }
  return out;
}

/** Interactive Allow/Deny queue — excludes bystander-stamped requests. */
export function collectAcpStreamingPermissions(
  activeSessionId: string | null,
  byKey: Record<string, StreamKeyEntry>,
): PendingPermissionEntry[] {
  if (!activeSessionId) return [];
  if (shouldAutoAllowSessionPermissions(activeSessionId)) return [];
  const me = useCurrentTeamStore.getState().currentMember?.id ?? null;
  const out: PendingPermissionEntry[] = [];
  forEachPendingInSession(activeSessionId, byKey, (entry, pending) => {
    if (!canCurrentMemberActOnPermission(pending, me)) return;
    out.push(buildPendingEntryFromAcpPermission(entry.sessionId, entry.actorId, pending));
  });
  return out;
}

/**
 * Pending permissions stamped for another member — used for the read-only
 * “等待 XXX 批准” banner (Phase 2.5). Legacy empty requester is excluded.
 */
export function collectAcpBystanderWaitingPermissions(
  activeSessionId: string | null,
  byKey: Record<string, StreamKeyEntry>,
): PendingPermissionEntry[] {
  if (!activeSessionId) return [];
  const me = useCurrentTeamStore.getState().currentMember?.id ?? null;
  const out: PendingPermissionEntry[] = [];
  forEachPendingInSession(activeSessionId, byKey, (entry, pending) => {
    const requester =
      pending.requesterActorId?.trim() || pending.params?.requester_actor_id?.trim() || "";
    if (!requester) return;
    if (canCurrentMemberActOnPermission(pending, me)) return;
    out.push(buildPendingEntryFromAcpPermission(entry.sessionId, entry.actorId, pending));
  });
  return out;
}
