import {
  useEffect,
  useState,
  useRef,
  MouseEvent as ReactMouseEvent,
  type ComponentType,
} from "react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { syncTrayMenuLabels } from "@/lib/sync-tray-menu";
import { Toaster, toast } from "sonner";
import { cn, isTauri, removeStartupSkeleton } from "@/lib/utils";
import { capabilities } from "@/lib/platform";
import { isSoloBuild } from "@/lib/solo-build";
import { scheduleReleaseStuckModalLayers } from "@/lib/modal-layer-cleanup";
import { appDisplayName } from "@/lib/build-config";
import { buildSessionDeeplink } from "@/lib/session-deeplink";
import { markStartup } from "@/lib/startup-perf";
import {
  BookOpen,
  FolderGit,
  ChevronLeft,
  X,
  PanelRightClose,
  Link2,
  Loader2,
  RotateCw,
  MessageSquarePlus,
  AppWindow,
  Users,
  TerminalSquare,
  SlidersHorizontal,
} from "lucide-react";
import { FileContentViewer } from "@/components/FileEditor";
import {
  useWorkspaceInit,
  useChannelGatewayInit,
  useGitReposInit,
  useCronInit,
  useWorkspaceRuntimeRefreshPoll,
  useOpenCodePreload,
  useExternalLinkHandler,
  useTauriBodyClass,
  useTelemetryConsent,
} from "@/hooks/useAppInit";
import { useDesktopNotifications } from "@/hooks/useDesktopNotifications";
import { useMemberPresenceHeartbeat } from "@/hooks/useMemberPresenceHeartbeat";
import { useExtensionSessionCleanup } from "@/hooks/useExtensionSessionCleanup";
import {
  usePanelAutoOpen,
  useFileTabSync,
  useResizablePanels,
} from "@/hooks/useFileEditorState";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarSecondColumn } from "@/components/sidebar/SidebarSecondColumn";
import { SIDEBAR_INTERACTIVE_CURSOR } from "@/components/sidebar/sidebar-interactive-cursor";
import { NarrowChatHeader } from "@/components/responsive/NarrowChatHeader";
import { useLayoutBreakpoint } from "@/hooks/use-layout-breakpoint";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { NewSessionDialog } from "@/components/chat/NewSessionDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MqttLiveWiring } from "@/components/MqttLiveWiring";
import { TeamSkillAutoFollow } from "@/components/TeamSkillAutoFollow";
import { SessionHistoryLoader } from "@/components/SessionHistoryLoader";
import { UpdateDialogContainer } from "@/components/updater/UpdateDialog";
import { RightPanel } from "@/components/panel";
import { AppControlPanel } from "@/components/apps/AppControlPanel";
import { resolveControlPanelAppId } from "@/lib/app-control-panel";
import { ExtensionSettings, Settings } from "@/components/settings";
import { FeedbackDialog } from "@/components/settings/FeedbackDialog";
import { AutomationPanelDialog } from "@/components/settings/AutomationPanelDialog";
import { CloseToTrayHost } from "@/components/CloseToTrayDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TelemetryConsentDialog } from "@/components/telemetry/TelemetryConsentDialog";
import { RuntimeRefreshWorkspaceBanner } from "@/components/workspace/RuntimeRefreshBanner";
import { useSessionStore } from "@/stores/session";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useAuthStore } from "@/stores/auth-store";
import { listenForDaemonLiveStatus } from "@/lib/mqtt-bridge";
import { setDaemonLiveConnected } from "@/lib/live-dedup-stats";
import { useOutboxStore } from "@/stores/outbox-store";
import { startOutboxSender } from "@/services/outbox-sender";
import { getBackend } from "@/lib/backend";
import { getVersion } from "@tauri-apps/api/app";
import { getDesktopDeviceId } from "./lib/backend/cloud-api/device-id";
import { resetClientChatState } from "@/lib/reset-client-chat-state";
import { startEmbedPageContextListener, consumePendingLinkContext } from "@/lib/embed-page-context";
import { startEmbedLinkOpenListener } from "@/lib/embed-link-session";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore, selectActiveTab, selectHasHiddenTabs } from "@/stores/tabs";
import {
  isTeamShareOwnedTarget,
  teamShareSectionForTarget,
} from "@/lib/tabs/teamshare-target";
import { isActorOwnedTarget } from "@/lib/tabs/actor-target";
import { useTeamShareBrowserStore } from "@/stores/team-share-browser";
import { TeamShareDetailContent } from "@/components/teamshare/TeamShareTabContent";
import { IdeasDetailColumn } from "@/components/panel/IdeaDetailPane";
import { useTerminalStore } from "@/stores/terminal-store";
import { useHeaderPreferencesStore } from "@/stores/header-preferences-store";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { FindInPageBar } from "@/components/tab-bar/FindInPageBar";
import { urlToLabel } from "@/lib/webview-utils";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { parseInviteDeeplink, claimInviteToken } from "@/lib/invite-deeplink";
import { parseSessionDeeplink } from "@/lib/session-deeplink";
import {
  completePendingSessionDeeplink,
  openSessionFromDeeplink,
  readPendingSessionDeeplink,
  stashPendingSessionDeeplink,
} from "@/lib/open-session-deeplink";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useAppsStore } from "@/stores/apps-store";
import { E2E_BUILD, isV2E2EControlActive } from "@/lib/e2e/v2-control-active";
import { TrafficLights } from "@/components/ui/traffic-lights";
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
export { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";

// ── Webview UI micro-store (find bar + zoom levels) ────────────────────────
const useWebviewUIStore = create<{
  showFind: boolean
  zoomLevels: Record<string, number>
  setShowFind: (v: boolean) => void
  setZoomLevel: (label: string, level: number) => void
}>((set, get) => ({
  showFind: false,
  zoomLevels: {},
  setShowFind: (v) => set({ showFind: v }),
  setZoomLevel: (label, level) =>
    set({ zoomLevels: { ...get().zoomLevels, [label]: level } }),
}))

/** Sync native tray + app menu labels with the active UI locale. */
function useTrayMenuLocaleSync() {
  useEffect(() => {
    void syncTrayMenuLabels();
    const onLang = () => {
      void syncTrayMenuLabels();
    };
    i18n.on("languageChanged", onLang);
    return () => {
      i18n.off("languageChanged", onLang);
    };
  }, []);
}

/** Native TeamClu → Settings… (⌘,) opens the in-app Settings dialog. */
function useAppMenuOpenSettings() {
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("open-app-settings", () => {
        useUIStore.getState().openSettings();
      }))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

/**
 * Global keyboard shortcuts (Cmd+F, Cmd+/-/0) and context menu listener
 * for webview tabs. Registered once, reads active tab from tabs store.
 */
/** Track the local-daemon SSE fast-path status (observability only). */
function useDaemonLiveStatus() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForDaemonLiveStatus((connected) => {
      setDaemonLiveConnected(connected);
      console.info(`[daemon-live] fast-path ${connected ? "connected" : "down"}`);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

function useWebviewShortcuts() {
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const activeTab = useTabsStore.getState().getActiveTab()
      if (!activeTab || activeTab.type !== "webview") return
      if (!isTauri()) return

      const mod = e.metaKey || e.ctrlKey
      const webviewLabel = urlToLabel(activeTab.target)
      const { setShowFind, setZoomLevel, zoomLevels } =
        useWebviewUIStore.getState()

      if (mod && e.key === "f") {
        e.preventDefault()
        setShowFind(true)
        return
      }

      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.min(Math.round((cur + 0.1) * 10) / 10, 2.0)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "-") {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.max(Math.round((cur - 0.1) * 10) / 10, 0.5)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "0") {
        e.preventDefault()
        setZoomLevel(webviewLabel, 1.0)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", {
            label: webviewLabel,
            level: 1.0,
          }).catch(() => {})
        })
        return
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])
}

