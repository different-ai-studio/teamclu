import { describe, test, expect, beforeEach, vi } from 'vitest'

const deleteTeamSkill = vi.fn(async (_teamId: string, _slug: string) => {})

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ teamSkills: { deleteTeamSkill } }),
}))

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'
import { useTabsStore } from '../tabs'

const store = () => useTeamShareBrowserStore.getState()

function skillRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'deploy-check',
    slug: 'deploy-check',
    name: 'deploy-check',
    invocationName: 'deploy-check',
    category: null,
    content: '',
    dirPath: null,
    filename: null,
    origin: 'registry',
    kind: 'team-installed',
    personalSource: null,
    personalSourceLabel: null,
    summary: null,
    whenToUse: null,
    whenNotToUse: null,
    requires: null,
    status: 'published',
    supersededBy: null,
    ownerActorId: 'actor-1',
    latestVersion: 3,
    installed: true,
    installedVersion: 3,
    hasUpdate: false,
    createdAt: null,
    updatedAt: null,
    ...over,
  }
}

describe('deleteTeamSkill', () => {
  let reconciled = 0

  beforeEach(() => {
    deleteTeamSkill.mockClear()
    reconciled = 0
    useTabsStore.getState().closeAll()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      skills: { items: [skillRow()] as never, loading: false, loaded: true, error: null },
      // The two collaborators this action drives; the real ones talk to disk
      // and to the registry, neither of which this test is about.
      reconcileSkills: async () => {
        reconciled += 1
      },
      loadSection: async () => {},
    })
    store().select('skills', 'deploy-check')
  })

  test('removes the registry row, then reconciles this machine', async () => {
    await store().deleteTeamSkill('deploy-check')

    expect(deleteTeamSkill).toHaveBeenCalledWith('team-1', 'deploy-check')
    // Not a nicety: without it the deleter keeps the pack on disk until the
    // next tick, looking at a skill they were just told is gone.
    expect(reconciled).toBe(1)
    expect(store().detailTarget).not.toEqual({ kind: 'skill', id: 'deploy-check' })
  })

  test('a reconcile that fails does not report the delete as failed', async () => {
    useTeamShareBrowserStore.setState({
      reconcileSkills: async () => {
        throw new Error('offline')
      },
    })

    await expect(store().deleteTeamSkill('deploy-check')).resolves.toBeUndefined()
    expect(deleteTeamSkill).toHaveBeenCalledTimes(1)
  })

  test('refuses a personal skill — this endpoint only deletes registry rows', async () => {
    useTeamShareBrowserStore.setState({
      skills: {
        items: [skillRow({ id: 'personal:notes', origin: 'personal', kind: 'personal' })] as never,
        loading: false,
        loaded: true,
        error: null,
      },
    })

    await expect(store().deleteTeamSkill('deploy-check')).rejects.toThrow('not a team skill')
    expect(deleteTeamSkill).not.toHaveBeenCalled()
  })

  test('refuses when no team is selected', async () => {
    useCurrentTeamStore.setState({ team: null } as never)
    await expect(store().deleteTeamSkill('deploy-check')).rejects.toThrow('no current team')
    expect(deleteTeamSkill).not.toHaveBeenCalled()
  })
})
