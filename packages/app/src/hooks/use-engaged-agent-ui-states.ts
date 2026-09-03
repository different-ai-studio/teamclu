import * as React from 'react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import { resolveAgentAvailableModels } from '@/lib/agent-available-models'
import { resolveAgentCatalogModels } from '@/lib/agent-model-fallback'
import {
  probeAgentReachability,
} from '@/lib/agent-reachability-probe'
import { mergeAgentDevicePresence } from '@/lib/agent-device-reachability'
import { resolveRuntimeStateEntryForAgent } from '@/lib/runtime-state-resolve'
import {
  SESSION_AGENT_CONNECTING_TIMEOUT_MS,
  resolveSessionAgentSyncHint,
  resolveSessionAgentUiState,
  type ReachabilityEvidence,
  type SessionAgentContext,
  type SessionAgentSyncHint,
  type SessionAgentUiState,
} from '@/lib/session-agent-ui-state'
import {
  getKnownLocalDaemonActorId,
  isSupersededLocalAgent,
  noteLocalDaemonActorId,
} from '@/lib/local-daemon-identity'
import { resolveEngagedAgentStaleBinding } from '@/lib/session-agent-stale-binding'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import {
  resolveSessionAttachmentEntry,
  useRuntimeStateStore,
  type ActorDefaultCatalogEntry,
  type RuntimeStateEntry,
} from '@/stores/runtime-state-store'
import {
  ensureLocalDaemonCatalog,
  useLocalDaemonCatalogStore,
  type LocalDaemonCatalogEntry,
} from '@/stores/local-daemon-catalog-store'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getLocalDaemonActorId } from '@/lib/daemon-agent-admin'
import {
  AGENT_REACHABILITY_PROBE_RETRY_MS,
  AGENT_REACHABILITY_INDETERMINATE_RETRY_MS,
  AGENT_REACHABILITY_REACHABLE_TTL_MS,
  LOCAL_AGENT_READY_PROBE_INTERVAL_MS,
  LOCAL_CATALOG_POLL_INTERVAL_MS,
} from '@/lib/session-agent-probe'
import { useDaemonMqttConnected } from '@/stores/daemon-mqtt-status'

export type EngagedAgentUiEntry = {
  agent: AttachedAgent
  uiState: SessionAgentUiState
  syncHint: SessionAgentSyncHint
}

/**
 * Pill UI must not hop to another session's live retain. Without a session
 * binding (or before that spawn's retain exists), show connecting — otherwise
 * quick-create flashes ready → connecting → ready while runtimeStart seeds.
 */
function resolveUiSessionRuntimeEntry(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  dbRuntimeId: string | null | undefined,
): RuntimeStateEntry | undefined {
  const trimmedAgent = agentId.trim()
  const dbId = dbRuntimeId?.trim() ?? ''
  if (!trimmedAgent || !dbId) return undefined

  const attached = resolveSessionAttachmentEntry(trimmedAgent, dbId, byRuntimeId)
  return attached
}

/**
 * Any ACTIVE attachment this actor holds, with a model catalog.
 */
