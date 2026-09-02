import { create } from "zustand";
import { UNSUPPORTED_BINARY_EXTENSIONS } from "@/components/viewers/UnsupportedFileViewer";
import { isTauri } from '@/lib/utils'
import { ensureGitignoreEntries } from '@/lib/gitignore-manager'
import { seedDefaultWorkspaceInstructions } from '@/lib/workspace-seed/seed-default-instructions'
import { appDisplayName, appStoragePrefix, TEAM_REPO_DIR } from '@/lib/build-config'
import { useTeamModeStore } from './team-mode'

// Start watching a directory for file changes
async function startWatching(path: string): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<boolean>("watch_directory", { path });
    console.log("[Workspace] Started file watcher for:", path);
    return result;
  } catch (error) {
    console.error("[Workspace] Failed to start file watcher:", error);
    return false;
  }
}

// Stop watching a directory
async function stopWatching(path: string): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<boolean>("unwatch_directory", { path });
    console.log("[Workspace] Stopped file watcher for:", path);
    return result;
  } catch (error) {
    console.error("[Workspace] Failed to stop file watcher:", error);
    return false;
  }
}

// Expand ~ to home directory
async function expandPath(path: string): Promise<string> {
  if (!path.startsWith("~")) return path;

  if (isTauri()) {
    try {
      const { homeDir } = await import("@tauri-apps/api/path");
      const home = await homeDir();
      return path.replace(/^~/, home.replace(/\/$/, ""));
    } catch {
      return path;
    }
  }
  return path;
}

async function ensureWorkspaceDirectory(path: string): Promise<void> {
  if (!isTauri()) return

  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs")
    await mkdir(path, { recursive: true })
  } catch (error) {
    console.warn("[Workspace] Failed to ensure workspace directory:", error)
  }
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

// Right panel tab type.
//
// `files` is the workspace file tree (rendered by the `FileBrowser` component,
// which still lives in components/workspace/). It was dropped from the right
// panel by #1054 (which removed the separate RAG `KnowledgeBrowser` that also
// lived under this tab id), but the `FileBrowser` itself was retained — it is
// also rendered in the left team-share column. Restoring the `files` tab here
// re-opens the right-panel entry to the same `FileBrowser`, with no RAG
// dependency. `teamShared` is intentionally NOT restored: that tab pointed at
// the team repo dir, which is empty now that knowledge syncs to
// `shared/knowledge`, and its header entry already moved to the left-nav
// Knowledge column.
export type RightPanelTab = "diff" | "shortcuts" | "files" | "actors";

// Undo operation types for file operations
interface UndoOperation {
  type: 'delete' | 'rename' | 'move';
  description: string;
  // For delete: original path + content backup
  originalPath: string;
  isDirectory: boolean;
  // For rename/move: new path
  newPath?: string;
  // For delete files: backed-up content (text only, binary files can't be undone)
  content?: string;
}

interface WorkspaceState {
  // Workspace state
  workspacePath: string | null;
  workspaceName: string | null;
  isLoadingWorkspace: boolean;

  // OpenCode sidecar state. This runtime is restored for settings,
  // automations, and gateway integrations; ChatPanel stays daemon-owned.
  openCodeBootstrapped: boolean;
  openCodeReady: boolean;
  openCodeUrl: string | null;
  setOpenCodeBootstrapped: (bootstrapped: boolean, url?: string) => void;
  setOpenCodeReady: (ready: boolean, url?: string) => void;

  /** Local amuxd daemon HTTP control plane is reachable (`/v1/healthz`). */
  daemonHttpReady: boolean;
  setDaemonHttpReady: (ready: boolean) => void;

  // Right panel state
  isPanelOpen: boolean;
  activeTab: RightPanelTab;

  // File browser state
  fileTree: FileNode[];
  /**
   * File trees rooted OUTSIDE the workspace, keyed by root path; the value is
   * that root's children.
   *
   * The team Knowledge column browses the daemon's real directory
   * (`~/.amuxd/teams/<id>/shared/knowledge`) — the same absolute path the OSS
   * sync engine owns — and never the per-workspace `team-knowledge` symlink.
   * That tree cannot live in `fileTree`: `fileTree` is workspace-rooted and is
   * what the right-hand file panel renders, so a foreign root parked in it
   * would show up there as a stray top-level folder.
   */
  externalTrees: Record<string, FileNode[]>;
  expandedPaths: Set<string>; // Tracks which directories are expanded (decoupled from tree data)
  loadingPaths: Set<string>; // Tracks which directories are currently loading
  selectedFile: string | null;
  selectedFiles: string[]; // Multi-select support
  lastSelectedFile: string | null; // Track last selected file for range selection
  fileContent: string | null;
  isLoadingFile: boolean;
  targetLine: number | null; // Line number to scroll to after file loads
  targetHeading: string | null; // Heading text to scroll to (for Markdown files)
  focusedPath: string | null; // Keyboard navigation focused item

