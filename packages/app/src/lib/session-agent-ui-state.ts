import { AgentStatus, RuntimeLifecycle, type RuntimeInfo } from '@/lib/proto/amux_pb'

/** Conversation-area agent pill / send UX states (方案甲). */
export type SessionAgentUiState =
  | 'ready'
  | 'connecting'
  | 'offline'
  | 'stale'
  | 'runtime-error'
  /**
   * The daemon is up and answering, and it has no models to run — a fresh
   * install with no provider configured. Terminal until the user configures
   * one, so it must not be shown as `connecting` (which implies "wait") or
   * `offline` (which implies "unreachable"). Local agents only: it is derived
   * from the loopback catalog, which cannot see a remote agent.
   */
  | 'unconfigured'
  /**
   * The daemon answered and told us it could not ask the backend for its models
   * — a rejected API key, a binary that will not start. Terminal like
   * `unconfigured`, but a failure rather than a setup gap: pointing the user at
   * "configure a model" for a bad credential is what this exists to stop.
   */
  | 'catalog-error'

/**
 * What this device's loopback catalog says, for the **local agent only**.
 * Mirrors `LocalDaemonCatalogStatus`; `undefined` for remote agents, which have
 * no loopback path and must keep resolving purely from presence + retain.
 */
type LocalCatalogSnapshot = 'pending' | 'ready' | 'empty' | 'error' | 'unknown'

type MentionDeliverySnapshot = 'ready' | 'offline' | 'stale'

export type SessionAgentContext =
  | { kind: 'draft' }
  | { kind: 'session'; sessionId: string }

export type ReachabilityEvidence = {
  status: 'pending' | 'reachable' | 'unreachable' | 'indeterminate'
  startedAt: number
  observedAt: number
  requestId: number
  contextKey: string
}

export const SESSION_AGENT_CONNECTING_TIMEOUT_MS = 10_000

/**
 * Detects MQTT ghost retain for a **prior local** amuxd identity while this
 * machine's daemon already publishes a live runtime under a new id.
 *
 * Callers must gate with `wasEverLocalDaemonIdentity(agentId)` first — this is
 * not a remote-agent reachability signal.
 */
export function isDriftedLocalGhostBinding(input: {
  agentId: string
  localDaemonActorId: string | null
  presenceOnline: boolean | undefined
  agentRuntimeInfo: RuntimeInfo | undefined
  agentAvailableModelCount: number
  localRuntimeInfo: RuntimeInfo | undefined
  localAvailableModelCount: number
}): boolean {
  const localId = input.localDaemonActorId?.trim()
  const agentId = input.agentId.trim()
  if (!localId || agentId === localId) return false
  if (input.presenceOnline !== true) return false

  const agentReady =
    input.agentAvailableModelCount > 0 &&
    input.agentRuntimeInfo?.state === RuntimeLifecycle.ACTIVE
  if (agentReady) return false

  const localReady =
    input.localAvailableModelCount > 0 &&
    input.localRuntimeInfo?.state === RuntimeLifecycle.ACTIVE
  return localReady
}

export type SessionAgentSyncHint = 'degraded' | null

export function resolveSessionAgentSyncHint(input: {
  uiState: SessionAgentUiState
  isLocalAgent?: boolean
  /** Debounced daemon MQTT link for UI (from daemon-mqtt-status store). */
  daemonMqttConnected?: boolean | null
  reachability?: ReachabilityEvidence
}): SessionAgentSyncHint {
  if (input.uiState !== 'ready') return null
  if (!input.isLocalAgent) return null
  if (input.reachability?.status !== 'reachable') return null
  if (input.daemonMqttConnected !== false) return null
  return 'degraded'
}

