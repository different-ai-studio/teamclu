import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadSessionIdsForActor, clearSessionByActorCache } from '@/lib/session/session-by-actor'

const listSessionIdsForActor = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: { listSessionIdsForActor },
  }),
}))

const loadCached = vi.fn()

vi.mock('@/lib/cache/local-cache', () => ({
  loadSessionIdsForActor: (...args: unknown[]) => loadCached(...args),
}))

describe('loadSessionIdsForActor', () => {
  beforeEach(() => {
    clearSessionByActorCache()
    vi.clearAllMocks()
    loadCached.mockResolvedValue([])
  })

  it('returns set of session ids from the backend', async () => {
    listSessionIdsForActor.mockResolvedValue(['s1', 's2', 's3'])

    const result = await loadSessionIdsForActor('actor-1', 'team-1')
    expect(result).toEqual(new Set(['s1', 's2', 's3']))
  })

  it('returns empty set on backend error', async () => {
    listSessionIdsForActor.mockRejectedValue(new Error('boom'))

    const result = await loadSessionIdsForActor('actor-1', 'team-1')
    expect(result).toEqual(new Set())
  })

  it('memoizes results by actorId', async () => {
    listSessionIdsForActor.mockResolvedValue(['s1'])

    await loadSessionIdsForActor('actor-1', 'team-1')
    await loadSessionIdsForActor('actor-1', 'team-1')

    expect(listSessionIdsForActor).toHaveBeenCalledTimes(1)
  })

  it('unions the local cache in, asking it with (teamId, actorId)', async () => {
    loadCached.mockResolvedValue(['s-local'])
    listSessionIdsForActor.mockResolvedValue(['s1'])

    const result = await loadSessionIdsForActor('actor-1', 'team-1')

    expect(loadCached).toHaveBeenCalledWith('team-1', 'actor-1')
    expect(result).toEqual(new Set(['s-local', 's1']))
  })

  it('falls back to the local cache when the backend fails, and asks again next time', async () => {
    loadCached.mockResolvedValue(['s-local'])
    listSessionIdsForActor.mockRejectedValueOnce(new Error('offline'))
    listSessionIdsForActor.mockResolvedValueOnce(['s1'])
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await loadSessionIdsForActor('actor-1', 'team-1')).toEqual(new Set(['s-local']))
    expect(await loadSessionIdsForActor('actor-1', 'team-1')).toEqual(new Set(['s-local', 's1']))
    error.mockRestore()
  })

  it('asks the backend again once the memo has aged out', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    listSessionIdsForActor.mockResolvedValueOnce(['s1'])
    listSessionIdsForActor.mockResolvedValueOnce(['s1', 's2'])

    await loadSessionIdsForActor('actor-1', 'team-1')
    now.mockReturnValue(1_000_000 + 60_000)
    const result = await loadSessionIdsForActor('actor-1', 'team-1')

    expect(result).toEqual(new Set(['s1', 's2']))
    now.mockRestore()
  })
})
