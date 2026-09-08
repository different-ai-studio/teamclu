import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppsNavSection } from '../AppsNavSection'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

const mkApp = (id: string, name: string): AppRow => ({
  id,
  teamId: 'team-1',
  name,
  slug: id,
  type: 'static_web',
  visibility: 'personal',
  workspaceId: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  provisionStatus: 'ready',
  fcStatus: null,
  fcEndpoint: null,
  publicUrl: null,
  authMode: 'none',
  runtime: 'node',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('AppsNavSection', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    useCurrentTeamStore.setState({ team: { id: 'team-1' } as never })
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha'), mkApp('app-2', 'Beta')],
      loading: false,
      selectedAppId: null,
      localAppIds: null,
      load: vi.fn(),
      refreshLocalApps: vi.fn(),
    })
  })

  it('is one row — the app list lives in column two now', () => {
    render(<AppsNavSection />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
    // The two things that used to sit on this row: the expand chevron and the
    // library button. Both moved out with the list.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('counts only what is on this machine', () => {
    useAppsStore.setState({ localAppIds: ['app-2'] })
    render(<AppsNavSection />)
    expect(screen.getByRole('button', { name: /^应用/ })).toHaveTextContent('1')
  })

  it('counts everything while the daemon has not answered yet', () => {
    // `null` is "unknown", not "none" — counting zero here would say the
    // user's apps are gone every time the daemon is slow to start.
    useAppsStore.setState({ localAppIds: null })
    render(<AppsNavSection />)
    expect(screen.getByRole('button', { name: /^应用/ })).toHaveTextContent('2')
  })

  it('opens the section on the list, not on the last app', () => {
    useAppsStore.setState({ selectedAppId: 'app-1' })
    render(<AppsNavSection />)
    fireEvent.click(screen.getByRole('button', { name: /^应用/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'apps' })
    // Column two switches on this: with a selection it renders that app's
    // sessions, so leaving it set would make this row unable to reach the list.
    expect(useAppsStore.getState().selectedAppId).toBe(null)
  })
})