  // Undo stack
  undoStack: UndoOperation[];

  // Clipboard
  clipboardPaths: string[];
  clipboardMode: 'copy' | 'cut' | null;
  setClipboard: (paths: string[], mode: 'copy' | 'cut') => void;
  clearClipboard: () => void;
  pasteFiles: (targetDir: string) => Promise<boolean>;

  // Actions
  setWorkspace: (path: string) => Promise<void>;
  clearWorkspace: () => Promise<void>;

  // Panel actions
  openPanel: (tab?: RightPanelTab) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setActiveTab: (tab: RightPanelTab) => void;

  // File tree actions
  loadDirectory: (path: string) => Promise<FileNode[]>;
  expandDirectory: (path: string) => Promise<void>;
  openExternalRoot: (rootPath: string) => Promise<void>;
  refreshExternalRoot: (rootPath: string) => Promise<void>;
  closeExternalRoot: (rootPath: string) => Promise<void>;
  collapseDirectory: (path: string) => void;
  collapseAll: () => void;
  refreshFileTree: () => Promise<void>;
  refreshChangedDirectories: (directories: string[]) => Promise<void>;
  revealFile: (path: string) => Promise<void>;

  // File actions
  selectFile: (path: string, line?: number, heading?: string) => Promise<void>;
  selectFileRange: (path: string) => void; // Shift+Click range selection
  toggleFileSelection: (path: string) => void; // Ctrl/Cmd+Click toggle selection
  reloadSelectedFile: () => Promise<void>;
  clearSelection: () => void;
  setFocusedPath: (path: string | null) => void;

  // Undo
  pushUndo: (op: UndoOperation) => void;
  undo: () => Promise<boolean>;

  // Helpers
  flattenVisibleFileTree: (nodes: FileNode[]) => string[];
}

// Extract folder name from path
function getFolderName(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export const WORKSPACE_STORAGE_KEY = `${appStoragePrefix}-workspace-path`;

async function readWorkspaceTextFile(
  workspacePath: string,
  path: string,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_workspace_text_file", { workspacePath, path });
}

async function readWorkspaceBinaryFile(
  workspacePath: string,
  path: string,
): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<number[]>("read_workspace_binary_file", { workspacePath, path });
  return new Uint8Array(bytes);
}

async function readWorkspaceDirectory(
  workspacePath: string,
  path: string,
): Promise<FileNode[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FileNode[]>("read_workspace_directory", { workspacePath, path });
}

// A freshly listed directory arrives with every entry's `children` undefined,
// so swapping the array in wholesale discards any subtree already expanded
// underneath it. Carry the loaded children across for entries that survived the
// listing; new entries keep their unloaded state.
//
// Without this, re-listing a parent silently un-loads its grandchildren, and
// any caller that treats "children === undefined" as "needs loading" — see
// FileBrowser's `findSubtree` — is handed a reason to load again immediately.
function mergeLoadedChildren(
  previous: FileNode[] | undefined,
  next: FileNode[],
): FileNode[] {
  if (!previous || previous.length === 0) return next;
  const loaded = new Map<string, FileNode[]>();
  for (const node of previous) {
    if (node.children !== undefined) loaded.set(node.path, node.children);
  }
  if (loaded.size === 0) return next;
  return next.map((node) => {
    const kept = loaded.get(node.path);
    // Only directories can carry children; a path that flipped file↔directory
    // between listings must not inherit the old subtree.
    return kept !== undefined && node.type === "directory"
      ? { ...node, children: kept }
      : node;
  });
}

// Update only the target node's children, creating new references only along
// the path from root to target. Siblings and unrelated subtrees keep their
// original references, preserving React.memo effectiveness.
function updateNodeChildren(
  nodes: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children: mergeLoadedChildren(node.children, children) };
    }
    // Only recurse into directories whose path is a prefix of targetPath
    if (node.children && targetPath.startsWith(node.path + "/")) {
      return {
        ...node,
        children: updateNodeChildren(node.children, targetPath, children),
      };
    }
    return node; // unchanged reference
  });
}

// Serialises `expandDirectory` per path. Two loads of the same directory used
// to interleave, and the one that started first could publish last —
// republishing children it read before the other call's write.
//
// Chained rather than dropped: several call sites expand a directory precisely
// to reveal a file they just created, and silently skipping that refresh would
// leave the new file invisible.
const expandChain = new Map<string, Promise<void>>();

/**
 * The registered external root that owns `path`, or null when the workspace
 * owns it. Prefix match on a path boundary so `/a/bc` never matches root `/a/b`.
 */
