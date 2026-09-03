import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const uiStoreState = vi.hoisted(() => ({
  currentView: 'chat',
  sidebarFilter: { kind: 'all' } as { kind: string; section?: string },
  closeSettings: vi.fn(),
  layoutMode: 'task',
  mainContentLayout: 'stacked',
  toggleMainContentLayout: vi.fn(() => {
    uiStoreState.mainContentLayout =
      uiStoreState.mainContentLayout === 'stacked' ? 'split' : 'stacked'
  }),
  fileModeRightTab: 'agent',
  setFileModeRightTab: vi.fn(),
  toggleLayoutMode: vi.fn(),
  openSettings: vi.fn(),
}))

const workspaceStoreState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  workspaceBootstrapped: false,
  workspaceReady: false,
  isPanelOpen: false,
  activeTab: 'shortcuts',
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  clearWorkspace: vi.fn(),
  selectedFile: null as string | null,
  fileContent: '',
  isLoadingFile: false,
  clearSelection: vi.fn(),
  selectFile: vi.fn(),
}))

const sidebarState = vi.hoisted(() => ({
  state: 'expanded',
  open: true,
  setOpen: vi.fn(),
}))

const teamModeState = vi.hoisted(() => ({
  devUnlocked: false,
  teamModeType: null as string | null,
}))

const tabsStoreState = vi.hoisted(() => ({
  activeTab: null as null | { id: string; type: string; target: string },
  tabs: [] as Array<{ id: string; type: string; target: string }>,
  activeTabId: null as string | null,
}))
const teamShareBrowserState = vi.hoisted(() => ({
  detailTarget: null as null | { kind: string; name?: string; id?: string; keyId?: string },
  clearDetail: vi.fn(),
}))
const currentTeamStoreState = vi.hoisted(() => ({
  team: null as null | { id: string },
  currentMember: null as null | { id: string },
  teamUserId: null as string | null,
  load: () => Promise.resolve(),
  reloadAndSwitchTo: () => Promise.resolve(),
}))

// Polyfill browser APIs missing in jsdom
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
})

