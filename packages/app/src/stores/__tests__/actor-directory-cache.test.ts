import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActorRow as CachedActorRow } from '@/lib/cache/local-cache'

const mocks = vi.hoisted(() => ({
  loadActorsForTeam: vi.fn(async (): Promise<CachedActorRow[]> => []),
  upsertActorsBatch: vi.fn(async (_rows: CachedActorRow[]) => {}),
  listActorDirectory: vi.fn(async (): Promise<unknown[]> => []),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))

vi.mock('@/lib/cache/local-cache', () => ({
  loadActorsForTeam: mocks.loadActorsForTeam,
  upsertActorsBatch: mocks.upsertActorsBatch,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ actors: { listActorDirectory: mocks.listActorDirectory } }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: null }) => unknown) => sel({ team: null }),
}))

import { useActorDirectoryStore } from '@/stores/actor-directory-store'

const PHOTO = 'https://cdn.example.test/avatars/member-1/avatar-1.jpg'

function cachedMember(avatarUrl: string | null): CachedActorRow {
  return {
    id: 'member-1',
    teamId: 'team-1',
    actorType: 'member',
    displayName: 'Matt',
    avatarUrl,
    memberStatus: 'active',
    agentStatus: null,
    lastActiveAt: null,
    teamRole: 'owner',
    agentVisibility: null,
    ownerMemberId: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    syncedAt: '2026-08-01T00:00:00Z',
  }
}

describe('actor directory ⇄ libsql cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useActorDirectoryStore.setState({ byTeam: {}, activeTeamId: null })
  })

  it('paints the cached photo before the network reconcile lands', async () => {
    mocks.loadActorsForTeam.mockResolvedValue([cachedMember(PHOTO)])
    let releaseNetwork!: (rows: unknown[]) => void
    mocks.listActorDirectory.mockReturnValue(new Promise((resolve) => { releaseNetwork = resolve }))

    useActorDirectoryStore.getState().ensure('team-1')

    await vi.waitFor(() => {
      expect(useActorDirectoryStore.getState().byTeam['team-1']?.actors[0]?.avatar_url).toBe(PHOTO)
    })
    expect(mocks.listActorDirectory).toHaveBeenCalled()
    releaseNetwork([])
  })

  it('writes the photo from the network directory into the cache', async () => {
    mocks.listActorDirectory.mockResolvedValue([
      { id: 'member-1', team_id: 'team-1', actor_type: 'member', display_name: 'Matt', avatar_url: PHOTO },
      { id: 'member-2', team_id: 'team-1', actor_type: 'member', display_name: 'Ada', avatar_url: null },
    ])

    await useActorDirectoryStore.getState().refetch('team-1')

    const written = mocks.upsertActorsBatch.mock.calls[0][0]
    expect(written.map((r) => [r.id, r.avatarUrl])).toEqual([
      ['member-1', PHOTO],
      ['member-2', null],
    ])
  })
})
