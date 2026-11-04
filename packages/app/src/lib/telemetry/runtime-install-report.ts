import { captureTelemetry, shouldReportThrottled, truncateForExtra } from '@/lib/telemetry/capture'
import {
  classifyInstallFailure,
  summarizeInstallFailure,
} from '@/lib/daemon/install-failure'

/**
 * Sentry reporting for a failed runtime install (`amuxd install-pi`) in the
 * first-run wizard.
 *
 * Until this existed we learned of a stuck install only when the user reached
 * us by some other channel, with a screenshot of whatever line the wizard
 * happened to show. Grouped by failure class (see `classifyInstallFailure`),
 * never by the error text, per the rule in `capture.ts`.
 */

/** One event per class per window: a user mashing Retry is one report. */
const THROTTLE_WINDOW_MS = 10 * 60_000

export type RuntimeInstallFailureContext = {
  /** Consecutive failures in this app session, this one included. */
  attempts: number
  /** Where the install chose to fetch from, when it got that far. */
  route?: string | null
  /** The install's last progress lines, oldest first. */
  output?: string[]
}

export function reportRuntimeInstallFailure(
  error: string,
  context: RuntimeInstallFailureContext,
): void {
  const kind = classifyInstallFailure(error)
  if (!shouldReportThrottled(`runtime-install:${kind}`, THROTTLE_WINDOW_MS)) return
  captureTelemetry({
    message: 'runtime install failed',
    level: 'error',
    tags: {
      area: 'runtime-install',
      failure_kind: kind,
      route: context.route ?? 'unknown',
      repeated: context.attempts > 1 ? 'yes' : 'no',
    },
    extra: {
      headline: summarizeInstallFailure(error).headline,
      error: truncateForExtra(error, 4000),
      attempts: context.attempts,
      output: truncateForExtra((context.output ?? []).slice(-40).join('\n'), 6000),
    },
    fingerprint: ['runtime-install-failed', kind],
  })
}
