import { workspacePathsMatch } from '@/stores/session-utils'

/**
 * Sentinel for "bind this window's project root" when that folder is not yet
 * a cloud workspace row. Never sent to Cloud API — create resolves it through
 * {@link resolveLocalDaemonWorkspaceBinding} so the row is created if needed.
 */
export const CURRENT_WINDOW_WORKSPACE_ID = '__current_window__'

export function pickNewSessionWorkspaceId(args: {
  currentId: string
  workspaces: ReadonlyArray<{ id: string; path: string | null }>
  windowPath: string
  defaultWorkspaceId: string
}): string {
  const listed = args.workspaces.filter((w) => !!w.path?.trim())
  const windowPath = args.windowPath.trim()
  const windowMatch = windowPath
    ? listed.find((w) => w.path && workspacePathsMatch(w.path, windowPath))
    : undefined

  if (args.currentId === CURRENT_WINDOW_WORKSPACE_ID) {
    if (windowMatch) return windowMatch.id
    return windowPath ? CURRENT_WINDOW_WORKSPACE_ID : ''
  }
  if (args.currentId && listed.some((w) => w.id === args.currentId)) return args.currentId

  if (windowMatch) return windowMatch.id
  if (windowPath) return CURRENT_WINDOW_WORKSPACE_ID

  const preferred = listed.find((w) => w.id === args.defaultWorkspaceId.trim())
  return preferred?.id ?? ''
}
