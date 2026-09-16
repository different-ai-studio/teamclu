/**
 * A per-session counter bumped whenever an agent's seat in that session is
 * moved to another workspace.
 *
 * `useSessionLocalWorkspace` resolves a session's folder when the session or
 * the workspace store changes. A seat bound while the session stays open
 * changes neither when the chosen folder is the one the window already has, so
 * the files pane kept saying the session had no workspace beside a tree that
 * was now correct. Reading this counter is how the hook learns to look again.
 */

const revisions = new Map<string, number>()
const listeners = new Set<() => void>()

export function noteSessionWorkspaceRebound(sessionId: string): void {
  revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1)
  for (const listener of listeners) listener()
}

export function sessionWorkspaceRebindRevision(sessionId: string | null): number {
  return sessionId ? revisions.get(sessionId) ?? 0 : 0
}

export function subscribeSessionWorkspaceRebind(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
