import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SidebarSecondColumn } from '../SidebarSecondColumn'
import { SidebarProvider } from '@/components/ui/sidebar'
import { useUIStore } from '@/stores/ui'
import { useShortcutsStore } from '@/stores/shortcuts'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('../SessionListColumn', () => ({
  SessionListColumn: () => <div data-testid="session-list-column" />,
}))

vi.mock('../AppSessionsColumn', () => ({
  AppSessionsColumn: () => <div data-testid="app-sessions-column" />,
}))

vi.mock('@/lib/config/remote-features', () => ({
  useFeatures: () => ({ apps: true }),
}))

// The column lazy-loads these from their leaf modules (not the panel barrel),
// so the mocks target the leaves.
vi.mock('@/components/panel/IdeasView', () => ({
  IdeasView: () => <div data-testid="ideas-list-column" />,
}))
vi.mock('@/components/panel/ActorsView', () => ({
  ActorsView: () => <div data-testid="actors-list-column" />,
}))

vi.mock('@/stores/tabs', () => ({
  selectActiveTab: () => null,
  useTabsStore: Object.assign(
    vi.fn((selector?: any) => {
      const state = {
        tabs: [],
        openTab: vi.fn(),
      }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ openTab: vi.fn(), tabs: [] }),
    },
  ),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((selector?: any) => {
    const state = { workspacePath: '/workspace' }
    return selector ? selector(state) : state
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    vi.fn((selector?: any) => {
      const state = { team: null }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ team: null }),
      subscribe: () => () => {},
    },
  ),
}))

describe('SidebarSecondColumn', () => {
  const renderWithSidebar = () =>
    render(
      <SidebarProvider>
        <SidebarSecondColumn />
      </SidebarProvider>,
    )

  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' }, embedMode: false })
    useShortcutsStore.setState({
      personalNodes: [
        {
          id: 'shortcut-1',
          scope: 'personal',
          ownerMemberId: null,
          teamId: null,
          parentId: null,
          label: 'Docs',
          icon: null,
          order: 0,
          type: 'link',
          target: 'https://docs.example.com',
          createdAt: '',
          updatedAt: '',
        },
      ],
      teamNodes: [],
      loading: false,
      loadedAt: null,
      teamRoles: null,
      shortcutVisibility: null,
    })
  })

  it('renders SessionListColumn for normal session filters', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    renderWithSidebar()
    expect(screen.getByTestId('session-list-column')).toBeInTheDocument()
  })

  // Every column other than the session list is lazy-loaded, so these await
  // the first paint of the column instead of asserting synchronously.
  it('renders shortcuts when the shortcuts filter is active', async () => {
    useUIStore.setState({ sidebarFilter: { kind: 'shortcuts' } })
    renderWithSidebar()
    expect(await screen.findByText('Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })

  it('renders the full ideas list when the ideas filter is active', async () => {
    useUIStore.setState({ sidebarFilter: { kind: 'ideas' } })
    renderWithSidebar()
    expect(await screen.findByTestId('ideas-list-column')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })

  it('renders the full actor list when the actors filter is active', async () => {
    useUIStore.setState({ sidebarFilter: { kind: 'actors' } })
    renderWithSidebar()
    expect(await screen.findByTestId('actors-list-column')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })

  it('falls back to sessions in embed mode when shortcuts or ideas filter is active', () => {
    useUIStore.setState({ embedMode: true, sidebarFilter: { kind: 'shortcuts' } })
    renderWithSidebar()
    expect(screen.getByTestId('session-list-column')).toBeInTheDocument()

    useUIStore.setState({ embedMode: true, sidebarFilter: { kind: 'ideas' } })
    renderWithSidebar()
    expect(screen.getAllByTestId('session-list-column').length).toBeGreaterThan(0)
  })

  it('renders AppSessionsColumn for apps filter (not the app list)', async () => {
    useUIStore.setState({ sidebarFilter: { kind: 'apps' } })
    renderWithSidebar()
    expect(await screen.findByTestId('app-sessions-column')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })
})
