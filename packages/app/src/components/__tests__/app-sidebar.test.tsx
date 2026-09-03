import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const uiStoreMocks = vi.hoisted(() => ({
  defaultNavTab: 'session',
  switchToSession: vi.fn(() => Promise.resolve()),
  openSettings: vi.fn(),
  closeSettings: vi.fn(),
}))

const workspaceStoreMocks = vi.hoisted(() => ({
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  clearSelection: vi.fn(),
  setWorkspace: vi.fn(),
  workspacePath: '/workspace',
  workspaceName: 'workspace',
  isLoadingWorkspace: false,
  isPanelOpen: false,
  activeTab: 'shortcuts',
}))

const teamModeStoreMocks = vi.hoisted(() => ({
  teamModeType: null as string | null,
  loadTeamGitFileSyncStatus: vi.fn(),
}))

const authStoreMocks = vi.hoisted(() => ({
  session: {
    user: {
      id: 'user-1',
      email: 'matt@example.com',
      user_metadata: { name: 'Fallback User' },
    },
  },
  signOut: vi.fn(() => Promise.resolve()),
  sendUpgradeEmailOtp: vi.fn(() => Promise.resolve()),
  verifyUpgradeEmailOtp: vi.fn(() => Promise.resolve()),
  resetUpgradeOtp: vi.fn(),
  upgradeEmail: null,
  loading: false,
  errorMessage: null,
}))

const currentTeamStoreMocks = vi.hoisted(() => ({
  team: { id: 'team-1', name: 'OpenBeta', slug: 'openbeta' },
  currentMember: {
    id: 'member-1',
    displayName: 'Matt',
    role: 'owner',
    joinedAt: '2026-05-01T00:00:00.000Z',
  },
}))

const sessionStoreMocks = vi.hoisted(() => ({
  sessions: [
    { id: 's1', title: 'Session One', updatedAt: new Date('2025-01-01'), messages: [] },
    { id: 's2', title: 'Session Two', updatedAt: new Date('2025-01-02'), messages: [] },
  ],
  archivedSessions: [] as unknown[],
  pinnedSessionIds: ['s1'],
  importedSessionIds: [],
  activeSessionId: 's1',
  isLoading: false,
  isLoadingArchivedSessions: false,
  archivedSessionError: null as string | null,
  isLoadingMore: false,
  hasMoreSessions: false,
  visibleSessionCount: 50,
  highlightedSessionIds: [],
  pendingPermissions: [],
  pendingQuestions: [],
  setActiveSession: vi.fn(),
  archiveSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  toggleSessionPinned: vi.fn(),
  loadMoreSessions: vi.fn(),
  loadArchivedSessions: vi.fn(() => Promise.resolve()),
  openArchivedSession: vi.fn(() => Promise.resolve()),
  createSession: vi.fn(),
  removeImportedSession: vi.fn(),
  exportSession: vi.fn(),
}))

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, _opts?: Record<string, unknown>) => fallback,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/date-format', () => ({
  formatSessionDate: (d: Date) => d.toISOString(),
  formatRelativeTime: (d: Date) => d.toISOString(),
}))

// Mock stores
vi.mock('@/stores/session-store', () => ({
  useSessionStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel(sessionStoreMocks as unknown as Record<string, unknown>),
    { getState: () => sessionStoreMocks },
  ),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel(uiStoreMocks as unknown as Record<string, unknown>),
    { getState: () => uiStoreMocks },
  ),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks),
}))

vi.mock('@/stores/tabs', () => ({
  useTabsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    { getState: () => ({ hideAll: vi.fn() }) },
  ),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(teamModeStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel?: (s: Record<string, unknown>) => unknown) =>
    sel ? sel(authStoreMocks as unknown as Record<string, unknown>) : authStoreMocks,
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(currentTeamStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children, ...props }: any) => <div data-testid="sidebar" {...props}>{children}</div>,
  SidebarContent: ({ children, className }: any) => (
    <div data-testid="sidebar-content" className={className}>
      {children}
    </div>
  ),
  SidebarFooter: ({ children }: any) => <div>{children}</div>,
  SidebarHeader: ({ children }: any) => <div>{children}</div>,
  useSidebar: () => ({ toggleSidebar: vi.fn(), state: 'expanded' }),
}))

