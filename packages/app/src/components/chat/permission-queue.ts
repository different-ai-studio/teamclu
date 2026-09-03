import { resolvePendingPermissionActivityOwner } from "@/lib/session/session-list-activity";
import type { SessionPermissionMode } from "@/lib/session/session-permission-mode";
import type {
  PendingPermissionEntry,
  Session,
  ToolCallPermission,
} from "@/stores/session-types";

function buildPendingEntryFromToolPermission(
  permission: ToolCallPermission,
  sessionId: string,
  sourceToolName?: string | null,
  sourceToolCallId?: string | null,
): PendingPermissionEntry {
  return {
    permission: {
      id: permission.id,
      sessionID: sessionId,
      permission: permission.permission,
      patterns: permission.patterns,
      metadata: permission.metadata as Record<string, string> | undefined,
      always: permission.always,
    },
    childSessionId: null,
    sourceToolName: sourceToolName ?? null,
    sourceToolCallId: sourceToolCallId ?? null,
  };
}

function collectToolPendingPermissions(session: Session | null): PendingPermissionEntry[] {
  if (!session) return [];

  const collected: PendingPermissionEntry[] = [];
  for (const message of session.messages) {
    for (const toolCall of message.toolCalls || []) {
      const permission = toolCall.permission;
      if (!permission) continue;
      if (permission.decision !== "pending") continue;
      if (toolCall.status !== "calling" && toolCall.status !== "waiting") continue;
      collected.push(
        buildPendingEntryFromToolPermission(
          permission,
          session.id,
          toolCall.name,
          toolCall.id,
        ),
      );
    }
  }

  return collected;
}

export function collectVisiblePermissions(
  activeSessionId: string | null,
  sessions: Session[],
  pendingPermissions: PendingPermissionEntry[],
  acpStreamingPermissions: PendingPermissionEntry[] = [],
): PendingPermissionEntry[] {
  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId) || null
    : null;

  const toolPermissions = collectToolPendingPermissions(activeSession);
  const visiblePendingPermissions = activeSessionId
    ? pendingPermissions.filter(
        (entry) =>
          resolvePendingPermissionActivityOwner(entry, sessions) === activeSessionId,
      )
    : pendingPermissions;
  const merged = [
    ...acpStreamingPermissions,
    ...toolPermissions,
    ...visiblePendingPermissions,
  ];
  const seen = new Set<string>();

  return merged.filter((entry) => {
    if (seen.has(entry.permission.id)) return false;
    seen.add(entry.permission.id);
    return true;
  });
}

export function hasVisiblePendingPermissions(
  activeSessionId: string | null,
  sessions: Session[],
  pendingPermissions: PendingPermissionEntry[],
  acpStreamingPermissions: PendingPermissionEntry[] = [],
  sessionPermissionMode: SessionPermissionMode = "default",
) {
  if (sessionPermissionMode === "fullAccess") {
    return false;
  }
  return (
    collectVisiblePermissions(
      activeSessionId,
      sessions,
      pendingPermissions,
      acpStreamingPermissions,
    ).length > 0
  );
}