function resolveActorLiveRuntimeEntry(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry | undefined {
  let best: RuntimeStateEntry | undefined
  for (const entry of Object.values(byRuntimeId)) {
    if (entry.daemonActorId !== agentId) continue
    if (entry.info.state !== RuntimeLifecycle.ACTIVE) continue
    if (resolveAgentAvailableModels(entry.info).length === 0) continue
    if (!best || entry.lastUpdated > best.lastUpdated) best = entry
  }
  return best
}

/**
 * Runtime entry driving the pill for this session.
 *
 * A session binding wins outright. Without one — a draft chat, or a session
 * this daemon has not attached yet — a **remote** agent falls back to its own
 * actor-level state: "that machine is online and has models" is a device fact,
 * not a session one, and withholding it pinned the pill at Connecting until the
 * first send attached a runtime. Local agents keep the loopback path instead.
 */
function resolveProvisionalRuntimeEntry(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  context: SessionAgentContext,
): RuntimeStateEntry | undefined {
  const agentId = agent.id.trim()
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const sessionBound = resolveUiSessionRuntimeEntry(agent.id, byRuntimeId, dbRuntimeId)
  if (sessionBound) return sessionBound

  if (dbRuntimeId?.trim() || context.kind === 'session') return undefined
  const localId = getKnownLocalDaemonActorId()
  if (localId && agentId === localId) return undefined

  return resolveActorLiveRuntimeEntry(agentId, byRuntimeId)
}

function resolveStaleBinding(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean; lastUpdated?: number } | undefined>,
): boolean {
  const localId = getKnownLocalDaemonActorId()
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  // Stale detection may use global hop — superseded local ghost vs new local.
  const agentEntry = resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId)
  const localEntry = localId
    ? resolveRuntimeStateEntryForAgent(localId, byRuntimeId)
    : undefined
  return resolveEngagedAgentStaleBinding({
    agentId: agent.id,
    localDaemonActorId: localId,
    presenceOnline: presenceByActor[agent.id]?.online,
    agentRuntimeInfo: agentEntry?.info,
    agentAvailableModelCount: resolveAgentAvailableModels(agentEntry?.info).length,
    localRuntimeInfo: localEntry?.info,
    localAvailableModelCount: resolveAgentAvailableModels(localEntry?.info).length,
  })
}

function computeProvisionalState(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean; lastUpdated?: number } | undefined>,
  connectingSinceByAgent: Record<string, number>,
  reachabilityByAgent: Record<string, ReachabilityEvidence>,
  activeStreamingAgentIds: ReadonlySet<string>,
  localCatalog: LocalDaemonCatalogEntry | undefined,
  defaultCatalogByActorId: Record<string, ActorDefaultCatalogEntry>,
  context: SessionAgentContext,
  contextKey: string,
  now: number,
): SessionAgentUiState {
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const entry = resolveProvisionalRuntimeEntry(agent, agentToRuntimeId, byRuntimeId, context)
  const runtimeInfo = entry?.info
  const localId = getKnownLocalDaemonActorId()
  const isLocalAgent = !!localId && agent.id === localId
  const availableModelCount = resolveAgentCatalogModels({
    agentId: agent.id,
    localDaemonActorId: localId,
    sessionId: dbRuntimeId,
    byRuntimeId,
    runtimeInfo,
    localWorkspaceCatalogModels: localCatalog?.models,
    remoteDefaultCatalogModels: defaultCatalogByActorId[agent.id]?.models,
  }).length
  const since = connectingSinceByAgent[agent.id]
  const connectingTimedOut =
    since !== undefined && now - since >= SESSION_AGENT_CONNECTING_TIMEOUT_MS
  const reachability = reachabilityByAgent[agent.id]
  const currentReachability =
    reachability?.contextKey === `${contextKey}:${agent.id}` ? reachability : undefined
  const mqttOnline = presenceByActor[agent.id]?.online
  const devicePresence = mergeAgentDevicePresence({
    mqttOnline,
    isLocalDaemon: isLocalAgent,
    localHttpOk:
      isLocalAgent && currentReachability?.status === 'reachable'
        ? true
        : isLocalAgent && currentReachability?.status === 'unreachable'
          ? false
          : null,
  })
  const presenceOnline =
    devicePresence === 'online' ? true : devicePresence === 'offline' ? false : undefined

  // Loopback knowledge is about THIS machine — attaching it to a remote agent
  // would let one device's catalog decide another device's readiness.
  const localCatalogSnapshot = isLocalAgent ? localCatalog?.status : undefined

  return resolveSessionAgentUiState({
    context,
    isLocalAgent,
    presenceOnline,
    presenceObservedAt: presenceByActor[agent.id]?.lastUpdated,
    runtimeInfo,
    runtimeObservedAt: entry?.lastUpdated,
    availableModelCount,
    isStaleBinding: resolveStaleBinding(agent, agentToRuntimeId, byRuntimeId, presenceByActor),
    connectingTimedOut,
    reachability: currentReachability,
    activeStreamConfirmed: activeStreamingAgentIds.has(agent.id),
    localCatalog: localCatalogSnapshot,
  })
}

