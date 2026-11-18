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

/** The tab set that is not on screen, parked under its scope key. */
interface ParkedScope {
  tabs: Tab[];
  activeTabId: string | null;
  lastActiveTabId: string | null;
}

/** Scope used while no session is open (new-chat draft, empty state). */
export const NO_SESSION_TAB_SCOPE = "__no-session__";

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Remembers the last active tab when hideAll is called */
  _lastActiveTabId: string | null;
  /**
   * Tabs belong to a session: what the content column shows next to a chat is
   * that chat's files. `tabs` / `activeTabId` are always the current scope's;
   * every other scope's set is parked here until its session is opened again.
   */
  scopeKey: string;
  _parked: Record<string, ParkedScope>;
  /** Park the current tab set and bring up `key`'s (empty if it has none). */
  switchScope: (key: string) => void;
  /** True if a tab with this id is open in any scope, on screen or parked. */
  hasTabInAnyScope: (id: string) => boolean;
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
  scopeKey: NO_SESSION_TAB_SCOPE,
  _parked: {},

  switchScope: (key) => {
    const { scopeKey, tabs, activeTabId, _lastActiveTabId, _parked } = get();
    if (key === scopeKey) return;
    const parked = { ..._parked };
    if (tabs.length > 0) {
      parked[scopeKey] = { tabs, activeTabId, lastActiveTabId: _lastActiveTabId };
    } else {
      delete parked[scopeKey];
    }
    const incoming = parked[key];
    delete parked[key];
    set({
      scopeKey: key,
      _parked: parked,
      tabs: incoming?.tabs ?? [],
      activeTabId: incoming?.activeTabId ?? null,
      _lastActiveTabId: incoming?.lastActiveTabId ?? null,
    });
  },

  hasTabInAnyScope: (id) => {
    const { tabs, _parked } = get();
    if (tabs.some((t) => t.id === id)) return true;
    return Object.values(_parked).some((scope) => scope.tabs.some((t) => t.id === id));
  },

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
    const { tabs, activeTabId, _parked } = get();
    // Parked scopes too: the callers close tabs whose target stopped meaning
    // anything (another team's rows), and that is true in every session.
    let parkedChanged = false;
    const parked: Record<string, ParkedScope> = {};
    for (const [key, scope] of Object.entries(_parked)) {
      const keptParked = scope.tabs.filter((t) => !match(t));
      if (keptParked.length === scope.tabs.length) {
        parked[key] = scope;
        continue;
      }
      parkedChanged = true;
      if (keptParked.length === 0) continue;
      const survives = keptParked.some((t) => t.id === scope.activeTabId);
      parked[key] = {
        tabs: keptParked,
        activeTabId: survives ? scope.activeTabId : null,
        lastActiveTabId: survives ? scope.lastActiveTabId : null,
      };
    }
    const kept = tabs.filter((t) => !match(t));
    if (kept.length === tabs.length) {
      if (parkedChanged) set({ _parked: parked });
      return;
    }
    const activeSurvives = kept.some((t) => t.id === activeTabId);
    set({
      tabs: kept,
      _parked: parked,
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
