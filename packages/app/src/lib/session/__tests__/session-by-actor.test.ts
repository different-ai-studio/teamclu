import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadSessionIdsForActor, clearSessionByActorCache } from '@/lib/session/session-by-actor'

const listSessionIdsForActor = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: { listSessionIdsForActor },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

describe('loadSessionIdsForActor', () => {
  beforeEach(() => {
    clearSessionByActorCache()
    vi.clearAllMocks()
  })

  it('returns set of session ids from the backend when not in Tauri', async () => {
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
})
