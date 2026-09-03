import { findV2PendingPermission } from "@/lib/teamclu/reply-acp-permission";
import { useSessionStore } from "@/stores/session-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

/** How long a resolved requestId suppresses a late PermissionRequest. */
const RESOLVED_TTL_MS = 60_000;

const resolvedAtByRequestId = new Map<string, number>();

function pruneResolved(now = Date.now()): void {
  for (const [id, at] of resolvedAtByRequestId) {
    if (now - at > RESOLVED_TTL_MS) {
      resolvedAtByRequestId.delete(id);
    }
  }
}

/** True if this requestId was recently cleared via PermissionResolved. */
export function wasPermissionRecentlyResolved(requestId: string): boolean {
  const trimmed = requestId.trim();
  if (!trimmed) return false;
  pruneResolved();
  const at = resolvedAtByRequestId.get(trimmed);
  if (at == null) return false;
  if (Date.now() - at > RESOLVED_TTL_MS) {
    resolvedAtByRequestId.delete(trimmed);
    return false;
  }
  return true;
}

function markPermissionResolved(requestId: string): void {
  const trimmed = requestId.trim();
  if (!trimmed) return;
  pruneResolved();
  resolvedAtByRequestId.set(trimmed, Date.now());
}

/**
 * Clear a pending ACP permission on every client after SessionEvent.PermissionResolved.
 * Locates by requestId scan so envelope actorId/runtimeId mismatches cannot leave sticky cards.
 */
export function handleSessionEventPermissionResolved(args: {
  requestId: string;
  /** Optional hint; ignored for lookup — findV2PendingPermission scans all keys. */
  sessionIdHint?: string;
}): void {
  const requestId = args.requestId.trim();
  if (!requestId) return;

  markPermissionResolved(requestId);

  const located = findV2PendingPermission(requestId);
  if (located) {
    useV2StreamingStore
      .getState()
      .clearPermissionRequest(located.sessionId, located.actorId, requestId);
  }

  useSessionStore.setState((state) => {
    if (!state.pendingPermissions.some((e) => e.permission.id === requestId)) {
      return {};
    }
    return {
      pendingPermissions: state.pendingPermissions.filter(
        (e) => e.permission.id !== requestId,
      ),
    };
  });
}

/** Test helper */
export function resetPermissionResolvedTtlForTests(): void {
  resolvedAtByRequestId.clear();
}
