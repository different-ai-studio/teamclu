import * as React from 'react'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { ensureAgentRuntimesForSession } from '@/lib/teamclu/ensure-agent-runtime'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import {
  agentHasLiveRuntimeForSessionBinding,
  shouldSkipAlreadyReadyRuntimeEnsure,
  shouldSkipThrottledRuntimeEnsure,
  resetRuntimeEnsureThrottle,
} from '@/lib/teamclu/runtime-ensure-scheduler'
import { useActorPresenceStore } from '@/stores/actor-presence-store'

function isDeviceOfflineForWake(agentId: string): boolean {
  return resolveAgentDevicePresenceSync(agentId) === 'offline'
}

function sessionBindingLive(
  agentId: string,
  sessionRuntimeByAgent?: ReadonlyMap<string, string> | null,
): boolean {
  return agentHasLiveRuntimeForSessionBinding(
    agentId,
    sessionRuntimeByAgent?.get(agentId),
  )
}

/** Agents that may recover via runtimeStart (excludes stale, ready, session-live, hard-offline). */
export function agentIdsNeedingRecoverableRuntimeWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  _presenceByActor?: Record<string, { online: boolean } | undefined>,
  sessionRuntimeByAgent?: ReadonlyMap<string, string> | null,
): string[] {
  return entries
    .filter((e) => {
      if (e.uiState === 'stale' || e.uiState === 'ready') return false
      // Same ruler as the pill: only skip when THIS session's binding is live.
      if (sessionBindingLive(e.agent.id, sessionRuntimeByAgent)) return false
      if (e.uiState === 'connecting') return true
      if (e.uiState === 'runtime-error') return true
      if (e.uiState === 'offline') {
        // Shared merge: LWT-offline remote stays out; local stale LWT may still wake.
        return !isDeviceOfflineForWake(e.agent.id)
      }
      return false
    })
    .map((e) => e.agent.id)
}

/** Same-session signature wakes: only connecting (offline recovers on focus / retry). */
function agentIdsNeedingConnectingWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  sessionRuntimeByAgent?: ReadonlyMap<string, string> | null,
): string[] {
  return entries
    .filter((e) => {
      if (e.uiState !== 'connecting') return false
      // Plan 2: Connecting must still wake unless THIS session binding is live.
      if (sessionBindingLive(e.agent.id, sessionRuntimeByAgent)) return false
      return true
    })
    .map((e) => e.agent.id)
}

export function hasConnectingEngagedAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
): boolean {
  return entries.some((e) => e.uiState === 'connecting')
}

/** Offline pills that may recover (transport glitch), excluding hard-offline agents. */
function hasRecoverableOfflineEngagedAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  _presenceByActor?: Record<string, { online: boolean } | undefined>,
): boolean {
  return entries.some((e) => {
    if (e.uiState !== 'offline') return false
    return !isDeviceOfflineForWake(e.agent.id)
  })
}

export function hasRecoverableNonReadyAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  presenceByActor?: Record<string, { online: boolean } | undefined>,
): boolean {
  return (
    hasConnectingEngagedAgent(entries) ||
    entries.some((e) => e.uiState === 'runtime-error') ||
    hasRecoverableOfflineEngagedAgent(entries, presenceByActor)
  )
}

const STALE_RUNTIME_RETRY_MS = 15_000

export function useEnsureEngagedRuntimesOnSessionFocus(args: {
  sessionId: string | null
  teamId: string | null
  engagedUiEntries: ReadonlyArray<EngagedAgentUiEntry>
  /** Session-scoped agent → runtime_id from agent_runtimes / runtime-targets. */
  agentToRuntimeId?: ReadonlyMap<string, string>
}): void {
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const prevSessionIdRef = React.useRef<string | null>(null)
  const engagedUiEntriesRef = React.useRef(args.engagedUiEntries)
  engagedUiEntriesRef.current = args.engagedUiEntries
  const agentToRuntimeIdRef = React.useRef(args.agentToRuntimeId)
  agentToRuntimeIdRef.current = args.agentToRuntimeId

  const engagedSignature = React.useMemo(
    () =>
      args.engagedUiEntries
        .map((e) => `${e.agent.id}:${e.uiState}`)
        .sort()
        .join('|'),
    [args.engagedUiEntries],
  )

  const runtimeMapSignature = React.useMemo(() => {
    if (!args.agentToRuntimeId || args.agentToRuntimeId.size === 0) return ''
    return [...args.agentToRuntimeId.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agentId, runtimeId]) => `${agentId}:${runtimeId}`)
      .join('|')
  }, [args.agentToRuntimeId])

  const presenceSignature = React.useMemo(
    () =>
      args.engagedUiEntries
        .map((a) => `${a.agent.id}:${presenceByActor[a.agent.id]?.online ?? 'u'}`)
        .sort()
        .join('|'),
    [args.engagedUiEntries, presenceByActor],
  )

  const tryEnsure = React.useCallback(
    (reason: string, agentActorIds: string[]) => {
      const sessionId = args.sessionId?.trim() || null
      const teamId = args.teamId?.trim() || null
      if (!sessionId || !teamId) return
      if (agentActorIds.length === 0) return
      const sessionRuntimeByAgent = agentToRuntimeIdRef.current ?? null
      if (shouldSkipAlreadyReadyRuntimeEnsure(agentActorIds, reason, sessionRuntimeByAgent)) {
        return
      }
      if (shouldSkipThrottledRuntimeEnsure(sessionId, agentActorIds)) return

      void ensureAgentRuntimesForSession({
        sessionId,
        teamId,
        agentActorIds,
        reason,
        sessionRuntimeByAgent: sessionRuntimeByAgent ?? undefined,
      })
    },
    [args.sessionId, args.teamId],
  )

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const focusChanged = prevSessionIdRef.current !== sessionId
    if (focusChanged) {
      resetRuntimeEnsureThrottle()
    }
    prevSessionIdRef.current = sessionId

    if (!sessionId || !args.teamId?.trim()) return

    const entries = engagedUiEntriesRef.current
    const runtimeMap = agentToRuntimeIdRef.current ?? null
    if (focusChanged) {
      tryEnsure(
        'session_focus',
        agentIdsNeedingRecoverableRuntimeWake(entries, presenceByActor, runtimeMap),
      )
      return
    }
    // Same session: wake connecting agents (session-scoped live check).
    tryEnsure('session_runtime_wake', agentIdsNeedingConnectingWake(entries, runtimeMap))
  }, [
    args.sessionId,
    args.teamId,
    engagedSignature,
    runtimeMapSignature,
    tryEnsure,
    presenceByActor,
  ])

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const teamId = args.teamId?.trim() || null
    if (!sessionId || !teamId) return
    if (!hasRecoverableNonReadyAgent(args.engagedUiEntries, presenceByActor)) return

    const timer = window.setInterval(() => {
      tryEnsure(
        'session_runtime_retry',
        agentIdsNeedingRecoverableRuntimeWake(
          engagedUiEntriesRef.current,
          presenceByActor,
          agentToRuntimeIdRef.current ?? null,
        ),
      )
    }, STALE_RUNTIME_RETRY_MS)

    return () => window.clearInterval(timer)
  }, [
    args.sessionId,
    args.teamId,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    tryEnsure,
    args.engagedUiEntries,
    presenceByActor,
  ])
}
