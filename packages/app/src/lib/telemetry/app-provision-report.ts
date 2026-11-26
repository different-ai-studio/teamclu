import { captureTelemetry, shouldReportThrottled, truncateForExtra } from '@/lib/telemetry/capture'

/**
 * Sentry reporting for app provisioning steps that run on the user's machine.
 *
 * Creating a Gitea-managed app finishes on the desktop: it fetches a deploy key
 * and has the local daemon seed and push the checkout. When that fails the row
 * goes to `error` and nothing server-side ever sees why — a customer's first
 * app failed twice in a row on a fresh machine and the only trace was an
 * `error` with an empty reason. This makes each failure an event.
 */

export type AppProvisionStage =
  /** Fetching the Gitea deploy key the seed pushes with. */
  | 'deploy_key'
  /** The local daemon writing, committing and pushing the starter checkout. */
  | 'seed'
  /** Pointing the daemon at a folder the user picked. */
  | 'adopt_dir'

export type AppProvisionFailureKind =
  | 'git_missing'
  | 'ssh_auth'
  | 'network'
  | 'unknown'

const THROTTLE_WINDOW_MS = 60_000

/**
 * Coarse buckets for the reason text, so Sentry groups the common causes
 * instead of one issue per path or hostname. Order matters: a missing git
 * usually also mentions the command line it tried.
 */
export function classifyAppProvisionFailure(reason: string | null | undefined): AppProvisionFailureKind {
  const text = (reason ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (
    /\bgit\b.*(not found|no such file|enoent|cannot find|program not found)/.test(text) ||
    /(not found|no such file|enoent|cannot find).*\bgit\b/.test(text) ||
    text.includes('不是内部或外部命令') ||
    text.includes('系统找不到指定的文件')
  ) {
    return 'git_missing'
  }
  if (text.includes('permission denied (publickey') || text.includes('host key verification failed')) {
    return 'ssh_auth'
  }
  if (
    /(timed out|timeout|could not resolve host|connection (refused|reset)|network is unreachable|failed to fetch)/.test(text)
  ) {
    return 'network'
  }
  return 'unknown'
}

export function reportAppProvisionFailure(
  stage: AppProvisionStage,
  reason: string | null | undefined,
  context: { appId: string; teamId?: string | null; appType?: string | null },
): void {
  const kind = classifyAppProvisionFailure(reason)
  if (!shouldReportThrottled(`app_provision|${context.appId}|${stage}`, THROTTLE_WINDOW_MS)) return
  captureTelemetry({
    message: `app_provision_failed: ${stage} (${kind})`,
    level: 'error',
    fingerprint: ['app_provision', stage, kind],
    tags: { app_provision_stage: stage, app_provision_failure_kind: kind },
    extra: {
      reason: truncateForExtra(reason ?? '', 1000),
      appId: context.appId,
      teamId: context.teamId ?? null,
      appType: context.appType ?? null,
    },
  })
}
