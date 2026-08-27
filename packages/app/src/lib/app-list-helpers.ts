import type { AppRow } from '@/lib/backend/types'

/**
 * Whether a "Reseed" action should be offered for an app in the given
 * provision state.
 */
export function canReseed(status: string): boolean {
  return status === 'pending' || status === 'repo_created' || status === 'error'
}

/** i18n key when deploy is blocked by auth/runtime policy, or null when allowed. */
export function deployDisabledReason(
  app: Pick<AppRow, 'authMode' | 'runtime'>,
): string | null {
  if (app.authMode === 'third') return 'apps.deployDisabledThird'
  if (app.runtime === 'container') return 'apps.deployDisabledContainer'
  return null
}

/** Show the public-access badge on live apps with no auth gate. */
export function showsPublicBadge(
  app: Pick<AppRow, 'authMode' | 'fcStatus'>,
): boolean {
  return app.authMode === 'none' && app.fcStatus === 'live'
}

function provisionMeta(status: string): { dot: 'ready' | 'failed' | 'idle'; key: string; fallback: string } {
  if (status === 'ready') return { dot: 'ready', key: 'apps.ready', fallback: 'Ready' }
  if (status === 'error' || status === 'failed') return { dot: 'failed', key: 'apps.error', fallback: 'Failed' }
  return { dot: 'idle', key: 'apps.provisioning', fallback: 'Provisioning…' }
}

/**
 * Status line for an app row, resolved from deploy + provision lifecycles.
 */
export function appStatusMeta(
  app: Pick<AppRow, 'provisionStatus' | 'fcStatus' | 'fcEndpoint'>,
  deploying: boolean,
): { dot: 'live' | 'ready' | 'failed' | 'idle'; key: string; fallback: string } {
  if (deploying) return { dot: 'idle', key: 'apps.deploying', fallback: '部署中…' }
  if (app.fcStatus === 'live' && app.fcEndpoint) return { dot: 'live', key: 'apps.live', fallback: '已上线' }
  if (app.fcStatus === 'deploy_error') return { dot: 'failed', key: 'apps.deployFailed', fallback: '部署失败' }
  if (app.fcStatus === 'awaiting_build' || app.fcStatus === 'building' || app.fcStatus === 'deploying') {
    return { dot: 'idle', key: 'apps.deploying', fallback: '部署中…' }
  }
  return provisionMeta(app.provisionStatus)
}
