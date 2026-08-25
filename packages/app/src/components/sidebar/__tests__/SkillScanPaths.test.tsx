import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

const { getSkillDirectories, homeDir } = vi.hoisted(() => ({
  getSkillDirectories: vi.fn(),
  homeDir: vi.fn(),
}))
vi.mock('@/lib/skills/loader', () => ({ getSkillDirectories }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir }))

import { SkillScanPaths, shortenScanPath } from '../SkillScanPaths'

const ROOTS = [
  '/ws/.claude/skills',
  '/Users/me/.agents/skills',
  '/ws/.agents/skills',
  '/Users/me/.amuxd/teams/t1/shared/teamclu-team/skills',
  '/Users/me/.claude/skills',
]

describe('shortenScanPath', () => {
  it('spells the workspace roots relative and the home roots with ~', () => {
    const opts = { home: '/Users/me', workspacePath: '/ws' }
    expect(shortenScanPath('/ws/.claude/skills', opts)).toBe('.claude/skills')
    expect(shortenScanPath('/Users/me/.agents/skills', opts)).toBe('~/.agents/skills')
  })

  it('leaves an unrelated absolute path alone', () => {
    expect(shortenScanPath('/opt/skills', { home: '/Users/me', workspacePath: '/ws' })).toBe(
      '/opt/skills',
    )
  })

  it('does not treat a sibling directory as being inside the workspace', () => {
    // `/ws-other` starts with `/ws` as a string but is a different directory.
    expect(shortenScanPath('/ws-other/.claude/skills', { workspacePath: '/ws' })).toBe(
      '/ws-other/.claude/skills',
    )
  })
})

describe('SkillScanPaths', () => {
  beforeEach(() => {
    getSkillDirectories.mockReset()
    homeDir.mockReset()
    homeDir.mockResolvedValue('/Users/me')
  })

  it('shows the first three roots and counts the rest', async () => {
    getSkillDirectories.mockResolvedValue(ROOTS)

    render(<SkillScanPaths workspacePath="/ws" />)

    await waitFor(() => expect(screen.getByText('.claude/skills')).toBeTruthy())
    expect(screen.getByText('~/.agents/skills')).toBeTruthy()
    expect(screen.getByText('.agents/skills')).toBeTruthy()
    // Fourth and fifth roots are only in the tooltip.
    expect(screen.queryByText('~/.claude/skills')).toBeNull()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('· 5')).toBeTruthy()
  })

  it('drops the "+N" badge when every root fits', async () => {
    getSkillDirectories.mockResolvedValue(ROOTS.slice(0, 2))

    render(<SkillScanPaths workspacePath="/ws" />)

    await waitFor(() => expect(screen.getByText('.claude/skills')).toBeTruthy())
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('renders nothing when the roots cannot be read', async () => {
    getSkillDirectories.mockRejectedValue(new Error('not tauri'))

    const { container } = render(<SkillScanPaths workspacePath={null} />)

    await waitFor(() => expect(getSkillDirectories).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="skill-scan-paths"]')).toBeNull()
  })

  it('re-reads the roots when the refresh key changes', async () => {
    getSkillDirectories.mockResolvedValue(ROOTS)

    const view = render(<SkillScanPaths workspacePath="/ws" refreshKey={0} />)
    await waitFor(() => expect(getSkillDirectories).toHaveBeenCalledTimes(1))

    view.rerender(<SkillScanPaths workspacePath="/ws" refreshKey={1} />)
    await waitFor(() => expect(getSkillDirectories).toHaveBeenCalledTimes(2))
  })
})
