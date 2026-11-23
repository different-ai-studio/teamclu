import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TeamSkillItem } from '@/stores/team-share-browser'
import { ShareSheet } from '../ShareSheet'
import { allocateTeamSkillSlug, teamSkillSlugFromName } from '@/lib/skills/team-skill-slug'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, unknown>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [name, value] of Object.entries(opts)) {
          text = text.replaceAll(`{{${name}}}`, String(value))
        }
      }
      return text
    },
  }),
}))

const CHINESE = '整车成本智能表格'

function item(overrides: Partial<TeamSkillItem> = {}): TeamSkillItem {
  return {
    id: `personal:${CHINESE}`,
    slug: CHINESE,
    name: CHINESE,
    invocationName: CHINESE,
    category: null,
    content: '',
    dirPath: '/home/.agents/skills',
    filename: CHINESE,
    origin: 'personal',
    kind: 'personal',
    personalSource: 'global-agent',
    personalSourceLabel: 'Agent',
    summary: '企业微信智能表格的读写技能',
    whenToUse: '',
    whenNotToUse: '',
    requires: null,
    status: null,
    supersededBy: null,
    ownerActorId: null,
    latestVersion: null,
    installed: true,
    installedVersion: null,
    hasUpdate: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function renderSheet(
  overrides: Partial<TeamSkillItem> = {},
  taken: string[] = [],
) {
  const onSubmit = vi.fn(async () => {})
  render(
    <ShareSheet
      item={item(overrides)}
      open
      busy={false}
      takenSlugs={new Set(taken)}
      onClose={() => {}}
      onSubmit={onSubmit}
    />,
  )
  return onSubmit
}

describe('ShareSheet slug', () => {
  it('keeps the Chinese title as the id, the share field, and the submitted slug', async () => {
    const onSubmit = renderSheet()
    const slug = screen.getByDisplayValue(CHINESE) as HTMLInputElement
    expect(slug.value).toBe(CHINESE)
    expect(screen.queryByText(/display name stays/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Share & install' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: CHINESE,
        displayName: CHINESE,
      }),
    )
  })

  it('leaves an ASCII slug alone', () => {
    renderSheet({
      id: 'personal:deploy-check',
      slug: 'deploy-check',
      name: 'deploy-check',
      filename: 'deploy-check',
      invocationName: 'deploy-check',
    })
    expect(screen.getByDisplayValue('deploy-check')).toBeTruthy()
    expect(screen.queryByText(/team id was generated/i)).toBeNull()
  })

  it('suffixes the default when that id is already in the team', () => {
    const base = teamSkillSlugFromName(CHINESE)
    renderSheet({}, [base])
    expect(screen.getByDisplayValue(allocateTeamSkillSlug(CHINESE, new Set([base])))).toBeTruthy()
    expect(screen.queryByText(/already has a skill/)).toBeNull()
  })

  it('blocks an empty slug', () => {
    const onSubmit = renderSheet()
    fireEvent.change(screen.getByDisplayValue(teamSkillSlugFromName(CHINESE)), {
      target: { value: '   ' },
    })
    expect(screen.getByText('Enter an id')).toBeTruthy()
    const submit = screen.getByRole('button', { name: 'Share & install' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('accepts a shorter Chinese id and blocks a slash or a Windows reserved name', () => {
    const onSubmit = renderSheet()
    const input = screen.getByDisplayValue(CHINESE)
    fireEvent.change(input, { target: { value: '整车' } })
    expect(screen.queryByText(/install folder and the skill name/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Share & install' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(input, { target: { value: '整车/成本' } })
    expect(screen.getByText(/install folder and the skill name/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Share & install' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'CON' } })
    expect(screen.getByText(/reserved on Windows/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Share & install' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('blocks a slug the team already has', () => {
    renderSheet({
      id: 'personal:deploy-check',
      slug: 'deploy-check',
      name: 'deploy-check',
      filename: 'deploy-check',
      invocationName: 'deploy-check',
    }, ['other-skill'])
    fireEvent.change(screen.getByDisplayValue('deploy-check'), { target: { value: 'other-skill' } })
    expect(screen.getByText(/already has a skill called other-skill/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Share & install' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