vi.mock('@/components/ui/traffic-lights', () => ({
  TrafficLights: () => null,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => <div onClick={onClick}>{children}</div>,
  DropdownMenuLabel: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/sidebar/NavRail', () => ({
  NavRail: () => <div data-testid="nav-rail" />,
}))

vi.mock('@/components/sidebar/LocalDaemonCard', () => ({
  LocalDaemonCard: () => null,
}))

vi.mock('@/components/sidebar/SessionListColumn', () => ({
  SessionListColumn: () => <div data-testid="session-list-column" />,
}))

import { AppSidebar } from '@/components/app-sidebar'

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStoreMocks.sessions = [
      { id: 's1', title: 'Session One', updatedAt: new Date('2025-01-01'), messages: [] },
      { id: 's2', title: 'Session Two', updatedAt: new Date('2025-01-02'), messages: [] },
    ]
    sessionStoreMocks.archivedSessions = []
    sessionStoreMocks.pinnedSessionIds = ['s1']
    sessionStoreMocks.activeSessionId = 's1'
    sessionStoreMocks.isLoadingArchivedSessions = false
    sessionStoreMocks.archivedSessionError = null
    sessionStoreMocks.highlightedSessionIds = []
    sessionStoreMocks.pendingPermissions = []
    sessionStoreMocks.pendingQuestions = []
    sessionStoreMocks.loadArchivedSessions = vi.fn(() => Promise.resolve())
    sessionStoreMocks.openArchivedSession = vi.fn(() => Promise.resolve())
    uiStoreMocks.defaultNavTab = 'session'
    uiStoreMocks.switchToSession = vi.fn(() => Promise.resolve())
    uiStoreMocks.openSettings = vi.fn()
    uiStoreMocks.closeSettings = vi.fn()
    workspaceStoreMocks.isPanelOpen = false
    workspaceStoreMocks.activeTab = 'shortcuts'
    workspaceStoreMocks.openPanel = vi.fn()
    workspaceStoreMocks.closePanel = vi.fn()
    teamModeStoreMocks.teamModeType = null
    authStoreMocks.session = {
      user: {
        id: 'user-1',
        email: 'matt@example.com',
        user_metadata: { name: 'Fallback User' },
      },
    }
    authStoreMocks.signOut = vi.fn(() => Promise.resolve())
    currentTeamStoreMocks.team = { id: 'team-1', name: 'OpenBeta', slug: 'openbeta' }
    currentTeamStoreMocks.currentMember = {
      id: 'member-1',
      displayName: 'Matt',
      role: 'owner',
      joinedAt: '2026-05-01T00:00:00.000Z',
    }
  })

  it('renders sidebar container', () => {
    render(<AppSidebar />)
    expect(screen.getByTestId('sidebar')).toBeDefined()
  })

  it('renders NavRail (SessionListColumn lives outside AppSidebar)', () => {
    render(<AppSidebar />)
    expect(screen.getByTestId('nav-rail')).toBeDefined()
    // SessionListColumn is now rendered as a sibling of AppSidebar in App.tsx,
    // not inside the sidebar shell — so it's intentionally absent here.
    expect(screen.queryByTestId('session-list-column')).toBeNull()
  })

  it('does not render a bottom Knowledge entry', () => {
    render(<AppSidebar />)
    expect(screen.queryByText('Knowledge')).toBeNull()
  })

  it('renders settings entry with english fallback text', () => {
    render(<AppSidebar />)
    expect(screen.getByText('Settings')).toBeDefined()
    expect(screen.queryByText('设置')).toBeNull()
  })

  it('preserves the settings footer row', () => {
    render(<AppSidebar />)
    expect(screen.getByText('Settings')).toBeDefined()
  })

  it('does not render a footer workspace selector', () => {
    render(<AppSidebar />)
    expect(screen.queryByTestId('workspace-name')).toBeNull()
  })

  it('renders the user account menu in the footer', () => {
    render(<AppSidebar />)
    expect(screen.getAllByText('Matt').length).toBeGreaterThan(0)
    expect(screen.getByText('matt@example.com')).toBeDefined()
    expect(screen.getByText('OpenBeta')).toBeDefined()
  })
})
