import { create as createZustand } from 'zustand'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  ActorPresenceSchema,
  RuntimeInfoSchema,
  type ActorPresence,
  type ModelInfo,
  type RuntimeInfo,
} from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt/mqtt-bridge'
import { sessionFlowLog } from '@/lib/session/session-flow-log'
import { createSharedModuleLeaseManager, type SharedModuleLease } from '@/lib/shared-module-lease'

/**
 * In-memory projection of daemon attachment state from MQTT.
 *
 * The only MQTT source is `amux/{team}/{actor}/state` (ActorPresence). Each
 * attached session is keyed `{daemonActorId}::{sessionId}` — never a per-spawn
 * id. Local RPC seeds (`seedRuntimeStateAfterStart`) may write the same key
 * before the retain arrives.
 *
 * `defaultCatalogByActorId` mirrors `ActorPresence.default_workspace_*` for
 * remote-agent draft pickers — no session attachment required.
 *
 * This store is intentionally STATELESS about user picks. It only mirrors what
 * the daemon publishes. The agent-model-pick-store is the source of truth for
 * user-selected models; `selectAgentModel` (runtime-state-resolve) reconciles.
 */

export type RuntimeStateEntry = {
  info: RuntimeInfo
  daemonActorId: string
  lastUpdated: number // ms epoch
}

export type ActorDefaultCatalogEntry = {
  defaultWorkspaceId: string
  defaultWorktree: string
  models: ModelInfo[]
  lastUpdated: number
}

type RuntimeStateUpdate = {
  runtimeId: string
  daemonActorId: string
  info: RuntimeInfo
}

interface RuntimeStateState {
  byRuntimeId: Record<string, RuntimeStateEntry>
  defaultCatalogByActorId: Record<string, ActorDefaultCatalogEntry>
  upsert: (runtimeId: string, daemonActorId: string, info: RuntimeInfo) => void
  upsertBatch: (updates: RuntimeStateUpdate[]) => void
  syncActorPresenceBatch: (
    syncs: {
      daemonActorId: string
      updates: RuntimeStateUpdate[]
      defaultCatalog: ActorDefaultCatalogEntry | null
    }[],
  ) => void
  clear: () => void
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function runtimeInfoEqual(a: RuntimeInfo, b: RuntimeInfo): boolean {
  return bytesEqual(toBinary(RuntimeInfoSchema, a), toBinary(RuntimeInfoSchema, b))
}

function applyRuntimeStateUpdates(
  current: Record<string, RuntimeStateEntry>,
  updates: RuntimeStateUpdate[],
): Record<string, RuntimeStateEntry> {
  let next = current
  let changed = false

  for (const update of updates) {
    const { runtimeId, daemonActorId, info } = update
    const receivedAt = Date.now()
    const prev = next[runtimeId]
    let merged = info
    if (
      prev &&
      prev.info.availableModels.length > 0 &&
      info.availableModels.length === 0
    ) {
      // Defensive: keep last-known model list when a partial retain (e.g.
      // status-only delta) arrives without `available_models`.
      merged = { ...info, availableModels: prev.info.availableModels }
    }

    const prevMatches =
      Boolean(prev) &&
      prev.daemonActorId === daemonActorId &&
      runtimeInfoEqual(prev!.info, merged)
    const entry: RuntimeStateEntry = prevMatches
      ? { ...prev!, lastUpdated: receivedAt }
      : { info: merged, daemonActorId, lastUpdated: receivedAt }

    const shouldSetRuntime = !prevMatches || entry !== prev
    if (!shouldSetRuntime) continue
    if (!changed) {
      next = { ...next }
      changed = true
    }
    next[runtimeId] = entry
  }

  return changed ? next : current
}

function pruneActorAttachments(
  current: Record<string, RuntimeStateEntry>,
  daemonActorId: string,
  liveKeys: ReadonlySet<string>,
): Record<string, RuntimeStateEntry> {
  const prefix = `${daemonActorId}::`
  let next = current
  let changed = false
  for (const key of Object.keys(current)) {
    if (!key.startsWith(prefix)) continue
    if (liveKeys.has(key)) continue
    if (!changed) {
      next = { ...next }
      changed = true
    }
    delete next[key]
  }
  return changed ? next : current
}

function applyDefaultCatalogUpdate(
  current: Record<string, ActorDefaultCatalogEntry>,
  daemonActorId: string,
  entry: ActorDefaultCatalogEntry | null,
): Record<string, ActorDefaultCatalogEntry> {
  if (!entry) {
    if (!(daemonActorId in current)) return current
    const next = { ...current }
    delete next[daemonActorId]
    return next
  }
  const prev = current[daemonActorId]
  if (
    prev &&
    prev.defaultWorkspaceId === entry.defaultWorkspaceId &&
    prev.defaultWorktree === entry.defaultWorktree &&
    prev.models.length === entry.models.length &&
    prev.models.every((model, index) => model.id === entry.models[index]?.id)
  ) {
    return current
  }
  return { ...current, [daemonActorId]: entry }
}

export const useRuntimeStateStore = createZustand<RuntimeStateState>((set, get) => ({
  byRuntimeId: {},
  defaultCatalogByActorId: {},
  upsert: (runtimeId, daemonActorId, info) => {
    const current = get().byRuntimeId
    const next = applyRuntimeStateUpdates(current, [{ runtimeId, daemonActorId, info }])
    if (next !== current) set({ byRuntimeId: next })
  },
  upsertBatch: (updates) => {
    if (updates.length === 0) return
    const current = get().byRuntimeId
    const next = applyRuntimeStateUpdates(current, updates)
    if (next !== current) set({ byRuntimeId: next })
  },
  syncActorPresenceBatch: (syncs) => {
    if (syncs.length === 0) return
    const current = get().byRuntimeId
    let nextRuntime = current
    let nextDefault = get().defaultCatalogByActorId
    let runtimeChanged = false
    let defaultChanged = false
    for (const { daemonActorId, updates, defaultCatalog } of syncs) {
      const liveKeys = new Set(updates.map((u) => u.runtimeId))
      const pruned = pruneActorAttachments(nextRuntime, daemonActorId, liveKeys)
      if (pruned !== nextRuntime) {
        nextRuntime = pruned
        runtimeChanged = true
      }
      const merged = applyRuntimeStateUpdates(nextRuntime, updates)
      if (merged !== nextRuntime) {
        nextRuntime = merged
        runtimeChanged = true
      }
      const defaultNext = applyDefaultCatalogUpdate(nextDefault, daemonActorId, defaultCatalog)
      if (defaultNext !== nextDefault) {
        nextDefault = defaultNext
        defaultChanged = true
      }
    }
    if (runtimeChanged || defaultChanged) {
      set({
        ...(runtimeChanged ? { byRuntimeId: nextRuntime } : {}),
        ...(defaultChanged ? { defaultCatalogByActorId: nextDefault } : {}),
      })
    }
  },
  clear: () => set({ byRuntimeId: {}, defaultCatalogByActorId: {} }),
}))

/** `amux/{team}/{actor}/state` — the one retained topic per actor. */
export function parseActorStateTopic(
  topic: string
): { teamId: string; actorId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'amux') return null
  if (parts[3] !== 'state') return null
  return { teamId: parts[1], actorId: parts[2] }
}

