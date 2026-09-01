import * as React from "react";
import {
  collectAcpBystanderWaitingPermissions,
  collectAcpStreamingPermissions,
} from "@/lib/teamclu/acp-permission-entries";
import { useSessionPermissionMode } from "@/lib/session-permission-mode";
import { useSessionStore } from "@/stores/session";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { collectVisiblePermissions } from "./permission-queue";

/** Permission / approval queue for a composer surface (main session or thread). */
export function usePendingPermissionsQueue(permissionSessionId: string | null) {
  const sessionPermissionMode = useSessionPermissionMode(permissionSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  const streamRevision = useV2StreamingStore((s) =>
    permissionSessionId ? (s.revisionBySession[permissionSessionId] ?? 0) : 0,
  );
  const [dismissedIds, setDismissedIds] = React.useState<string[]>([]);

  const acpStreamingPermissions = React.useMemo(() => {
    const streamByKey = useV2StreamingStore.getState().byKey;
    return collectAcpStreamingPermissions(permissionSessionId, streamByKey);
  }, [permissionSessionId, streamRevision]);

  const waitingPermissions = React.useMemo(() => {
    const streamByKey = useV2StreamingStore.getState().byKey;
    return collectAcpBystanderWaitingPermissions(permissionSessionId, streamByKey);
  }, [permissionSessionId, streamRevision]);

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
    setDismissedIds((current) =>
      current.filter((id) =>
        baseVisiblePermissions.some((entry) => entry.permission.id === id),
      ),
    );
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
    sessionPermissionMode,
    visiblePermissions,
    currentEntry,
    queuedCount,
    waitingRequesterActorId,
    onReplyStart,
    onReplyRollback,
  };
}
