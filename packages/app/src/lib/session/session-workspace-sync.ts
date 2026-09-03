import {
  invalidateViewerWorkspaceContext,
  loadViewerWorkspaceContext,
} from "@/lib/session/session-viewer-workspace";

/**
 * Refresh the viewer's workspace context for a team.
 *
 * This used to pull every `agent_runtimes` row in the team and cache the
 * session → workspace links locally, because that team-wide fetch was the only
 * way to get them. The workspace belongs to the participant row now (ADR-0005),
 * so `session-viewer-workspace` resolves it per session on demand and the
 * bulk prefetch — the query that reached 1306 rows and a 48KB URL — is gone.
 *
 * What remains is invalidating the cached viewer context so newly connected
 * agents and newly registered workspaces are picked up.
 */
export async function syncSessionWorkspaces(teamId: string): Promise<void> {
  invalidateViewerWorkspaceContext(teamId);
  await loadViewerWorkspaceContext(teamId);
}
