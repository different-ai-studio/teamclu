/**
 * useFileEditorState — file editor and tab state management extracted from App.tsx
 *
 * Handles:
 *  - Resizable panel widths (right panel)
 *  - Syncing selectedFile <-> TabsStore
 */
import { useEffect, useRef, useCallback } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore, selectActiveTab } from "@/stores/tabs";

// ─────────────────────────────────────────────────────────────────────────────
// Legacy no-op retained for callers/tests while file mode is removed.
// ─────────────────────────────────────────────────────────────────────────────

export function useLayoutModePanelSync() {
  return;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync selectedFile -> TabsStore (task mode)
// ─────────────────────────────────────────────────────────────────────────────

export function useFileTabSync() {
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);

  // Open a tab whenever a file is selected in the standard task layout.
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync tab switch -> workspace selectFile
// ─────────────────────────────────────────────────────────────────────────────

export function useTabToFileSync() {
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const activeTab = useTabsStore(selectActiveTab);
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      selectFile(activeTab.target);
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resizable panel state
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";

const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 600;
const MAIN_SPLIT_LEFT_MIN = 360;
const MAIN_SPLIT_LEFT_MAX = 900;

export function useResizablePanels(options?: { mainSplitLeftMaxWidth?: number }) {
  const [rightPanelWidth, setRightPanelWidth] = useState(400);
  const [mainSplitLeftWidth, setMainSplitLeftWidth] = useState(560);
  const mainSplitLeftMaxWidth = options?.mainSplitLeftMaxWidth ?? MAIN_SPLIT_LEFT_MAX;

  const handleRightPanelResize = useCallback((delta: number) => {
    setRightPanelWidth((prev) =>
      Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, prev - delta)),
    );
  }, []);

  const handleMainSplitResize = useCallback((delta: number) => {
    setMainSplitLeftWidth((prev) =>
      Math.min(mainSplitLeftMaxWidth, Math.max(MAIN_SPLIT_LEFT_MIN, prev + delta)),
    );
  }, [mainSplitLeftMaxWidth]);

  useEffect(() => {
    setMainSplitLeftWidth((prev) =>
      Math.min(mainSplitLeftMaxWidth, Math.max(MAIN_SPLIT_LEFT_MIN, prev)),
    );
  }, [mainSplitLeftMaxWidth]);

  return {
    rightPanelWidth,
    handleRightPanelResize,
    mainSplitLeftWidth,
    handleMainSplitResize,
  };
}