function useTerminalShortcuts() {
  const togglePanel = useTerminalStore(s => s.togglePanel);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePath) return;
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl + ` (backtick) — toggle terminal panel
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        togglePanel(workspacePath);
        return;
      }

      // Only act on Cmd+T / Cmd+W when focus is inside a terminal viewport.
      const focused = document.activeElement;
      const inTerminal = focused?.closest?.(".xterm") != null;
      if (!inTerminal) return;

      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void openTerminal(workspacePath, {
          cwd: workspacePath,
          allowedRoots: [workspacePath],
        });
        return;
      }

      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const state = useTerminalStore.getState();
        const activeId = state.activeTabByWorkspace[workspacePath];
        if (activeId) void closeTerminal(activeId);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspacePath, togglePanel, openTerminal, closeTerminal]);
}

// Main content component - shows chat with tab overlay
// ChatPanel is always mounted to preserve state, hidden when a tab is active
function MainContent() {
  const activeTab = useTabsStore(selectActiveTab);
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  const sidebarFilter = useUIStore((s) => s.sidebarFilter);
  const teamShareDetail = useTeamShareBrowserStore((s) => s.detailTarget);
  const directTeamShareSection =
    sidebarFilter.kind === "teamShare" && sidebarFilter.section !== "knowledge"
      ? sidebarFilter.section
      : null;
  const visibleTeamShareDetail =
    directTeamShareSection && teamShareSectionForTarget(teamShareDetail) === directTeamShareSection
      ? teamShareDetail
      : null;
  // Ideas mirror team-share: the section owns the main column, no tabs involved.
  const directIdeasSection = sidebarFilter.kind === "ideas";
  const mainColumnOwned = !!directTeamShareSection || directIdeasSection;
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [splitContainerWidth, setSplitContainerWidth] = useState(0);
  const mainSplitLeftMaxWidth =
    splitContainerWidth > 0 ? Math.max(360, splitContainerWidth - 280) : undefined;
  const { mainSplitLeftWidth, handleMainSplitResize } = useResizablePanels({
    mainSplitLeftMaxWidth,
  });
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const fileContent = useWorkspaceStore((s) => s.fileContent);
  const isLoadingFile = useWorkspaceStore((s) => s.isLoadingFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const showFind = useWebviewUIStore((s) => s.showFind)
  const zoomLevels = useWebviewUIStore((s) => s.zoomLevels)
  const hasActiveTab = !!activeTab;

  // Track previous active tab to detect tab switches (user clicking a different tab)
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  // Sync workspace store when user switches tabs (tab click → load file)
  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    const hadTab = prevActiveTabId.current !== null;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      selectFile(activeTab.target);
    }
    // When active file tab is closed (had a tab → now null), clear selectedFile
    // to prevent stale file re-opening on mode switch
    if (tabChanged && hadTab && !activeTab) {
      clearSelection();
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile, clearSelection]);

  // Sync file selections to tab store (file opened from chat links, file tree, etc.)
  useEffect(() => {
    if (selectedFile) {
      const filename = selectedFile.split("/").pop() || selectedFile;
      useTabsStore.getState().openTab({
        type: "file",
        target: selectedFile,
        label: filename,
      });
    }
  }, [selectedFile]);

  useEffect(() => {
    if (mainContentLayout !== "split") return;
    const container = splitContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setSplitContainerWidth(container.getBoundingClientRect().width);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [mainContentLayout]);

  const fileArea = (
    <div className="relative h-full flex flex-col">
      {!mainColumnOwned && <TabBar />}
      {!mainColumnOwned && hasActiveTab && activeTab.type === "webview" && (
        <WebViewToolbar
          url={activeTab.target}
          label={urlToLabel(activeTab.target)}
          zoomLevel={zoomLevels[urlToLabel(activeTab.target)]}
        />
      )}
      {!mainColumnOwned && hasActiveTab && activeTab.type === "webview" && showFind && (
        <FindInPageBar
          label={urlToLabel(activeTab.target)}
          onClose={() => useWebviewUIStore.getState().setShowFind(false)}
        />
      )}
      <div className="relative flex-1">
        {directTeamShareSection ? (
          <div className="absolute inset-0 bg-background">
            {visibleTeamShareDetail ? (
              <TeamShareDetailContent target={visibleTeamShareDetail} />
            ) : null}
          </div>
        ) : directIdeasSection ? (
          <div className="absolute inset-0 bg-background">
            <IdeasDetailColumn />
          </div>
        ) : hasActiveTab ? (
          <div className={cn(
            "absolute inset-0",
            activeTab.type === "webview" ? "bg-transparent pointer-events-none" : "bg-background"
          )}>
            {activeTab.type === "file" ? (
              <FileContentViewer
                selectedFile={selectedFile}
                fileContent={fileContent}
                isLoadingFile={isLoadingFile}
                onClose={() => {
                  clearSelection();
                  useTabsStore.getState().closeTab(activeTab.id);
                }}
              />
            ) : (
              <TabContentRenderer />
            )}
          </div>
        ) : (
          mainContentLayout === "split" ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a file or web tab
            </div>
          ) : null
        )}
      </div>
    </div>
  );

  if (mainContentLayout === "split") {
    return (
      <div
        ref={splitContainerRef}
        className="flex h-full min-h-0 overflow-hidden bg-background"
        data-testid="main-content-split"
      >
        <div
          className="min-w-0 shrink-0 overflow-hidden border-r border-border bg-background"
          style={{ width: mainSplitLeftWidth }}
        >
          {fileArea}
        </div>
        <ResizeHandle
          onResize={handleMainSplitResize}
          className="bg-border/60 hover:bg-primary/50"
          testId="main-content-split-resize-handle"
        />
        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
          <ErrorBoundary scope="Chat" inline>
            <ChatPanel />
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      {fileArea}
      <div
        className={`absolute inset-0 ${hasActiveTab || mainColumnOwned ? "invisible" : "visible"}`}
      >
        <ErrorBoundary scope="Chat" inline>
          <ChatPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}

// Terminal toggle button in header
function TerminalToggleButton({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const terminalOpen = useTerminalStore(
    s => Boolean(s.panelOpenByWorkspace[workspacePath]),
  );
  const togglePanel = useTerminalStore(s => s.togglePanel);
  return (
    <button
      className={cn(
        "ml-1 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
        terminalOpen ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
      onClick={() => togglePanel(workspacePath)}
      title={t("terminal.toggle", "Toggle terminal (⌃`)")}
    >
      <TerminalSquare className="h-4 w-4" />
    </button>
  );
}

