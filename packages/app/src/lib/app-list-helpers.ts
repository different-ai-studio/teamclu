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

/**
 * Where an app's code actually lives — the three-way distinction the create
 * flow makes, said back to the user in the list.
 *
 * It decides real behaviour, not just wording: only `hosted` deploys a commit
 * off the forge, and only `hosted` or `remote` can be downloaded onto another
 * machine at all. `local` exists on exactly one machine until someone gives it
 * a remote.
 */
export type AppGitKind = 'hosted' | 'remote' | 'local'

export function appGitKind(
  app: Pick<AppRow, 'gitAuthKind' | 'gitRemoteUrl'>,
): { kind: AppGitKind; key: string; fallback: string } {
  if (app.gitAuthKind === 'gitea_deploy_key') {
    return { kind: 'hosted', key: 'apps.gitHosted', fallback: '托管仓库' }
  }
  if (app.gitRemoteUrl?.trim()) {
    return { kind: 'remote', key: 'apps.gitRemote', fallback: '外部仓库' }
  }
  return { kind: 'local', key: 'apps.gitLocal', fallback: '仅本机' }
}
