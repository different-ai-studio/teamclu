import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const uiStoreState = vi.hoisted(() => ({
  currentView: 'chat',
  sidebarFilter: { kind: 'all' } as { kind: string; section?: string },
  closeSettings: vi.fn(),
  layoutMode: 'task',
  contentColumnMode: 'half' as 'half' | 'full',
  contentColumnRatio: 0.5,
  setContentColumnMode: vi.fn(),
  setContentColumnRatio: vi.fn(),
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
vi.mock('@/lib/config/build-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/config/build-config')>()
  return {
    ...actual,
    appShortName: 'teamclu',
    appStoragePrefix: 'teamclu',
    appScheme: 'teamclu',
    deeplinkSchemes: ['teamclu', 'teamclaw', 'amux'],
    TEAM_REPO_DIR: 'teamclu-team',
    buildConfig: {
      app: { name: 'TeamClu' },
      features: {},
    },
  }
})
vi.mock('@/components/FileEditor', () => ({ FileContentViewer: () => <div data-testid="file-content-viewer" /> }))
// STR-11: one module per hook now (was `@/hooks/useAppInit`).
vi.mock('@/hooks/use-workspace-init', () => ({
  useWorkspaceInit: () => ({ initialWorkspaceResolved: true }),
}))
vi.mock('@/hooks/use-opencode-preload', () => ({ useOpenCodePreload: vi.fn() }))
vi.mock('@/hooks/use-channel-gateway-init', () => ({ useChannelGatewayInit: vi.fn() }))
vi.mock('@/hooks/use-git-repos-init', () => ({ useGitReposInit: vi.fn() }))
vi.mock('@/hooks/use-cron-init', () => ({ useCronInit: vi.fn() }))
vi.mock('@/hooks/use-agent-app-changes', () => ({ useAgentAppChanges: vi.fn() }))
vi.mock('@/hooks/use-workspace-runtime-refresh-poll', () => ({
  useWorkspaceRuntimeRefreshPoll: vi.fn(),
}))
vi.mock('@/hooks/use-external-link-handler', () => ({ useExternalLinkHandler: vi.fn() }))
vi.mock('@/hooks/use-tauri-body-class', () => ({ useTauriBodyClass: vi.fn() }))
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
      switchScope: vi.fn(),
      tabs: tabsStoreState.tabs,
      activeTabId: tabsStoreState.activeTabId,
      getActiveTab: () => tabsStoreState.activeTab,
    }) }
  ),
  selectActiveTab: () => tabsStoreState.activeTab,
  selectHasHiddenTabs: (_s: any) =>
    tabsStoreState.tabs.length > 0 && tabsStoreState.activeTabId === null,
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
    uiStoreState.contentColumnMode = 'half'
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

  it('keeps column four off screen while no tab is active', () => {
    workspaceStoreState.workspacePath = '/workspace'

    render(<App />)

    expect(screen.queryByTestId('content-column')).toBeNull()
    expect(screen.queryByTestId('content-column-restore')).toBeNull()
  })

  it('opens column four beside the conversation in half mode', () => {
    workspaceStoreState.workspacePath = '/workspace'
    tabsStoreState.activeTab = { id: 'tab-1', type: 'webview', target: 'https://example.com' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    const column = screen.getByTestId('content-column')
    expect(column).toHaveAttribute('data-content-mode', 'half')
    expect(column).toContainElement(screen.getByTestId('tab-bar'))
    expect(column).toContainElement(screen.getByTestId('tab-content-renderer'))
    expect(screen.getByTestId('content-column-resize')).toBeInTheDocument()
    // The conversation is still on screen next to it.
    expect(screen.getByTestId('chat-panel').closest('.hidden')).toBeNull()
  })

  it('hides the conversation column while column four is full width', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.contentColumnMode = 'full'
    tabsStoreState.activeTab = { id: 'tab-1', type: 'file', target: '/workspace/notes.md' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    expect(screen.getByTestId('content-column')).toHaveAttribute('data-content-mode', 'full')
    expect(screen.queryByTestId('content-column-resize')).toBeNull()
    // Mounted (it keeps its state) but out of sight.
    expect(screen.getByTestId('chat-panel').closest('.hidden')).not.toBeNull()
  })

  it('offers to bring column four back when its tabs are hidden', () => {
    workspaceStoreState.workspacePath = '/workspace'
    tabsStoreState.tabs = [{ id: 'tab-1', type: 'file', target: '/workspace/notes.md' }]
    tabsStoreState.activeTabId = null

    render(<App />)

    expect(screen.queryByTestId('content-column')).toBeNull()
    expect(screen.getByTitle('Show files')).toBeInTheDocument()
  })

  it.each(['skills', 'mcp', 'env', 'knowledge'])(
    'hides the conversation while the %s section is selected',
    (section) => {
      workspaceStoreState.workspacePath = '/workspace'
      uiStoreState.sidebarFilter = { kind: 'teamShare', section }

      render(<App />)

      // Still mounted (it keeps its state), but out of sight.
      expect(screen.getByTestId('chat-panel').closest('.hidden')).not.toBeNull()
      expect(screen.getByTestId('section-detail')).toHaveAttribute('data-section', section)
    },
  )

  it.each([['ideas'], ['actors']])('hides the conversation for the %s section', (kind) => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind }

    render(<App />)

    expect(screen.getByTestId('chat-panel').closest('.hidden')).not.toBeNull()
    expect(screen.getByTestId('section-detail')).toHaveAttribute('data-section', kind)
  })

  it('keeps the conversation for the session list', () => {
    workspaceStoreState.workspacePath = '/workspace'

    render(<App />)

    expect(screen.getByTestId('chat-panel').closest('.hidden')).toBeNull()
    expect(screen.queryByTestId('section-detail')).toBeNull()
  })

  it('shows a team-share item where the conversation was, with column four beside it', async () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'teamShare', section: 'mcp' }
    teamShareBrowserState.detailTarget = { kind: 'mcp', name: 'memory' }
    tabsStoreState.activeTab = { id: 'tab-1', type: 'file', target: '/workspace/notes.md' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    // The team-share detail pane is lazy-loaded.
    const detail = await screen.findByTestId('team-share-detail')
    expect(detail).toHaveTextContent('mcp')
    expect(screen.getByTestId('section-detail')).toContainElement(detail)
    const column = screen.getByTestId('content-column')
    expect(column).not.toContainElement(detail)
    expect(column).toHaveAttribute('data-content-mode', 'half')
  })

  it('opens knowledge files in column four', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'teamShare', section: 'knowledge' }
    tabsStoreState.activeTab = { id: 'tab-1', type: 'file', target: '/workspace/knowledge/spec.md' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    const column = screen.getByTestId('content-column')
    expect(column).toContainElement(screen.getByTestId('tab-bar'))
    expect(column).toContainElement(screen.getByTestId('file-content-viewer'))
    // A document takes the conversation's place: no empty-state prompt, no
    // resize edge (there is nothing beside it to share the row with).
    expect(screen.queryByTestId('section-detail')).toBeNull()
    expect(screen.queryByTestId('content-column-resize')).toBeNull()
    expect(screen.getByTestId('chat-panel').closest('.hidden')).not.toBeNull()
  })

  it('prompts for a knowledge document until one is open', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'teamShare', section: 'knowledge' }

    render(<App />)

    expect(screen.getByTestId('knowledge-empty-state')).toBeInTheDocument()
  })

  it('opens a shortcut page in place of the conversation', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'shortcuts' }
    tabsStoreState.activeTab = { id: 'tab-1', type: 'file', target: '/workspace/notes.md' }
    tabsStoreState.tabs = [tabsStoreState.activeTab]
    tabsStoreState.activeTabId = 'tab-1'

    render(<App />)

    expect(screen.getByTestId('content-column')).toBeInTheDocument()
    expect(screen.queryByTestId('section-detail')).toBeNull()
    expect(screen.queryByTestId('content-column-resize')).toBeNull()
    expect(screen.getByTestId('chat-panel').closest('.hidden')).not.toBeNull()
  })

  it('prompts for a shortcut until one is open, with the conversation hidden', () => {
    workspaceStoreState.workspacePath = '/workspace'
    uiStoreState.sidebarFilter = { kind: 'shortcuts' }

    render(<App />)

    expect(screen.getByTestId('shortcuts-empty-state')).toBeInTheDocument()
    expect(screen.getByTestId('chat-panel').closest('.hidden')).not.toBeNull()
  })
})