// Header panel tab button component
function HeaderPanelTab({
  icon: Icon,
  label,
  count,
  isActive,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2 py-1 text-xs transition-colors rounded ${
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      {isActive && <span>{label}</span>}
      {!!count && count > 0 && (
        <span
          className={`min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-medium flex items-center justify-center ${
            isActive ? "bg-primary/20 text-primary" : "bg-muted-foreground/20"
          }`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

// Resize handle component for resizable panels
function ResizeHandle({
  onResize,
  direction = "horizontal",
  className = "",
  testId,
}: {
  onResize: (delta: number) => void;
  direction?: "horizontal" | "vertical";
  className?: string;
  testId?: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);

  const handleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const currentPos =
        direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPosRef.current;
      startPosRef.current = currentPos;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`
        ${direction === "horizontal" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
        ${isDragging ? "bg-primary" : "bg-transparent hover:bg-primary/50"}
        transition-colors duration-150 flex-shrink-0 z-20
        ${className}
      `}
      data-testid={testId}
      onMouseDown={handleMouseDown}
    >
      {/* Larger hit area */}
      <div
        className={`
          ${direction === "horizontal" ? "w-3 h-full -ml-1" : "h-3 w-full -mt-1"}
        `}
      />
    </div>
  );
}


// Inner component to access sidebar context
function AppContent() {
  const { t } = useTranslation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Session store - individual selectors. Note: we subscribe to the
  // *result* of getActiveSession() so re-renders fire when currentSessionId
  // / sessions change. Subscribing to the function ref alone never
  // re-renders since the ref is stable.
  const activeSession = useSessionStore((s) => s.getActiveSession());
  const sessionDiff = useSessionStore((s) => s.sessionDiff);
  const reloadActiveSessionMessages = useSessionStore(
    (s) => s.reloadActiveSessionMessages,
  );

  // Workspace store - individual selectors
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isPanelOpen = useWorkspaceStore((s) => s.isPanelOpen);
  const activeTab = useWorkspaceStore((s) => s.activeTab);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  const closePanel = useWorkspaceStore((s) => s.closePanel);

  const appControlPanelOpen = useUIStore((s) => s.appControlPanelOpen);
  const toggleAppControlPanel = useUIStore((s) => s.toggleAppControlPanel);
  const closeAppControlPanel = useUIStore((s) => s.closeAppControlPanel);
  const selectedAppId = useAppsStore((s) => s.selectedAppId);
  const appIdBySessionId = useAppsStore((s) => s.appIdBySessionId);
  const appItems = useAppsStore((s) => s.items);
  const activeSessionId = useSessionSelectionStore((s) => s.currentSessionId);

  const controlPanelAppId = React.useMemo(
    () =>
      resolveControlPanelAppId({
        selectedAppId,
        activeSessionId,
        appIdBySessionId,
      }),
    [selectedAppId, activeSessionId, appIdBySessionId],
  );
  const controlPanelApp = React.useMemo(
    () => (controlPanelAppId ? appItems.find((a) => a.id === controlPanelAppId) ?? null : null),
    [appItems, controlPanelAppId],
  );

  const breakpoint = useLayoutBreakpoint();

  // UI store - individual selectors
  const embedMode = useUIStore((s) => s.embedMode);
  const currentView = useUIStore((s) => s.currentView);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const sidebarFilter = useUIStore((s) => s.sidebarFilter);
  const authSession = useAuthStore((s) => s.session);
  // `load()` keeps the cached team while auth is still restoring, so it has to
  // run again once auth settles. The user id alone is not enough of a trigger:
  // a genuinely signed-out user never gets one, and the cached team would
  // linger with nothing to clear it.
  const authLoading = useAuthStore((s) => s.loading);
  const loadCurrentTeam = useCurrentTeamStore((s) => s.load);
  // Team-share state drives the top-right "team shared files" tab visibility.
  // Refresh it centrally (below) so the tab reflects the true share mode even
  // before the user ever opens the panel or Settings → Team.
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  // Header icon visibility — additive gates on top of the capability/session
  // conditions below. Defaults hidden; users enable per-icon in Settings →
  // General → "会话头部图标". See stores/header-preferences-store.ts.
  const showTerminalToggle = useHeaderPreferencesStore((s) => s.showTerminalToggle);
  const showChangesTab = useHeaderPreferencesStore((s) => s.showChangesTab);
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const hasActiveFileTab = !!useTabsStore(selectActiveTab);
  const hasHiddenTabs = useTabsStore(selectHasHiddenTabs);
  /** Shortcuts open in the left dock for both shells.
   * Only the workspace shell temporarily replaces the sidebar with that dock.
   * Files pops out from the right (via the top-right files icon). */
  const leftDockActive =
    isPanelOpen &&
    activeTab === "shortcuts";
  const showAppControlPanel = appControlPanelOpen && !!controlPanelApp;
  const showRightWorkspacePanel = isPanelOpen && !leftDockActive && !showAppControlPanel;
  const showRightSidePanel = showRightWorkspacePanel || showAppControlPanel;
  const settingsOpen = currentView === "settings";
  /** Extension welcome has its own empty state — skip duplicate "New Chat" header. */
  const showChatSessionHeader = !(embedMode && !activeSession);
  const teamShareHeaderTitle =
    sidebarFilter.kind === "teamShare"
      ? sidebarFilter.section === "skills"
        ? t("teamShare.skills", "Skills")
        : sidebarFilter.section === "mcp"
          ? t("teamShare.mcp", "MCP")
          : sidebarFilter.section === "env"
            ? t("teamShare.env", "Environment Variables")
            : t("teamShare.knowledge", "Knowledge")
      : null;

  const handleCloseSettings = React.useCallback(() => {
    setFeedbackOpen(false);
    closeSettings();
    // DialogContent also schedules cleanup; this covers programmatic close paths.
    scheduleReleaseStuckModalLayers();
  }, [closeSettings]);

  useEffect(() => {
    void loadCurrentTeam();
  }, [authSession?.user.id, authLoading, loadCurrentTeam]);

  useEffect(() => {
    if (!controlPanelAppId && appControlPanelOpen) {
      closeAppControlPanel();
    }
  }, [controlPanelAppId, appControlPanelOpen, closeAppControlPanel]);

  // In workspace mode, SessionListColumn always sits to the left of SidebarInset
  // and renders its own traffic-light + collapse strip when the sidebar is
  // closed, so the chat header should NOT re-render that strip there.
  const collapsedInsetLeading = null;
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  // Resolved by the MQTT-connect effect; passed to the notification dispatcher.
  const [myActorId, setMyActorId] = useState<string | null>(null);
  // Extracted hooks — initialization, panel state, keyboard shortcuts
  const { initialWorkspaceResolved, openCodeError } = useWorkspaceInit();
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);

  // Surface a local amuxd daemon connection failure as a persistent toast
  // instead of taking over the whole window. The rest of the UI stays usable;
  // the toast auto-dismisses once the daemon becomes reachable.
  useEffect(() => {
    const DAEMON_TOAST_ID = "amuxd-daemon-unavailable";
    if (isTauri() && workspacePath && !daemonHttpReady && openCodeError) {
      toast.error(openCodeError, {
        id: DAEMON_TOAST_ID,
        duration: Infinity,
        description: t(
          "workspace.daemonUnavailableHint",
          "Start amuxd on this machine (e.g. pnpm daemon:run), confirm the HTTP port/token files exist under ~/.amuxd/, then retry.",
        ),
        action: {
          label: t("common.retry", "Retry"),
          onClick: () => window.location.reload(),
        },
      });
    } else {
      toast.dismiss(DAEMON_TOAST_ID);
    }
  }, [workspacePath, daemonHttpReady, openCodeError, t]);

  useDesktopNotifications(myActorId);
  useChannelGatewayInit();
  useGitReposInit();
  useCronInit();
  useWorkspaceRuntimeRefreshPoll();
  useExternalLinkHandler();
  usePanelAutoOpen();
  useFileTabSync();
  useEffect(() => {
    const stopPageContext = startEmbedPageContextListener()
    const stopLinkOpen = startEmbedLinkOpenListener()
    void consumePendingLinkContext()
    return () => {
      stopPageContext()
      stopLinkOpen()
    }
  }, []);

  // Desktop: hand off from the static #skeleton once the workspace resolves to
  // real three-column content. AuthGate keeps the skeleton up through every
  // loading gate and lets App own the final removal, so cold start is
  // skeleton → real UI with no intermediate blank.
  //
  // Extension/web: there is no workspace gate — initialWorkspaceResolved flips
  // true almost immediately. App must NOT tear the skeleton down here while
  // AuthGate still returns null (auth hydrate / team bootstrap / myTeams);
  // otherwise #root is empty and the side panel flashes white for seconds.
  // AuthGate removes the skeleton when it finally renders children.
  useEffect(() => {
    if (!initialWorkspaceResolved) return;
    if (!capabilities.workspace) return;
    removeStartupSkeleton();
    if (workspacePath) markStartup("first-content");
  }, [initialWorkspaceResolved, workspacePath]);

  // Boot the outbox: hydrate any pending/failed rows from libsql so a
  // crashed/closed app resumes in-flight sends, then start the sender loop
  // (idempotent). `startOutboxSender` schedules a tick every second; the
  // first tick fires immediately after hydration.
  useEffect(() => {
    void (async () => {
      await useOutboxStore.getState().hydrate();
      startOutboxSender();
    })();
  }, []);

  // v2 Phase 1 — Task 1D.4: connect MQTT after auth, subscribe to all teams'
  // session live topics, decode incoming LiveEventEnvelope and append to
  // useSessionStore so ActorMessageList re-renders. The orphan
  // session-event-bus.ts is bypassed: we write straight to the store the UI
  // reads from.
  const userId = useAuthStore((s) => s.session?.user.id ?? null);
  // Wait for a team id for MQTT ACL. The active team from settings is the
  // authoritative source — populated by AuthGate / loadCurrentTeam after login.
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null);
  useMemberPresenceHeartbeat(currentTeamId, myActorId);
  useExtensionSessionCleanup();

  // v2 Phase 1: load the session list once AppContent mounts (i.e. after auth
  // is verified), then re-scope it whenever the active team resolves or
  // changes. The list is team-scoped (GET /v1/sessions?teamId=), so a cold boot
  // that guessed the team from localStorage has to refetch once current-team
  // lands — and a team switch has to refetch rather than keep showing the team
  // being left. Concurrent calls with the same scope share one request.
  const sessionListLoadedTeamId = useSessionListStore((s) => s.loadedTeamId);
  useEffect(() => {
    if (isV2E2EControlActive()) return;
    // Keyed on loadedTeamId, not scopeTeamId: the scope is committed before the
    // fetch so the list cannot paint the old team's rows, which means a failed
    // first page would otherwise be indistinguishable from a loaded one and the
    // sidebar would sit empty with no retry. loadedTeamId only advances on a
    // page that actually arrived, so a failure leaves this effect armed.
    if (currentTeamId && sessionListLoadedTeamId === currentTeamId) return;
    void useSessionListStore.getState().load();
  }, [currentTeamId, sessionListLoadedTeamId]);

  // A team-share tab names a row in *this* team's registry — a skill id, an MCP
  // server, an env key, a document's history. An actor tab names a row in this
  // team's directory. After a switch those addresses resolve to nothing, so the
  // tabs go with the team rather than lingering as windows onto another team's
  // content.
  const prevTeamIdRef = useRef<string | null>(currentTeamId);
  useEffect(() => {
    const prev = prevTeamIdRef.current;
    prevTeamIdRef.current = currentTeamId;
    if (prev === null || prev === currentTeamId) return;
    useTabsStore
      .getState()
      .closeWhere(
        (tab) =>
          tab.type === "native" &&
          (isTeamShareOwnedTarget(tab.target) || isActorOwnedTarget(tab.target)),
      );
    useTeamShareBrowserStore.getState().clearDetail();
  }, [currentTeamId]);

  // Clear in-memory chat when the signed-in user or active team changes.
  // signOut resets before unmount; this effect owns team-switch / adoptSession.
  const chatIdentityKey =
    userId && currentTeamId ? `${userId}::${currentTeamId}` : null;
  const prevChatIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatIdentityKey) {
      prevChatIdentityRef.current = null;
      return;
    }
    if (
      prevChatIdentityRef.current !== null &&
      prevChatIdentityRef.current !== chatIdentityKey
    ) {
      resetClientChatState();
      if (!isV2E2EControlActive()) {
        void useSessionListStore.getState().loadFirstPage();
      }
    }
    prevChatIdentityRef.current = chatIdentityKey;
  }, [chatIdentityKey]);

  // Resume a cross-team session deeplink after enterTeam() clears chat state.
  useEffect(() => {
    if (!userId || !currentTeamId) return;
    if (!readPendingSessionDeeplink()) return;
    void completePendingSessionDeeplink();
  }, [userId, currentTeamId, chatIdentityKey]);

  // Report this desktop install's tauri client version once per team selection.
  useEffect(() => {
    if (!currentTeamId) return;
    let cancelled = false;
    void (async () => {
      let version: string;
      try {
        version = await getVersion(); // throws outside Tauri (web preview) — skip then
      } catch {
        return;
      }
      if (cancelled) return;
      await getBackend().telemetry.reportClientVersion(currentTeamId, {
        clientType: "tauri",
        version,
        deviceId: getDesktopDeviceId(),
        build: null,
      });
    })();
    return () => { cancelled = true; };
  }, [currentTeamId]);

  const hasCurrentSession = Boolean(
    useSessionSelectionStore((s) => s.currentSessionId),
  );

  /** When left dock opens, hide the main sidebar; restore prior expansion when it closes. */
  const restoreSidebarAfterLeftDockRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (leftDockActive) {
      if (restoreSidebarAfterLeftDockRef.current === null) {
        restoreSidebarAfterLeftDockRef.current = sidebarOpen;
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
      } else if (sidebarOpen) {
        // User re-opened sidebar while left dock is active — close the dock.
        closePanel();
      }
    } else {
      const shouldExpand = restoreSidebarAfterLeftDockRef.current === true;
      restoreSidebarAfterLeftDockRef.current = null;
      if (shouldExpand) {
        setSidebarOpen(true);
      }
    }
  }, [leftDockActive, sidebarOpen, setSidebarOpen, closePanel]);

  const settingsModal = (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleCloseSettings();
        }
      }}
    >
      <DialogContent
        aria-label={t("common.settings", "Settings")}
        className="flex h-[min(780px,calc(100vh-5rem))] w-[min(960px,calc(100vw-4rem))] max-w-none grid-cols-none flex-col gap-0 overflow-hidden rounded-[14px] border-border bg-paper p-0 shadow-2xl sm:max-w-none"
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-2 border-b border-border bg-paper px-5 py-0 text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[15px] font-bold leading-normal text-foreground">
              {t("common.settings", "Settings")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.description", "Configure TeamClu settings.")}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={() => setFeedbackOpen(true)}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t('settings.feedback.title', 'Send Feedback')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={handleCloseSettings}
            aria-label={t("common.close", "Close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        <div className="min-h-0 flex-1 overflow-hidden">
          {embedMode ? <ExtensionSettings /> : <Settings />}
        </div>
      </DialogContent>
    </Dialog>
  );

  // Rendered on both return paths: this wiring must keep running while the
  // workspace is still resolving, exactly as it did when these effects lived
  // in this component's body.
  const appWiring = (
    <>
      <MqttLiveWiring userId={userId} teamId={currentTeamId} onMyActorId={setMyActorId} />
      <TeamSkillAutoFollow teamId={currentTeamId} />
      <SessionHistoryLoader />
    </>
  );

  if (!initialWorkspaceResolved) {
    return (
      <>
        {appWiring}
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <span className="font-medium">{appDisplayName}</span>
          </header>
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SidebarInset>
        {settingsModal}
        <AutomationPanelDialog />
      </>
    );
  }

  return (
    <>
      {appWiring}
      {breakpoint === 'wide' && <AppSidebar />}
      {breakpoint !== 'narrow' && (
        <div className={cn('w-(--session-list-width) shrink-0 h-svh overflow-hidden', SIDEBAR_INTERACTIVE_CURSOR)}>
          <SidebarSecondColumn showNewSessionActions={breakpoint === 'medium'} />
        </div>
      )}
      <SidebarInset className="flex flex-row h-svh overflow-hidden relative">
        <div
          className={cn(
            "shrink-0 overflow-hidden border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
            leftDockActive
              ? "w-(--sidebar-width) translate-x-0 border-r opacity-100"
              : "pointer-events-none w-0 -translate-x-4 border-r-0 opacity-0",
          )}
        >
          <div className="flex h-full w-(--sidebar-width) flex-col overflow-hidden bg-background">
            {leftDockActive && (
              <>
                <div
                  className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
                  data-tauri-drag-region
                >
                  <TrafficLights />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-lg"
                    onClick={() => closePanel()}
                    title={t("shortcuts.backToSidebar", "Back to sidebar")}
                    aria-label={t(
                      "shortcuts.backToSidebar",
                      "Back to sidebar",
                    )}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="min-w-0 truncate text-sm font-medium">
                    {t("navigation.shortcuts", "Shortcuts")}
                  </span>
                  <div className="min-w-0 flex-1" data-tauri-drag-region />
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <RightPanel diff={sessionDiff} />
                </div>
              </>
            )}
          </div>
        </div>
        {/* Main column: header + main content */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {breakpoint === 'narrow' && <NarrowChatHeader />}
          <>
          {/* Header with breadcrumb - sticky */}
          {showChatSessionHeader ? (
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}

            <button
              className={cn(
                "min-w-0 truncate text-sm text-left",
                hasActiveFileTab && "cursor-pointer hover:text-foreground/70 transition-colors"
              )}
              onClick={() => {
                if (hasActiveFileTab) {
                  useTabsStore.getState().hideAll();
                }
              }}
              disabled={!hasActiveFileTab}
            >
              {teamShareHeaderTitle || activeSession?.title || t("chat.newChat", "New Chat")}
            </button>
            {activeSession && !isSoloBuild() && (
              <button
                onClick={async () => {
                  setIsRefreshingMessages(true);
                  await reloadActiveSessionMessages();
                  setIsRefreshingMessages(false);
                }}
                className="ml-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("chat.refreshMessages", "Refresh messages")}
              >
                <RotateCw
                  className={cn(
                    "h-3.5 w-3.5",
                    isRefreshingMessages && "animate-spin",
                  )}
                />
              </button>
            )}
            {activeSession && (
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(buildSessionDeeplink(activeSession.id));
                    toast.success(t("chat.shareLinkCopied", "会话链接已复制"));
                  } catch {
                    toast.error(t("chat.shareLinkCopyFailed", "复制失败"));
                  }
                }}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("chat.copyShareLink", "复制会话分享链接")}
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
            )}

            {/* Panel tabs - right side of header */}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {mainContentLayout === "stacked" && (hasActiveFileTab || hasHiddenTabs) && (
                <button
                  className={cn(
                    "rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
                    hasActiveFileTab ? "text-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => {
                    if (hasActiveFileTab) {
                      useTabsStore.getState().hideAll();
                    } else {
                      useTabsStore.getState().restoreLastTab();
                    }
                  }}
                  title={hasActiveFileTab
                    ? t("navigation.hideTabs", "Hide files")
                    : t("navigation.restoreTabs", "Show files")
                  }
                >
                  <AppWindow className="h-4 w-4" />
                </button>
              )}
              {capabilities.workspace && workspacePath && showTerminalToggle && (
                <TerminalToggleButton workspacePath={workspacePath} />
              )}
              {hasCurrentSession && !isSoloBuild() && (
                <HeaderPanelTab
                  icon={Users}
                  label={t("chat.actorSheet.title", "Actors")}
                  isActive={isPanelOpen && activeTab === "actors"}
                  onClick={() => isPanelOpen && activeTab === "actors" ? closePanel() : openPanel("actors")}
                />
              )}
              {/* Workspace file tree. Restored as a header entry that opens the
                  right-panel `files` tab (rendered by the existing FileBrowser,
                  not the deleted RAG KnowledgeBrowser). Gate mirrors the
                  pre-#1054 condition: desktop + a workspace path. */}
              {capabilities.workspace && (
                <HeaderPanelTab
                  icon={BookOpen}
                  label={t("navigation.files", "files")}
                  isActive={isPanelOpen && activeTab === "files"}
                  onClick={() => isPanelOpen && activeTab === "files" ? closePanel() : openPanel("files")}
                />
              )}
              {/* The team shared files tab moved to the Knowledge entry in the
                  left nav, where the same tree renders in column two with its
                  editor in column three. Kept out of the header so the two do
                  not diverge. */}
              {capabilities.workspace && hasCurrentSession && showChangesTab && (
                <HeaderPanelTab
                  icon={FolderGit}
                  label={t("navigation.changes", "Changes")}
                  count={sessionDiff.length}
                  isActive={isPanelOpen && activeTab === "diff"}
                  onClick={() => isPanelOpen && activeTab === "diff" ? closePanel() : openPanel("diff")}
                />
              )}
              {controlPanelApp && (
                <HeaderPanelTab
                  icon={SlidersHorizontal}
                  label={t("apps.controlPanel.title", "应用设置")}
                  isActive={showAppControlPanel}
                  onClick={() => toggleAppControlPanel()}
                />
              )}
              {showRightSidePanel && (
                <button
                  className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    if (showAppControlPanel) closeAppControlPanel();
                    else closePanel();
                  }}
                  title={t("navigation.collapsePanel", "Collapse panel")}
                >
                  <PanelRightClose className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>
          ) : null}

          <RuntimeRefreshWorkspaceBanner />

          {/* Main content - Chat or file preview */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <MainContent />
          </div>
          </>
        </div>

        {/* Right Panel - full height (RightPanel or AppControlPanel, mutually exclusive) */}
        <div
          className={cn(
            "shrink-0 overflow-hidden border-l border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
            showRightSidePanel
              ? "w-72 translate-x-0 opacity-100"
              : "pointer-events-none w-0 translate-x-4 border-l-0 opacity-0",
          )}
        >
          <div className="h-full w-72">
            {showRightWorkspacePanel && (
              <RightPanel diff={sessionDiff} />
            )}
            {showAppControlPanel && controlPanelApp && (
              <AppControlPanel app={controlPanelApp} />
            )}
          </div>
        </div>
      </SidebarInset>
      {settingsModal}
      <AutomationPanelDialog />
    </>
  );
}

