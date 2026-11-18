//! Column four: everything opened *from* a conversation — workspace files,
//! chat attachments, web tabs, app data — as tabs beside it.
//!
//! The column is on screen exactly while a tab is active. Hiding it is
//! `hideAll` (tabs stay, the last one is remembered); opening any tab brings
//! it back. Its width follows `contentColumnMode`: `half` shares the row with
//! the conversation, `full` takes column two's and three's room too.

import * as React from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Columns2, Maximize2, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileContentViewer } from "@/components/FileEditor";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore, selectActiveTab, selectHasHiddenTabs } from "@/stores/tabs";
import { useUIStore } from "@/stores/ui";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { FindInPageBar } from "@/components/tab-bar/FindInPageBar";
import { urlToLabel } from "@/lib/ui/webview-utils";
import { useWebviewUIStore } from "@/app/webview-ui-store";
import { PreviewTabContent } from "@/components/content-column/PreviewTabContent";
import { useLayoutBreakpoint } from "@/hooks/use-layout-breakpoint";
import { useEffectiveContentColumnMode } from "@/components/content-column/content-column-state";
import { useSectionMode } from "@/lib/layout/section-mode";

export {
  useContentColumnVisible,
  useEffectiveContentColumnMode,
} from "@/components/content-column/content-column-state";

/**
 * Header button that brings column four back after it was hidden. Renders
 * nothing unless the open session has tabs parked behind a hide.
 */
export function ContentColumnRestoreButton() {
  const { t } = useTranslation();
  const hasHiddenTabs = useTabsStore(selectHasHiddenTabs);
  if (!hasHiddenTabs) return null;
  const label = t("navigation.restoreTabs", "Show files");
  return (
    <button
      type="button"
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => useTabsStore.getState().restoreLastTab()}
      title={label}
      aria-label={label}
      data-testid="content-column-restore"
    >
      <AppWindow className="h-4 w-4" />
    </button>
  );
}

/**
 * Keeps the workspace's single "selected file" and the active file tab in
 * step. Lives here rather than in a view because both directions must keep
 * working while the column is hidden: a file picked in the tree has to open a
 * tab (which shows the column), and switching tabs has to load the file.
 */
function useFileTabSelectionSync() {
  const activeTab = useTabsStore(selectActiveTab);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    const hadTab = prevActiveTabId.current !== null;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      void selectFile(activeTab.target);
    }
    // Leaving file tabs altogether (hidden, closed, other session): clear the
    // selection so a stale file does not reopen itself.
    if (tabChanged && hadTab && activeTab?.type !== "file") {
      clearSelection();
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile, clearSelection]);
}

function LayoutButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-selected text-foreground"
          : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LayoutSwitcher() {
  const { t } = useTranslation();
  const mode = useEffectiveContentColumnMode();
  // In the knowledge section column four already has the row to itself, so
  // "half" has nothing to share it with; "full" there means "hide the list".
  const fills = useSectionMode() === "knowledge";
  const canHalf = useLayoutBreakpoint() === "wide" && !fills;
  const setMode = useUIStore((s) => s.setContentColumnMode);
  return (
    <>
      {canHalf ? (
        <LayoutButton
          label={t("contentColumn.half", "Half width")}
          active={mode === "half"}
          onClick={() => setMode("half")}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </LayoutButton>
      ) : null}
      <LayoutButton
        label={t("contentColumn.full", "Full width")}
        active={mode === "full"}
        onClick={() => setMode(mode === "full" ? "half" : "full")}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </LayoutButton>
      <LayoutButton
        label={t("contentColumn.hide", "Hide")}
        onClick={() => useTabsStore.getState().hideAll()}
      >
        <PanelRightClose className="h-3.5 w-3.5" />
      </LayoutButton>
    </>
  );
}

/** Drag handle on the column's left edge, half mode only. */
function ResizeEdge({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const setRatio = useUIStore((s) => s.setContentColumnRatio);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const row = containerRef.current?.parentElement;
    if (!row) return;
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const rect = row.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      if (rect.width <= 0) return;
      setRatio((rect.right - e.clientX) / rect.width);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };
  return (
    <div
      className="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-border"
      onPointerDown={onPointerDown}
      title={t("contentColumn.resize", "Drag to resize")}
      data-testid="content-column-resize"
    />
  );
}

export function ContentColumn() {
  useFileTabSelectionSync();
  const activeTab = useTabsStore(selectActiveTab);
  const mode = useEffectiveContentColumnMode();
  const ratio = useUIStore((s) => s.contentColumnRatio);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const fileContent = useWorkspaceStore((s) => s.fileContent);
  const isLoadingFile = useWorkspaceStore((s) => s.isLoadingFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const showFind = useWebviewUIStore((s) => s.showFind);
  const zoomLevels = useWebviewUIStore((s) => s.zoomLevels);
  const containerRef = useRef<HTMLElement | null>(null);
  // Knowledge documents replace the conversation rather than sit beside it,
  // so in that section a half-width column takes the whole row instead.
  const fills = useSectionMode() === "knowledge" && mode === "half";

  if (!activeTab) return null;

  return (
    <section
      ref={containerRef}
      data-testid="content-column"
      data-content-mode={mode}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        mode === "full" || fills ? "flex-1" : "shrink-0 border-l border-border",
      )}
      style={mode === "half" && !fills ? { width: `${ratio * 100}%` } : undefined}
    >
      {mode === "half" && !fills ? <ResizeEdge containerRef={containerRef} /> : null}
      <TabBar trailing={<LayoutSwitcher />} />
      {activeTab.type === "webview" && (
        <WebViewToolbar
          url={activeTab.target}
          label={urlToLabel(activeTab.target)}
          zoomLevel={zoomLevels[urlToLabel(activeTab.target)]}
        />
      )}
      {activeTab.type === "webview" && showFind && (
        <FindInPageBar
          label={urlToLabel(activeTab.target)}
          onClose={() => useWebviewUIStore.getState().setShowFind(false)}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0",
            activeTab.type === "webview" ? "pointer-events-none bg-transparent" : "bg-background",
          )}
        >
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
          ) : activeTab.type === "preview" ? (
            <PreviewTabContent key={activeTab.target} target={activeTab.target} />
          ) : (
            <TabContentRenderer />
          )}
        </div>
      </div>
    </section>
  );
}
