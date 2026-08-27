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

vi.mock('@/components/apps/CreateAppDialog', () => ({
  CreateAppDialog: () => null,
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
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
    localStorage.clear()
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    useCurrentTeamStore.setState({ team: { id: 'team-1' } as never })
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha'), mkApp('app-2', 'Beta')],
      loading: false,
      selectedAppId: null,
      load: vi.fn(),
    })
  })

  it('defaults to a collapsed app list', () => {
    render(<AppsNavSection />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('title row selects apps filter without toggling the list', () => {
    render(<AppsNavSection />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /应用/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'apps' })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('chevron toggles the app list and persists to localStorage', () => {
    localStorage.setItem('teamclu.nav.appsExpanded', 'true')
    render(<AppsNavSection />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /收起/ }))
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(localStorage.getItem('teamclu.nav.appsExpanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: /展开/ }))
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('carries no action buttons — they live in the second column header now', () => {
    // The hover strip cost every row a fixed 64px right gutter, which is what
    // truncated the names in the screenshot that prompted the move.
    localStorage.setItem('teamclu.nav.appsExpanded', 'true')
    render(<AppsNavSection />)
    for (const label of [/部署/, /打开部署地址/, /在 Finder/]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
    const row = screen.getByRole('button', { name: /^Alpha/ })
    expect(row.className).not.toMatch(/\bpr-16\b/)
  })

  it('clicking an app selects it without opening a session', () => {
    const switchToSession = vi.spyOn(useUIStore.getState(), 'switchToSession').mockResolvedValue(undefined)
    localStorage.setItem('teamclu.nav.appsExpanded', 'true')
    render(<AppsNavSection />)
    fireEvent.click(screen.getByRole('button', { name: /^Alpha/ }))
    expect(useAppsStore.getState().selectedAppId).toBe('app-1')
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'apps' })
    expect(switchToSession).not.toHaveBeenCalled()
    switchToSession.mockRestore()
  })
})
