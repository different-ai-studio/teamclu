import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  collectAcpBystanderWaitingPermissions,
  collectAcpStreamingPermissions,
} from "@/lib/teamclu/acp-permission-entries";
import { useSessionStore } from "@/stores/session-store";
import {
  useV2StreamingStore,
  type AgentStreamEntry,
} from "@/stores/v2-streaming-store";
import { collectVisiblePermissions } from "./permission-queue";

const NO_PENDING: Array<AgentStreamEntry["pendingPermissionsByRequestId"]> = [];

/**
 * The session's per-actor pending-permission maps. A text delta replaces the
 * stream entry but keeps this map's reference, so the result stays
 * shallow-equal and the composer does not re-render. Subscribing to the
 * session revision re-rendered ComposerStack — and through it every agent
 * strip — on every frame of a reply.
 */
function selectPendingMaps(
  byKey: Record<string, AgentStreamEntry>,
  sessionId: string | null,
): Array<AgentStreamEntry["pendingPermissionsByRequestId"]> {
  if (!sessionId) return NO_PENDING;
  const out: Array<AgentStreamEntry["pendingPermissionsByRequestId"]> = [];
  for (const entry of Object.values(byKey)) {
    if (entry.sessionId === sessionId) out.push(entry.pendingPermissionsByRequestId);
  }
  return out;
}

/** Permission / approval queue for a composer surface (main session or thread). */
export function usePendingPermissionsQueue(permissionSessionId: string | null) {
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  const pendingMaps = useV2StreamingStore(
    useShallow((s) => selectPendingMaps(s.byKey, permissionSessionId)),
  );
  const [dismissedIds, setDismissedIds] = React.useState<string[]>([]);

  const acpStreamingPermissions = React.useMemo(() => {
    const streamByKey = useV2StreamingStore.getState().byKey;
    return collectAcpStreamingPermissions(permissionSessionId, streamByKey);
    // pendingMaps is the change signal for the getState() read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionSessionId, pendingMaps]);

  const waitingPermissions = React.useMemo(() => {
    const streamByKey = useV2StreamingStore.getState().byKey;
    return collectAcpBystanderWaitingPermissions(permissionSessionId, streamByKey);
    // pendingMaps is the change signal for the getState() read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionSessionId, pendingMaps]);

  const baseVisiblePermissions = React.useMemo(
    () =>
      collectVisiblePermissions(
        permissionSessionId,
        sessions,
        pendingPermissions,
        acpStreamingPermissions,
      ),
    [permissionSessionId, acpStreamingPermissions, pendingPermissions, sessions],
  );

  React.useEffect(() => {
    // Keep the same array when nothing was dropped: a fresh empty array is a
    // state change, and it re-rendered the composer once more per update.
    setDismissedIds((current) => {
      const kept = current.filter((id) =>
        baseVisiblePermissions.some((entry) => entry.permission.id === id),
      );
      return kept.length === current.length ? current : kept;
    });
  }, [baseVisiblePermissions]);

  const visiblePermissions = React.useMemo(
    () =>
      baseVisiblePermissions.filter(
        (entry) => !dismissedIds.includes(entry.permission.id),
      ),
    [baseVisiblePermissions, dismissedIds],
  );

  const currentEntry = visiblePermissions[0] ?? null;
  const queuedCount = visiblePermissions.length;
  const waitingEntry = waitingPermissions[0] ?? null;
  const waitingRequesterActorId =
    (waitingEntry?.permission.metadata?.requester_actor_id as string | undefined)?.trim() ||
    null;

  const onReplyStart = React.useCallback((permissionId: string) => {
    setDismissedIds((current) =>
      current.includes(permissionId) ? current : [...current, permissionId],
    );
  }, []);

  const onReplyRollback = React.useCallback((permissionId: string) => {
    setDismissedIds((current) => current.filter((id) => id !== permissionId));
  }, []);

  return {
    permissionSessionId,
    visiblePermissions,
    currentEntry,
    queuedCount,
    waitingRequesterActorId,
    onReplyStart,
    onReplyRollback,
  };
}
