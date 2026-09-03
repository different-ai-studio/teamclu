import { describe, test, expect, beforeEach, vi } from 'vitest'

const installCalls: unknown[] = []
let inspectStates: Record<string, string> = {}

const listTeamSkills = vi.fn(async () => [
  {
    slug: 'say-hi',
    installed: true,
    installedVersion: 1,
    latestVersion: 1,
    category: 'general',
    summary: 'Say hi',
    whenToUse: null,
    whenNotToUse: null,
    requires: null,
    status: 'published',
    supersededBy: null,
    ownerActorId: 'actor-1',
    hasUpdate: false,
    createdAt: null,
    updatedAt: null,
    origin: 'local',
    upstreamSlug: null,
    upstreamSubscribed: false,
    upstreamDetachedAt: null,
  },
])

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ teamSkills: { listTeamSkills } }),
}))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'agent-1',
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { slug?: string }) => {
    if (cmd === 'team_skill_list_installed') {
      return [{ slug: 'say-hi', version: '1', teamId: 'team-1' }]
    }
    if (cmd === 'team_skill_inspect') {
      return {
        slug: args.slug,
        source: 'hosted-agent',
        state: inspectStates[args.slug ?? ''] ?? 'clean',
        installedVersion: '1',
        modified: inspectStates[args.slug ?? ''] === 'dirty' ? ['SKILL.md'] : [],
        deleted: [],
        added: [],
      }
    }
    if (cmd === 'team_skill_install') {
      installCalls.push(args)
      return null
    }
    return null
  }),
}))

import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()

describe('refreshSkillLocalState', () => {
  beforeEach(() => {
    installCalls.length = 0
    inspectStates = {}
    listTeamSkills.mockClear()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useTeamShareBrowserStore.setState({ skillLocalState: {} })
  })

  test('records dirty from inspect without installing', async () => {
    inspectStates = { 'say-hi': 'dirty' }

    await store().refreshSkillLocalState()

    expect(store().skillLocalState['say-hi']?.state).toBe('dirty')
    expect(installCalls).toHaveLength(0)
  })

  test('leaves skillLocalState clean when inspect reports clean', async () => {
    await store().refreshSkillLocalState()

    expect(store().skillLocalState['say-hi']?.state).toBe('clean')
  })
})
