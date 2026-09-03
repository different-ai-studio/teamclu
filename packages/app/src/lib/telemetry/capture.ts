/**
 * Shared Sentry plumbing for the telemetry reporters in this directory.
 *
 * Grouping rule every reporter must follow: never interpolate ids, durations,
 * or raw reasons into `message`. Sentry fingerprints on message text, and
 * embedded UUIDs shatter one problem into dozens of issues — the
 * `team gate mismatch` reports fragmented into four separate issues exactly
 * that way. Ids belong in tags/extra with an explicit `fingerprint`.
 */

export type TelemetryLevel = 'warning' | 'error'

type TelemetryCaptureArgs = {
  /** Stable across occurrences — no ids, no numbers. */
  message: string
  level: TelemetryLevel
  tags: Record<string, string>
  extra: Record<string, unknown>
  fingerprint: string[]
  /** When present, captured as an exception instead of a message. */
  error?: unknown
}

/**
 * One shared import for every capture. Kept lazy so hot paths do not pull
 * Sentry in eagerly, and memoized so a burst of reports in the same tick
 * resolves against a single module promise (concurrent dynamic imports of the
 * same module do not reliably settle).
 */
let sentryModule: Promise<typeof import('@sentry/react')> | null = null

export function loadSentry(): Promise<typeof import('@sentry/react')> {
  sentryModule ??= import('@sentry/react')
  return sentryModule
}

/**
 * Resolves once `Sentry.init` has run. Every capture path goes through this so
 * an event raised during startup — before the SDK chunk has finished loading —
 * still lands, instead of hitting a client-less `captureException` no-op.
 */
let sentryReady: Promise<typeof import('@sentry/react')> | null = null

/**
 * Boot Sentry off the startup path.
 *
 * The SDK is ~450KB of the startup chunk if imported statically, all of it
 * parsed and executed before first paint for a service that reports nothing in
 * the common case. Loading it dynamically starts the fetch just as early but
 * keeps it out of the critical chunk.
 */
export function initSentry(
  options: Parameters<typeof import('@sentry/react').init>[0],
): Promise<typeof import('@sentry/react')> {
  sentryReady ??= loadSentry().then((Sentry) => {
    Sentry.init(options)
    return Sentry
  })
  return sentryReady
}

/**
 * Run `fn` against an initialized Sentry. Callers must not care when that
 * happens — the returned promise is already error-swallowed.
 */
export function withSentry(fn: (Sentry: typeof import('@sentry/react')) => void): Promise<void> {
  return (sentryReady ?? loadSentry()).then(fn).catch(() => {
    // Telemetry must never break the path it observes.
  })
}

/** @internal test hook */
export function __resetSentryModuleForTest(): void {
  sentryModule = null
  sentryReady = null
}

const lastReportedAt = new Map<string, number>()

/**
 * True when `key` has not been reported inside `windowMs`. Reporters that sit
 * on retry/wake loops must throttle, or one persistent fault produces hundreds
 * of identical events.
 */
export function shouldReportThrottled(key: string, windowMs: number): boolean {
  const now = Date.now()
  const previous = lastReportedAt.get(key)
  if (previous !== undefined && now - previous < windowMs) return false
  lastReportedAt.set(key, now)
  return true
}

/** @internal test hook */
export function __resetTelemetryThrottleForTest(): void {
  lastReportedAt.clear()
}

export function truncateForExtra(value: string | undefined, maxLength = 300): string {
  const trimmed = (value ?? '').trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
}

export function captureTelemetry({
  message,
  level,
  tags,
  extra,
  fingerprint,
  error,
}: TelemetryCaptureArgs): void {
  void withSentry((Sentry) => {
    if (error !== undefined) {
      Sentry.captureException(error, { level, tags, extra, fingerprint })
      return
    }
    Sentry.captureMessage(message, { level, tags, extra, fingerprint })
  })
}
