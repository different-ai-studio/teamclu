import type { RuntimeStartFailure, RuntimeStartFailureCode } from '@/lib/session/session-create'
import {
  captureTelemetry,
  shouldReportThrottled,
  truncateForExtra,
  type TelemetryLevel,
} from '@/lib/telemetry/capture'

export {
  __resetSentryModuleForTest,
  __resetTelemetryThrottleForTest as __resetRuntimeErrorReportThrottleForTest,
} from '@/lib/telemetry/capture'

/**
 * Sentry reporting for the agent-runtime startup path.
 *
 * These failures only ever surfaced as toasts, so their real-world frequency
 * was invisible — Sentry held zero events for `rpc timeout` or `runtimeStart`
 * even though the toasts fire regularly. See `capture.ts` for the grouping
 * rule every reporter here follows.
 */

type RuntimeErrorKind =
  /** A per-agent failure from the runtimeStart fanout or its gates. */
  | 'runtime_start_failure'
  /** MQTT/RPC never became ready, so runtimeStart was never attempted. */
  | 'rpc_not_ready'
  /** The ensure-runtime batch itself threw. */
  | 'ensure_runtime_crash'

/**
 * Sub-classification of a failure `reason`. `RuntimeStartFailureCode` alone
 * cannot distinguish "the daemon took too long" from "we never managed to
 * publish" — both arrive as `runtime_rpc_failed`.
 */
type RuntimeFailureReasonKind =
  | 'rpc_timeout'
  | 'local_rpc_timeout'
  | 'rpc_not_initialized'
  /** We cancelled the request ourselves. See {@link isCancelledRuntimeFailure}. */
  | 'rpc_disposed'
  | 'mqtt_publish_failed'
  | 'mqtt_disconnected'
  | 'device_offline'
  | 'cloud_network_error'
  | 'daemon_rejected'
  | 'unknown'

export type RuntimeErrorContext = {
  sessionId?: string
  teamId?: string
  agentActorId?: string
  /** Why ensure-runtime ran (send, wake, reconnect, ...). */
  trigger?: string
}

const THROTTLE_WINDOW_MS = 60_000

export function classifyRuntimeFailureReason(reason: string | undefined): RuntimeFailureReasonKind {
  const lower = (reason ?? '').trim().toLowerCase()
  if (!lower) return 'unknown'
  if (lower.includes('local rpc timeout')) return 'local_rpc_timeout'
  if (lower.includes('rpc timeout')) return 'rpc_timeout'
  if (lower.includes('rpc disposed')) return 'rpc_disposed'
  if (lower.includes('not initialized') || lower.includes('actorid required')) {
    return 'rpc_not_initialized'
  }
  if (lower.includes('mqtt disconnected') || lower.includes('mqtt not connected')) {
    return 'mqtt_disconnected'
  }
  if (lower.includes('device offline')) return 'device_offline'
  if (
    lower.includes('error sending request for url') ||
    lower.includes('token refresh timed out')
  ) {
    return 'cloud_network_error'
  }
  if (lower.includes('publish')) return 'mqtt_publish_failed'
  if (lower.includes('rejected')) return 'daemon_rejected'
  return 'unknown'
}

/**
 * A failure this client caused and recovers from on its own — not a defect, and
 * not something to put in front of the user.
 *
 * `disposeTeamcluRpc()` rejects every in-flight request with `rpc disposed`
 * whenever the MQTT wiring effect re-runs (token refresh, reconnect nonce bump,
 * team switch). A `session_runtime_retry` tick that happened to have a
 * runtimeStart in flight at that moment lands here, and the next tick just
 * re-attempts it. Before this was classified, the only lasting effects were an
 * error-level Sentry event and an error toast for something that was never
 * broken — most of TEAMCLU-REACT-7W.
 */
export function isCancelledRuntimeFailure(reason: string | undefined): boolean {
  return classifyRuntimeFailureReason(reason) === 'rpc_disposed'
}

/** A daemon → Cloud API transport failure that the runtime retry loop can recover. */
export function isTransientRuntimeNetworkFailure(reason: string | undefined): boolean {
  return classifyRuntimeFailureReason(reason) === 'cloud_network_error'
}

/**
 * Offline transports and transient Cloud API failures are expected recoverable
 * states — keep them off the error feed. Same for a request we cancelled
 * ourselves, which the `code` alone cannot express: it arrives as a plain
 * `runtime_rpc_failed`.
 */
function levelFor(
  code: RuntimeStartFailureCode | undefined,
  reasonKind: RuntimeFailureReasonKind,
): TelemetryLevel {
  if (code === 'device_offline' || code === 'transport_offline') return 'warning'
  if (reasonKind === 'rpc_disposed' || reasonKind === 'cloud_network_error') return 'warning'
  return 'error'
}

type CaptureArgs = {
  kind: RuntimeErrorKind
  code?: RuntimeStartFailureCode
  reason?: string
  error?: unknown
  context: RuntimeErrorContext
}

function capture({ kind, code, reason, error, context }: CaptureArgs): void {
  const reasonKind = classifyRuntimeFailureReason(reason)
  captureTelemetry({
    message: `${kind}: ${code ?? reasonKind}`,
    level: levelFor(code, reasonKind),
    fingerprint: ['runtime', kind, code ?? 'none', reasonKind],
    tags: {
      runtime_error_kind: kind,
      runtime_failure_code: code ?? 'none',
      runtime_failure_reason_kind: reasonKind,
    },
    extra: {
      reason: truncateForExtra(reason),
      sessionId: context.sessionId ?? null,
      teamId: context.teamId ?? null,
      agentActorId: context.agentActorId ?? null,
      trigger: context.trigger ?? null,
    },
    error,
  })
}

/**
 * Report one per-agent runtimeStart failure. Throttled per
 * (kind, code, agent) so the wake/focus/reconnect ensure loop cannot flood
 * Sentry with the same offline daemon.
 */
export function reportRuntimeStartFailure(
  failure: RuntimeStartFailure,
  context: RuntimeErrorContext = {},
): void {
  const key = `runtime_start_failure|${failure.code}|${failure.agentActorId}`
  if (!shouldReportThrottled(key, THROTTLE_WINDOW_MS)) return
  capture({
    kind: 'runtime_start_failure',
    code: failure.code,
    reason: failure.reason,
    context: { ...context, agentActorId: failure.agentActorId },
  })
}

export function reportRuntimeRpcNotReady(
  waitedMs: number,
  context: RuntimeErrorContext = {},
): void {
  const key = `rpc_not_ready|${context.sessionId ?? ''}`
  if (!shouldReportThrottled(key, THROTTLE_WINDOW_MS)) return
  capture({
    kind: 'rpc_not_ready',
    reason: `teamclu rpc not ready after ${waitedMs}ms`,
    context,
  })
}

export function reportRuntimeEnsureCrash(
  error: unknown,
  context: RuntimeErrorContext = {},
): void {
  const reason = error instanceof Error ? error.message : String(error)
  const key = [
    'ensure_runtime_crash',
    classifyRuntimeFailureReason(reason),
    context.trigger ?? '',
    context.sessionId ?? '',
  ].join('|')
  if (!shouldReportThrottled(key, THROTTLE_WINDOW_MS)) return
  capture({ kind: 'ensure_runtime_crash', reason, error, context })
}
