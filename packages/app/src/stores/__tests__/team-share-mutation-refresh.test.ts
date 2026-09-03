import { describe, test, expect, beforeEach, vi } from 'vitest'

const {
  notifyDaemonSkillsChanged,
  manageAgentCapability,
  createAgentManagementGrant,
  deleteTeamSkill,
} = vi.hoisted(() => ({
  notifyDaemonSkillsChanged: vi.fn(async () => {}),
  manageAgentCapability: vi.fn(async () => ({})),
  createAgentManagementGrant: vi.fn(async () => ({ grant: 'grant', nonce: 'nonce' })),
  deleteTeamSkill: vi.fn(async () => {}),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/Users/me/project',
}))
vi.mock('@/lib/daemon/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon/daemon-local-client')>()
  return {
    ...actual,
    notifyDaemonSkillsChanged,
    encodeWorkspaceId: (p: string) => `ws:${p}`,
  }
})
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    actors: { createAgentManagementGrant },
    teamSkills: { deleteTeamSkill, listTeamSkills: async () => [] },
  }),
}))
vi.mock('@/lib/daemon/teamclu-rpc', () => ({ manageAgentCapability }))
vi.mock('@/lib/agent/agent-device-reachability', () => ({
  resolveAgentDevicePresenceSync: () => 'online',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

import {
  SkillMutationRefreshError,
  useTeamShareBrowserStore,
} from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()

function skillRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'say-hello',
    slug: 'say-hello',
    name: 'say-hello',
    invocationName: 'say-hello',
    category: 'other',
    content: '',
    dirPath: '/hosted/skills',
    filename: 'say-hello',
    origin: 'registry',
    kind: 'team-available',
    personalSource: null,
    personalSourceLabel: null,
    summary: 'hi',
    whenToUse: null,
    whenNotToUse: null,
    requires: null,
    status: 'published',
    supersededBy: null,
    ownerActorId: 'actor-1',
    latestVersion: 1,
    installed: false,
    installedVersion: null,
    hasUpdate: false,
    createdAt: null,
    updatedAt: null,
    marketplaceOrigin: 'local',
    upstreamSubscribed: false,
    ...overrides,
  }
}

describe('skill mutation refresh partial success', () => {
  beforeEach(() => {
    notifyDaemonSkillsChanged.mockReset()
    notifyDaemonSkillsChanged.mockRejectedValue(new Error('daemon down'))
    manageAgentCapability.mockClear()
    createAgentManagementGrant.mockClear()
    deleteTeamSkill.mockClear()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: 'actor-1',
      skills: { items: [skillRow()] as never, loading: false, loaded: true, error: null },
      reconcileSkills: async () => {},
      loadSection: async () => {},
    })
  })

  test('install success plus refresh failure is not a generic install failure', async () => {
    await expect(store().installSkill('say-hello')).rejects.toMatchObject({
      name: 'SkillMutationRefreshError',
      action: 'install',
      slug: 'say-hello',
    })
    expect(manageAgentCapability).toHaveBeenCalledTimes(1)
    expect(notifyDaemonSkillsChanged).toHaveBeenCalledWith('ws:/Users/me/project')
  })

  test('uninstall success plus refresh failure keeps the uninstall', async () => {
    useTeamShareBrowserStore.setState({
      skills: {
        items: [skillRow({ kind: 'team-installed', installed: true })] as never,
        loading: false,
        loaded: true,
        error: null,
      },
    })
    await expect(store().uninstallSkill('say-hello')).rejects.toBeInstanceOf(
      SkillMutationRefreshError,
    )
    expect(manageAgentCapability).toHaveBeenCalledTimes(1)
  })

  test('delete success plus refresh failure does not look like a delete failure', async () => {
    await expect(store().deleteTeamSkill('say-hello')).rejects.toMatchObject({
      action: 'delete-team',
    })
    expect(deleteTeamSkill).toHaveBeenCalledTimes(1)
    expect(manageAgentCapability).not.toHaveBeenCalled()
  })

  test('personal delete success plus refresh failure is not a generic delete failure', async () => {
    useTeamShareBrowserStore.setState({
      skills: {
        items: [
          skillRow({
            kind: 'personal',
            origin: 'personal',
            id: 'personal:say-hello',
          }),
        ] as never,
        loading: false,
        loaded: true,
        error: null,
      },
    })
    await expect(store().deletePersonalSkill('say-hello')).rejects.toMatchObject({
      action: 'delete-personal',
    })
    expect(manageAgentCapability).toHaveBeenCalledTimes(1)
  })

  test('retry refresh only calls the refresh endpoint', async () => {
    notifyDaemonSkillsChanged.mockResolvedValue(undefined)
    await store().retrySkillsRuntimeRefresh()
    expect(notifyDaemonSkillsChanged).toHaveBeenCalledTimes(1)
    expect(manageAgentCapability).not.toHaveBeenCalled()
    expect(deleteTeamSkill).not.toHaveBeenCalled()
  })
})
