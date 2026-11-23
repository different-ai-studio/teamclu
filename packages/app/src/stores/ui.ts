import { create } from 'zustand'
import { useDiagnosticsStore } from '@/stores/diagnostics-store'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'
import { resolveEmbedMode } from '@/lib/embed/embed-mode'
import { scheduleReleaseStuckModalLayers } from '@/lib/ui/modal-layer-cleanup'
import type { PageContext } from '@/lib/embed/embed-page-context'
import { loadFromStorage, saveToStorage } from '@/lib/config/storage'
import { appStoragePrefix } from '@/lib/config/build-config'
import {
  loadUiLayoutPrefs,
  persistUiLayoutPref,
  reconcileUiLayoutPrefs,
  type UiLayoutPrefKey,
  type UiLayoutPrefs,
} from '@/lib/config/ui-layout-prefs'

const NAV_PINNED_STORAGE_KEY = `${appStoragePrefix}-nav-pinned`
const SESSION_DRAWER_PINNED_STORAGE_KEY = `${appStoragePrefix}-session-drawer-pinned`

const LAYOUT_PREF_STORAGE_KEYS: Record<UiLayoutPrefKey, string> = {
  navPinned: NAV_PINNED_STORAGE_KEY,
  sessionDrawerPinned: SESSION_DRAWER_PINNED_STORAGE_KEY,
}

/** Layout keys the user changed since launch: the startup restore leaves them
 * alone, so a toggle made while the file is still being read is not undone. */
const layoutPrefsTouched = new Set<UiLayoutPrefKey>()

type View = 'chat' | 'settings'

/**
 * Release Radix scroll-lock/overlay residue after a *programmatic* view switch
 * (e.g. `switchToSession` flipping `currentView` out of `settings`). Controlled
 * `open=false` unmounts the Dialog without invoking its `onOpenChange` cleanup,
 * so without this the chat view stays covered by a dead overlay until a manual
 * close. Idempotent and a no-op while another modal is still open.
 */
function releaseStuckModalLayersAfterViewSwitch(): void {
  scheduleReleaseStuckModalLayers()
}

type LayoutMode = 'task'
/**
 * How the content column (column four: file previews, editors, web tabs) sits
 * next to the conversation while it has a tab showing. Hidden is not a mode:
 * the column is hidden exactly when no tab is active (see stores/tabs).
 */
export type ContentColumnMode = 'half' | 'full'

// Right panel tab in file mode
type FileModeRightTab = 'shortcuts' | 'changes' | 'files' | 'agent'
type DefaultPrimaryTab = 'session' | 'actors' | 'ideas' | 'shortcuts'
type DefaultMoreDestination = 'settings'

/** Preselected actor for the draft chat state: when the user taps an actor
 * row in the Actors tab, we record it here, switch nav back to Session, and
 * clear activeSessionId. ChatPanel's "no active session" branch then renders
 * a draft view that uses this actor's name as the title and creates a solo
 * session directly on send, bypassing the new-session dialog. */
export type DraftActor = { id: string; displayName: string; kind: 'member' | 'agent' }

/** Selector for what the workspace sidebar's column 2 displays. */
export type SidebarFilter =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'shortcuts' }
  | { kind: 'ideas' }
  | { kind: 'apps' }
  | { kind: 'actors' }
  /** `actorType` is carried for callers that want it; nothing reads it today.
   *  It spans every actor kind, external gateway contacts included. */
  | { kind: 'actor'; actorId: string; displayName: string; actorType: 'member' | 'agent' | 'external' }
  | { kind: 'idea'; ideaId: string; title: string }
  | { kind: 'teamShare'; section: TeamShareSection }

export type SettingsSection = 'llm' | 'general' | 'prompt' | 'channels' | 'automation' | 'daemonGeneral' | 'daemonWorkspaces' | 'daemonRuntimes' | 'envVars' | 'skills' | 'roles' | 'rolesSkills' | 'deps' | 'billing'
  | 'tokenUsage' | 'leaderboard' | 'shortcuts' | 'cache' | 'diagnostics'
  | 'knowledgeAcl' | 'teamRoles' | 'providerKeys' | 'operatorOrgs' | 'operatorCredits'

/** Context passed when opening Agent settings from a blocked quick-new-chat action. */
type DaemonGeneralPrompt = 'quick_chat'

