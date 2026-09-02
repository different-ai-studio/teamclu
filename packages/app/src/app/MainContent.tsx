//! The centre column: whichever tab is active renders here.

import * as React from "react";
import { useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { FileContentViewer } from "@/components/FileEditor";
import { useResizablePanels } from "@/hooks/useFileEditorState";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyNamed } from "@/lib/lazy-component";
import { PaneLoading } from "@/components/ui/pane-loading";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore, selectActiveTab } from "@/stores/tabs";
import { teamShareSectionForTarget } from "@/lib/tabs/teamshare-target";
import { useTeamShareBrowserStore } from "@/stores/team-share-browser";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { FindInPageBar } from "@/components/tab-bar/FindInPageBar";
import { urlToLabel } from "@/lib/webview-utils";
import { ResizeHandle } from "@/app/chrome";
import { useWebviewUIStore } from "@/app/webview-ui-store";

const TeamShareDetailContent = lazyNamed(
  () => import("@/components/teamshare/TeamShareTabContent"),
  "TeamShareDetailContent",
);
const IdeasDetailColumn = lazyNamed(
  () => import("@/components/panel/IdeaDetailPane"),
  "IdeasDetailColumn",
);
const ActorsDetailColumn = lazyNamed(
  () => import("@/components/main-content/ActorDetailPane"),
  "ActorsDetailColumn",
);

// Shows chat with a tab overlay. ChatPanel is always mounted to preserve its
// state, and hidden when a tab is active.
export function MainContent() {
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
  const directActorsSection = sidebarFilter.kind === "actors";
  const mainColumnOwned = !!directTeamShareSection || directIdeasSection || directActorsSection;
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
              <React.Suspense fallback={<PaneLoading />}>
                <TeamShareDetailContent target={visibleTeamShareDetail} />
              </React.Suspense>
            ) : null}
          </div>
        ) : directIdeasSection ? (
          <div className="absolute inset-0 bg-background">
            <React.Suspense fallback={<PaneLoading />}>
              <IdeasDetailColumn />
            </React.Suspense>
          </div>
        ) : directActorsSection ? (
          <div className="absolute inset-0 bg-background">
            <React.Suspense fallback={<PaneLoading />}>
              <ActorsDetailColumn />
            </React.Suspense>
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
