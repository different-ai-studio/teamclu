import type { DaemonRuntimeRefreshStatus } from '@/lib/daemon/daemon-local-client'

/** Human-readable labels for daemon `refresh.change_kinds` snake_case values. */
export function formatRuntimeRefreshChangeKinds(kinds: string[]): string {
  if (kinds.length === 0) return ''
  const labels = kinds.map((kind) => {
    switch (kind) {
      case 'skills':
        return 'skills'
      case 'mcp':
        return 'MCP'
      case 'env_vars':
        return 'environment'
      case 'provider_auth':
        return 'provider credentials'
      case 'provider_catalog':
        return 'provider catalog'
      case 'permissions':
        return 'permissions'
      case 'opencode_json':
        return 'OpenCode config'
      default:
        return kind.replace(/_/g, ' ')
    }
  })
  return labels.join(', ')
}

export function runtimeRefreshNeedsBanner(
  status: DaemonRuntimeRefreshStatus | null | undefined,
): boolean {
  return status === 'failed'
}

/**
 * Whether a daemon refresh error is the OS refusing a write in the workspace
 * (EACCES / EPERM on unix, ERROR_ACCESS_DENIED on Windows). The daemon sends
 * the raw `io::Error` text, so match its rendering rather than a code field.
 */
export function isRuntimeRefreshPermissionError(error: string | null | undefined): boolean {
  if (!error) return false
  return /permission denied|operation not permitted|access is denied|os error (13|1|5)\)/i.test(error)
}