function computeSyncHint(
  agent: AttachedAgent,
  uiState: SessionAgentUiState,
  reachabilityByAgent: Record<string, ReachabilityEvidence>,
  contextKey: string,
  daemonMqttConnected: boolean | null,
): SessionAgentSyncHint {
  const localId = getKnownLocalDaemonActorId()
  const isLocalAgent = !!localId && agent.id === localId
  const reachability = reachabilityByAgent[agent.id]
  const currentReachability =
    reachability?.contextKey === `${contextKey}:${agent.id}` ? reachability : undefined

  return resolveSessionAgentSyncHint({
    uiState,
    isLocalAgent,
    daemonMqttConnected,
    reachability: currentReachability,
  })
}

function latestPositiveEvidenceAt(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean; lastUpdated?: number } | undefined>,
  reachabilityByAgent: Record<string, ReachabilityEvidence>,
  context: SessionAgentContext,
  contextKey: string,
): number {
  const entry = resolveProvisionalRuntimeEntry(agent, agentToRuntimeId, byRuntimeId, context)
  const presence = presenceByActor[agent.id]
  const reachability = reachabilityByAgent[agent.id]
  return Math.max(
    presence?.online === true ? presence.lastUpdated ?? 0 : 0,
    entry?.lastUpdated ?? 0,
    reachability?.contextKey === `${contextKey}:${agent.id}` &&
      reachability.status === 'reachable'
      ? reachability.observedAt
      : 0,
  )
}

function shouldProbeAgent(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean; lastUpdated?: number } | undefined>,
  connectingSinceByAgent: Record<string, number>,
  reachabilityByAgent: Record<string, ReachabilityEvidence>,
  lastProbeAtByAgent: Record<string, number>,
  localDaemonActorId: string | null,
  activeStreamingAgentIds: ReadonlySet<string>,
  localCatalog: LocalDaemonCatalogEntry | undefined,
  defaultCatalogByActorId: Record<string, ActorDefaultCatalogEntry>,
  context: SessionAgentContext,
  contextKey: string,
  now: number,
): boolean {
  if (isSupersededLocalAgent(agent.id)) return false

  const state = computeProvisionalState(
    agent,
    agentToRuntimeId,
    byRuntimeId,
    presenceByActor,
    connectingSinceByAgent,
    reachabilityByAgent,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
    context,
    contextKey,
    now,
  )
  if (state === 'stale') return false

  const localId = localDaemonActorId?.trim() || null
  const isLocalAgent = !!localId && agent.id === localId

  if (state === 'ready') {
    if (!isLocalAgent) {
      if (presenceByActor[agent.id]?.online === true) return false
      const evidence = reachabilityByAgent[agent.id]
      return Boolean(
        evidence?.contextKey === `${contextKey}:${agent.id}` &&
        evidence.status === 'reachable' &&
        now - evidence.observedAt >= AGENT_REACHABILITY_REACHABLE_TTL_MS
      )
    }
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    return now - lastProbeAt >= LOCAL_AGENT_READY_PROBE_INTERVAL_MS
  }

  const reachability = reachabilityByAgent[agent.id]
  if (reachability?.contextKey === `${contextKey}:${agent.id}`) {
    if (reachability.status === 'pending') return false
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    if (reachability.status === 'reachable') {
      if (!isLocalAgent && presenceByActor[agent.id]?.online === true) return false
      return now - reachability.observedAt >= AGENT_REACHABILITY_REACHABLE_TTL_MS
    }
    if (reachability.status === 'unreachable') {
      return now - lastProbeAt >= AGENT_REACHABILITY_PROBE_RETRY_MS
    }
    if (reachability.status === 'indeterminate') {
      return now - lastProbeAt >= AGENT_REACHABILITY_INDETERMINATE_RETRY_MS
    }
  }

  if (state === 'connecting') return true
  if (state === 'offline' && isLocalAgent) {
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    return now - lastProbeAt >= AGENT_REACHABILITY_PROBE_RETRY_MS
  }
  if (state === 'offline' && presenceByActor[agent.id]?.online === true) return true
  if (
    state === 'offline' &&
    context.kind === 'draft' &&
    presenceByActor[agent.id]?.online === undefined
  ) return true
  return false
}

