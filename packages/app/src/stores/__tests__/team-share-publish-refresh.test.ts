import { describe, test, expect, beforeEach, vi } from 'vitest'

const {
  notifyDaemonSkillsChanged,
  publishTeamSkillVersion,
  installTeamSkill,
  detachTeamSkill,
  invoke,
} = vi.hoisted(() => ({
  notifyDaemonSkillsChanged: vi.fn(async () => {}),
  publishTeamSkillVersion: vi.fn(async () => ({
    version: 4,
    summary: 'hi',
    whenToUse: null,
    whenNotToUse: null,
    requires: null,
  })),
  installTeamSkill: vi.fn(async () => ({})),
  detachTeamSkill: vi.fn(async () => {}),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'team_skill_installed_dir') return '/hosted/skills/say-hello'
    if (cmd === 'team_skill_pack_and_upload') return { contentHash: 'abc', size: 12 }
    if (cmd === 'team_skill_rebaseline') return {}
    return null
  }),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/Users/me/project',
}))
vi.mock('@/lib/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon-local-client')>()
  return {
    ...actual,
    notifyDaemonSkillsChanged,
    encodeWorkspaceId: (p: string) => `ws:${p}`,
  }
})
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamSkills: { publishTeamSkillVersion, installTeamSkill },
    marketplace: { detachTeamSkill },
  }),
}))
vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: async () => 'token',
}))
vi.mock('@/lib/server-config', () => ({
  getEffectiveServerConfig: async () => ({ cloudApiUrl: 'https://api.example' }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  SkillPublishedRefreshError,
  useTeamShareBrowserStore,
} from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()

function skillRow() {
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
    kind: 'team-installed',
    personalSource: null,
    personalSourceLabel: null,
    summary: 'hi',
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
    marketplaceOrigin: 'local',
    upstreamSubscribed: false,
  }
}

describe('publishSkillVersion refresh', () => {
  let reconciled = 0

  beforeEach(() => {
    notifyDaemonSkillsChanged.mockReset()
    notifyDaemonSkillsChanged.mockResolvedValue(undefined)
    publishTeamSkillVersion.mockClear()
    installTeamSkill.mockClear()
    invoke.mockClear()
    reconciled = 0
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: 'actor-1',
      skills: { items: [skillRow()] as never, loading: false, loaded: true, error: null },
      skillLocalState: {
        'say-hello': { state: 'dirty', installedVersion: '3' },
      } as never,
      reconcileSkills: async () => {
        reconciled += 1
      },
      loadSection: async () => {},
    })
  })

  test('calls refresh after rebaseline even when reconcile reports no disk change', async () => {
    await store().publishSkillVersion('say-hello', { changelog: 'n' })
    expect(invoke).toHaveBeenCalledWith('team_skill_rebaseline', expect.anything())
    expect(notifyDaemonSkillsChanged).toHaveBeenCalledWith('ws:/Users/me/project')
    expect(reconciled).toBe(1)
  })

  test('cloud success plus refresh failure is not a generic publish failure', async () => {
    notifyDaemonSkillsChanged.mockRejectedValueOnce(new Error('daemon down'))
    await expect(
      store().publishSkillVersion('say-hello', { changelog: 'n' }),
    ).rejects.toBeInstanceOf(SkillPublishedRefreshError)
    expect(publishTeamSkillVersion).toHaveBeenCalled()
    expect(reconciled).toBe(1)
  })
})
