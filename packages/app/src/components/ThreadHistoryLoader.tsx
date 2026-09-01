/**
 * Loads message history for the active thread session (same paths as main session).
 */
import { useEffect } from "react";
import { isV2E2EControlActive } from "@/lib/e2e/v2-control-active";
import { loadSessionMessageHistory } from "@/lib/load-session-message-history";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionListStore } from "@/stores/session-list-store";
import { useThreadPanelStore } from "@/stores/thread-panel-store";
import { useWorkspaceStore } from "@/stores/workspace";

export function ThreadHistoryLoader() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const threadSessionId = useThreadPanelStore((s) =>
    s.isOpen ? s.threadSessionId : null,
  );
  const parentSessionId = useThreadPanelStore((s) =>
    s.isOpen ? s.parentSessionId : null,
  );
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null);
  const parentTeamId = useSessionListStore((s) =>
    parentSessionId
      ? s.rows.find((r) => r.id === parentSessionId)?.team_id ?? null
      : null,
  );
  const teamId = parentTeamId ?? currentTeamId;

  useEffect(() => {
    if (!threadSessionId || !teamId) return;
    if (isV2E2EControlActive()) return;

    const controller = new AbortController();
    void loadSessionMessageHistory({
      sessionId: threadSessionId,
      teamId,
      workspacePath,
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [threadSessionId, teamId, workspacePath]);

  return null;
}
