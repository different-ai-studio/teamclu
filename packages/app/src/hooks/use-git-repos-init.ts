/** Auto-sync the workspace's git repos once the workspace is ready.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect } from "react";
import { isTauri } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTeamMembersStore } from "@/stores/team-members";
import { useShortcutsStore } from "@/stores/shortcuts";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useOssSyncStore } from "@/stores/oss-sync";

export function useGitReposInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const workspaceReady = !!workspacePath;

  useEffect(() => {
    if (!workspacePath || !workspaceReady || !isTauri()) return;

    // Hydrate shortcuts: first paint from local cache, then refresh from Supabase.
    void (async () => {
      try {
        const store = useShortcutsStore.getState();
        await store.hydrateFromCache();
        await store.loadPersonal();
        const teamId = useCurrentTeamStore.getState().team?.id ?? null;
        if (teamId) await store.loadTeamForCurrentTeam(teamId);
      } catch (err: unknown) {
        console.warn("[App] Failed to load shortcuts (non-critical):", err);
      }
    })();

    void (async () => {
      try {
        await useTeamMembersStore.getState().loadCurrentNodeId();
      } catch (err: unknown) {
        console.warn("[App] Failed to load current team member identity (non-critical):", err);
      }
    })();

  }, [workspacePath, workspaceReady]);

  // Team sync status. Not gated on a workspace (the status is per team), and no
  // longer on a cloud share-mode flag either — nothing in the product sets that
  // flag, so gating on it meant never reading the status at all.
  //
  // What used to be here as well — a `file-change` listener under
  // `<workspace>/teamclu-team/` that re-read this status on every team file
  // write — is gone. It existed to repaint per-file sync badges, which the
  // daemon stopped exposing (`fileSyncStatusMap` has been `{}` since), and it
  // watched a tree sync retired: team content lives in the team's own
  // `shared/knowledge` now, which that path never pointed at.
  useEffect(() => {
    if (!isTauri()) return;
    void useOssSyncStore.getState().refresh(workspacePath);
  }, [workspacePath]);
}
