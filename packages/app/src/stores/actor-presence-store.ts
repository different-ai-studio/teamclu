import { create as createZustand } from 'zustand'
import { fromBinary } from '@bufbuild/protobuf'
import { ActorPresenceSchema } from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt/mqtt-bridge'
import { createSharedModuleLeaseManager, type SharedModuleLease } from '@/lib/shared-module-lease'

// Per-actor presence. Fed by retained `amux/{team}/{actor}/state` publishes —
// including the LWT the daemon registers at connect-time, which the broker
// flips to `online: false` automatically when the daemon's connection drops.
// So this store is authoritative for "is the daemon actually reachable right
// now?" — unlike `runtime-state-store`, whose retains can linger after a
// daemon dies.
//
// The topic's `{actor}` segment is the agent's `actor_id`, so callers index
// this store by the agent's actor id when they want agent presence.

type ActorPresenceEntry = {
  online: boolean
  displayName: string
  lastUpdated: number // ms epoch
}

interface ActorPresenceState {
  byActorId: Record<string, ActorPresenceEntry>
  upsert: (actorId: string, entry: ActorPresenceEntry) => void
  clear: () => void
}

export const useActorPresenceStore = createZustand<ActorPresenceState>((set, get) => ({
  byActorId: {},
  upsert: (actorId, entry) => {
    set({
      byActorId: {
        ...get().byActorId,
        [actorId]: entry,
      },
    })
  },
  clear: () => set({ byActorId: {} }),
}))

export function parseActorStateTopic(
  topic: string,
): { teamId: string; actorId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'amux') return null
  if (parts[3] !== 'state') return null
  return { teamId: parts[1], actorId: parts[2] }
}

const presenceLeaseManager = createSharedModuleLeaseManager<string>({
  key: (teamId) => teamId.trim(),
  setup: async (teamId, controls) => {
    const actorTopic = `amux/${teamId}/+/state`
    const unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
      const parsed = parseActorStateTopic(env.topic)
      if (!parsed || parsed.teamId !== teamId) return
      try {
        const state = fromBinary(ActorPresenceSchema, new Uint8Array(env.bytes))
        useActorPresenceStore.getState().upsert(parsed.actorId, {
          online: state.online,
          displayName: state.displayName,
          lastUpdated: Date.now(),
        })
      } catch (e) {
        console.warn('[actor-presence] failed to decode ActorPresence', e)
      }
    })
    controls.setCleanup(unlisten)
    if (!controls.isCurrent()) return
    await mqttSubscribe(actorTopic)
  },
  onDeactivate: () => useActorPresenceStore.getState().clear(),
})

export function acquireActorPresenceStore(teamId: string, ownerId: string): SharedModuleLease {
  return presenceLeaseManager.acquire(teamId.trim(), ownerId)
}
