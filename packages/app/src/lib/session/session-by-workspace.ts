import { loadSessionWorkspacesForTeam, type SessionWorkspaceRow } from "@/lib/cache/local-cache";
import {
  loadViewerWorkspaceContext,
  resolveSessionWorkspaceForViewer,
} from "@/lib/session/session-viewer-workspace";
import { workspacePathsMatch } from "@/stores/session-utils";

async function loadViewerSessionWorkspaceRows(
  teamId: string,
): Promise<SessionWorkspaceRow[]> {
  const viewer = await loadViewerWorkspaceContext(teamId);
  if (!viewer.memberId) return [];
  return loadSessionWorkspacesForTeam(teamId, viewer.memberId);
}

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

/** Switch the desktop workspace when opening a session bound to another folder. */
export async function switchToSessionWorkspaceIfNeeded(
  teamId: string,
  sessionId: string,
): Promise<void> {
  const targetPath = await resolveSessionWorkspacePath(teamId, sessionId);
  if (!targetPath) return;

  const { useWorkspaceStore } = await import("@/stores/workspace");
  const currentPath = useWorkspaceStore.getState().workspacePath;
  if (currentPath && workspacePathsMatch(currentPath, targetPath)) return;

  await useWorkspaceStore.getState().setWorkspace(targetPath);
}

/**
 * Resolve the set of session ids that belong to a workspace for the current
 * viewer, reading ONLY the local libsql `session_viewer_workspace` table.
 */
export async function loadSessionIdsForWorkspace(
  teamId: string,
  target: { workspaceId: string | null; path: string },
): Promise<Set<string>> {
  const rows = await loadViewerSessionWorkspaceRows(teamId);
  const ids = new Set<string>();
  for (const r of rows) {
    const byId = !!target.workspaceId && r.workspaceId === target.workspaceId;
    const byPath =
      !!r.workspacePath &&
      !!target.path &&
      workspacePathsMatch(r.workspacePath, target.path);
    if (byId || byPath) ids.add(r.sessionId);
  }
  return ids;
}
