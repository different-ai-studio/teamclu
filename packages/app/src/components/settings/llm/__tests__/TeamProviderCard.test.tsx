import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const t = (k: string, d?: string) => d ?? k

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN', changeLanguage: vi.fn() } }),
}))

const teamState = vi.hoisted(() => ({ team: { id: 'team-1' } as { id: string } | null }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: unknown) => unknown) => sel(teamState),
}))

const { TeamProviderCard } = await import('../TeamProviderCard')

describe('TeamProviderCard', () => {
  it('pins the three tiers and offers no way to remove or disconnect them', () => {
    teamState.team = { id: 'team-1' }
    render(<TeamProviderCard />)

    expect(screen.getByText('团队模型')).toBeTruthy()
    // Collapsed: the tiers are behind the disclosure, the pinned badge is not.
    expect(screen.getByText('内置')).toBeTruthy()
    expect(screen.queryByText('default')).toBeNull()

    fireEvent.click(screen.getByText('团队模型'))
    for (const id of ['default', 'pro', 'max']) {
      expect(screen.getByText(id)).toBeTruthy()
    }
    expect(screen.getByText('标准')).toBeTruthy()
    expect(screen.getByText('高级')).toBeTruthy()
    expect(screen.getByText('旗舰')).toBeTruthy()

    // The whole point of the card: the team's plan is the credential, so there
    // is no control here that could take it away.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when the user has no team to bill against', () => {
    teamState.team = null
    const { container } = render(<TeamProviderCard />)
    expect(container.firstChild).toBeNull()
  })
})

describe('team gateway runtime compatibility', () => {
  // Source-scan guard, in the spirit of no-supabase-import.test.ts: the team
  // tiers reach a session through opencode's `provider.team` or pi's provider
  // config. cursor and claude-code drive their own vendor accounts and have no
  // hook for it, so pinning the card in their panes would promise a model those
  // runtimes cannot serve.
  const settingsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

  it('is imported by the opencode and pi panes only', () => {
    const panes = ['LLMSection.tsx', 'PiLLMSection.tsx', 'CursorLLMSection.tsx', 'ClaudeLLMSection.tsx']
    const importers = panes.filter((f) =>
      fs.readFileSync(path.join(settingsDir, f), 'utf8').includes('TeamProviderCard'),
    )
    expect(importers.sort()).toEqual(['LLMSection.tsx', 'PiLLMSection.tsx'])
  })
})
