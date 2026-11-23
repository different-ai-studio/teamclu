import { create } from "zustand";

export interface Tab {
  id: string;
  /**
   * `preview` is a read-only rendering of a chat file (markdown / html) whose
   * body lives in `lib/tabs/preview-tabs.ts`, keyed by `target`.
   */
  type: "file" | "webview" | "native" | "preview";
  target: string;
  label: string;
  dirty: boolean;
  title?: string;
  faviconUrl?: string;
}

interface OpenTabInput {
  type: Tab["type"];
  target: string;
  label: string;
}

let nextId = 1;

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Remembers the last active tab when hideAll is called */
  _lastActiveTabId: string | null;
  openTab: (item: OpenTabInput) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  /**
   * Close every tab whose target the predicate accepts.
   *
   * Takes a predicate rather than a prefix so this store stays ignorant of what
   * any particular target means — the caller owns that vocabulary.
   */
  closeWhere: (match: (tab: Tab) => boolean) => void;
  /** Deactivate all tabs without closing them — returns to agent view */
  hideAll: () => void;
  /** Re-activate the last tab after hideAll */
  restoreLastTab: () => void;
  getActiveTab: () => Tab | null;
  updateTabMeta: (target: string, meta: { title?: string; faviconUrl?: string }) => void;
}

/** True when tabs exist but none is active (hidden via hideAll). */
export function selectHasHiddenTabs(s: TabsState): boolean {
  return s.tabs.length > 0 && s.activeTabId === null;
}

/** Zustand selector for the active tab. Use with `useTabsStore(selectActiveTab)`. */
export function selectActiveTab(s: TabsState): Tab | null {
  if (!s.activeTabId) return null;
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  _lastActiveTabId: null,

  openTab: (item) => {
    const { tabs, activeTabId } = get();
    const existing = tabs.find(
      (t) => t.type === item.type && t.target === item.target,
    );
    if (existing) {
      // Skip state update if this tab is already active — prevents circular re-renders
      if (activeTabId !== existing.id) {
        set({ activeTabId: existing.id });
      }
      return;
    }
    const id = `tab-${nextId++}`;
    const tab: Tab = { id, ...item, dirty: false };
    set({ tabs: [...tabs, tab], activeTabId: id });
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const newTabs = tabs.filter((t) => t.id !== id);
    let newActive = activeTabId;
    if (activeTabId === id) {
      if (newTabs.length === 0) {
        newActive = null;
      } else if (idx < newTabs.length) {
        newActive = newTabs[idx].id; // right neighbor
      } else {
        newActive = newTabs[newTabs.length - 1].id; // left neighbor
      }
    }
    set({ tabs: newTabs, activeTabId: newActive });
  },

  setActiveTab: (id) => {
    const { tabs } = get();
    if (tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
    }
  },

  setDirty: (id, dirty) => {
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
    });
  },

  closeOthers: (id) => {
    const kept = get().tabs.filter((t) => t.id === id);
    set({ tabs: kept, activeTabId: kept.length > 0 ? id : null });
  },

  closeAll: () => {
    set({ tabs: [], activeTabId: null });
  },

  closeWhere: (match) => {
    const { tabs, activeTabId } = get();
    const kept = tabs.filter((t) => !match(t));
    if (kept.length === tabs.length) return;
    const activeSurvives = kept.some((t) => t.id === activeTabId);
    set({
      tabs: kept,
      // Falling back to the last remaining tab rather than to nothing: closing
      // the active one should leave you somewhere, the way closeTab does.
      activeTabId: activeSurvives ? activeTabId : (kept[kept.length - 1]?.id ?? null),
    });
  },

  hideAll: () => {
    const { activeTabId } = get();
    if (activeTabId) set({ _lastActiveTabId: activeTabId, activeTabId: null });
    else set({ activeTabId: null });
  },

  restoreLastTab: () => {
    const { tabs, activeTabId, _lastActiveTabId } = get();
    if (activeTabId) return; // already showing a tab
    if (_lastActiveTabId && tabs.some((t) => t.id === _lastActiveTabId)) {
      set({ activeTabId: _lastActiveTabId });
    } else if (tabs.length > 0) {
      set({ activeTabId: tabs[tabs.length - 1].id });
    }
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    if (!activeTabId) return null;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },

  updateTabMeta: (target, meta) => {
    set({
      tabs: get().tabs.map((t) =>
        t.target === target ? { ...t, ...meta } : t
      ),
    });
  },
}));
