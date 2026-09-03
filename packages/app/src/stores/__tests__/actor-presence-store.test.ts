import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { ActorPresenceSchema } from '@/lib/proto/amux_pb'

const mockSubscribe = vi.fn().mockResolvedValue(undefined)
let envelopeHandler: ((env: { topic: string; bytes: number[] }) => void) | null = null
const presenceLeases: Array<{ release(): void }> = []

async function acquireActorPresenceStoreForTest(teamId: string): Promise<void> {
  const { acquireActorPresenceStore } = await import('../actor-presence-store')
  const lease = acquireActorPresenceStore(teamId, `test-presence-${presenceLeases.length}`)
  presenceLeases.push(lease)
  await lease.ready
}
const mockListen = vi.fn().mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
  envelopeHandler = handler
  return () => { envelopeHandler = null }
})

vi.mock('@/lib/mqtt/mqtt-bridge', () => ({
  mqttSubscribe: mockSubscribe,
  listenForEnvelopes: mockListen,
  mqttPublish: vi.fn(),
}))

beforeEach(() => {
  mockSubscribe.mockClear()
  mockSubscribe.mockResolvedValue(undefined)
  mockListen.mockClear()
  mockListen.mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
    envelopeHandler = handler
    return () => { envelopeHandler = null }
  })
  envelopeHandler = null
})

afterEach(() => {
  for (let index = presenceLeases.length - 1; index >= 0; index -= 1) {
    presenceLeases[index].release()
  }
  presenceLeases.length = 0
})

describe('actor-presence-store', () => {
  it('subscribes to the state wildcard for the team', async () => {
    await acquireActorPresenceStoreForTest('team-1')
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/+/state')
  })

  it('registers the envelope handler before subscribing (boot retain race)', async () => {
    const callOrder: string[] = []
    mockListen.mockImplementation(async (handler) => {
      callOrder.push('listen')
      envelopeHandler = handler
      return () => {
        envelopeHandler = null
      }
    })
    mockSubscribe.mockImplementation(async () => {
      callOrder.push('subscribe')
      envelopeHandler?.({
        topic: 'amux/team-1/actor-mac/state',
        bytes: Array.from(
          toBinary(
            ActorPresenceSchema,
            create(ActorPresenceSchema, { online: true, displayName: 'Macmini' }),
          ),
        ),
      })
    })

    const { useActorPresenceStore } = await import('../actor-presence-store')
    await acquireActorPresenceStoreForTest('team-1')

    expect(callOrder).toEqual(['listen', 'subscribe'])
    expect(useActorPresenceStore.getState().byActorId['actor-mac']?.online).toBe(true)
  })

  it('decodes ActorPresence retains and upserts presence by actorId', async () => {
    const { useActorPresenceStore } = await import('../actor-presence-store')
    await acquireActorPresenceStoreForTest('team-1')

    const onlineState = create(ActorPresenceSchema, {
      online: true,
      displayName: 'Macmini',
      timestamp: 1700000000n,
    })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, onlineState)),
    })

    const entry = useActorPresenceStore.getState().byActorId['actor-mac']
    expect(entry).toBeTruthy()
    expect(entry.online).toBe(true)
    expect(entry.displayName).toBe('Macmini')
  })

  it('reflects LWT offline transition', async () => {
    const { useActorPresenceStore } = await import('../actor-presence-store')
    await acquireActorPresenceStoreForTest('team-1')

    const online = create(ActorPresenceSchema, { online: true, displayName: 'Macmini', timestamp: 1n })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, online)),
    })
    expect(useActorPresenceStore.getState().byActorId['actor-mac'].online).toBe(true)

    // LWT publish replaces retain with online:false.
    const offline = create(ActorPresenceSchema, { online: false, displayName: 'Macmini', timestamp: 2n })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, offline)),
    })
    expect(useActorPresenceStore.getState().byActorId['actor-mac'].online).toBe(false)
  })

  it('ignores envelopes for other teams and malformed topics', async () => {
    const { useActorPresenceStore } = await import('../actor-presence-store')
    await acquireActorPresenceStoreForTest('team-1')

    const state = create(ActorPresenceSchema, { online: true })
    envelopeHandler!({
      topic: 'amux/team-2/a2/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, state)),
    })
    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })

    expect(Object.keys(useActorPresenceStore.getState().byActorId)).toHaveLength(0)
  })

  it('shares one subscription across same-team owners until the final release', async () => {
    const { acquireActorPresenceStore, useActorPresenceStore } = await import('../actor-presence-store')
    const a = acquireActorPresenceStore('team-1', 'owner-a')
    const b = acquireActorPresenceStore('team-1', 'owner-b')
    await Promise.all([a.ready, b.ready])
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledTimes(1)

    a.release()
    const online = create(ActorPresenceSchema, { online: true, displayName: 'Still live' })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, online)),
    })
    expect(useActorPresenceStore.getState().byActorId['actor-mac']?.online).toBe(true)

    b.release()
    expect(useActorPresenceStore.getState().byActorId).toEqual({})
  })
})
