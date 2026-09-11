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

  it('lists the team\'s apps and marks the ones that are not here', () => {
    // Hiding them was worse than marking them: the same account on a second
    // computer saw an empty column and no sign the apps existed at all.
    render(<AppListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    const marks = screen.getAllByTestId('app-row-not-downloaded')
    expect(marks).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Beta/ })).toContainElement(marks[0])
  })

  it('marks nothing while the daemon has not answered yet', () => {
    // `null` is "unknown", not "none": greying every row out would say the
    // user's apps are gone every time the daemon is slow to start.
    useAppsStore.setState({ localAppIds: null })
    render(<AppListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByTestId('app-row-not-downloaded')).not.toBeInTheDocument()
  })

  it('picking an app that is here is the whole of drilling in', () => {
    // Nothing else happens — no session is opened, no dialog. `AppsColumn`
    // reads this and swaps the column for that app's sessions.
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(useAppsStore.getState().selectedAppId).toBe('app-1')
  })

  it('picking an app that is not here downloads it instead of opening it', async () => {
    // Its sessions are in the cloud, but there is nothing on this machine for
    // an agent to run in — so the click has to fetch the code, not show a list
    // of conversations that cannot be continued.
    const download = vi.fn().mockResolvedValue(undefined)
    useAppsStore.setState({ download })
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-2' }))
    await Promise.resolve()
    expect(useAppsStore.getState().selectedAppId).toBeNull()
  })

  it('drills in once the download has actually landed', async () => {
    const download = vi.fn().mockImplementation(async () => {
      useAppsStore.setState({ localAppIds: ['app-1', 'app-2'] })
    })
    useAppsStore.setState({ download })
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
    await vi.waitFor(() => expect(useAppsStore.getState().selectedAppId).toBe('app-2'))
  })

  it('creating opens the form in column three, not a modal', () => {
    // Reached from the empty state, which is now the only create affordance in
    // this column: the header's `+` duplicated the library's own 新建 one click
    // earlier and made the header read as two competing actions.
    useAppsStore.setState({ items: [], localAppIds: [] })
    render(<AppListColumn />)
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: 'native', target: 'app-create' })
  })

  it('the header offers only the library, never a second create button', () => {
    render(<AppListColumn />)
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '所有应用' })).toBeInTheDocument()
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

  it('offers both ways out when the team has no apps at all', () => {
    useAppsStore.setState({ items: [], localAppIds: [] })
    render(<AppListColumn />)
    expect(screen.getByText('还没有内容')).toBeInTheDocument()
    // One create button (the empty state's), two ways to the library (the
    // header icon and the empty state's own button).
    expect(screen.getAllByRole('button', { name: '新建' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '所有应用' })).toHaveLength(2)
  })

  it('refreshes the local half on mount', () => {
    render(<AppListColumn />)
    expect(useAppsStore.getState().refreshLocalApps).toHaveBeenCalledWith('team-1')
  })
})