export function useEngagedAgentUiStates(
  engagedAgents: AttachedAgent[],
  agentToRuntimeId: Map<string, string>,
  activeStreamingAgentIds: ReadonlySet<string>,
  context: SessionAgentContext,
): EngagedAgentUiEntry[] {
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const defaultCatalogByActorId = useRuntimeStateStore((s) => s.defaultCatalogByActorId)
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)?.trim() || ''
  const localCatalog = useLocalDaemonCatalogStore((s) =>
    workspacePath ? s.byWorkspacePath[workspacePath] : undefined,
  )
  const [connectingSinceByAgent, setConnectingSinceByAgent] = React.useState<
    Record<string, number>
  >({})
  const [reachabilityByAgent, setReachabilityByAgent] = React.useState<
    Record<string, ReachabilityEvidence>
  >({})
  const requestIdRef = React.useRef(0)
  const teamId = useCurrentTeamStore((s) => s.team?.id)?.trim() || ''
  const contextKey = `${teamId}:${context.kind}:${context.kind === 'session' ? context.sessionId : 'draft'}`
  const daemonMqttConnected = useDaemonMqttConnected(!!getKnownLocalDaemonActorId())
  const stableContext = React.useMemo<SessionAgentContext>(
    () => context.kind === 'session'
      ? { kind: 'session', sessionId: context.sessionId }
      : { kind: 'draft' },
    [contextKey],
  )
  const lastProbeAtByAgentRef = React.useRef<Record<string, number>>({})
  const engagedAgentsRef = React.useRef(engagedAgents)
  engagedAgentsRef.current = engagedAgents
  // The only wall-clock input to the derived states is the connecting timeout
  // (`connectingSince + SESSION_AGENT_CONNECTING_TIMEOUT_MS`). This counter
  // advances exactly when the earliest pending deadline passes, so the host
  // (ChatPanel / SessionChatColumn) re-renders when a pill can actually flip —
  // not at 1 Hz for as long as the chat is open.
  const [connectingClock, advanceConnectingClock] = React.useReducer((x: number) => x + 1, 0)

  React.useEffect(() => {
    setConnectingSinceByAgent({})
    setReachabilityByAgent({})
    lastProbeAtByAgentRef.current = {}
    requestIdRef.current += 1
  }, [contextKey])

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      const id = await getLocalDaemonActorId()
      if (cancelled) return
      noteLocalDaemonActorId(id)
    }
    void load()
    const interval = setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [teamId])

  React.useEffect(() => {
    const now = Date.now()
    let nextDeadline = Infinity
    for (const agent of engagedAgents) {
      const since = connectingSinceByAgent[agent.id]
      if (since === undefined) continue
      const deadline = since + SESSION_AGENT_CONNECTING_TIMEOUT_MS
      if (deadline > now && deadline < nextDeadline) nextDeadline = deadline
    }
    if (nextDeadline === Infinity) return
    // If the timer lands a hair early the state does not flip yet; the bump
    // re-runs this effect, which re-arms for the remainder.
    const timer = setTimeout(advanceConnectingClock, nextDeadline - now)
    return () => clearTimeout(timer)
  }, [engagedAgents, connectingSinceByAgent, connectingClock])

  // Keep this device's loopback catalog warm.
  //
  // Deliberately NOT gated on the local agent being engaged yet: on a cold
  // start the pill renders before anything is mentioned, and waiting for
  // engagement would put the catalog fetch behind the very render it is meant
  // to unblock — the 连接中 flash this fast path exists to remove. It is one
  // loopback request for the whole device, and the store rate-limits a settled
  // answer to one refresh per 5 minutes, so the standing cost is negligible.
  // Still local-only: this reaches this machine's daemon and no other.
  React.useEffect(() => {
    if (!workspacePath) return
    const run = () => {
      // No local daemon identity has ever been observed on this device — there
      // is nothing on loopback to ask.
      if (!getKnownLocalDaemonActorId()) return
      ensureLocalDaemonCatalog(workspacePath)
    }
    run()
    const interval = setInterval(run, LOCAL_CATALOG_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [workspacePath])

  const engagedSignature = React.useMemo(
    () =>
      engagedAgents
        .map((a) => a.id)
        .sort()
        .join(','),
    [engagedAgents],
  )
  const runtimeMapSignature = React.useMemo(
    () =>
      [...agentToRuntimeId.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([agentId, runtimeId]) => `${agentId}:${runtimeId}`)
        .join('|'),
    [agentToRuntimeId],
  )
  const activeStreamingSignature = React.useMemo(
    () => [...activeStreamingAgentIds].sort().join(','),
    [activeStreamingAgentIds],
  )

  const presenceSignature = React.useMemo(
    () =>
      engagedAgents
        .map((a) => `${a.id}:${presenceByActor[a.id]?.online ?? 'u'}`)
        .sort()
        .join('|'),
    [engagedAgents, presenceByActor],
  )

  React.useEffect(() => {
    const now = Date.now()
    const activeIds = new Set(engagedAgents.map((a) => a.id))
    setConnectingSinceByAgent((prev) => {
      const next: Record<string, number> = {}
      let changed = false

      for (const agent of engagedAgents) {
        const provisional = computeProvisionalState(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          prev,
          reachabilityByAgent,
          activeStreamingAgentIds,
          localCatalog,
          defaultCatalogByActorId,
          stableContext,
          contextKey,
          now,
        )
        const previousSince = prev[agent.id]
        if (
          previousSince !== undefined &&
          (provisional === 'connecting' ||
            provisional === 'offline' ||
            provisional === 'runtime-error')
        ) {
          const positiveAt = latestPositiveEvidenceAt(
            agent,
            agentToRuntimeId,
            byRuntimeId,
            presenceByActor,
            reachabilityByAgent,
            stableContext,
            contextKey,
          )
          next[agent.id] = positiveAt > previousSince + SESSION_AGENT_CONNECTING_TIMEOUT_MS
            ? now
            : previousSince
          if (prev[agent.id] !== next[agent.id]) changed = true
        } else if (provisional === 'connecting') {
          next[agent.id] = now
          changed = true
        }
      }

      for (const id of Object.keys(prev)) {
        if (!activeIds.has(id)) changed = true
      }

      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        let same = true
        for (const [id, since] of Object.entries(next)) {
          if (prev[id] !== since) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })

    setReachabilityByAgent((prev) => {
      const next: Record<string, ReachabilityEvidence> = {}
      let changed = false
      for (const agent of engagedAgents) {
        if (prev[agent.id]?.contextKey === `${contextKey}:${agent.id}`) {
          next[agent.id] = prev[agent.id]
        }
      }
      for (const id of Object.keys(prev)) {
        if (!activeIds.has(id)) changed = true
      }
      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        let same = true
        for (const [id, value] of Object.entries(next)) {
          if (prev[id] !== value) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    activeStreamingSignature,
    byRuntimeId,
    agentToRuntimeId,
    reachabilityByAgent,
    connectingSinceByAgent,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
    stableContext,
    contextKey,
  ])

  // One sweep decides, per engaged agent, whether a reachability probe is due
  // now. It runs when its inputs change and on a fixed cadence for the
  // time-based retries (TTL expiry, indeterminate retry). The cadence goes
  // through a ref so a sweep that finds nothing due costs no render: the only
  // state it touches is `reachabilityByAgent`, and only when a probe starts.
  const sweepProbes = () => {
    const now = Date.now()
    const localDaemonActorId = getKnownLocalDaemonActorId()

    for (const agent of engagedAgents) {
      if (
        !shouldProbeAgent(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          connectingSinceByAgent,
          reachabilityByAgent,
          lastProbeAtByAgentRef.current,
          localDaemonActorId,
          activeStreamingAgentIds,
          localCatalog,
          defaultCatalogByActorId,
          stableContext,
          contextKey,
          now,
        )
      ) {
        continue
      }

      const agentId = agent.id
      const requestId = ++requestIdRef.current
      const startedAt = now
      const evidenceContextKey = `${contextKey}:${agentId}`
      setReachabilityByAgent((prev) => {
        if (prev[agentId]?.status === 'pending' && prev[agentId]?.contextKey === evidenceContextKey) return prev
        return {
          ...prev,
          [agentId]: {
            status: 'pending',
            startedAt,
            observedAt: startedAt,
            requestId,
            contextKey: evidenceContextKey,
          },
        }
      })
      lastProbeAtByAgentRef.current[agentId] = now

      void probeAgentReachability({
        agentActorId: agentId,
        localDaemonActorId,
      }).then((result) => {
        if (!engagedAgentsRef.current.some((row) => row.id === agentId)) return
        setReachabilityByAgent((prev) => {
          const current = prev[agentId]
          if (current?.requestId !== requestId || current.contextKey !== evidenceContextKey) {
            return prev
          }
          return {
            ...prev,
            [agentId]: {
              ...current,
              status: result,
              observedAt: Date.now(),
            },
          }
        })
      })
    }
  }
  const sweepProbesRef = React.useRef(sweepProbes)
  sweepProbesRef.current = sweepProbes

  React.useEffect(() => {
    sweepProbesRef.current()
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    byRuntimeId,
    agentToRuntimeId,
    connectingSinceByAgent,
    reachabilityByAgent,
    activeStreamingSignature,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
    stableContext,
    contextKey,
  ])

  React.useEffect(() => {
    const interval = setInterval(
      () => sweepProbesRef.current(),
      AGENT_REACHABILITY_INDETERMINATE_RETRY_MS,
    )
    return () => clearInterval(interval)
  }, [])

  return React.useMemo(() => {
    const now = Date.now()
    return engagedAgents.map((agent) => {
      const uiState = computeProvisionalState(
        agent,
        agentToRuntimeId,
        byRuntimeId,
        presenceByActor,
        connectingSinceByAgent,
        reachabilityByAgent,
        activeStreamingAgentIds,
        localCatalog,
        defaultCatalogByActorId,
        stableContext,
        contextKey,
        now,
      )
      return {
        agent,
        uiState,
        syncHint: computeSyncHint(
          agent,
          uiState,
          reachabilityByAgent,
          contextKey,
          daemonMqttConnected,
        ),
      }
    })
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    activeStreamingSignature,
    connectingSinceByAgent,
    reachabilityByAgent,
    byRuntimeId,
    agentToRuntimeId,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
    stableContext,
    contextKey,
    connectingClock,
    daemonMqttConnected,
  ])
}

/** True when any engaged agent is not ready (offline, connecting, or stale). */
export function hasAnyNonReadyEngaged(entries: EngagedAgentUiEntry[]): boolean {
  return entries.some((e) => e.uiState !== 'ready')
}
