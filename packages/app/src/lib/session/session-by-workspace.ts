import { resolveSessionWorkspaceForViewer } from "@/lib/session/session-viewer-workspace";
import { workspacePathsMatch } from "@/stores/session-utils";
import { workspacePathAvailableHere } from "@/lib/workspace/path-available-here";

/**
 * Viewer-scoped local path for a session. Only adopts workspaces tied to the
 * current member's agents and registered on this machine — never a foreign path.
 */
export async function resolveSessionWorkspacePath(
  teamId: string,
  sessionId: string,
): Promise<string | null> {
  return resolveSessionWorkspaceForViewer(teamId, sessionId);
}

/** True when this session is bound to `workspacePath` for the current viewer. */
export async function sessionBelongsToWorkspace(
  teamId: string,
  sessionId: string,
  workspacePath: string,
): Promise<boolean> {
  const targetPath = await resolveSessionWorkspacePath(teamId, sessionId);
  if (!targetPath) return false;
  return workspacePathsMatch(targetPath, workspacePath);
}

/**
 * Switch the desktop workspace when opening a session bound to another folder.
 *
 * Only to a folder that exists here. A session's bound path is whatever machine
 * created it, so opening a teammate's session otherwise switches this window to
 * *their* path — and `setWorkspace` persists it to `teamclu-workspace-path`,
 * where it outlives the session view and becomes this client's idea of "the
 * current folder". Everything downstream that resolves a folder to a cloud
 * workspace then matches on the path string and hands back the row that other
 * machine owns.
 *
 * That is how a daemon ended up seated on `/Users/<someone-else>/TeamClu` on
 * 2026-09-23: every new session with it was refused with
 * WORKSPACE_PATH_UNAVAILABLE and retried forever, which reads as "the agent is
 * offline". See #1579.
 */
export async function switchToSessionWorkspaceIfNeeded(
  teamId: string,
  sessionId: string,
): Promise<void> {
  const targetPath = await resolveSessionWorkspacePath(teamId, sessionId);
  if (!targetPath) return;

  const { useWorkspaceStore } = await import("@/stores/workspace");
  const currentPath = useWorkspaceStore.getState().workspacePath;
  if (currentPath && workspacePathsMatch(currentPath, targetPath)) return;

  if (!(await workspacePathAvailableHere(targetPath))) {
    console.info(
      "[session] session workspace is not on this machine; staying put:",
      targetPath,
    );
    return;
  }

  await useWorkspaceStore.getState().setWorkspace(targetPath);
}
