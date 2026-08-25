import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

const teamState = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: { team: { id: string } | null }) => unknown) =>
    selector({ team: teamState.id ? { id: teamState.id } : null }),
}))

const workspaceState = vi.hoisted(() => ({ path: '/workspace' as string | null }))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: { workspacePath: string | null }) => unknown) =>
    selector({ workspacePath: workspaceState.path }),
}))

const { loadCounts, loadSection, setSidebarFilter } = vi.hoisted(() => ({
  loadCounts: vi.fn(),
  loadSection: vi.fn(),
  setSidebarFilter: vi.fn(),
}))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      loadCounts,
      loadSection,
      skills: { items: [] },
      mcp: { items: [] },
      envCount: 0,
      knowledge: { items: [] },
      skillLocalState: {},
    }),
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ sidebarFilter: { kind: 'sessions' }, setSidebarFilter }),
}))

import { TeamShareNavSection, useTeamShareCountsLoader } from '../TeamShareNavSection'

function CountsLoaderHarness() {
  useTeamShareCountsLoader()
  return null
}

describe('useTeamShareCountsLoader', () => {
  it('loads counts after the current team becomes available', async () => {
    teamState.id = null
    workspaceState.path = '/workspace'
    loadCounts.mockReset()

    const view = render(<CountsLoaderHarness />)
    expect(loadCounts).not.toHaveBeenCalled()

    teamState.id = 'team-1'
    view.rerender(<CountsLoaderHarness />)

    await waitFor(() => expect(loadCounts).toHaveBeenCalledTimes(1))
  })

  /**
   * Team-share content is the team's — the skill/MCP registries and the team's
   * own knowledge directory. Gating this on a workspace showed 0 for all four
   * sections on a client with no folder open, which reads as "the team has
   * nothing shared" rather than "not loaded yet".
   */
  it('loads counts with no workspace open', async () => {
    teamState.id = 'team-1'
    workspaceState.path = null
    loadCounts.mockReset()

    render(<CountsLoaderHarness />)

    await waitFor(() => expect(loadCounts).toHaveBeenCalledTimes(1))
  })

  it('reloads when a workspace opens, which adds this machine\'s local rows', async () => {
    teamState.id = 'team-1'
    workspaceState.path = null
    loadCounts.mockReset()

    const view = render(<CountsLoaderHarness />)
    await waitFor(() => expect(loadCounts).toHaveBeenCalledTimes(1))

    workspaceState.path = '/workspace'
    view.rerender(<CountsLoaderHarness />)

    await waitFor(() => expect(loadCounts).toHaveBeenCalledTimes(2))
  })
})

describe('TeamShareNavSection', () => {
  it('renders only the requested sections', () => {
    teamState.id = 'team-1'
    const { getByText, queryByText } = render(<TeamShareNavSection sections={['skills', 'knowledge']} />)

    expect(getByText('Skills')).toBeTruthy()
    expect(getByText('Knowledge')).toBeTruthy()
    expect(queryByText('MCP')).toBeNull()
    expect(queryByText('Team Env')).toBeNull()
  })
})