function externalRootFor(roots: string[], path: string): string | null {
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  return null;
}

function findNodeByPath(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const child = findNodeByPath(node.children, path);
      if (child) return child;
    }
  }
  return null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  // Initial state
  workspacePath: null,
  workspaceName: null,
  isLoadingWorkspace: false,
  openCodeBootstrapped: false,
  openCodeReady: false,
  openCodeUrl: null,
  setOpenCodeBootstrapped: (bootstrapped: boolean, url?: string) =>
    set(
      bootstrapped
        ? { openCodeBootstrapped: true, ...(url ? { openCodeUrl: url } : {}) }
        : { openCodeBootstrapped: false, openCodeReady: false, openCodeUrl: null },
    ),
  setOpenCodeReady: (ready: boolean, url?: string) =>
    set({
      openCodeReady: ready,
      ...(ready ? { openCodeBootstrapped: true } : {}),
      ...(url ? { openCodeUrl: url } : {}),
    }),
  daemonHttpReady: false,
  setDaemonHttpReady: (ready: boolean) => set({ daemonHttpReady: ready }),
  isPanelOpen: false,
  activeTab: "shortcuts",
  fileTree: [],
  externalTrees: {},
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  selectedFile: null,
  selectedFiles: [], // Multi-select support
  lastSelectedFile: null, // Track last selected file for range selection
  fileContent: null,
  isLoadingFile: false,
  targetLine: null,
  targetHeading: null,
  focusedPath: null,
  undoStack: [],
  clipboardPaths: [],
  clipboardMode: null,

  setClipboard: (paths, mode) => set({ clipboardPaths: paths, clipboardMode: mode }),
  clearClipboard: () => set({ clipboardPaths: [], clipboardMode: null }),

  pasteFiles: async (targetDir: string) => {
    const { clipboardPaths, clipboardMode, refreshFileTree } = get();
    if (!isTauri()) return false;

    try {
      const { readSystemClipboardFiles, resolvePasteSource } = await import(
        "@/components/workspace/system-clipboard-files"
      );
      // The OS pasteboard wins when it holds files, so a Copy performed in
      // Finder can be pasted here. Falls back to the in-app clipboard, which
      // is the only source that can express a pending move.
      const source = resolvePasteSource(
        await readSystemClipboardFiles(),
        clipboardPaths,
        clipboardMode,
      );
      if (!source) return false;

      const { copyItem, moveItem } = await import(
        "@/components/workspace/file-tree-operations"
      );

      let allSuccess = true;
      for (const sourcePath of source.paths) {
        // Skip copy/move into self or own subtree
        if (targetDir === sourcePath || targetDir.startsWith(sourcePath + '/')) continue;
        const success =
          source.mode === "copy"
            ? await copyItem(sourcePath, targetDir)
            : await moveItem(sourcePath, targetDir);
        if (!success) allSuccess = false;
      }

      if (source.mode === "cut") {
        set({ clipboardPaths: [], clipboardMode: null });
      }

      await refreshFileTree();
      // A paste can land inside an external root (the Knowledge tree), which
      // the workspace refresh above does not touch.
      if (externalRootFor(Object.keys(get().externalTrees), targetDir)) {
        await get().expandDirectory(targetDir);
      }
      return allSuccess;
    } catch (error) {
      console.error("[Workspace] Paste failed:", error);
      return false;
    }
  },

  // Set workspace and load file tree
  setWorkspace: async (path: string) => {
    // Expand ~ to home directory
    const expandedPath = await expandPath(path);
    console.log("[Workspace] Setting workspace:", path, "->", expandedPath);
    await ensureWorkspaceDirectory(expandedPath);

    // If selecting the same workspace, just refresh the file tree — don't reset agent state
    const currentPath = get().workspacePath;
    if (currentPath === expandedPath) {
      console.log("[Workspace] Same workspace selected, skipping reset");
      await get().refreshFileTree();
      return;
    }

    // Stop watching previous workspace if any
    if (currentPath) {
      await stopWatching(currentPath);
    }

    set({
      isLoadingWorkspace: true,
      openCodeBootstrapped: false,
      openCodeReady: false,
      openCodeUrl: null,
      daemonHttpReady: false,
      workspacePath: expandedPath,
      workspaceName: getFolderName(expandedPath),
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
      focusedPath: null,
      undoStack: [],
      clipboardPaths: [],
      clipboardMode: null,
    });

    // Update dock right-click menu title to show workspace name
    if (isTauri()) {
      const wsName = getFolderName(expandedPath);
      import('@tauri-apps/api/core')
        .then(async (m) => {
          await Promise.all([
            m.invoke('set_window_title', { title: `${appDisplayName} — ${wsName}` }),
            m.invoke('register_window_workspace', { workspacePath: expandedPath }),
          ]);
          const { default: i18n } = await import('@/lib/i18n');
          await m.invoke('set_config_locale', { locale: i18n.language }).catch(() => {});
        })
        .catch(() => {});
    }

    // Reset UI to home state: close settings, switch to task/chat mode, clear tabs
    try {
      const { useUIStore } = await import("./ui");
      useUIStore.setState({
        currentView: 'chat',
        layoutMode: 'task',
        settingsInitialSection: null,
      });
    } catch { /* ignore */ }
    try {
      const { useTabsStore } = await import("./tabs");
      useTabsStore.getState().closeAll();
    } catch { /* ignore */ }

    // Reset team mode state — each workspace has its own team config
    try {
      const { useTeamMembersStore } = await import("./team-members");
      useTeamMembersStore.getState().reset();
      useTeamModeStore.setState({
        teamModelConfig: null,
        _appliedConfigKey: null,
        teamGitSyncing: false,
      });
      // Load team config immediately so sidebar shows team tag on startup
      useTeamModeStore.getState().loadTeamConfig(expandedPath).catch(() => {});
    } catch { /* ignore */ }

    // Persist workspace path for auto-restore on next launch.
    // Secondary windows opened via create_workspace_window pass `?workspace=`
    // in the URL — they must not overwrite the main window's saved value.
    const isSecondaryWindow =
      typeof window !== 'undefined' &&
      typeof window.location?.search === 'string' &&
      new URLSearchParams(window.location.search).has('workspace');
    if (!isSecondaryWindow) {
      try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, expandedPath);
      } catch {
        /* ignore storage errors */
      }
    }

    try {
      // Seed root AGENTS.md / CLAUDE.md for nearly empty workspaces (never overwrite)
      // before refreshing the tree so the new files show up immediately.
      try {
        const { useCurrentTeamStore } = await import('./current-team')
        const teamName = useCurrentTeamStore.getState().team?.name ?? null
        await seedDefaultWorkspaceInstructions(expandedPath, {
          teamName,
          workspaceName: getFolderName(expandedPath),
        })
      } catch (error) {
        console.warn('[Workspace] Failed to seed default instructions:', error)
      }

      // Ensure .gitignore has required entries
      await ensureGitignoreEntries(expandedPath);

      // Load root directory
      await get().refreshFileTree();

      // Start watching the new workspace for file changes
      await startWatching(expandedPath);

      set({ isLoadingWorkspace: false });
    } catch (error) {
      console.error("Failed to load workspace:", error);
      set({ isLoadingWorkspace: false });
    }
  },

  clearWorkspace: async () => {
    // Stop watching current workspace
    const currentPath = get().workspacePath;
    if (currentPath) {
      await stopWatching(currentPath);
    }

    // Remove persisted workspace path (frontend localStorage + Rust last-workspace.json)
    try {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } catch {
      /* ignore storage errors */
    }
    if (isTauri()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("clear_last_workspace");
      } catch { /* ignore */ }
    }

    // Reset team mode state
    try {
      const { useTeamMembersStore } = await import("./team-members");
      const { useTeamModeStore } = await import("./team-mode");
      useTeamMembersStore.getState().reset();
      useTeamModeStore.setState({
        teamModelConfig: null,
        _appliedConfigKey: null,
        teamGitSyncing: false,
      });
    } catch { /* ignore */ }

    set({
      workspacePath: null,
      workspaceName: null,
      openCodeBootstrapped: false,
      openCodeReady: false,
      openCodeUrl: null,
      daemonHttpReady: false,
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
      focusedPath: null,
      undoStack: [],
      clipboardPaths: [],
      clipboardMode: null,
    });
  },

  // Panel actions
  openPanel: (tab?: RightPanelTab) => {
    void import("./ui").then(({ useUIStore }) => {
      useUIStore.getState().closeAppControlPanel();
    });
    set({
      isPanelOpen: true,
      ...(tab ? { activeTab: tab } : {}),
    });
  },
  closePanel: () => {
    set({ isPanelOpen: false })
  },
  togglePanel: () => {
    set((state) => ({ isPanelOpen: !state.isPanelOpen }))
  },
  setActiveTab: (tab: RightPanelTab) => set({ activeTab: tab }),

  // Load directory contents using Tauri FS plugin
  loadDirectory: async (path: string): Promise<FileNode[]> => {
    const { workspacePath, externalTrees } = get();
    // An external root reads against itself. `read_workspace_directory` only
    // checks that the target sits under the root it is handed, so the team
    // knowledge dir under ~/.amuxd browses even with no workspace open.
    const base = externalRootFor(Object.keys(externalTrees), path) ?? workspacePath;
    if (!base) {
      console.log("[Workspace] No workspace path set");
      return [];
    }

    // In web mode, skip file system operations
    if (!isTauri()) {
      console.log("[Web Mode] File browser not available");
      return [];
    }

    try {
      const fullPath = path === "." ? base : path;
      console.log("[Workspace] Loading directory:", fullPath);
      const nodes = await readWorkspaceDirectory(base, fullPath);
      console.log("[Workspace] Found", nodes.length, "entries");

      const visibleNodes = [...nodes];

      visibleNodes.sort((a, b) => {
        // Always put teamclu-team first
        if (a.name === TEAM_REPO_DIR && b.name !== TEAM_REPO_DIR) return -1;
        if (b.name === TEAM_REPO_DIR && a.name !== TEAM_REPO_DIR) return 1;
        
        // Then directories before files
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        
        // Then alphabetical
        return a.name.localeCompare(b.name);
      });

      return visibleNodes;
    } catch (error) {
      console.error("[Workspace] Failed to load directory:", error);
      return [];
    }
  },

  // Expand a directory node
  expandDirectory: async (path: string) => {
    const load = async () => {
      const { loadDirectory } = get();

      // Mark as loading via loadingPaths Set (O(1), no tree copy)
      const nextLoading = new Set(get().loadingPaths);
      nextLoading.add(path);
      set({ loadingPaths: nextLoading });

      // Load children
      const children = await loadDirectory(path);

      // Whichever tree owns this path is the one that gets rewritten.
      const externalRoot = externalRootFor(Object.keys(get().externalTrees), path);
      const currentExternal = externalRoot
        ? (get().externalTrees[externalRoot] ?? [])
        : [];
      const updatedExternal = externalRoot
        ? {
            ...get().externalTrees,
            // The root itself holds no node of its own — its children ARE the
            // tree — so it merges directly instead of going through the tree walk.
            [externalRoot]:
              path === externalRoot
                ? mergeLoadedChildren(currentExternal, children)
                : updateNodeChildren(currentExternal, path, children),
          }
        : get().externalTrees;

      // Update only the target node's children in the tree (minimal copy)
      const updatedTree = externalRoot
        ? get().fileTree
        : updateNodeChildren(get().fileTree, path, children);

      // Always clone CURRENT expandedPaths to avoid race conditions —
      // the Set reference may have been replaced by refreshFileTree during the await
      const nextExpanded = new Set(get().expandedPaths);
      nextExpanded.add(path);
      const doneLoading = new Set(get().loadingPaths);
      doneLoading.delete(path);

      set({
        fileTree: updatedTree,
        externalTrees: updatedExternal,
        expandedPaths: nextExpanded,
        loadingPaths: doneLoading,
      });
    };

    // Queue behind any load already running for this same path. See expandChain.
    const previous = expandChain.get(path) ?? Promise.resolve();
    const run = previous.then(load);
    // Swallowed only so one failure cannot poison every later expand of this
    // path; the awaited `run` below still rejects for this caller.
    const settled = run.catch(() => {});
    expandChain.set(path, settled);
    try {
      await run;
    } finally {
      // Last one out clears the slot, so the map cannot grow unbounded.
      if (expandChain.get(path) === settled) expandChain.delete(path);
    }
  },

  /**
   * Register a root outside the workspace, list it, and watch it.
   *
   * The watch is what makes a teammate's synced note appear without a manual
   * refresh: the daemon writes into its own directory, and a recursive watch on
   * the workspace never saw those writes — `notify` does not follow the
   * `team-knowledge` symlink, so the real directory was watched by nobody.
   *
   * Idempotent, and re-listing is the point: a create or delete inside the
   * knowledge tree refreshes it by calling this again.
   */
  openExternalRoot: async (rootPath: string) => {
    if (!(rootPath in get().externalTrees)) {
      set({ externalTrees: { ...get().externalTrees, [rootPath]: [] } });
      // Awaited, and before the listing: a watch started afterwards would miss
      // anything written while the first listing was in flight.
      await startWatching(rootPath);
    }
    await get().expandDirectory(rootPath);
  },

  /**
   * Re-list an external root and every expanded directory under it.
   *
   * `refreshFileTree`'s counterpart for a tree that is not the workspace's.
   * Expansions that no longer exist on disk are dropped; the workspace's own
   * expansions are never touched.
   */
  refreshExternalRoot: async (rootPath: string) => {
    const { loadDirectory } = get();
    if (!(rootPath in get().externalTrees)) return;

    const expandedPaths = get().expandedPaths;
    const stillValid = new Set<string>();
    const refreshExpanded = async (tree: FileNode[]): Promise<FileNode[]> =>
      Promise.all(
        tree.map(async (node) => {
          if (node.type === "directory" && expandedPaths.has(node.path)) {
            const children = await loadDirectory(node.path);
            stillValid.add(node.path);
            return { ...node, children: await refreshExpanded(children) };
          }
          return node;
        }),
      );

    const refreshed = await refreshExpanded(await loadDirectory(rootPath));

    const nextExpanded = new Set<string>();
    for (const path of get().expandedPaths) {
      const underRoot = path === rootPath || path.startsWith(`${rootPath}/`);
      // The root is the tree rather than a node in it, so it stays expanded.
      if (!underRoot || path === rootPath || stillValid.has(path)) {
        nextExpanded.add(path);
      }
    }

    set({
      externalTrees: { ...get().externalTrees, [rootPath]: refreshed },
      expandedPaths: nextExpanded,
    });
  },

  /**
   * Forget an external root and stop watching it. Used when the root itself
   * changes — switching teams repoints the knowledge dir at another directory,
   * and the old one must stop reporting.
   */
  closeExternalRoot: async (rootPath: string) => {
    const externalTrees = { ...get().externalTrees };
    if (!(rootPath in externalTrees)) return;
    delete externalTrees[rootPath];

    const nextExpanded = new Set<string>();
    for (const path of get().expandedPaths) {
      if (path !== rootPath && !path.startsWith(`${rootPath}/`)) nextExpanded.add(path);
    }

    set({ externalTrees, expandedPaths: nextExpanded });
    await stopWatching(rootPath);
  },

  // Collapse a directory node
  collapseDirectory: (path: string) => {
    // O(1) set operation, zero tree copy
    const nextExpanded = new Set(get().expandedPaths);
    nextExpanded.delete(path);
    set({ expandedPaths: nextExpanded });
  },

  // Collapse all directories
  collapseAll: () => {
    set({ expandedPaths: new Set<string>() });
  },

  setFocusedPath: (path: string | null) => {
    set({ focusedPath: path });
  },

  pushUndo: (op: UndoOperation) => {
    const stack = get().undoStack;
    // Keep max 20 undo operations
    set({ undoStack: [...stack.slice(-19), op] });
  },

  undo: async () => {
    const stack = get().undoStack;
    if (stack.length === 0) return false;

    const op = stack[stack.length - 1];
    const newStack = stack.slice(0, -1);
    set({ undoStack: newStack });

    if (!isTauri()) return false;

    try {
      if (op.type === 'rename' || op.type === 'move') {
        // Reverse: move newPath back to originalPath
        if (op.newPath) {
          const { rename } = await import("@tauri-apps/plugin-fs");
          await rename(op.newPath, op.originalPath);
        }
      } else if (op.type === 'delete' && op.content !== undefined && !op.isDirectory) {
        // Restore deleted file with backed-up content
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(op.originalPath, op.content);
      } else {
        // Can't undo directory delete or binary file delete
        return false;
      }
      await get().refreshFileTree();
      return true;
    } catch (error) {
      console.error("[Workspace] Undo failed:", error);
      return false;
    }
  },

  // Reveal a file in the tree: expand all ancestor directories and set focus
  revealFile: async (path: string) => {
    const { workspacePath, expandDirectory } = get();
    if (!workspacePath || !path.startsWith(workspacePath)) return;

    // Build list of ancestor directories to expand
    const relativePath = path.slice(workspacePath.length + 1);
    const segments = relativePath.split("/");
    let currentPath = workspacePath;

    // Expand each ancestor directory
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = `${currentPath}/${segments[i]}`;
      await expandDirectory(currentPath);
    }

    set({ focusedPath: path });
  },

  // Refresh file tree from root, preserving expand states and selection
  refreshFileTree: async () => {
    const { loadDirectory, expandedPaths } = get();
    const rootNodes = await loadDirectory(".");

    // Re-expand previously expanded directories
    const stillValid = new Set<string>();
    const refreshExpanded = async (tree: FileNode[]): Promise<FileNode[]> => {
      return Promise.all(
        tree.map(async (node) => {
          if (node.type === "directory" && expandedPaths.has(node.path)) {
            const children = await loadDirectory(node.path);
            stillValid.add(node.path);
            return {
              ...node,
              children: await refreshExpanded(children),
            };
          }
          return node;
        }),
      );
    };

    const refreshedTree = await refreshExpanded(rootNodes);
    // This rebuilds the WORKSPACE tree only. Expansions inside an external root
    // are not represented in `rootNodes`, so dropping them here would collapse
    // the Knowledge tree every time a workspace file changed.
    const externalRoots = Object.keys(get().externalTrees);
    for (const path of expandedPaths) {
      if (externalRootFor(externalRoots, path)) stillValid.add(path);
    }
    set({
      fileTree: refreshedTree,
      expandedPaths: stillValid,
    });
  },

  /**
   * Re-list only the directories a file-change batch touched.
   *
   * `refreshFileTree` re-reads the root plus every expanded directory on any
   * change — one IPC per open folder for every save in the editor. A batch
   * names the parents whose listing can actually differ, so this reads those
   * and nothing else. A directory that is not on screen (never expanded, or
   * under no root this store owns) is skipped; the workspace root and every
   * registered external root always count as on screen.
   */
  refreshChangedDirectories: async (directories: string[]) => {
    if (directories.length === 0) return;
    const { workspacePath, loadDirectory } = get();
    const externalRoots = Object.keys(get().externalTrees);

    const ownerOf = (dir: string): string | null => {
      const external = externalRootFor(externalRoots, dir);
      if (external) return external;
      if (workspacePath && (dir === workspacePath || dir.startsWith(`${workspacePath}/`))) {
        return workspacePath;
      }
      return null;
    };

    // Parents before children: a directory deleted along with its contents is
    // dropped by its parent's re-list before its own read would come up empty.
    const targets = [...new Set(directories)]
      .filter((dir) => ownerOf(dir) !== null)
      .sort((a, b) => a.length - b.length);
    if (targets.length === 0) return;

    for (const dir of targets) {
      const external = externalRootFor(externalRoots, dir);
      const isRoot = dir === (external ?? workspacePath);
      const tree = external ? (get().externalTrees[external] ?? []) : get().fileTree;

      if (!isRoot) {
        const node = findNodeByPath(tree, dir);
        // Not listed, or listed but never expanded: nothing on screen to update.
        if (!node || node.type !== "directory" || node.children === undefined) continue;
      }

      const children = await loadDirectory(dir);

      // Re-read after the await — another update may have landed meanwhile.
      if (external) {
        const current = get().externalTrees[external];
        if (current === undefined) continue; // root was closed while listing
        const next = isRoot
          ? mergeLoadedChildren(current, children)
          : updateNodeChildren(current, dir, children);
        set({ externalTrees: { ...get().externalTrees, [external]: next } });
      } else {
        if (get().workspacePath !== workspacePath) return; // workspace switched
        const next = isRoot
          ? mergeLoadedChildren(get().fileTree, children)
          : updateNodeChildren(get().fileTree, dir, children);
        set({ fileTree: next });
      }
    }

    // Expansions whose directory vanished are dropped, as refreshFileTree does.
    // Roots stay: they are trees, not nodes in one.
    const roots = new Set<string>([workspacePath ?? "", ...externalRoots]);
    const trees = [get().fileTree, ...Object.values(get().externalTrees)];
    const nextExpanded = new Set<string>();
    let pruned = false;
    for (const path of get().expandedPaths) {
      const underTarget = targets.some((dir) => path.startsWith(`${dir}/`));
      if (underTarget && !roots.has(path) && !trees.some((t) => findNodeByPath(t, path))) {
        pruned = true;
        continue;
      }
      nextExpanded.add(path);
    }
    if (pruned) set({ expandedPaths: nextExpanded });
  },

  // Helper function to flatten visible file tree into ordered list of file paths
  flattenVisibleFileTree: (nodes: FileNode[]): string[] => {
    const { expandedPaths } = get();
    const result: string[] = [];
    const traverse = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") {
          result.push(node.path);
        }
        if (
          node.type === "directory" &&
          expandedPaths.has(node.path) &&
          node.children
        ) {
          traverse(node.children);
        }
      }
    };
    traverse(nodes);
    return result;
  },

  // Select and load a file using Tauri FS plugin
  selectFile: async (path: string, line?: number, heading?: string) => {
    const { workspacePath, fileTree, externalTrees } = get();
    // Reads are rooted at whichever tree owns the path: the workspace, or an
    // external root such as the team knowledge dir under ~/.amuxd.
    const readRoot = externalRootFor(Object.keys(externalTrees), path) ?? workspacePath;
    const knownNode =
      findNodeByPath(fileTree, path) ??
      findNodeByPath(Object.values(externalTrees).flat(), path);

    if (knownNode?.type === "directory") {
      set({
        selectedFile: null,
        selectedFiles: [],
        focusedPath: path,
        isLoadingFile: false,
        fileContent: null,
        targetLine: null,
        targetHeading: null,
      });
      await get().expandDirectory(path);
      return;
    }

    // Update both single and multi-select state for backward compatibility
    set({
      selectedFile: path,
      selectedFiles: [path], // Single selection clears multi-select
      lastSelectedFile: path,
      focusedPath: null, // Clear keyboard focus when selecting a file
      isLoadingFile: true,
      fileContent: null,
      targetLine: line ?? null,
      targetHeading: heading ?? null,
    });

    // In web mode, skip file system operations
    if (!isTauri()) {
      set({
        fileContent: "[Web Mode] File preview not available",
        isLoadingFile: false,
      });
      return;
    }

    // Check file type for appropriate reading strategy
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const previewableBinaryExtensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "ico",
      "svg",
      "pdf",
    ];
    const isPreviewableBinary = previewableBinaryExtensions.includes(ext);
    const isUnsupportedBinary = UNSUPPORTED_BINARY_EXTENSIONS.has(ext);

    try {
      if (isUnsupportedBinary) {
        // For unsupported binary files, don't read content - just mark as loaded
        // The viewer will detect the file type from filename and show an appropriate message
        set({ fileContent: "", isLoadingFile: false });
      } else if (isPreviewableBinary) {
        if (!readRoot) {
          throw new Error("No workspace path set");
        }
        const bytes = await readWorkspaceBinaryFile(readRoot, path);

        // Convert to base64
        let binary = "";
        const len = bytes.length;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        // Determine MIME type
        const mimeTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          ico: "image/x-icon",
          svg: "image/svg+xml",
          pdf: "application/pdf",
        };
        const mimeType = mimeTypes[ext] || "application/octet-stream";

        // Store as data URL
        set({
          fileContent: `data:${mimeType};base64,${base64}`,
          isLoadingFile: false,
        });
      } else {
        if (!readRoot) {
          throw new Error("No workspace path set");
        }
        const content = await readWorkspaceTextFile(readRoot, path);
        set({ fileContent: content, isLoadingFile: false });
      }
    } catch (error) {
      console.error("Failed to load file:", error);
      set({
        fileContent: `Error loading file: ${error}`,
        isLoadingFile: false,
      });
    }
  },

  // Reload the currently selected file (useful when file is modified externally)
  // Unlike selectFile, this does NOT set fileContent: null or isLoadingFile: true,
  // so the editor stays mounted and can apply the change incrementally.
  reloadSelectedFile: async () => {
    const { selectedFile, workspacePath, externalTrees } = get();
    if (!selectedFile) return;
    const readRoot =
      externalRootFor(Object.keys(externalTrees), selectedFile) ?? workspacePath;
    if (!readRoot) return;

    // In web mode, nothing to reload
    if (!isTauri()) return;

    try {
      const ext = selectedFile.split(".").pop()?.toLowerCase() || "";
      const previewableBinaryExtensions = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "bmp",
        "ico",
        "svg",
        "pdf",
      ];

      if (previewableBinaryExtensions.includes(ext)) {
        // Binary files: fall back to full selectFile (rare case for agent writes)
        const { selectFile } = get();
        await selectFile(selectedFile);
      } else {
        // Text files: just re-read content and update — no unmount cycle
        const content = await readWorkspaceTextFile(readRoot, selectedFile);
        set({ fileContent: content });
      }
    } catch (error) {
      console.error("[Workspace] Failed to reload file:", error);
    }
  },

  // Shift+Click range selection
  selectFileRange: (path: string) => {
    const { fileTree, lastSelectedFile, flattenVisibleFileTree } = get();

    // Flatten visible file tree to get ordered list
    const visibleFiles = flattenVisibleFileTree(fileTree);

    // If no lastSelectedFile, treat as single selection
    if (!lastSelectedFile) {
      set({
        selectedFile: path,
        selectedFiles: [path],
        lastSelectedFile: path,
      });
      return;
    }

    // Find indices of lastSelectedFile and clicked file
    const lastIndex = visibleFiles.indexOf(lastSelectedFile);
    const clickedIndex = visibleFiles.indexOf(path);

    // If either file not found, treat as single selection
    if (lastIndex === -1 || clickedIndex === -1) {
      set({
        selectedFile: path,
        selectedFiles: [path],
        lastSelectedFile: path,
      });
      return;
    }

    // Select all files between lastIndex and clickedIndex (inclusive)
    const startIndex = Math.min(lastIndex, clickedIndex);
    const endIndex = Math.max(lastIndex, clickedIndex);
    const rangeFiles = visibleFiles.slice(startIndex, endIndex + 1);

    set({
      selectedFile: path, // Still update selectedFile for editor
      selectedFiles: rangeFiles,
      lastSelectedFile: path,
    });
  },

  toggleFileSelection: (path: string) => {
    const { selectedFiles } = get();
    const isSelected = selectedFiles.includes(path);
    if (isSelected) {
      const newFiles = selectedFiles.filter(f => f !== path);
      set({
        selectedFile: newFiles.length > 0 ? newFiles[newFiles.length - 1] : null,
        selectedFiles: newFiles,
        lastSelectedFile: path,
      });
    } else {
      set({
        selectedFile: path,
        selectedFiles: [...selectedFiles, path],
        lastSelectedFile: path,
      });
    }
  },

  clearSelection: () =>
    set({
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
    }),
}));