// Mock everything App depends on
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    promise: vi.fn(),
    custom: vi.fn(),
  }),
}))
vi.mock('@/lib/utils', () => ({
  cn: (...a: string[]) => a.join(' '),
  isTauri: () => false,
  removeStartupSkeleton: () => {},
}))
vi.mock('@/lib/config/platform', () => ({
  isChromeExtension: () => false,
  getAppPlatform: () => 'web',
  capabilities: {
    workspace: true,
    tauriInvoke: false,
    pageCapture: false,
  },
}))
vi.mock('@/lib/config/build-config', () => ({
  appShortName: 'teamclu',
  appStoragePrefix: 'teamclu',
  appScheme: 'teamclu',
  deeplinkSchemes: ['teamclu', 'teamclaw', 'amux'],
  TEAM_REPO_DIR: 'teamclu-team',
  buildConfig: {
    app: { name: 'TeamClu' },
    features: {},
  },
}))
vi.mock('@/components/FileEditor', () => ({ FileContentViewer: () => <div data-testid="file-content-viewer" /> }))
// STR-11: one module per hook now (was `@/hooks/useAppInit`).
vi.mock('@/hooks/use-workspace-init', () => ({
  useWorkspaceInit: () => ({ initialWorkspaceResolved: true }),
}))
vi.mock('@/hooks/use-opencode-preload', () => ({ useOpenCodePreload: vi.fn() }))
vi.mock('@/hooks/use-channel-gateway-init', () => ({ useChannelGatewayInit: vi.fn() }))
vi.mock('@/hooks/use-git-repos-init', () => ({ useGitReposInit: vi.fn() }))
vi.mock('@/hooks/use-cron-init', () => ({ useCronInit: vi.fn() }))
vi.mock('@/hooks/use-workspace-runtime-refresh-poll', () => ({
  useWorkspaceRuntimeRefreshPoll: vi.fn(),
}))
vi.mock('@/hooks/use-external-link-handler', () => ({ useExternalLinkHandler: vi.fn() }))
vi.mock('@/hooks/use-tauri-body-class', () => ({ useTauriBodyClass: vi.fn() }))
vi.mock('@/hooks/use-telemetry-consent', () => ({
  useTelemetryConsent: () => ({ showConsentDialog: false, setShowConsentDialog: vi.fn() }),
}))
vi.mock('@/hooks/useMCPFileWatcher', () => ({ useMCPFileWatcher: vi.fn() }))
vi.mock('@/hooks/use-file-editor-state', () => ({
  usePanelAutoOpen: vi.fn(),
  useLayoutModePanelSync: vi.fn(),
  useFileTabSync: vi.fn(),
  useResizablePanels: () => ({
    rightPanelWidth: 300,
    handleRightPanelResize: vi.fn(),
    mainSplitLeftWidth: 560,
    handleMainSplitResize: vi.fn(),
  }),
}))
vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <div data-testid="sidebar">sidebar</div>,
  SidebarIconGroup: () => null,
  SidebarCollapseToggle: () => null,
  SidebarSecondarySessionActions: () => null,
}))
vi.mock('@/components/sidebar/SidebarSecondColumn', () => ({
  SidebarSecondColumn: () => <div data-testid="sidebar-second-column" />,
}))
vi.mock('@/components/settings/section-registry', () => ({
  SettingsSectionBody: () => <div data-testid="settings-section-body" />,
}))
vi.mock('@/components/chat/ChatPanel', () => ({ ChatPanel: () => <div data-testid="chat-panel">chat</div> }))
vi.mock('@/components/chat/NewSessionDialog', () => ({ NewSessionDialog: () => null }))
vi.mock('@/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/components/updater/UpdateDialog', () => ({ UpdateDialogContainer: () => null }))
vi.mock('@/components/panel/RightPanel', () => ({
  RightPanel: () => null,
}))
vi.mock('@/components/settings', () => ({ Settings: () => <div>settings</div> }))
vi.mock('@/components/settings/FeedbackDialog', () => ({ FeedbackDialog: () => null }))
vi.mock('@/components/telemetry/TelemetryConsentDialog', () => ({ TelemetryConsentDialog: () => null }))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: vi.fn((sel: (s: any) => any) => {
    const state = {
      getActiveSession: () => null, todos: [], sessionDiff: [],
      createSession: vi.fn(), sessions: [], setActiveSession: vi.fn(),
      reloadActiveSessionMessages: vi.fn(),
    }
    return sel(state)
  }),
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    vi.fn((sel: (s: any) => any) => {
      return sel(uiStoreState)
    }),
    { getState: () => uiStoreState, subscribe: () => () => {} },
  ),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    return sel(workspaceStoreState)
  }),
}))
// Mock the current-team store so App's mount-time load() doesn't fire the real
// Tauri-invoke path (unavailable in jsdom) and leak unhandled rejections.
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    vi.fn((sel: (s: any) => any) => sel(currentTeamStoreState)),
    { getState: () => currentTeamStoreState, setState: vi.fn(), subscribe: () => () => {} },
  ),
  setLocalCacheTeamGate: () => Promise.resolve(),
  readCachedCurrentTeam: () => null,
  writeCachedCurrentTeam: () => {},
  initialCurrentTeamState: () => ({ team: null, currentMember: null, teamUserId: null }),
}))
vi.mock('@/stores/tabs', () => ({
  useTabsStore: Object.assign(
    vi.fn((sel: (s: any) => any) => sel({
      tabs: tabsStoreState.tabs,
      activeTabId: tabsStoreState.activeTabId,
      getActiveTab: () => tabsStoreState.activeTab,
    })),
    { getState: () => ({
      openTab: vi.fn(),
      closeTab: vi.fn(),
      hideAll: vi.fn(),
      restoreLastTab: vi.fn(),
      tabs: tabsStoreState.tabs,
      activeTabId: tabsStoreState.activeTabId,
      getActiveTab: () => tabsStoreState.activeTab,
    }) }
  ),
  selectActiveTab: () => tabsStoreState.activeTab,
  selectHasHiddenTabs: (_s: any) => false,
}))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: vi.fn((sel: (s: any) => any) => sel(teamShareBrowserState)),
}))
vi.mock('@/components/teamshare/TeamShareTabContent', () => ({
  TeamShareDetailContent: ({ target }: { target: { kind: string } }) => (
    <div data-testid="team-share-detail">{target.kind}</div>
  ),
}))
vi.mock('@/components/tab-bar/TabBar', () => ({ TabBar: () => <div data-testid="tab-bar" /> }))
vi.mock('@/components/tab-bar/TabContentRenderer', () => ({ TabContentRenderer: () => <div data-testid="tab-content-renderer" /> }))
vi.mock('@/components/tab-bar/WebViewToolbar', () => ({ WebViewToolbar: () => null }))
vi.mock('@/components/tab-bar/FindInPageBar', () => ({ FindInPageBar: () => null }))
vi.mock('@/lib/ui/webview-utils', () => ({ urlToLabel: (u: string) => u }))
vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: vi.fn((sel: (s: any) => any) => sel(teamModeState)),
}))
vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectory: () => ({
    actors: [],
    loading: false,
    error: false,
    refetch: vi.fn(),
  }),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    vi.fn((sel: (s: any) => any) =>
      sel({ team: null, currentMember: null, load: vi.fn(), reloadAndSwitchTo: vi.fn() })
    ),
    {
      getState: () => ({ team: null, currentMember: null, load: vi.fn(), reloadAndSwitchTo: vi.fn() }),
      // idea-detail subscribes at module scope to clear its pane on team switch.
      subscribe: () => () => {},
    }
  ),
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useSidebar: () => sidebarState,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/separator', () => ({
  Separator: () => <hr />,
}))
vi.mock('@/components/ui/traffic-lights', () => ({ TrafficLights: () => null }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => open ? <>{children}</> : null,
  DialogContent: ({ children, showCloseButton: _showCloseButton, ...props }: any) => <div role="dialog" {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  DialogHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <>{children}</>,
  DropdownMenuItem: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
}))

