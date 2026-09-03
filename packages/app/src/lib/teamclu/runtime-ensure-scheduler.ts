import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  resolveSessionAttachmentEntry,
  useRuntimeStateStore,
} from '@/stores/runtime-state-store'

const RUNTIME_ENSURE_MIN_INTERVAL_MS = 3_000

/**
 * Wake/recover paths — skip when THIS SESSION's bound spawn is already live.
 * Bind paths (session_create / outbox_send / mention_pill) always proceed.
 * offline_banner_retry is excluded: user asked to retry despite retain ghosts.
 */
const RUNTIME_ENSURE_WAKE_REASONS = new Set([
  'session_focus',
  'session_runtime_wake',
  'session_runtime_retry',
  'mqtt_reconnect_ensure',
  'session_auto_engage',
])

const lastEnsureRef: { key: string; at: number } = { key: '', at: 0 }

export function runtimeEnsureKey(sessionId: string, agentActorIds: string[]): string {
  return `${sessionId}::${agentActorIds.slice().sort().join(',')}`
}

export function isRuntimeEnsureWakeReason(reason: string): boolean {
  return RUNTIME_ENSURE_WAKE_REASONS.has(reason)
}

/**
 * True when the session-registered spawn for this agent is ACTIVE with models.
 * Looks up retain by the session binding id only — never falls through to
 * "any live retain for the agent" (that caused Connecting stuck on stale
 * session rows while another session still had a live spawn).
 */
export function agentHasLiveRuntimeForSessionBinding(
  agentActorId: string,
  sessionRuntimeId: string | null | undefined,
): boolean {
  const agentId = agentActorId.trim()
  const bindingId = sessionRuntimeId?.trim() ?? ''
  if (!agentId || !bindingId) return false

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId
  const entry = resolveSessionAttachmentEntry(agentId, bindingId, byRuntimeId)
  if (!entry) return false
  return (
    entry.info.state === RuntimeLifecycle.ACTIVE &&
    entry.info.availableModels.length > 0
  )
}

function runtimeIdFromSessionMap(
  agentActorId: string,
  sessionRuntimeByAgent?: ReadonlyMap<string, string> | null,
): string | undefined {
  if (!sessionRuntimeByAgent) return undefined
  return sessionRuntimeByAgent.get(agentActorId)?.trim() || undefined
}

/**
 * True when every agent already has an ACTIVE retain+models for THIS session's
 * binding. When `sessionRuntimeByAgent` is omitted, returns false so wake
 * paths never skip on a global-live guess (callers should pass the map).
 */
export function agentsHaveLiveRuntimeModels(
  agentActorIds: string[],
  sessionRuntimeByAgent?: ReadonlyMap<string, string> | null,
): boolean {
  if (agentActorIds.length === 0) return false
  if (!sessionRuntimeByAgent) return false
  return agentActorIds.every((agentActorId) =>
    agentHasLiveRuntimeForSessionBinding(
      agentActorId,
      runtimeIdFromSessionMap(agentActorId, sessionRuntimeByAgent),
    ),
  )
}

/**
 * Skip redundant runtimeStart on focus/reconnect/retry when THIS session's
 * bound spawn is already live. Never skip create/send paths. Never skip
 * without a session binding map — global live retain is not enough.
 */
export function shouldSkipAlreadyReadyRuntimeEnsure(
  agentActorIds: string[],
  reason: string,
  sessionRuntimeByAgent?: ReadonlyMap<string, string> | null,
): boolean {
  if (!isRuntimeEnsureWakeReason(reason)) return false
  return agentsHaveLiveRuntimeModels(agentActorIds, sessionRuntimeByAgent)
}

/** Returns true when a recent runtime-start attempt for the same session+agents should be skipped. */
export function shouldSkipThrottledRuntimeEnsure(sessionId: string, agentActorIds: string[]): boolean {
  const key = runtimeEnsureKey(sessionId, agentActorIds)
  const now = Date.now()
  return lastEnsureRef.key === key && now - lastEnsureRef.at < RUNTIME_ENSURE_MIN_INTERVAL_MS
}

/** Record a runtime-start attempt (call only when startAgentRuntimesAsync is about to run). */
export function recordRuntimeEnsureAttempt(sessionId: string, agentActorIds: string[]): void {
  lastEnsureRef.key = runtimeEnsureKey(sessionId, agentActorIds)
  lastEnsureRef.at = Date.now()
}

export function resetRuntimeEnsureThrottle(): void {
  lastEnsureRef.key = ''
  lastEnsureRef.at = 0
}

/** @internal test helper */
export function resetRuntimeEnsureThrottleForTests(): void {
  resetRuntimeEnsureThrottle()
}