function App() {
  React.useEffect(() => {
    // Test-only control surface. Behind a build-time constant and a dynamic
    // import so a normal build drops both this branch and the ~30KB module it
    // reaches; the E2E harness polls for `window.__TEAMCLU_V2_E2E__`, so the
    // extra tick before it appears is fine.
    if (E2E_BUILD) {
      void import("@/lib/e2e/v2-control").then((m) => m.installV2E2EControl());
    }
  }, []);

  // ── Global webview shortcuts (find, zoom, context menu) ──
  useWebviewShortcuts()
  useTerminalShortcuts()
  useDaemonLiveStatus()
  useTrayMenuLocaleSync()
  useAppMenuOpenSettings()

  // ── Initialize tauri-plugin-mcp event listeners (dev + E2E builds) ──
  // The plugin's `execute_js` works by emitting an `execute-js` event and
  // waiting for `execute-js-response`; these listeners are what answers it.
  // Without them every executeJs call from the test harness times out, so an
  // E2E build needs them even though vite built it in production mode.
  useEffect(() => {
    if (!isTauri()) return;
    if (import.meta.env.PROD && !E2E_BUILD) return;
    // Deliberately NOT `/* @vite-ignore */`: that leaves the specifier
    // unanalyzed, so neither the stub alias nor the E2E bundling below can
    // apply and the webview is handed a bare specifier it cannot resolve.
    // Normal builds alias this to a no-op stub; an E2E build bundles the real
    // package.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    import('tauri-plugin-mcp').then((mod: { setupPluginListeners?: () => void }) => {
      mod.setupPluginListeners?.();
      console.log('[App] tauri-plugin-mcp listeners initialized');
    }).catch(() => {});
  }, []);

  // ── Deeplink: teamclu://invite?token=… ───────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;

    async function handle(urls: string[]) {
      for (const raw of urls) {
        const token = parseInviteDeeplink(raw);
        if (!token) continue;
        // Member invites require an account. If the user isn't signed in yet,
        // stash the token and let sign-in + AuthGate's pending-invite effect
        // claim it once they're authenticated.
        const authState = useAuthStore.getState();
        if (!authState.session) {
          authState.setPendingInviteToken(token);
          continue;
        }
        try {
          const claim = await claimInviteToken(token);
          // enterTeam, not reloadAndSwitchTo: the claim switched the org
          // server-side but this client still holds the pre-claim JWT.
          await useCurrentTeamStore.getState().enterTeam(claim.teamId);
          // Re-onboard the local daemon to the freshly-claimed team. The
          // daemon-onboarding store's refresh() detects the team mismatch and
          // the DaemonOnboardingWizard handles re-onboard. Best-effort only.
          if (isTauri()) {
            try {
              const { useDaemonOnboardingStore } = await import("@/stores/daemon-onboarding");
              await useDaemonOnboardingStore.getState().refresh();
            } catch (e) {
              console.warn("[invite] daemon refresh after claim failed", e);
            }
          }
          // TODO(Task 12): surface <JoinTeamFlow teamId={claim.teamId}
          //   workspacePath={currentWorkspacePath} /> in an onboarding sheet
          //   here so the joiner auto-pulls workspace config and enters the
          //   team secret. Component lives at
          //   packages/app/src/components/onboarding/JoinTeamFlow.tsx.
        } catch (err) {
          console.error('[invite] claim failed', err);
        }
      }
    }

    // Cold start — link that launched the app. Requires deep-link:default in
    // apps/desktop/capabilities (getCurrent is an invoke; onOpenUrl is not).
    getCurrent()
      .then((urls) => { if (urls) handle(urls); })
      .catch((err) => { console.warn("[invite] getCurrent failed", err); });

    // Hot delivery while app is already open
    onOpenUrl(handle)
      .then((u) => { unlisten = u; })
      .catch((err) => { console.warn("[invite] onOpenUrl failed", err); });

    return () => { unlisten?.(); };
  }, []);

  // ── Deeplink: teamclu://session/<uuid> ───────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;

    async function handle(urls: string[]) {
      for (const raw of urls) {
        const sessionId = parseSessionDeeplink(raw);
        if (!sessionId) continue;
        stashPendingSessionDeeplink(sessionId);
        await openSessionFromDeeplink(sessionId);
      }
    }

    // Cold start — macOS delivers RunEvent::Opened before the webview listens,
    // so the URL is only recoverable via getCurrent (needs deep-link:default).
    getCurrent()
      .then((urls) => { if (urls) handle(urls); })
      .catch((err) => { console.warn("[session-deeplink] getCurrent failed", err); });

    // Hot delivery while app is already open
    onOpenUrl(handle)
      .then((u) => { unlisten = u; })
      .catch((err) => { console.warn("[session-deeplink] onOpenUrl failed", err); });

    return () => { unlisten?.(); };
  }, []);

  // Cold-start resume: the OS may deliver the session link before auth hydrates.
  const authSession = useAuthStore((s) => s.session);
  useEffect(() => {
    if (!isTauri()) return;
    if (!authSession) return;
    const pending = readPendingSessionDeeplink();
    if (!pending) return;
    void openSessionFromDeeplink(pending.sessionId);
  }, [authSession]);

  // Extracted hooks — initialization, telemetry consent
  useTauriBodyClass();
  useOpenCodePreload();
  const { showConsentDialog, setShowConsentDialog } = useTelemetryConsent();

  // First-run onboarding (welcome, dependency setup, role, model) all lives in
  // AuthGate now, ahead of this component — see #881. By the time App renders,
  // the user is through it.
  const mainContent = (
    <>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "220px",
            "--session-list-width": "280px",
          } as React.CSSProperties
        }
      >
        <AppContent />
      </SidebarProvider>
      <Toaster
        position="top-center"
        offset={40}
        toastOptions={{
          className: '!bg-popover !text-popover-foreground !border-border !shadow-md !rounded-md !text-xs !py-2 !px-3 !min-h-0 !gap-1.5',
          descriptionClassName: '!text-muted-foreground !text-[11px]',
        }}
      />
      <UpdateDialogContainer />
      <CloseToTrayHost />
      <NewSessionDialog />
      <TelemetryConsentDialog
        open={showConsentDialog}
        onComplete={() => setShowConsentDialog(false)}
      />
    </>
  )

  return isTauri() ? (
    <div className="h-screen w-screen rounded-2xl overflow-hidden bg-background">
      {mainContent}
    </div>
  ) : (
    <>{mainContent}</>
  )
}

export default App;
