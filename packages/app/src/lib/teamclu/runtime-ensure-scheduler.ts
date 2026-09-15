import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  resolveSessionAttachmentEntry,
  useRuntimeStateStore,
} from '@/stores/runtime-state-store'

const RUNTIME_ENSURE_MIN_INTERVAL_MS = 3_000

/**
 * After MQTT rewiring, `byRuntimeId` is cleared and retains re-flush. Wake
 * ensures that fire in that window race an empty store, call runtimeStart, and
 * toast `rpc timeout after 20000ms` even though the remote agent was fine.
 * Wait this long for session attachments to reappear before ensuring.
 */
export const WAKE_RETAIN_REFILL_WAIT_MS = 5_000

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

function agentsStillNeedingWakeRetain(
  sessionId: string,
  agentActorIds: string[],
): string[] {
  const sid = sessionId.trim()
  if (!sid) return [...agentActorIds]
  return agentActorIds.filter(
    (agentActorId) => !agentHasLiveRuntimeForSessionBinding(agentActorId, sid),
  )
}

export type WakeRetainWaitResult = {
  status: 'ready' | 'timeout'
  /** Agents that still lack an ACTIVE+models attachment for this session. */
  stillNeeded: string[]
}

/**
 * Poll until every agent has an ACTIVE retain+models attachment for
 * `sessionId`, or until `timeoutMs`. Used by wake ensures after MQTT rewiring
 * clears `byRuntimeId`.
 */
export async function waitForWakeRuntimeRetain(args: {
  sessionId: string
  agentActorIds: string[]
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<WakeRetainWaitResult> {
  const sessionId = args.sessionId.trim()
  const agentActorIds = [
    ...new Set(args.agentActorIds.map((id) => id.trim()).filter(Boolean)),
  ]
  if (!sessionId || agentActorIds.length === 0) {
    return { status: 'ready', stillNeeded: [] }
  }

  const timeoutMs = args.timeoutMs ?? WAKE_RETAIN_REFILL_WAIT_MS
  const pollMs = args.pollMs ?? 100
  const now = args.now ?? Date.now
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs

  for (;;) {
    const stillNeeded = agentsStillNeedingWakeRetain(sessionId, agentActorIds)
    if (stillNeeded.length === 0) {
      return { status: 'ready', stillNeeded: [] }
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      return { status: 'timeout', stillNeeded }
    }
    await sleep(Math.min(pollMs, remaining))
  }
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
