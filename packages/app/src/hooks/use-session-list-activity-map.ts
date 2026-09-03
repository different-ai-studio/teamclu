import * as React from "react";
import { useSessionStore } from "@/stores/session-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import {
  selectSessionParentLinks,
} from "@/lib/session/session-parent-links";
import { buildSessionListActivityMap } from "@/lib/session/session-list-activity";
import type { PendingPermissionEntry } from "@/stores/session-types";
import {
  collectAcpStreamingPermissionsForList,
  selectStreamingPermissionSnapshot,
} from "@/lib/teamclu/acp-permission-entries";

function mergePendingPermissionEntries(
  ...groups: PendingPermissionEntry[][]
): PendingPermissionEntry[] {
  const byId = new Map<string, PendingPermissionEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const id = entry.permission?.id;
      if (id) byId.set(id, entry);
    }
  }
  return Array.from(byId.values());
}

export function useSessionListActivityMap(activeSessionId: string | null) {
  // Parent graph fingerprint — title/preview/message writes must not refresh the list.
  const sessionParentLinksKey = useSessionStore((s) =>
    s.sessions.map((row) => `${row.id}:${row.parentID ?? ""}`).join("|"),
  );
  const sessionParentLinks = React.useMemo(
    () => selectSessionParentLinks(useSessionStore.getState().sessions),
    [sessionParentLinksKey],
  );
  const sessionStatuses = useSessionStore((s) => s.sessionStatuses) || {};
  const pendingQuestionIdsBySession =
    useSessionStore((s) => s.pendingQuestionIdsBySession) || {};
  const pendingQuestions = useSessionStore((s) => s.pendingQuestions) || [];
  const legacyPendingPermissions =
    useSessionStore((s) => s.pendingPermissions) || [];
  const permissionSnapshot = useV2StreamingStore((s) =>
    selectStreamingPermissionSnapshot(s.byKey),
  );

  return React.useMemo(
    () =>
      buildSessionListActivityMap({
        sessions: sessionParentLinks,
        activeSessionId,
        sessionStatuses,
        pendingQuestionIdsBySession,
        pendingQuestions,
        pendingPermissions: mergePendingPermissionEntries(
          legacyPendingPermissions,
          collectAcpStreamingPermissionsForList(
            useV2StreamingStore.getState().byKey,
          ),
        ),
        // The v1 streaming store is gone; live turns are reported through the
        // permissionSnapshot / acp paths above and by useV2StreamingStore readers.
        streamingMessageId: null,
        streamingChildSessionIds: [],
      }),
    [
      activeSessionId,
      sessionParentLinks,
      legacyPendingPermissions,
      pendingQuestionIdsBySession,
      pendingQuestions,
      permissionSnapshot,
      sessionStatuses,
    ],
  );
}
