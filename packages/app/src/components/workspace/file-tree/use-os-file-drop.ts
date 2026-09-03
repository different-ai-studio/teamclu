//! The Tauri native drag-drop listeners: files dropped on the window from
//! Finder, and internal row drags that Tauri intercepts before HTML5 does.
//!
//! Lives outside `FileTree` because it is the one effect in that component
//! with no React state of its own — it reads refs, writes two setters, and
//! re-subscribes only when the workspace or the tree root changes.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isChatInputDropTarget, isPointOverElement } from "@/lib/ui/chat-file-drop";
import { isTauri } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FlatTreeNode } from "./flatten";

type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

export function useOsFileDrop({
  workspacePath,
  treeRoot,
  refreshFileTree,
  expandDirectory,
  dragSourcePathRef,
  dragOverPathRef,
  flatNodesRef,
  pushUndoRef,
  setDragSourcePath,
  setDragOverPath,
}: {
  workspacePath: string | null;
  treeRoot: string | null;
  refreshFileTree: WorkspaceState["refreshFileTree"];
  expandDirectory: WorkspaceState["expandDirectory"];
  dragSourcePathRef: React.MutableRefObject<string | null>;
  dragOverPathRef: React.MutableRefObject<string | null>;
  flatNodesRef: React.MutableRefObject<FlatTreeNode[]>;
  pushUndoRef: React.MutableRefObject<WorkspaceState["pushUndo"]>;
  setDragSourcePath: (path: string | null) => void;
  setDragOverPath: (path: string | null) => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isTauri() || !workspacePath) return;
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (cancelled) return;

      // Handle external file drop (or internal drag that landed outside the file tree)
      unlisteners.push(await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-drop',
        async (event) => {
          // Internal drag-move: Tauri intercepts the HTML5 drop event.
          // Check if the drop target was inside the file tree (perform move)
          // or outside (dispatch to prompt input / other drop targets).
          if (dragSourcePathRef.current) {
            const sourcePath = dragSourcePathRef.current;
            // Read refs before clearing state to avoid race with useEffect sync
            let targetDir = dragOverPathRef.current;
            dragSourcePathRef.current = null;
            setDragSourcePath(null);
            setDragOverPath(null);

            // Resolve drop target: prefer dragOverPath (set by HTML5 dragover
            // on directories), fall back to elementFromPoint for file targets
            if (!targetDir) {
              const { x, y } = event.payload.position;
              const el = document.elementFromPoint(x, y);
              const treeItem = el?.closest('[data-path]') as HTMLElement | null;
              if (treeItem) {
                const path = treeItem.getAttribute('data-path');
                if (path) {
                  const node = flatNodesRef.current.find(fn => fn.node.path === path);
                  if (node && node.node.type === 'file') {
                    targetDir = path.substring(0, path.lastIndexOf('/')) || treeRoot;
                  } else {
                    targetDir = path;
                  }
                }
              }
            }

            // Drop landed on a directory in the file tree → move
            if (targetDir && targetDir !== sourcePath && !targetDir.startsWith(sourcePath + '/')) {
              const fileName = sourcePath.substring(sourcePath.lastIndexOf('/') + 1);
              const newPath = `${targetDir}/${fileName}`;
              const { moveItem } = await import('../file-tree-operations');
              const success = await moveItem(sourcePath, targetDir);
              if (success) {
                pushUndoRef.current({
                  type: 'move',
                  description: `Move ${fileName} to ${targetDir.substring(targetDir.lastIndexOf('/') + 1)}`,
                  originalPath: sourcePath,
                  newPath,
                  isDirectory: false,
                });
                await refreshFileTree();
                await expandDirectory(targetDir);
              }
              return;
            }

            // Drop landed outside the file tree → dispatch for prompt input
            window.dispatchEvent(new CustomEvent('teamclu:filedrop', {
              detail: { path: sourcePath, position: event.payload.position },
            }));
            return;
          }
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;

          // OS drops on the chat composer attach as pending files (PromptInput
          // listens to the same tauri://drag-drop event). Do not copy into the
          // workspace in that case — previously every external drop was treated
          // as a file-tree import, so drag-to-input silently stopped working.
          const dropPos = event.payload.position;
          const chatInput = document.querySelector('[data-testid="chat-input-area"]');
          // Prefer geometry over elementFromPoint — during native DnD the
          // hit-test under the cursor can miss the composer chrome.
          if (
            isPointOverElement(dropPos, chatInput) ||
            isChatInputDropTarget(document.elementFromPoint(dropPos.x, dropPos.y))
          ) {
            setDragOverPath(null);
            return;
          }

          const targetDir = dragOverPathRef.current || treeRoot;
          if (!targetDir) return;

          const { copyExternalFiles } = await import('../file-tree-operations');
          const success = await copyExternalFiles(paths, targetDir);
          if (success) {
            await refreshFileTree();
            if (targetDir !== treeRoot) {
              await expandDirectory(targetDir);
            }
          } else {
            toast.error(t('fileExplorer.externalDropFailed', 'Failed to copy files'));
          }
          setDragOverPath(null);
        },
      ));
      if (cancelled) { unlisteners.forEach(fn => fn()); return; }

      // Highlight hovered directory during external drag (skip for internal drags)
      unlisteners.push(await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-over',
        (event) => {
          if (dragSourcePathRef.current) return; // Internal drag handled by HTML5 handlers
          const el = document.elementFromPoint(event.payload.position.x, event.payload.position.y);
          const treeItem = el?.closest('[data-path]') as HTMLElement | null;
          if (treeItem) {
            const path = treeItem.getAttribute('data-path');
            if (path) {
              // Resolve to parent directory if hovering over a file
              const node = flatNodesRef.current.find(fn => fn.node.path === path);
              if (node && node.node.type === 'file') {
                const parentDir = path.substring(0, path.lastIndexOf('/'));
                setDragOverPath(parentDir || treeRoot);
              } else {
                setDragOverPath(path);
              }
            }
          } else {
            setDragOverPath(null);
          }
        },
      ));
      if (cancelled) { unlisteners.forEach(fn => fn()); return; }

      // Clear highlight when drag leaves window
      unlisteners.push(await listen('tauri://drag-leave', () => {
        setDragOverPath(null);
      }));
      if (cancelled) { unlisteners.forEach(fn => fn()); return; }
    });

    return () => { cancelled = true; unlisteners.forEach(fn => fn()); };
    // Refs and setState identities are stable; the reactive inputs are these five.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, treeRoot, refreshFileTree, expandDirectory, t]);
}