interface UIState {
  /** True when the page was loaded with ?embed=chat — renders minimal layout. Read-only; no setter. */
  embedMode: boolean
  currentView: View
  layoutMode: LayoutMode
  contentColumnMode: ContentColumnMode
  /** Share of the row the content column takes in `half` mode (0.3–0.7). */
  contentColumnRatio: number
  fileModeRightTab: FileModeRightTab
  defaultNavTab: DefaultPrimaryTab
  defaultMoreOpen: boolean
  /** Toggle for the session-scoped Actors sheet (the right-side slideover
   * that lists members + agents for the current session). Lives in ui-store
   * so the header trigger (App.tsx) and the sheet mount (ChatPanel) can
   * share state. */
  actorSheetOpen: boolean
  settingsInitialSection: SettingsSection | null
  /** Shown as a banner in DaemonGeneralSection when the user was redirected here. */
  daemonGeneralPrompt: DaemonGeneralPrompt | null
  /**
   * Which org the operator console's credits screen should open filtered to.
   * Set when jumping there from an org row; the screen clears it once applied.
   */
  operatorOrgFilter: string | null
  draftPreselectedActor: DraftActor | null
  sidebarFilter: SidebarFilter
  ideasSectionCollapsed: boolean
  /** 更多 nav group (想法 / 应用 / 快捷方式 / MCP / 环境变量) is expanded. */
  moreNavExpanded: boolean
  /**
   * First column pinned open as the full list. Off (the default) it is the
   * icon rail that widens on hover. Wide windows only — App ignores it below
   * that. Persisted per install.
   */
  navPinned: boolean
  /**
   * The session drawer (files / actors / app settings) docked into column
   * three, pushing the conversation, instead of floating over its right edge.
   * Persisted per install.
   */
  sessionDrawerPinned: boolean
  /** Workspace list expanded (「管理 Workspace 列表」). */
  localDaemonExpanded: boolean
  /** Action sheet open (⋯ menu). */
  localDaemonSheetOpen: boolean
  /** Narrow layout's bottom sheet that stands in for the second column. In
   * the store, not in NarrowChatHeader, so picking a section in the nav drawer
   * can bring it up. */
  narrowListSheetOpen: boolean
  /** Standalone automation panel (CronSection) without opening full Settings. */
  automationPanelOpen: boolean
  /** App control panel (design §2.4) — mutually exclusive with workspace RightPanel. */
  appControlPanelOpen: boolean
  draftIdeaId: string | null
  /** Modal "新会话" dialog (NavRail ▾ menu + intercepted send-with-no-session). */
  newSessionDialogOpen: boolean
  /** Message text the dialog opens with — used when the user typed in the
   * empty-session input then hit send (we redirect into the dialog so the
   * draft isn't lost). */
  newSessionDialogInitialMessage: string | null
  openNewSessionDialog: (initialMessage?: string | null) => void
  closeNewSessionDialog: () => void
  setSidebarFilter: (filter: SidebarFilter) => void
  setNarrowListSheetOpen: (open: boolean) => void
  toggleIdeasSection: () => void
  toggleMoreNav: () => void
  setMoreNavExpanded: (expanded: boolean) => void
  setNavPinned: (pinned: boolean) => void
  setSessionDrawerPinned: (pinned: boolean) => void
  toggleLocalDaemon: () => void
  toggleLocalDaemonSheet: () => void
  setLocalDaemonSheetOpen: (open: boolean) => void
  openAutomationPanel: () => void
  closeAutomationPanel: () => void
  setAutomationPanelOpen: (open: boolean) => void
  openAppControlPanel: () => void
  closeAppControlPanel: () => void
  toggleAppControlPanel: () => void
  setDraftIdeaId: (ideaId: string) => void
  clearDraftIdeaId: () => void
  setView: (view: View) => void
  setDefaultMoreOpen: (open: boolean) => void
  setActorSheetOpen: (open: boolean) => void
  toggleActorSheet: () => void
  selectDefaultPrimaryTab: (tab: DefaultPrimaryTab) => void
  openDefaultMoreDestination: (destination: DefaultMoreDestination) => Promise<void> | void
  openSettings: (section?: SettingsSection) => void
  openOperatorTeams: (orgId: string | null) => void
  clearOperatorOrgFilter: () => void
  openDaemonAgentSettings: (prompt?: DaemonGeneralPrompt) => void
  clearDaemonGeneralPrompt: () => void
  closeSettings: () => void
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void
  setContentColumnMode: (mode: ContentColumnMode) => void
  setContentColumnRatio: (ratio: number) => void
  setFileModeRightTab: (tab: FileModeRightTab) => void
  startNewChat: () => void
  /** Incremented to request focus on the chat composer (e.g. after quick new session). */
  composerFocusRequestId: number
  requestComposerFocus: () => void
  /** Pending page-link chip insert — survives composer mount race after session switch. */
  pendingPageLinkInsert: PageContext | null
  pageLinkInsertRequestId: number
  requestPageLinkInsert: (ctx: PageContext) => void
  /** Open a session in the chat view. By default this also resets the sidebar
   *  to the session list, since the caller is usually leaving a
   *  actor/idea/workspace view. Pass `keepSidebarFilter` when column 2 is the
   *  list the session was launched from and should stay put (Apps). */
  switchToSession: (sessionId: string, opts?: { keepSidebarFilter?: boolean }) => Promise<void>
  enterActorDraft: (actor: DraftActor) => void
  clearActorDraft: () => void
}