import App from '../App'

describe('App', () => {
  beforeEach(() => {
    uiStoreState.currentView = 'chat'
    uiStoreState.sidebarFilter = { kind: 'all' }
    uiStoreState.layoutMode = 'task'
    uiStoreState.mainContentLayout = 'stacked'
    uiStoreState.fileModeRightTab = 'agent'
    workspaceStoreState.workspacePath = null
    workspaceStoreState.isPanelOpen = false
    workspaceStoreState.activeTab = 'shortcuts'
    teamModeState.devUnlocked = false
    teamModeState.teamModeType = null
    tabsStoreState.activeTab = null
    tabsStoreState.tabs = []
    tabsStoreState.activeTabId = null
    teamShareBrowserState.detailTarget = null
    teamShareBrowserState.clearDetail.mockReset()
    sidebarState.state = 'expanded'
    sidebarState.open = true
    sidebarState.setOpen.mockReset()
  })

  it('renders without crashing', () => {
    const { container } = render(<App />)
    expect(container).toBeTruthy()
  })

  it('opens settings as a modal panel over the current workspace', async () => {
    uiStoreState.currentView = 'settings'
    workspaceStoreState.workspacePath = '/workspace'

    render(<App />)

    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    expect(dialog.className).toContain('w-[min(960px,calc(100vw-4rem))]')
    // The settings body is lazy-loaded into the already-open dialog.
    expect(await screen.findByText('settings')).toBeInTheDocument()
  })

  // The `files` right-panel tab and its BookOpen header entry went with the RAG
  // knowledge browser; team knowledge is reached from the left-nav Knowledge
  // column instead. The two tests that covered them were removed with it.

  it('does not show the DEV badge even when devUnlocked is true', () => {
    teamModeState.devUnlocked = true

    render(<App />)

    expect(screen.queryByText('DEV')).toBeNull()
  })

  it('only shows the hide files button in stacked layout', () => {
    workspaceStoreState.workspacePath = '/workspace'
    tabsStoreState.activeTab = { id: 'tab-1', type: 'webview', target: 'https://example.com' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    const { rerender } = render(<App />)
    expect(screen.getByTitle('Hide files')).toBeTruthy()

    uiStoreState.mainContentLayout = 'split'
    rerender(<App />)

    expect(screen.queryByTitle('Hide files')).toBeNull()
    expect(screen.queryByTitle('Show files')).toBeNull()
  })

  it('does not show the file empty-state prompt in stacked layout without active tabs', () => {
    workspaceStoreState.workspacePath = '/workspace'

    render(<App />)

    expect(screen.queryByText('Select a file or web tab')).toBeNull()
  })

  it.each([
    ['skills', 'Skills'],
    ['mcp', 'MCP'],
    ['env', 'Environment Variables'],
    ['knowledge', 'Knowledge'],
  ])('shows the %s page title instead of New Chat', (section, title) => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'teamShare', section }

    render(<App />)

    expect(screen.getByRole('button', { name: title })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Chat' })).toBeNull()
  })

  it('renders team-share item details directly without the tab bar', async () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'teamShare', section: 'mcp' }
    teamShareBrowserState.detailTarget = { kind: 'mcp', name: 'memory' }
    tabsStoreState.activeTab = { id: 'tab-1', type: 'file', target: '/workspace/notes.md' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    // The team-share detail pane is lazy-loaded.
    expect(await screen.findByTestId('team-share-detail')).toHaveTextContent('mcp')
    expect(screen.queryByTestId('tab-bar')).toBeNull()
    expect(screen.queryByTestId('tab-content-renderer')).toBeNull()
  })

  it('keeps knowledge files in the existing tab layout', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'teamShare', section: 'knowledge' }
    tabsStoreState.activeTab = { id: 'tab-1', type: 'file', target: '/workspace/knowledge/spec.md' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    expect(screen.getByTestId('tab-bar')).toBeInTheDocument()
    expect(screen.getByTestId('file-content-viewer')).toBeInTheDocument()
    expect(screen.queryByTestId('team-share-detail')).toBeNull()
  })

  it('renders split main content with file area on the left and chat on the right', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.mainContentLayout = 'split'
    tabsStoreState.activeTab = { id: 'tab-1', type: 'webview', target: 'https://example.com' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    expect(screen.getByTestId('main-content-split')).toBeTruthy()
    expect(screen.getByTestId('main-content-split-resize-handle')).toBeTruthy()
    expect(screen.getByTestId('tab-content-renderer')).toBeTruthy()
    expect(screen.getByTestId('chat-panel')).toBeTruthy()
  })
})