export function resolveSessionAgentUiState(input: {
  context: SessionAgentContext
  isLocalAgent?: boolean
  presenceOnline: boolean | undefined
  presenceObservedAt?: number
  runtimeInfo: RuntimeInfo | undefined
  runtimeObservedAt?: number
  availableModelCount: number
  isStaleBinding: boolean
  connectingTimedOut: boolean
  reachability?: ReachabilityEvidence
  /** The current session is receiving a live stream from this agent. */
  activeStreamConfirmed?: boolean
  /**
   * Loopback catalog result. Set for the local agent only — passing it for a
   * remote agent would claim loopback knowledge about another machine.
   */
  localCatalog?: LocalCatalogSnapshot
}): SessionAgentUiState {
  if (input.isStaleBinding) return 'stale'

  // A live stream is direct, session-scoped evidence. It intentionally wins
  // over a delayed LWT/probe result, but never over a stale actor binding.
  if (input.activeStreamConfirmed === true) return 'ready'

  {
    const reachabilityStatus = input.reachability?.status
    const reachabilityStartedAt = input.reachability?.startedAt ?? 0
    const presenceObservedAt = input.presenceObservedAt ?? 0
    const runtimeObservedAt = input.runtimeObservedAt ?? 0

    if (input.context.kind === 'session') {
      // Local session: loopback is authoritative for send readiness. A broker
      // retain blip must not paint the pill red when this machine can still run.
      if (input.isLocalAgent) {
        if (reachabilityStatus === 'unreachable') return 'offline'

        if (reachabilityStatus === 'reachable') {
          switch (input.runtimeInfo?.state) {
            case RuntimeLifecycle.ACTIVE:
              return 'ready'
            case RuntimeLifecycle.FAILED:
            case RuntimeLifecycle.STOPPED:
              return 'runtime-error'
            case RuntimeLifecycle.STARTING:
            case RuntimeLifecycle.UNKNOWN:
            default:
              if (input.availableModelCount > 0 || input.localCatalog === 'ready') {
                return 'ready'
              }
              if (input.localCatalog === 'empty') return 'unconfigured'
              if (input.localCatalog === 'error') return 'catalog-error'
              return input.connectingTimedOut ? 'runtime-error' : 'connecting'
          }
        }

        if (
          input.presenceOnline === false &&
          input.runtimeInfo?.state === RuntimeLifecycle.ACTIVE
        ) {
          return 'ready'
        }
      }

      if (input.presenceOnline === false) return 'offline'
      if (input.isLocalAgent && reachabilityStatus === 'unreachable') return 'offline'

      const latestPositiveAt = Math.max(
        input.presenceOnline === true ? presenceObservedAt : 0,
        runtimeObservedAt,
      )
      if (
        !input.isLocalAgent &&
        reachabilityStatus === 'unreachable' &&
        reachabilityStartedAt >= latestPositiveAt
      ) {
        return 'runtime-error'
      }

      switch (input.runtimeInfo?.state) {
        case RuntimeLifecycle.ACTIVE:
          return 'ready'
        case RuntimeLifecycle.FAILED:
        case RuntimeLifecycle.STOPPED:
          return 'runtime-error'
        case RuntimeLifecycle.STARTING:
        case RuntimeLifecycle.UNKNOWN:
        default:
          return input.connectingTimedOut ? 'runtime-error' : 'connecting'
      }
    }

    if (input.isLocalAgent) {
      if (reachabilityStatus === 'unreachable' || input.presenceOnline === false) {
        return 'offline'
      }
      if (reachabilityStatus === 'reachable') {
        if (input.availableModelCount > 0 || input.localCatalog === 'ready') return 'ready'
        if (input.localCatalog === 'empty') return 'unconfigured'
        if (input.localCatalog === 'error') return 'catalog-error'
      }
      return input.connectingTimedOut ? 'offline' : 'connecting'
    }

    // A presence retain received after the probe began is newer evidence and
    // cannot be overturned by that older request's eventual result.
    if (
      input.presenceOnline === true &&
      presenceObservedAt >= reachabilityStartedAt
    ) {
      return 'ready'
    }
    if (input.presenceOnline === false) return 'offline'
    if (reachabilityStatus === 'reachable') return 'ready'
    if (reachabilityStatus === 'unreachable') {
      return input.presenceOnline === true ? 'runtime-error' : 'offline'
    }
    return input.connectingTimedOut ? 'offline' : 'connecting'
  }

}

// ────────────────────────────────────────────────────────────────────────────
// Agent pill status dot
// ────────────────────────────────────────────────────────────────────────────

type AgentPillDot = { color: string; pulse: boolean }

/** Connected = green. Starting = yellow. Error = red. Stopped/unknown = gray. */
function dotClassesForRuntimeInfo(info: RuntimeInfo | undefined): AgentPillDot {
  if (!info) return { color: 'bg-muted-foreground/40', pulse: false }
  switch (info.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', pulse: false }
    case RuntimeLifecycle.STARTING:
      return { color: 'bg-amber-400', pulse: false }
    case RuntimeLifecycle.ACTIVE:
      if (info.status === AgentStatus.ERROR) {
        return { color: 'bg-red-500', pulse: false }
      }
      return { color: 'bg-emerald-500', pulse: false }
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

function dotClassesForUiState(uiState: SessionAgentUiState): AgentPillDot {
  switch (uiState) {
    case 'ready':
      return { color: 'bg-emerald-500', pulse: false }
    case 'connecting':
      return { color: 'bg-amber-400', pulse: true }
    case 'unconfigured':
      // Amber like connecting — the daemon is up; this is a setup gap, not a
      // failure — but steady, because nothing is in progress.
      return { color: 'bg-amber-400', pulse: false }
    case 'catalog-error':
      // Red, unlike unconfigured's amber: something is broken, not merely unset.
      return { color: 'bg-red-500', pulse: false }
    case 'runtime-error':
      return { color: 'bg-red-500', pulse: false }
    case 'stale':
      return { color: 'bg-red-500', pulse: false }
    case 'offline':
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

/**
 * THE dot resolver for the agent pill.
 *
 * When a retain exists it is the finer-grained answer (STARTING vs ACTIVE vs
 * FAILED vs ERROR), so it wins. When it does NOT exist, the dot must fall back
 * to `uiState` rather than reporting gray.
 *
 * That fallback is not a nicety — it is the whole point. A **remote** agent
 * only reaches `ready` via the `RuntimeLifecycle.ACTIVE` branch of
 * `resolveSessionAgentUiState`, so a missing retain and `ready` are mutually
 * exclusive for it. The **local** agent has the loopback fast path, which
 * returns `ready` off the catalog alone with no retain in sight — reading the
 * absent retain there painted a gray dot on a pill that was simultaneously
 * showing a model name, no status suffix, and a live model picker.
 */
export function resolveAgentPillDot(
  uiState: SessionAgentUiState,
  runtimeInfo: RuntimeInfo | undefined,
): AgentPillDot {
  if (uiState === 'ready' && runtimeInfo) return dotClassesForRuntimeInfo(runtimeInfo)
  return dotClassesForUiState(uiState)
}

export function toMentionDeliverySnapshot(
  uiState: SessionAgentUiState,
): MentionDeliverySnapshot | null {
  if (uiState === 'ready') return 'ready'
  if (uiState === 'stale') return 'stale'
  // Connecting means the session binding has not landed yet — the send path
  // will spawn/wake. Do not freeze that as "offline" in message metadata.
  if (uiState === 'connecting') return null
  // `unconfigured` is reachable but cannot run a prompt — for delivery purposes
  // that is indistinguishable from offline.
  if (uiState === 'offline' || uiState === 'unconfigured') {
    return 'offline'
  }
  return null
}
