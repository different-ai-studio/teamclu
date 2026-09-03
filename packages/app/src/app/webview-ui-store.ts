//! Find-bar visibility and per-webview zoom levels.
//!
//! A module-level micro-store rather than component state: the shortcut
//! handlers and the webview surface that renders the find bar sit in
//! different subtrees of the app shell.

import { create } from "zustand";

export const useWebviewUIStore = create<{
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
