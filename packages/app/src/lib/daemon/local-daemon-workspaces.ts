import { invoke } from '@tauri-apps/api/core'

/**
 * The workspaces the local daemon has registered, and which of them is its
 * default.
 *
 * A leaf module on purpose: `effective-workspace` resolves the daemon's default
 * workspace on behalf of settings panels, and pulling this out of
 * `cron-workspace-models` — which reaches into the cron store, the runtime
 * state store and the proto bundle — kept that resolution from dragging half
 * the app into every consumer.
 */
export interface LocalDaemonWorkspace {
  workspaceId: string
  remoteWorkspaceId: string
  path: string
  displayName: string
  teamId: string | null
  isDefault: boolean
}

export async function listLocalDaemonWorkspaces(): Promise<LocalDaemonWorkspace[]> {
  try {
    const rows = await invoke<LocalDaemonWorkspace[]>('list_local_daemon_workspaces')
    return dedupeWorkspacesByPath(rows)
  } catch {
    return []
  }
}

/** The daemon can register several workspace ids for the same on-disk path;
 *  collapse them to one entry per path (preferring the default row) so the cron
 *  workspace picker doesn't list the same path a dozen times. */
function dedupeWorkspacesByPath(rows: LocalDaemonWorkspace[]): LocalDaemonWorkspace[] {
  const byPath = new Map<string, LocalDaemonWorkspace>()
  for (const row of rows) {
    const key = row.path?.trim()
    if (!key) continue
    const existing = byPath.get(key)
    // Keep the first occurrence, but let a default row win over a non-default one.
    if (!existing || (row.isDefault && !existing.isDefault)) {
      byPath.set(key, row)
    }
  }
  return [...byPath.values()]
}

export function defaultLocalDaemonWorkspacePath(rows: LocalDaemonWorkspace[]): string | null {
  const explicit = rows.find((row) => row.isDefault && row.path.trim())
  if (explicit) return explicit.path
  if (rows.length === 1 && rows[0].path.trim()) return rows[0].path
  return null
}
