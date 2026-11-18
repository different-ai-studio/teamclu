import { describe, test, expect, beforeEach, vi } from 'vitest'

/**
 * Sharing a personal skill whose folder name is not a registry id.
 * The install path has to be ASCII on Windows and macOS; the title does not.
 */

const { registry, listTeamSkills, publishTeamSkill, installTeamSkill, invoke } = vi.hoisted(() => {
  const registry: Array<Record<string, unknown>> = []
  return {
    registry,
    listTeamSkills: vi.fn(async () => registry.map((r) => ({ ...r }))),
    publishTeamSkill: vi.fn(async (_teamId: string, input: { slug: string }) => {
      const row = {
        slug: input.slug,
        displayName: (input as { displayName?: string }).displayName,
        ownerActorId: 'member-1',
        createdBy: 'member-1',
        latestVersion: 1,
        summary: 's',
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
      if (cmd === 'team_skill_retire_personal') return '/trash/skill'
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

import { SkillSlugTakenError, useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'
import { SkillSlugInvalidError, teamSkillSlugFromName } from '@/lib/skills/team-skill-slug'

const store = () => useTeamShareBrowserStore.getState()
const CHINESE = '整车成本智能表格'
const input = {
  summary: 's',
  category: 'general' as const,
  whenToUse: 'w',
  whenNotToUse: 'n',
  changelog: 'first',
}

function personal(filename: string, name = filename) {
  return {
    id: `personal:${filename}`,
    slug: filename,
    name,
    kind: 'personal' as const,
    origin: 'personal' as const,
    dirPath: '/home/.agents/skills',
    filename,
  }
}

const uploads = () => invoke.mock.calls.filter(([cmd]) => cmd === 'team_skill_pack_and_upload')

describe('sharing a skill whose name is not an ASCII slug', () => {
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
      skills: { items: [], loading: false, loaded: true, error: null },
      skillRegistry: [],
      loadSection: async () => {},
      select: () => {},
    })
  })

  test('publishes the generated id, keeps the Chinese title, and retires the personal folder', async () => {
    const slug = teamSkillSlugFromName(CHINESE)
    useTeamShareBrowserStore.setState({
      skills: { items: [personal(CHINESE)] as never, loading: false, loaded: true, error: null },
    })

    const retired = await store().sharePersonalSkill(CHINESE, {
      ...input,
      slug,
      displayName: CHINESE,
    })

    expect(retired).toBe('/trash/skill')
    expect(publishTeamSkill).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ slug, displayName: CHINESE }),
    )
    expect(uploads()[0]?.[1]).toEqual(expect.objectContaining({ slug }))
    expect(invoke).toHaveBeenCalledWith(
      'team_skill_retire_personal',
      expect.objectContaining({
        slug,
        dirPath: `/home/.agents/skills/${CHINESE}`,
      }),
    )
  })

  test('refuses a Chinese slug before uploading', async () => {
    useTeamShareBrowserStore.setState({
      skills: { items: [personal(CHINESE)] as never, loading: false, loaded: true, error: null },
    })

    await expect(
      store().sharePersonalSkill(CHINESE, { ...input, slug: CHINESE }),
    ).rejects.toBeInstanceOf(SkillSlugInvalidError)
    expect(uploads()).toHaveLength(0)
    expect(publishTeamSkill).not.toHaveBeenCalled()
  })

  test('refuses an empty slug before uploading', async () => {
    useTeamShareBrowserStore.setState({
      skills: { items: [personal('deploy-check')] as never, loading: false, loaded: true, error: null },
    })
    await expect(
      store().sharePersonalSkill('deploy-check', { ...input, slug: '  ' }),
    ).rejects.toBeInstanceOf(SkillSlugInvalidError)
    expect(uploads()).toHaveLength(0)
  })

  test('keeps the personal folder when an ASCII id is deliberately renamed', async () => {
    useTeamShareBrowserStore.setState({
      skills: { items: [personal('deploy-check')] as never, loading: false, loaded: true, error: null },
    })
    const retired = await store().sharePersonalSkill('deploy-check', {
      ...input,
      slug: 'deploy-check-2',
    })
    expect(retired).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('team_skill_retire_personal', expect.anything())
    expect(publishTeamSkill).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ slug: 'deploy-check-2', displayName: 'deploy-check' }),
    )
  })

  test('still refuses a generated id the team already owns', async () => {
    const slug = teamSkillSlugFromName(CHINESE)
    registry.push({ slug, createdBy: 'member-2', ownerActorId: 'member-2', latestVersion: 1 })
    useTeamShareBrowserStore.setState({
      skills: { items: [personal(CHINESE)] as never, loading: false, loaded: true, error: null },
    })
    await expect(
      store().sharePersonalSkill(CHINESE, { ...input, slug, displayName: CHINESE }),
    ).rejects.toBeInstanceOf(SkillSlugTakenError)
    expect(uploads()).toHaveLength(0)
  })
})
