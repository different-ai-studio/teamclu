import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppListColumn } from '../AppListColumn'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTabsStore } from '@/stores/tabs'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// Sidebar UI primitives call useSidebar() which requires a SidebarProvider.
vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {} }),
}))
vi.mock('@/components/app-sidebar', () => ({ SidebarCollapseToggle: () => null }))
vi.mock('@/components/ui/traffic-lights', () => ({ TrafficLights: () => null }))

const mkApp = (id: string, name: string, over: Partial<AppRow> = {}): AppRow => ({
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
  ...over,
})

describe('AppListColumn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCurrentTeamStore.setState({ team: { id: 'team-1' } as never })
    useTabsStore.setState({ tabs: [], activeTabId: null })
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha'), mkApp('app-2', 'Beta')],
      loading: false,
      selectedAppId: null,
      localAppIds: ['app-1'],
      deployingIds: [],
      refreshLocalApps: vi.fn().mockResolvedValue(undefined),
    })
  })

  it('lists only the apps on this machine', () => {
    render(<AppListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('lists everything while the daemon has not answered yet', () => {
    // `null` is "unknown", not "none": an empty list here would say the user's
    // apps are gone every time the daemon is slow to start.
    useAppsStore.setState({ localAppIds: null })
    render(<AppListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('picking an app is the whole of drilling in', () => {
    // Nothing else happens — no session is opened, no dialog. `AppsColumn`
    // reads this and swaps the column for that app's sessions.
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(useAppsStore.getState().selectedAppId).toBe('app-1')
  })

  it('+ opens the create form in column three, not a modal', () => {
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: 'native', target: 'app-create' })
  })

  it('gives each app type its own glyph', () => {
    // Eleven identical marks down the left edge said nothing about eleven
    // different apps. The class is lucide's own, one per icon.
    useAppsStore.setState({
      items: [
        mkApp('a', 'Site', { type: 'static_web' }),
        mkApp('b', 'Deck', { type: 'slides' }),
        mkApp('c', 'Data', { type: 'data_app' }),
        mkApp('d', 'Repo', { type: 'imported' }),
      ],
      localAppIds: null,
    })
    const { container } = render(<AppListColumn />)
    for (const icon of ['globe', 'presentation', 'database', 'folder-git-2']) {
      expect(container.querySelector(`svg.lucide-${icon}`), icon).not.toBeNull()
    }
  })

  it('the library opens in column three, not over this column', () => {
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: '所有应用' }))
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: 'native', target: 'app-library' })
    expect(useTabsStore.getState().activeTabId).toBe(tabs[0].id)
  })

  it('offers both ways out when nothing is here', () => {
    // Two reasons the list is empty — nothing created yet, or the team's apps
    // are simply not on this machine — and the second is the common one.
    useAppsStore.setState({ items: [], localAppIds: [] })
    render(<AppListColumn />)
    expect(screen.getByText('还没有内容')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '新建' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '所有应用' })).toHaveLength(2)
  })

  it('refreshes the local half on mount', () => {
    render(<AppListColumn />)
    expect(useAppsStore.getState().refreshLocalApps).toHaveBeenCalledWith('team-1')
  })
})