type ActorPresenceSync = {
  daemonActorId: string
  updates: RuntimeStateUpdate[]
  defaultCatalog: ActorDefaultCatalogEntry | null
}
let queuedActorPresenceSyncs: ActorPresenceSync[] = []
let runtimeStateFlushScheduled = false

function flushQueuedRuntimeStateUpdates(): void {
  runtimeStateFlushScheduled = false
  const syncs = queuedActorPresenceSyncs
  queuedActorPresenceSyncs = []
  useRuntimeStateStore.getState().syncActorPresenceBatch(syncs)
}

function enqueueActorPresenceSync(
  daemonActorId: string,
  updates: RuntimeStateUpdate[],
  defaultCatalog: ActorDefaultCatalogEntry | null,
): void {
  queuedActorPresenceSyncs.push({ daemonActorId, updates, defaultCatalog })
  if (runtimeStateFlushScheduled) return
  runtimeStateFlushScheduled = true
  // A retained-message flood (broker replaying every `runtime/state` retain on
  // reconnect) does not always arrive as one `mqtt:envelopes` batch — Tauri can
  // emit it as many back-to-back events. `queueMicrotask` only coalesces
  // updates that land inside the SAME synchronous callback, so a burst spread
  // across even a handful of separate emits still produced one `set()` (and
  // one React commit) per emit, tight enough to blow React's nested-update
  // limit ("Maximum update depth exceeded", TEAMCLU-REACT-72/85/7N).
  // `setTimeout(0)` schedules a macrotask instead, so every emit that lands
  // before it fires — however many separate deliveries that spans — still
  // rolls into the same flush.
  setTimeout(flushQueuedRuntimeStateUpdates, 0)
}

/** Live-probed default-workspace catalog from `{actor}/state`. */
function extractActorDefaultCatalog(
  presence: ActorPresence,
): ActorDefaultCatalogEntry | null {
  const worktree = presence.defaultWorktree?.trim() ?? ''
  if (!worktree) return null
  return {
    defaultWorkspaceId: presence.defaultWorkspaceId?.trim() ?? '',
    defaultWorktree: worktree,
    models: [...(presence.defaultWorkspaceModels ?? [])],
    lastUpdated: Date.now(),
  }
}

/**
 * Project an `ActorPresence` retain into the same entry shape the per-runtime
 * retains produce, one entry per attached session.
 *
 * Keyed by `session_id`, not by a spawn id. That is the whole point: a spawn id
 * is minted per start and stale the moment it is recorded, whereas exactly one
 * attachment serves a session at a time (ADR-0004). Commands are addressed the
 * same way since the rpc/req migration, so consumers that treat this key as an
 * opaque address keep working.
 *
 * A session absent from `live_sessions` is deliberately not represented: no
 * entry means cold, which is how the UI distinguishes "answers immediately"
 * from "will spawn on send".
 */
