import { describe, test, expect, beforeEach, vi } from 'vitest'

/**
 * Opening a section fires two forced loads in the same tick — the nav row's
 * click handler and the list column's `[section]` effect. Both pass
 * `coalesce`, so they share one fetch. A refresh after a mutation does not, and
 * must still fetch on its own even with a navigation load in flight.
 */

const inventory = vi.hoisted(() => vi.fn())

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamSkills: { listTeamSkills: vi.fn(async () => []) },
    actors: { createAgentManagementGrant: vi.fn(async () => ({ grant: 'g', nonce: 'n' })) },
  }),
}))

vi.mock('@/lib/daemon/teamclu-rpc', async (orig) => ({
  ...(await orig<typeof import('@/lib/daemon/teamclu-rpc')>()),
  manageAgentCapability: inventory,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({ getKnownLocalDaemonActorId: () => 'someone-else' }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => null,
  useEffectiveWorkspacePath: () => null,
}))

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

describe('section loads opened from navigation', () => {
  beforeEach(() => {
    inventory.mockReset()
    inventory.mockImplementation(async () => ({ skills: [] }))
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: 'agent-1',
      skills: { items: [], loading: false, loaded: false, error: null } as never,
    })
  })

  test('two coalescing loads in the same tick share one fetch', async () => {
    const { loadSection } = useTeamShareBrowserStore.getState()
    await Promise.all([
      loadSection('skills', { force: true, coalesce: true }),
      loadSection('skills', { force: true, coalesce: true }),
    ])
    expect(inventory).toHaveBeenCalledTimes(1)
  })

  test('a refresh after a mutation does not join the navigation load', async () => {
    const { loadSection } = useTeamShareBrowserStore.getState()
    await Promise.all([
      loadSection('skills', { force: true, coalesce: true }),
      loadSection('skills', { force: true }),
    ])
    expect(inventory).toHaveBeenCalledTimes(2)
  })

  test('once a load settles, the next navigation fetches again', async () => {
    const { loadSection } = useTeamShareBrowserStore.getState()
    await loadSection('skills', { force: true, coalesce: true })
    await loadSection('skills', { force: true, coalesce: true })
    expect(inventory).toHaveBeenCalledTimes(2)
  })

  test('a forced load does not join a non-forced one that skipped fetching', async () => {
    useTeamShareBrowserStore.setState({
      skills: { items: [], loading: false, loaded: true, error: null } as never,
    })
    const { loadSection } = useTeamShareBrowserStore.getState()
    await Promise.all([
      loadSection('skills'),
      loadSection('skills', { force: true, coalesce: true }),
    ])
    expect(inventory).toHaveBeenCalledTimes(1)
  })
})
