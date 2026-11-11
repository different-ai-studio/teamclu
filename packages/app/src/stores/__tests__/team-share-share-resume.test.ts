import { describe, test, expect, beforeEach, vi } from 'vitest'

/**
 * Sharing a personal skill that publishes and then fails to install.
 *
 * The registry row survives the failure (nobody but an admin can delete it), so
 * the question is whether the next share finishes the job or collides with its
 * own name forever — issue #1850.
 */

const { registry, listTeamSkills, publishTeamSkill, installTeamSkill, invoke } = vi.hoisted(() => {
  const registry: Array<Record<string, unknown>> = []
  return {
    registry,
    listTeamSkills: vi.fn(async () => registry.map((r) => ({ ...r }))),
    publishTeamSkill: vi.fn(async (_teamId: string, input: { slug: string; summary: string }) => {
      if (registry.some((r) => r.slug === input.slug)) {
        const { CloudApiError } = await import('@/lib/backend/cloud-api/http')
        throw new CloudApiError(409, 'conflict', `a skill named ${input.slug} already exists`, null)
      }
      const row = {
        slug: input.slug,
        ownerActorId: 'member-1',
        createdBy: 'member-1',
        latestVersion: 1,
        summary: input.summary,
        category: 'general',
        whenToUse: 'w',
        whenNotToUse: 'n',
        requires: null,
      }
      registry.push(row)
      return { ...row }
    }),
    installTeamSkill: vi.fn(async () => ({})),
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === 'team_skill_pack_and_upload') return { contentHash: 'a'.repeat(64), size: 10 }
      if (cmd === 'team_skill_retire_personal') return '/trash/perf'
      return null
    }),
  }
})

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/ws',
}))
vi.mock('@/lib/skills/ensure-agents-paths', () => ({ ensureAgentsSkillsPaths: async () => {} }))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ teamSkills: { listTeamSkills, publishTeamSkill, installTeamSkill } }),
}))
vi.mock('@/lib/auth/session-store', () => ({ getFreshAccessToken: async () => 'token' }))
vi.mock('@/lib/config/server-config', () => ({
  getEffectiveServerConfig: async () => ({ cloudApiUrl: 'https://api.example' }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  SkillShareIncompleteError,
  SkillSlugTakenError,
  takenShareSlugs,
  useTeamShareBrowserStore,
} from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()
const SLUG = 'personal-performance-usage'
const input = {
  slug: SLUG,
  summary: 's',
  category: 'general' as const,
  whenToUse: 'w',
  whenNotToUse: 'n',
  changelog: 'first',
}

function personalRow() {
  return { id: SLUG, slug: SLUG, kind: 'personal', origin: 'personal', dirPath: '/home/.agents/skills', filename: SLUG }
}

const uploads = () => invoke.mock.calls.filter(([cmd]) => cmd === 'team_skill_pack_and_upload').length

describe('a share that published but did not install', () => {
  beforeEach(() => {
    registry.length = 0
    listTeamSkills.mockClear()
    publishTeamSkill.mockClear()
    installTeamSkill.mockReset()
    installTeamSkill.mockResolvedValue({})
    invoke.mockClear()
    useCurrentTeamStore.setState({ team: { id: 'team-1' }, currentMember: { id: 'member-1' } } as never)
    useTeamShareBrowserStore.setState({
      subjectActorId: 'agent-1',
      skills: { items: [personalRow()] as never, loading: false, loaded: true, error: null },
      skillRegistry: [],
      loadSection: async () => {},
      select: () => {},
    })
  })

  test('reports the half-finished state instead of a generic failure', async () => {
    installTeamSkill.mockRejectedValueOnce(new Error('network down'))

    const err = await store().sharePersonalSkill(SLUG, input).catch((e) => e)

    expect(err).toBeInstanceOf(SkillShareIncompleteError)
    expect(err.message).toBe('network down')
    expect(registry).toHaveLength(1)
    // The personal original is only retired after the install landed.
    expect(invoke).not.toHaveBeenCalledWith('team_skill_retire_personal', expect.anything())
  })

  test('sharing again finishes the install without publishing or uploading twice', async () => {
    installTeamSkill.mockRejectedValueOnce(new Error('network down'))
    await store().sharePersonalSkill(SLUG, input).catch(() => {})
    expect(uploads()).toBe(1)

    const retired = await store().sharePersonalSkill(SLUG, input)

    expect(retired).toBe('/trash/perf')
    expect(publishTeamSkill).toHaveBeenCalledTimes(1)
    expect(uploads()).toBe(1)
    expect(installTeamSkill).toHaveBeenLastCalledWith('team-1', SLUG, { version: 1, actorId: 'agent-1' })
  })

  test("someone else's skill with the same name is refused before any upload", async () => {
    registry.push({ slug: SLUG, createdBy: 'member-2', ownerActorId: 'member-2', latestVersion: 1 })

    await expect(store().sharePersonalSkill(SLUG, input)).rejects.toBeInstanceOf(SkillSlugTakenError)
    expect(uploads()).toBe(0)
    expect(publishTeamSkill).not.toHaveBeenCalled()
  })

  test('my own skill that has moved past v1 is not resumed', async () => {
    registry.push({ slug: SLUG, createdBy: 'member-1', ownerActorId: 'member-1', latestVersion: 2 })

    await expect(store().sharePersonalSkill(SLUG, input)).rejects.toBeInstanceOf(SkillSlugTakenError)
    expect(uploads()).toBe(0)
  })

  test('a server conflict that slipped past the check reads as a taken name', async () => {
    listTeamSkills.mockRejectedValueOnce(new Error('offline'))
    registry.push({ slug: SLUG, createdBy: 'member-2', ownerActorId: 'member-2', latestVersion: 1 })

    await expect(store().sharePersonalSkill(SLUG, input)).rejects.toBeInstanceOf(SkillSlugTakenError)
  })
})

describe('takenShareSlugs', () => {
  const items = [{ slug: 'installed-here', origin: 'registry' as const }]

  test('includes uninstalled registry skills, minus my own unfinished share', () => {
    const taken = takenShareSlugs(
      [
        { slug: 'installed-here', createdBy: 'member-1', latestVersion: 1 },
        { slug: 'theirs', createdBy: 'member-2', latestVersion: 1 },
        { slug: 'mine-unfinished', createdBy: 'member-1', latestVersion: 1 },
        { slug: 'mine-v3', createdBy: 'member-1', latestVersion: 3 },
      ],
      items,
      'member-1',
    )
    expect([...taken].sort()).toEqual(['installed-here', 'mine-v3', 'theirs'])
  })
})
