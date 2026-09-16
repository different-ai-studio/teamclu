import { describe, test, expect, beforeEach, vi } from 'vitest'

const updateTeamSkill = vi.fn(async () => ({}))

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ teamSkills: { updateTeamSkill } }),
}))

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

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

describe('deprecateTeamSkill / restoreTeamSkill', () => {
  const loadSection = vi.fn(async () => {})

  beforeEach(() => {
    updateTeamSkill.mockClear()
    loadSection.mockClear()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      skills: { items: [skillRow()] as never, loading: false, loaded: true, error: null },
      loadSection,
    })
  })

  test('deprecateTeamSkill patches status and supersededBy, then reloads skills', async () => {
    await store().deprecateTeamSkill('deploy-check', 'hotfix-deploy')

    expect(updateTeamSkill).toHaveBeenCalledWith('team-1', 'deploy-check', {
      status: 'deprecated',
      supersededBy: 'hotfix-deploy',
    })
    expect(loadSection).toHaveBeenCalledTimes(1)
    expect(loadSection).toHaveBeenCalledWith('skills', { force: true })
  })

  test('deprecateTeamSkill without supersededBy sends null', async () => {
    await store().deprecateTeamSkill('deploy-check')

    expect(updateTeamSkill).toHaveBeenCalledWith('team-1', 'deploy-check', {
      status: 'deprecated',
      supersededBy: null,
    })
    expect(loadSection).toHaveBeenCalledTimes(1)
  })

  test('restoreTeamSkill patches published status and clears supersededBy', async () => {
    await store().restoreTeamSkill('deploy-check')

    expect(updateTeamSkill).toHaveBeenCalledWith('team-1', 'deploy-check', {
      status: 'published',
      supersededBy: null,
    })
    expect(loadSection).toHaveBeenCalledTimes(1)
  })

  test('refuses a personal skill — this endpoint only patches registry rows', async () => {
    useTeamShareBrowserStore.setState({
      skills: {
        items: [skillRow({ id: 'personal:notes', origin: 'personal', kind: 'personal' })] as never,
        loading: false,
        loaded: true,
        error: null,
      },
    })

    await expect(store().deprecateTeamSkill('deploy-check')).rejects.toThrow('not a team skill')
    expect(updateTeamSkill).not.toHaveBeenCalled()
    expect(loadSection).not.toHaveBeenCalled()
  })

  test('refuses when no team is selected', async () => {
    useCurrentTeamStore.setState({ team: null } as never)

    await expect(store().deprecateTeamSkill('deploy-check')).rejects.toThrow('no current team')
    expect(updateTeamSkill).not.toHaveBeenCalled()
    expect(loadSection).not.toHaveBeenCalled()
  })
})
