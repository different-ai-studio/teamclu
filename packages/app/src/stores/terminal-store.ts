import { create } from "zustand";
import {
  closeTerminal as closeTerminalIpc,
  listTerminals,
  openTerminal as openTerminalIpc,
} from "@/lib/terminal/client";

type TerminalTabId = string;

export interface TerminalTab {
  id: TerminalTabId;
  workspaceId: string;
  title: string;
  pid: number;
  shell: string;
  cwd: string;
  status: "running" | "exited";
  exitCode?: number;
  exitedAt?: number;
  /** Last command line the user pressed Enter on (from OSC 633 ; E). */
  lastCommand?: string;
  /** Exit code of the most recently finished command (from OSC 633 ; D). */
  lastCommandExit?: number;
  /** Wall-clock timestamp when the last command finished. */
  lastCommandAt?: number;
}

interface OpenOpts {
  cwd: string;
  shell?: string;
  allowedRoots: string[];
}

interface TerminalState {
  tabsByWorkspace: Record<string, TerminalTab[]>;
  activeTabByWorkspace: Record<string, TerminalTabId | null>;
  panelOpenByWorkspace: Record<string, boolean>;
  panelHeightByWorkspace: Record<string, number>;
}

interface TerminalActions {
  openTerminal(workspaceId: string, opts: OpenOpts): Promise<void>;
  closeTerminal(id: TerminalTabId): Promise<void>;
  setActiveTab(workspaceId: string, id: TerminalTabId): void;
  renameTab(id: TerminalTabId, title: string): void;
  togglePanel(workspaceId: string): void;
  setPanelHeight(workspaceId: string, px: number): void;
  hydrateForWorkspace(workspaceId: string): Promise<void>;
  markExited(id: TerminalTabId, code: number | null): void;
  updateCwd(id: TerminalTabId, cwd: string): void;
  recordCommandStart(id: TerminalTabId, command: string): void;
  recordCommandFinish(id: TerminalTabId, exitCode: number | null): void;
}

const HEIGHT_KEY = (ws: string) => `teamclu.terminal.height.${ws}`;
const DEFAULT_HEIGHT = 240;

function loadHeight(workspaceId: string): number {
  if (typeof localStorage === "undefined") return DEFAULT_HEIGHT;
  const v = localStorage.getItem(HEIGHT_KEY(workspaceId));
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 120 ? n : DEFAULT_HEIGHT;
}