export function projectActorPresence(
  daemonActorId: string,
  presence: ActorPresence,
): RuntimeStateUpdate[] {
  // Device-level, not per-worktree (#742). Looking the catalog up by
  // `live.worktree` was the "multi-worktree device shows no models" bug: the
  // key frequently did not match any published catalog, the lookup missed, and
  // every session on that device reported an empty model list — which the
  // session pill reads as "connecting" and never recovers from.
  //
  // `catalogModels` is already the device-wide union of everything probed for
  // the active backend, so it is exactly the list to offer.
  const models = presence.catalogModels
  // Older daemons send only the per-worktree copies. Fall back to the first of
  // those so this client keeps working against one until it is upgraded.
  const legacy = presence.worktrees[0]
  const defaultModel = presence.defaultModel || legacy?.defaultModel || ''
  const availableCommands =
    presence.availableCommands.length > 0
      ? presence.availableCommands
      : (legacy?.availableCommands ?? [])

  return presence.liveSessions.map((live) => {
    const info = create(RuntimeInfoSchema, {
      runtimeId: live.sessionId,
      agentType: presence.activeAgentType,
      workspaceId: live.workspaceId,
      worktree: live.worktree,
      status: live.status,
      state: live.lifecycle,
      stage: live.stage,
      errorCode: live.errorCode,
      errorMessage: live.errorMessage,
      failedStage: live.failedStage,
      currentModel: live.currentModel || defaultModel,
      availableModels: models,
      availableCommands,
    })

    // Keyed by (actor, session), not by session alone. A daemon holds at most
    // one attachment per session — `coalesce_session_runtimes` enforces that —
    // but this store merges every actor's retain, and a session with agents on
    // two machines has one attachment per machine. Keying by session alone let
    // the second actor's entry evict the first.
    //
    // `info.runtimeId` stays the bare session id: that is the command address,
    // and commands are addressed by (actor, session) at the wire level too.
    return { runtimeId: `${daemonActorId}::${live.sessionId}`, daemonActorId, info }
  })
}

/** Composite key for one actor's attachment to one session. */
export function attachmentKey(daemonActorId: string, sessionId: string): string {
  return `${daemonActorId}::${sessionId}`
}

/** One actor's attachment to one session — keyed `{actorId}::{sessionId}`. */
export function resolveSessionAttachmentEntry(
  agentId: string,
  sessionId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry | undefined {
  const trimmedAgent = agentId.trim()
  const trimmedSession = sessionId.trim()
  if (!trimmedAgent || !trimmedSession) return undefined

  const attached = byRuntimeId[attachmentKey(trimmedAgent, trimmedSession)]
  if (attached?.daemonActorId === trimmedAgent) return attached
  return undefined
}

/** Every actor's attachment to `sessionId` — one per daemon serving it. */
export function attachmentsForSession(
  sessionId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry[] {
  const id = sessionId.trim()
  if (!id) return []
  return Object.entries(byRuntimeId)
    .filter(([key]) => key.endsWith(`::${id}`))
    .map(([, entry]) => entry)
}

const runtimeStateLeaseManager = createSharedModuleLeaseManager<string>({
  key: (teamId) => teamId.trim(),
  setup: async (teamId, controls) => {
    const actorTopic = `amux/${teamId}/+/state`
    const unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
    const actor = parseActorStateTopic(env.topic)
    if (!actor || actor.teamId !== teamId) return
    let presence: ActorPresence
    try {
      presence = fromBinary(ActorPresenceSchema, new Uint8Array(env.bytes))
    } catch (e) {
      console.warn('[runtime-state] failed to decode ActorPresence', e)
      return
    }
    const updates = projectActorPresence(actor.actorId, presence)
    const defaultCatalog = extractActorDefaultCatalog(presence)
    sessionFlowLog('actor_state.retain.received', {
      teamId: actor.teamId,
      actorId: actor.actorId,
      online: presence.online,
      activeAgentType: presence.activeAgentType,
      backendHealth: presence.backendHealth,
      worktreeCount: presence.worktrees.length,
      catalogModelCount: presence.catalogModels.length,
      liveSessionCount: presence.liveSessions.length,
      defaultWorktree: presence.defaultWorktree ?? '',
      defaultCatalogModelCount: presence.defaultWorkspaceModels.length,
    })
    enqueueActorPresenceSync(actor.actorId, updates, defaultCatalog)
    })
    controls.setCleanup(unlisten)
    if (!controls.isCurrent()) return
    await mqttSubscribe(actorTopic)
    console.info('[runtime-state] subscribed', { teamId, topic: actorTopic })
  },
  onDeactivate: () => {
    queuedActorPresenceSyncs = []
    runtimeStateFlushScheduled = false
    useRuntimeStateStore.getState().clear()
  },
})

export function acquireRuntimeStateStore(teamId: string, ownerId: string): SharedModuleLease {
  return runtimeStateLeaseManager.acquire(teamId.trim(), ownerId)
}
