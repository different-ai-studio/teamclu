import { describe, test, expect, beforeEach, vi } from 'vitest'

/**
 * The skills list carries the team's whole catalog, not only what the Agent
 * has installed: the uninstalled ones are what the column's install button is
 * for. Driven through the real `loadSection`, with the Agent inventory and the
 * registry as the only inputs.
 */

const registry = [
  { slug: 'deploy-check', displayName: 'Deploy check', status: 'published', latestVersion: 2 },
  { slug: 'weekly-report', displayName: 'Weekly report', status: 'published', latestVersion: 1 },
  { slug: 'old-thing', displayName: 'Old thing', status: 'deprecated', latestVersion: 1 },
]

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamSkills: { listTeamSkills: vi.fn(async () => registry) },
    actors: { createAgentManagementGrant: vi.fn(async () => ({ grant: 'g', nonce: 'n' })) },
  }),
}))

vi.mock('@/lib/daemon/teamclu-rpc', async (orig) => ({
  ...(await orig<typeof import('@/lib/daemon/teamclu-rpc')>()),
  manageAgentCapability: vi.fn(async () => ({
    skills: [
      { id: 'deploy-check', name: 'Deploy check', teamItem: true, version: '2', health: 'installed' },
      { id: 'personal:notes', name: 'notes', teamItem: false, version: '1', health: 'installed', source: 'agent' },
    ],
  })),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({ getKnownLocalDaemonActorId: () => 'someone-else' }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => null,
  useEffectiveWorkspacePath: () => null,
}))

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

describe('the skills list', () => {
  beforeEach(() => {
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: 'agent-1',
      skills: { items: [], loading: false, loaded: false, error: null } as never,
    })
  })

  test('offers the team skills this Agent has not installed, but not deprecated ones', async () => {
    await useTeamShareBrowserStore.getState().loadSection('skills', { force: true })
    const kinds = Object.fromEntries(
      useTeamShareBrowserStore.getState().skills.items.map((item) => [item.slug, item.kind]),
    )
    expect(kinds).toEqual({
      'deploy-check': 'team-installed',
      'weekly-report': 'team-available',
      notes: 'personal',
    })
    const available = useTeamShareBrowserStore
      .getState()
      .skills.items.find((item) => item.slug === 'weekly-report')
    expect(available?.installed).toBe(false)
    expect(available?.latestVersion).toBe(1)
  })
})
