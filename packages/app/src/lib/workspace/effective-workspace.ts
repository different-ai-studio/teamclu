import * as React from 'react'

import { useWorkspaceStore } from '@/stores/workspace'
import {
  defaultLocalDaemonWorkspacePath,
  listLocalDaemonWorkspaces,
} from '@/lib/daemon/local-daemon-workspaces'

/**
 * The workspace that daemon-scoped *config* calls should use: the folder the
 * user has open, or — when there is none — the daemon's own default workspace.
 *
 * The fallback is not a guess. The daemon registers a default workspace and
 * runs there itself whenever nothing else is picked: gateway sessions and
 * global cron jobs already land in it. So the MCP servers, skills, permissions
 * and env this resolves to are the ones those runs actually read. Before this,
 * every such surface simply died with no folder open — an empty panel for
 * config that was never per-project to begin with.
 *
 * NOT for workspace *content*: the file tree, the editor, session diffs and
 * chat all address a real project the user chose, and must keep requiring one.
 */
let cachedFallback: string | null = null
let inflight: Promise<string | null> | null = null

/**
 * The daemon's default workspace, on its own — no store involved, so the React
 * binding below can use it with nothing but the selector value it already has.
 */
async function daemonDefaultWorkspacePath(): Promise<string | null> {
  if (cachedFallback) return cachedFallback

  // Coalesced: several panels resolve this on the same paint.
  if (!inflight) {
    inflight = listLocalDaemonWorkspaces()
      .then((rows) => defaultLocalDaemonWorkspacePath(rows))
      .catch(() => null)
  }
  try {
    const resolved = await inflight
    if (resolved) cachedFallback = resolved
    return resolved
  } finally {
    inflight = null
  }
}

export async function effectiveWorkspacePath(): Promise<string | null> {
  return useWorkspaceStore.getState().workspacePath ?? (await daemonDefaultWorkspacePath())
}

/** Drop the cached fallback — the daemon's workspace registry has changed. */
export function invalidateEffectiveWorkspacePath(): void {
  cachedFallback = null
  inflight = null
}

/**
 * React binding for {@link effectiveWorkspacePath}. Returns the open folder
 * immediately and resolves the fallback in the background, so a panel renders
 * its "no workspace" state for at most one paint rather than forever.
 */
export function useEffectiveWorkspacePath(): string | null {
  const open = useWorkspaceStore((s) => s.workspacePath)
  const [fallback, setFallback] = React.useState<string | null>(cachedFallback)

  React.useEffect(() => {
    if (open) return
    let cancelled = false
    void daemonDefaultWorkspacePath().then((path) => {
      if (!cancelled) setFallback(path)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  return open ?? fallback
}