export const useTerminalStore = create<TerminalState & TerminalActions>((set, get) => ({
  tabsByWorkspace: {},
  activeTabByWorkspace: {},
  panelOpenByWorkspace: {},
  panelHeightByWorkspace: {},

  async openTerminal(workspaceId, opts) {
    const { id, shell, pid } = await openTerminalIpc({
      workspaceId,
      cwd: opts.cwd,
      cols: 80,
      rows: 24,
      shell: opts.shell,
      allowedRoots: opts.allowedRoots,
    });
    const tab: TerminalTab = {
      id,
      workspaceId,
      title: deriveTitle(shell),
      pid,
      shell,
      cwd: opts.cwd,
      status: "running",
    };
    set(state => {
      const existing = state.tabsByWorkspace[workspaceId] ?? [];
      return {
        tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: [...existing, tab] },
        activeTabByWorkspace: { ...state.activeTabByWorkspace, [workspaceId]: id },
        panelOpenByWorkspace: { ...state.panelOpenByWorkspace, [workspaceId]: true },
        panelHeightByWorkspace: state.panelHeightByWorkspace[workspaceId]
          ? state.panelHeightByWorkspace
          : { ...state.panelHeightByWorkspace, [workspaceId]: loadHeight(workspaceId) },
      };
    });
  },

  async closeTerminal(id) {
    const state = get();
    let owner: string | undefined;
    let index = -1;
    for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
      const i = tabs.findIndex(t => t.id === id);
      if (i >= 0) { owner = ws; index = i; break; }
    }
    if (!owner) return;
    await closeTerminalIpc(id).catch(() => {});

    const tabs = state.tabsByWorkspace[owner];
    const nextTabs = tabs.filter(t => t.id !== id);
    let nextActive: TerminalTabId | null = state.activeTabByWorkspace[owner] ?? null;
    if (nextActive === id) {
      nextActive = nextTabs.length === 0
        ? null
        : nextTabs[Math.max(0, index - 1)].id;
    }
    set({
      tabsByWorkspace: { ...state.tabsByWorkspace, [owner]: nextTabs },
      activeTabByWorkspace: { ...state.activeTabByWorkspace, [owner]: nextActive },
    });
  },

  setActiveTab(workspaceId, id) {
    set(state => ({
      activeTabByWorkspace: { ...state.activeTabByWorkspace, [workspaceId]: id },
    }));
  },

  renameTab(id, title) {
    set(state => {
      const out: Record<string, TerminalTab[]> = {};
      for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
        out[ws] = tabs.map(t => (t.id === id ? { ...t, title } : t));
      }
      return { tabsByWorkspace: out };
    });
  },

  togglePanel(workspaceId) {
    set(state => ({
      panelOpenByWorkspace: {
        ...state.panelOpenByWorkspace,
        [workspaceId]: !state.panelOpenByWorkspace[workspaceId],
      },
      panelHeightByWorkspace: state.panelHeightByWorkspace[workspaceId]
        ? state.panelHeightByWorkspace
        : { ...state.panelHeightByWorkspace, [workspaceId]: loadHeight(workspaceId) },
    }));
  },

  setPanelHeight(workspaceId, px) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(HEIGHT_KEY(workspaceId), String(px));
    }
    set(state => ({
      panelHeightByWorkspace: { ...state.panelHeightByWorkspace, [workspaceId]: px },
    }));
  },

  async hydrateForWorkspace(workspaceId) {
    const summaries = await listTerminals(workspaceId).catch(() => []);
    if (summaries.length === 0) return;
    set(state => {
      const existing = state.tabsByWorkspace[workspaceId] ?? [];
      const known = new Map(existing.map(t => [t.id, t]));
      const merged: TerminalTab[] = summaries.map((s: { id: string; shell: string; pid: number; status: "running" | "exited"; exit_code?: number | null }) => {
        const prev = known.get(s.id);
        return prev
          ? { ...prev, status: s.status, exitCode: s.exit_code ?? undefined }
          : {
              id: s.id,
              workspaceId,
              title: deriveTitle(s.shell),
              pid: s.pid,
              shell: s.shell,
              cwd: "",
              status: s.status,
              exitCode: s.exit_code ?? undefined,
            };
      });
      return {
        tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: merged },
        activeTabByWorkspace: state.activeTabByWorkspace[workspaceId]
          ? state.activeTabByWorkspace
          : { ...state.activeTabByWorkspace, [workspaceId]: merged[0]?.id ?? null },
      };
    });
  },

  markExited(id, code) {
    set(state => {
      const out: Record<string, TerminalTab[]> = {};
      for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
        out[ws] = tabs.map(t =>
          t.id === id
            ? { ...t, status: "exited", exitCode: code ?? undefined, exitedAt: Date.now() }
            : t,
        );
      }
      return { tabsByWorkspace: out };
    });
  },

  updateCwd(id, cwd) {
    set(state => patchTab(state, id, t => (t.cwd === cwd ? t : { ...t, cwd })));
  },

  recordCommandStart(id, command) {
    const trimmed = command.trim();
    if (!trimmed) return;
    set(state =>
      patchTab(state, id, t => ({ ...t, lastCommand: trimmed, lastCommandExit: undefined })),
    );
  },

  recordCommandFinish(id, exitCode) {
    set(state =>
      patchTab(state, id, t => ({
        ...t,
        lastCommandExit: exitCode ?? undefined,
        lastCommandAt: Date.now(),
      })),
    );
  },
}));

function patchTab(
  state: TerminalState,
  id: TerminalTabId,
  patch: (tab: TerminalTab) => TerminalTab,
): Partial<TerminalState> {
  let touched = false;
  const out: Record<string, TerminalTab[]> = {};
  for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
    let tabsChanged = false;
    const nextTabs = tabs.map(t => {
      if (t.id !== id) return t;
      const next = patch(t);
      if (next !== t) tabsChanged = true;
      return next;
    });
    out[ws] = tabsChanged ? nextTabs : tabs;
    if (tabsChanged) touched = true;
  }
  return touched ? { tabsByWorkspace: out } : {};
}

function deriveTitle(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? "shell";
  return base.replace(/\.exe$/, "");
}
