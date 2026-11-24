import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { AppListColumn } from '../AppListColumn'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTabsStore } from '@/stores/tabs'
import { useAppSidebarFilterStore } from '@/stores/app-relationship-filter'
import { useAppTouchStore } from '@/lib/apps/app-recency'
import { useSessionListStore } from '@/stores/session-list-store'
import { useLocalAgentInstallStore } from '@/stores/local-agent-install'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) =>
      (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, name) => values?.[name] ?? ''),
  }),
}))

// Real one would reach the cache and the network on mount.
vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectory: () => ({ actors: [{ id: 'actor-lin', display_name: 'Lin' }] }),
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
    // 我的 lists every app I made, here or not — what most of these cases need.
    useAppSidebarFilterStore.setState({ byTeam: { 'team-1': 'owner' } })
    useAppTouchStore.setState({ touchedAt: {} })
    useSessionListStore.setState({ rows: [] })
    useLocalAgentInstallStore.setState({ byTeam: {} })
    useAppsStore.setState({
      items: [mkApp('app-1', 'Alpha'), mkApp('app-2', 'Beta')],
      loading: false,
      selectedAppId: null,
      localAppIds: ['app-1'],
      deployingIds: [],
      appIdBySessionId: {},
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

  it('has no library button: the library is already the main view beside it', () => {
    render(<AppListColumn />)
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '所有应用' })).not.toBeInTheDocument()
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

  it('offers to create one when the team has no apps at all', () => {
    useAppsStore.setState({ items: [], localAppIds: [] })
    render(<AppListColumn />)
    expect(screen.getByText('还没有内容')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '新建' })).toHaveLength(1)
  })

  it('keeps names visible and does not download or open when no local agent is installed', () => {
    useLocalAgentInstallStore.setState({
      byTeam: { 'team-1': { status: 'absent', agentId: null, displayName: null } },
    })
    const download = vi.fn().mockResolvedValue(undefined)
    useAppsStore.setState({ download })
    render(<AppListColumn />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(
      screen.getByText('A local agent is not installed, so apps cannot be downloaded, opened, or created yet.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
    expect(useAppsStore.getState().selectedAppId).toBeNull()
    expect(download).not.toHaveBeenCalled()
  })

  describe('本机 / 我的 / 受邀', () => {
    beforeEach(() => {
      useAppSidebarFilterStore.setState({ byTeam: {} })
      useAppsStore.setState({
        items: [
          mkApp('a', 'Own here', { relationship: 'owner' }),
          mkApp('a2', 'Own away', { relationship: 'owner' }),
          mkApp('b', 'Shared here', { relationship: 'invited', invitedByActorId: 'actor-lin' }),
          mkApp('b2', 'Shared away', { relationship: 'invited' }),
          mkApp('c', 'Common here', { relationship: 'team', visibility: 'team' }),
          mkApp('d', 'Common away', { relationship: 'team', visibility: 'team' }),
        ],
        localAppIds: ['a', 'b', 'c'],
      })
    })

    const names = () => screen.getAllByTestId('app-row-status').map((el) => el.closest('button')!.textContent)

    it('offers exactly 本机, 我的 and 受邀, starting on 本机', () => {
      render(<AppListColumn />)
      expect(screen.getByTestId('app-relationship-chip-local')).toHaveTextContent('本机3')
      expect(screen.getByTestId('app-relationship-chip-owner')).toHaveTextContent('我的2')
      expect(screen.getByTestId('app-relationship-chip-invited')).toHaveTextContent('受邀2')
      expect(screen.queryByTestId('app-relationship-chip-all')).not.toBeInTheDocument()
      expect(screen.queryByTestId('app-relationship-chip-team')).not.toBeInTheDocument()
      expect(screen.getByTestId('app-relationship-chip-local')).toHaveAttribute('aria-pressed', 'true')
    })

    it('本机 is every app here, whoever it belongs to, and nothing else', () => {
      render(<AppListColumn />)
      expect(screen.getByText('Own here')).toBeInTheDocument()
      expect(screen.getByText('Shared here')).toBeInTheDocument()
      expect(screen.getByText('Common here')).toBeInTheDocument()
      expect(screen.queryByText('Own away')).not.toBeInTheDocument()
      expect(screen.queryByText('Common away')).not.toBeInTheDocument()
    })

    it('本机 puts the app I used last on top: opened here, or a session that moved', () => {
      useAppTouchStore.setState({ touchedAt: { c: '2026-11-20T00:00:00.000Z' } })
      useSessionListStore.setState({
        rows: [
          { id: 's1', app_id: 'b', last_message_at: '2026-11-22T00:00:00.000Z', updated_at: null },
        ] as never,
      })
      render(<AppListColumn />)
      expect(names()[0]).toContain('Shared here')
      expect(names()[1]).toContain('Common here')
      expect(names()[2]).toContain('Own here')
    })

    it('我的 and 受邀 list them wherever they are, the absent ones marked', () => {
      render(<AppListColumn />)
      fireEvent.click(screen.getByTestId('app-relationship-chip-owner'))
      expect(screen.getByText('Own here')).toBeInTheDocument()
      expect(screen.getByText('Own away')).toBeInTheDocument()
      expect(screen.queryByText('Shared here')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Own away/ })).toContainElement(
        screen.getByTestId('app-row-not-downloaded'),
      )
      expect(useAppSidebarFilterStore.getState().byTeam['team-1']).toBe('owner')

      fireEvent.click(screen.getByTestId('app-relationship-chip-invited'))
      expect(screen.getByText('Shared here')).toBeInTheDocument()
      expect(screen.getByText('Shared away')).toBeInTheDocument()
      expect(screen.queryByText('Own here')).not.toBeInTheDocument()
      expect(screen.queryByText('Common away')).not.toBeInTheDocument()
    })

    it('says under each icon in 本机 how I am related to the app, with the inviter on hover', () => {
      render(<AppListColumn />)
      const labelIn = (name: RegExp) =>
        within(screen.getByRole('button', { name })).getByTestId('app-row-relationship')
      expect(labelIn(/Own here/)).toHaveTextContent('我的')
      expect(labelIn(/Common here/)).toHaveTextContent('团队')
      expect(labelIn(/Shared here/)).toHaveTextContent(/^受邀$/)
      expect(labelIn(/Shared here/)).toHaveAttribute('title', 'Lin 邀请')
      expect(labelIn(/Own here/)).not.toHaveAttribute('title')
    })

    it('drops the row label under 我的 / 受邀 — every row would say the same word', () => {
      render(<AppListColumn />)
      expect(screen.getAllByTestId('app-row-relationship')).toHaveLength(3)
      fireEvent.click(screen.getByTestId('app-relationship-chip-owner'))
      expect(screen.queryByTestId('app-row-relationship')).not.toBeInTheDocument()
    })

    it('shrinks the icon only to make room for the word under it', () => {
      render(<AppListColumn />)
      expect(screen.getAllByTestId('app-row-icon')[0]).toHaveClass('h-6', 'w-6')
      fireEvent.click(screen.getByTestId('app-relationship-chip-owner'))
      expect(screen.getAllByTestId('app-row-icon')[0]).toHaveClass('h-7', 'w-7')
    })

    it('keeps the label off the status line, so it never squeezes the status', () => {
      render(<AppListColumn />)
      const status = screen.getAllByTestId('app-row-status')[0]
      const label = screen.getAllByTestId('app-row-relationship')[0]
      expect(status.parentElement).not.toContainElement(label)
    })

    it('本机 is empty, not guessed, while the daemon has not answered', () => {
      useAppsStore.setState({ localAppIds: null })
      render(<AppListColumn />)
      expect(screen.getByText('本机还没有应用')).toBeInTheDocument()
    })

    it('an empty filter says so', () => {
      useAppSidebarFilterStore.setState({ byTeam: { 'team-1': 'invited' } })
      useAppsStore.setState({ items: [mkApp('a', 'Own', { relationship: 'owner' })] })
      render(<AppListColumn />)
      expect(screen.getByText('没有受邀的应用')).toBeInTheDocument()
    })
  })

  it('refreshes the local half on mount', () => {
    render(<AppListColumn />)
    expect(useAppsStore.getState().refreshLocalApps).toHaveBeenCalledWith('team-1')
  })
})
