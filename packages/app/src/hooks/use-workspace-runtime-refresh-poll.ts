/** Poll the workspace's agent-runtime refresh queue.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect } from "react";
import { isTauri } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorkspaceRuntimeRefreshStore } from "@/stores/workspace-runtime-refresh";
import { SKILLS_CHANGED_EVENT } from "@/lib/skills/changed-event";

export function useWorkspaceRuntimeRefreshPoll() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);
  const startPolling = useWorkspaceRuntimeRefreshStore((s) => s.startPolling);
  const stopPolling = useWorkspaceRuntimeRefreshStore((s) => s.stopPolling);
  const refreshNow = useWorkspaceRuntimeRefreshStore((s) => s.refreshNow);

  useEffect(() => {
    if (!isTauri() || !daemonHttpReady || !workspacePath) {
      stopPolling();
      return;
    }
    startPolling(workspacePath);
    return () => stopPolling();
  }, [workspacePath, daemonHttpReady, startPolling, stopPolling]);

  const noteLocalRefresh = useWorkspaceRuntimeRefreshStore((s) => s.noteLocalRefresh);

  useEffect(() => {
    const bump = () => {
      noteLocalRefresh(["skills"]);
      const path = useWorkspaceStore.getState().workspacePath;
      if (path) void refreshNow(path);
    };
    window.addEventListener(SKILLS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, bump);
  }, [noteLocalRefresh, refreshNow]);
}