export const useUIStore = create<UIState>((set, get) => ({
  embedMode:
    typeof window !== 'undefined'
      ? resolveEmbedMode(window.location.search, import.meta.env.VITE_FORCE_EMBED) === 'chat'
      : import.meta.env.VITE_FORCE_EMBED === 'chat',
  currentView: 'chat',
  layoutMode: 'task',
  contentColumnMode: 'half',
  contentColumnRatio: 0.5,
  fileModeRightTab: 'agent',
  defaultNavTab: 'session',
  defaultMoreOpen: false,
  actorSheetOpen: false,
  settingsInitialSection: null,
  daemonGeneralPrompt: null,
  operatorOrgFilter: null,
  draftPreselectedActor: null,
  sidebarFilter: { kind: 'all' },
  ideasSectionCollapsed: false,
  moreNavExpanded: false,
  navPinned: loadFromStorage<boolean>(NAV_PINNED_STORAGE_KEY, false),
  sessionDrawerPinned: loadFromStorage<boolean>(SESSION_DRAWER_PINNED_STORAGE_KEY, false),
  localDaemonExpanded: false,
  localDaemonSheetOpen: false,
  narrowListSheetOpen: false,
  automationPanelOpen: false,
  appControlPanelOpen: false,
  draftIdeaId: null,
  newSessionDialogOpen: false,
  newSessionDialogInitialMessage: null,
  composerFocusRequestId: 0,

  requestComposerFocus: () => set((s) => ({
    composerFocusRequestId: s.composerFocusRequestId + 1,
  })),

  pendingPageLinkInsert: null,
  pageLinkInsertRequestId: 0,

  requestPageLinkInsert: (ctx) => set((s) => ({
    pendingPageLinkInsert: ctx,
    pageLinkInsertRequestId: s.pageLinkInsertRequestId + 1,
  })),

  openNewSessionDialog: (initialMessage) => set({
    newSessionDialogOpen: true,
    newSessionDialogInitialMessage: initialMessage ?? null,
  }),
  closeNewSessionDialog: () => set({
    newSessionDialogOpen: false,
    newSessionDialogInitialMessage: null,
  }),

  setView: (view) => set({ currentView: view }),

  setDefaultMoreOpen: (open) => set({ defaultMoreOpen: open }),

  setActorSheetOpen: (open) => set({ actorSheetOpen: open }),
  toggleActorSheet: () => set((s) => ({ actorSheetOpen: !s.actorSheetOpen })),

  selectDefaultPrimaryTab: (tab) => {
    const ws = useWorkspaceStore.getState()

    set({
      defaultNavTab: tab,
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
    })

    if (tab === 'session') {
      ws.clearSelection()
      ws.closePanel()
      return
    }

    ws.clearSelection()
    ws.closePanel()
  },

  openDefaultMoreDestination: (destination) => {
    set({ defaultMoreOpen: false })

    if (destination === 'settings') {
      get().openSettings()
      return
    }
  },

  openSettings: (section) => set({
    currentView: 'settings',
    settingsInitialSection: section ?? null,
    daemonGeneralPrompt: null,
  }),

  // The operator console's own deep link: an org row jumps to that org's teams.
  openOperatorTeams: (orgId) => set({
    currentView: 'settings',
    settingsInitialSection: 'operatorCredits',
    daemonGeneralPrompt: null,
    operatorOrgFilter: orgId,
  }),

  clearOperatorOrgFilter: () => set({ operatorOrgFilter: null }),

  openDaemonAgentSettings: (prompt) => set({
    currentView: 'settings',
    settingsInitialSection: 'daemonGeneral',
    daemonGeneralPrompt: prompt ?? null,
  }),

  clearDaemonGeneralPrompt: () => set({ daemonGeneralPrompt: null }),

  closeSettings: () => {
    const diagnostics = useDiagnosticsStore.getState()
    diagnostics.clearReport()
    diagnostics.clearFocus()
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
    })
  },

  startNewChat: () => {
    // Switch to chat view synchronously so settings hides immediately —
    // waiting on the dynamic imports below would leave the settings UI
    // visible until the import chain resolves.
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
      // Starting a fresh chat overrides any pending actor-draft selection.
      draftPreselectedActor: null,
      sidebarFilter: { kind: 'all' },
      draftIdeaId: null,
    })
    useWorkspaceStore.getState().clearSelection()
    useWorkspaceStore.getState().closePanel()
    // No hideAll: column four's tabs are not tied to a session
    // (hooks/use-section-scoped-tabs), so they stay open for the new chat.
    useTeamShareBrowserStore.getState().clearDetail()

    // Import session and other stores lazily to avoid circular dependencies
    import('@/stores/cron').then(({ useCronStore }) => {
      useCronStore.getState().setShowCronSessions(false)
    })
    import('@/stores/session-selection-store').then(({ useSessionSelectionStore }) => {
      import('@/stores/session-store').then(({ useSessionStore }) => {
        useSessionSelectionStore.getState().clearActiveSession()

        // Clear session state to show "Start a New Chat" UI
        // Actual session will be created when user sends first message
        useSessionStore.setState({
          isLoading: false,
          messageQueue: [],
          sessionError: null,
          pendingQuestions: [],
          pendingPermissions: [],
        })
      })
    })
  },

  switchToSession: async (sessionId: string, opts?: { keepSidebarFilter?: boolean }) => {
    const sidebarPatch = opts?.keepSidebarFilter
      ? {}
      : { sidebarFilter: { kind: 'all' } as SidebarFilter }
    // Import stores lazily to avoid circular dependencies
    const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
    const { useWorkspaceStore } = await import('@/stores/workspace')
    const { useCurrentTeamStore } = await import('@/stores/current-team')
    const { switchToSessionWorkspaceIfNeeded } = await import('@/lib/session/session-by-workspace')
    
    const teamId = useCurrentTeamStore.getState().team?.id

    // Resolving the session's workspace does daemon IPC + a Cloud API round-trip.
    // It must NOT gate the view/selection flip, or every click feels laggy. Fire
    // it in the background — the chat view renders instantly and the workspace
    // catches up a beat later (only matters for daemon runtimes started from this
    // session, which the user can't trigger within that window anyway).
    const resolveWorkspaceInBackground = () => {
      if (teamId) void switchToSessionWorkspaceIfNeeded(teamId, sessionId)
    }

    // If already on this session just navigate back to chat view (e.g. user
    // opened the apps panel and clicked the same app again). Still switch the
    // workspace so daemon runtimes started from this session use the right
    // worktree (e.g. app sessions whose workspace wasn't set yet).
    const currentActiveId = useSessionSelectionStore.getState().activeSessionId
    if (sessionId === currentActiveId) {
      set({
        currentView: 'chat',
        settingsInitialSection: null,
        daemonGeneralPrompt: null,
        automationPanelOpen: false,
        ...sidebarPatch,
      })
      releaseStuckModalLayersAfterViewSwitch()
      useWorkspaceStore.getState().clearSelection()
      resolveWorkspaceInBackground()
      return
    }

    // Close any open UI elements and return to chat view — synchronously, so the
    // click responds immediately.
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
      automationPanelOpen: false,
    })
    // Flipping currentView unmounts the Settings/History Dialog without going
    // through its onOpenChange handler, so Radix's scroll-lock/overlay residue
    // is never released — the chat view ends up covered by a dead overlay until
    // a manual close. Run the same cleanup the Dialog's close path would.
    releaseStuckModalLayersAfterViewSwitch()
    useWorkspaceStore.getState().clearSelection()

    // Switch to the session. setActiveSession flips the selection state
    // synchronously; its read-marker network write runs in the background, so we
    // don't await it here (awaiting added a Cloud API round-trip to every click).
    void useSessionSelectionStore.getState().setActiveSession(sessionId)
    // If the user was in actor-draft mode, drop that since they jumped into
    // an existing session.
    set({ draftPreselectedActor: null, draftIdeaId: null, ...sidebarPatch })

    resolveWorkspaceInBackground()
  },

  enterActorDraft: (actor) => {
    set({
      draftPreselectedActor: actor,
      draftIdeaId: null,
      defaultNavTab: 'session',
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
      sidebarFilter: { kind: 'all' },
    })
    // Mirror startNewChat's clear-out so the chat view shows an empty
    // canvas with the preselected actor as the implicit recipient. We
    // dynamic-import to avoid a top-level cycle with session/workspace stores.
    void (async () => {
      const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
      const { useSessionStore } = await import('@/stores/session-store')
      const { useWorkspaceStore } = await import('@/stores/workspace')
      useWorkspaceStore.getState().clearSelection()
      useWorkspaceStore.getState().closePanel()
      useSessionSelectionStore.getState().clearActiveSession()
      useSessionStore.setState({
        isLoading: false,
        messageQueue: [],
        sessionError: null,
        pendingQuestions: [],
        pendingPermissions: [],
      })
    })()
  },

  clearActorDraft: () => set({ draftPreselectedActor: null }),

  setNarrowListSheetOpen: (open) => set({ narrowListSheetOpen: open }),
  // Leaving a section needs no tab cleanup here: sections have their own tab
  // scope (hooks/use-section-scoped-tabs), so their tabs park themselves.
  setSidebarFilter: (filter) => set({ sidebarFilter: filter }),
  toggleIdeasSection: () => set((s) => ({ ideasSectionCollapsed: !s.ideasSectionCollapsed })),
  toggleMoreNav: () => set((s) => ({ moreNavExpanded: !s.moreNavExpanded })),
  setMoreNavExpanded: (expanded) => set({ moreNavExpanded: expanded }),
  setNavPinned: (pinned) => {
    layoutPrefsTouched.add('navPinned')
    saveToStorage(NAV_PINNED_STORAGE_KEY, pinned)
    persistUiLayoutPref('navPinned', pinned)
    set({ navPinned: pinned })
  },
  setSessionDrawerPinned: (pinned) => {
    layoutPrefsTouched.add('sessionDrawerPinned')
    saveToStorage(SESSION_DRAWER_PINNED_STORAGE_KEY, pinned)
    persistUiLayoutPref('sessionDrawerPinned', pinned)
    set({ sessionDrawerPinned: pinned })
  },
  toggleLocalDaemon: () => set((s) => ({ localDaemonExpanded: !s.localDaemonExpanded })),
  toggleLocalDaemonSheet: () => set((s) => ({ localDaemonSheetOpen: !s.localDaemonSheetOpen })),
  setLocalDaemonSheetOpen: (open) => set({ localDaemonSheetOpen: open }),

  openAutomationPanel: () => set({ automationPanelOpen: true }),
  closeAutomationPanel: () => set({ automationPanelOpen: false }),
  setAutomationPanelOpen: (open) => set({ automationPanelOpen: open }),

  openAppControlPanel: () => {
    useWorkspaceStore.getState().closePanel()
    set({ appControlPanelOpen: true })
  },
  closeAppControlPanel: () => set({ appControlPanelOpen: false }),
  toggleAppControlPanel: () => {
    const next = !get().appControlPanelOpen
    if (next) {
      useWorkspaceStore.getState().closePanel()
    }
    set({ appControlPanelOpen: next })
  },

  setDraftIdeaId: (ideaId) => set({ draftIdeaId: ideaId }),
  clearDraftIdeaId: () => set({ draftIdeaId: null }),

  setLayoutMode: () => set({ layoutMode: 'task' }),

  toggleLayoutMode: () => set({ layoutMode: 'task' }),

  setContentColumnMode: (mode) => set({ contentColumnMode: mode }),
  setContentColumnRatio: (ratio) =>
    set({ contentColumnRatio: Math.min(0.7, Math.max(0.3, ratio)) }),

  setFileModeRightTab: (tab) => set({ fileModeRightTab: tab }),
}))

/**
 * Restores the layout switches from the desktop shell's file, which outlives
 * localStorage across updates and reinstalls. Runs once at startup.
 */
export async function restoreUiLayoutPrefs(): Promise<void> {
  const file = await loadUiLayoutPrefs()
  if (!file) return
  const { navPinned, sessionDrawerPinned } = useUIStore.getState()
  const { apply, backfill } = reconcileUiLayoutPrefs(file, { navPinned, sessionDrawerPinned })
  const patch: UiLayoutPrefs = {}
  for (const [key, value] of Object.entries(apply) as [UiLayoutPrefKey, boolean][]) {
    if (layoutPrefsTouched.has(key)) continue
    saveToStorage(LAYOUT_PREF_STORAGE_KEYS[key], value)
    patch[key] = value
  }
  if (Object.keys(patch).length > 0) useUIStore.setState(patch)
  for (const [key, value] of Object.entries(backfill) as [UiLayoutPrefKey, boolean][]) {
    if (!layoutPrefsTouched.has(key)) persistUiLayoutPref(key, value)
  }
}

void restoreUiLayoutPrefs()
