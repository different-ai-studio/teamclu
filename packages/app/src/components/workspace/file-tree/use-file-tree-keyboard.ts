//! Keyboard navigation and the shortcuts that act on the focused row.
//!
//! Extracted whole from `FileTree`: the callback and its dependency list are
//! unchanged, so the memoisation is the same — what moved is 200 lines of
//! key handling out of a 1,700-line component.

import { useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FlatTreeNode } from "./flatten";

type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

export function useFileTreeKeyboard({
  flatNodes,
  focusedPath,
  renamingPath,
  creatingIn,
  effectiveExpandedPaths,
  treeRoot,
  selectedFiles,
  setFocusedPath,
  expandDirectory,
  collapseDirectory,
  collapseCompacted,
  selectFile,
  handleDelete,
  handleDuplicate,
  handleCopy,
  handleCut,
  clipboardPaths,
  systemClipboardHasFiles,
  pasteFiles,
  treeContainerRef,
  setRenamingPath,
}: {
  flatNodes: FlatTreeNode[];
  focusedPath: string | null;
  renamingPath: string | null;
  creatingIn: { dirPath: string; type: "file" | "folder" } | null;
  effectiveExpandedPaths: Set<string>;
  treeRoot: string | null;
  selectedFiles: WorkspaceState["selectedFiles"];
  setFocusedPath: WorkspaceState["setFocusedPath"];
  expandDirectory: WorkspaceState["expandDirectory"];
  collapseDirectory: WorkspaceState["collapseDirectory"];
  collapseCompacted: (paths: string[]) => void;
  selectFile: WorkspaceState["selectFile"];
  handleDelete: (path: string, isDirectory: boolean) => void;
  handleDuplicate: (path: string) => Promise<void> | void;
  handleCopy: (paths: string[]) => void;
  handleCut: (paths: string[]) => void;
  clipboardPaths: WorkspaceState["clipboardPaths"];
  systemClipboardHasFiles: boolean;
  pasteFiles: WorkspaceState["pasteFiles"];
  treeContainerRef: React.RefObject<HTMLDivElement | null>;
  setRenamingPath: (path: string | null) => void;
}) {
  const { t } = useTranslation();

  // ── Keyboard navigation ──
  return useCallback(
    async (e: React.KeyboardEvent) => {
      if (!flatNodes.length) return;
      // Don't handle keys when renaming
      if (renamingPath || creatingIn) return;

      // ⌘D = Duplicate focused item
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault();
        if (focusedPath) {
          handleDuplicate(focusedPath);
        }
        return;
      }

      // Clipboard shortcuts
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (e.key === 'c') {
          e.preventDefault();
          const paths = selectedFiles.length > 0 ? selectedFiles : (focusedPath ? [focusedPath] : []);
          if (paths.length > 0) {
            handleCopy(paths);
          }
          return;
        }
        if (e.key === 'x') {
          e.preventDefault();
          const paths = selectedFiles.length > 0 ? selectedFiles : (focusedPath ? [focusedPath] : []);
          if (paths.length > 0) {
            handleCut(paths);
          }
          return;
        }
        if (e.key === 'v') {
          e.preventDefault();
          // No internal-clipboard precondition: the paths may be coming from
          // Finder, in which case only the OS pasteboard knows about them.
          // pasteFiles resolves both sources and no-ops when neither has files.
          let targetDir = treeRoot;
          if (focusedPath) {
            const node = flatNodes.find(n => n.node.path === focusedPath);
            if (node?.node.type === 'directory') {
              targetDir = focusedPath;
            } else {
              targetDir = focusedPath.substring(0, focusedPath.lastIndexOf('/'));
            }
          }
          if (targetDir) {
            const success = await pasteFiles(targetDir);
            if (success) {
              await expandDirectory(targetDir);
            } else if (clipboardPaths.length > 0 || systemClipboardHasFiles) {
              toast.error(t('fileExplorer.pasteFailed', 'Paste failed'));
            }
          }
          return;
        }
      }

      const currentIndex = flatNodes.findIndex(
        (n) => n.node.path === focusedPath,
      );

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const nextIndex = currentIndex < flatNodes.length - 1
            ? currentIndex + 1
            : 0;
          setFocusedPath(flatNodes[nextIndex].node.path);
          // Scroll into view
          const el = treeContainerRef.current?.querySelector(
            `[data-path="${CSS.escape(flatNodes[nextIndex].node.path)}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prevIndex = currentIndex > 0
            ? currentIndex - 1
            : flatNodes.length - 1;
          setFocusedPath(flatNodes[prevIndex].node.path);
          const el = treeContainerRef.current?.querySelector(
            `[data-path="${CSS.escape(flatNodes[prevIndex].node.path)}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (currentIndex === -1) break;
          const node = flatNodes[currentIndex].node;
          if (node.type === "directory" && !effectiveExpandedPaths.has(node.path)) {
            expandDirectory(node.path);
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (currentIndex === -1) break;
          const { node, compactedPaths } = flatNodes[currentIndex];
          if (node.type === "directory" && effectiveExpandedPaths.has(node.path)) {
            if (compactedPaths && compactedPaths.length > 1) {
              collapseCompacted(compactedPaths);
            } else {
              collapseDirectory(node.path);
            }
          } else {
            // Navigate to parent directory
            const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
            if (parentPath && parentPath !== treeRoot) {
              setFocusedPath(parentPath);
              const el = treeContainerRef.current?.querySelector(
                `[data-path="${CSS.escape(parentPath)}"]`,
              );
              el?.scrollIntoView({ block: "nearest" });
            }
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (currentIndex === -1) break;
          const entryNode = flatNodes[currentIndex];
          if (entryNode.node.type === "directory") {
            if (effectiveExpandedPaths.has(entryNode.node.path)) {
              if (entryNode.compactedPaths && entryNode.compactedPaths.length > 1) {
                collapseCompacted(entryNode.compactedPaths);
              } else {
                collapseDirectory(entryNode.node.path);
              }
            } else {
              expandDirectory(entryNode.node.path);
            }
          } else {
            selectFile(entryNode.node.path);
          }
          break;
        }
        case "Home": {
          e.preventDefault();
          if (flatNodes.length > 0) {
            setFocusedPath(flatNodes[0].node.path);
            const el = treeContainerRef.current?.querySelector(
              `[data-path="${CSS.escape(flatNodes[0].node.path)}"]`,
            );
            el?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "End": {
          e.preventDefault();
          const last = flatNodes[flatNodes.length - 1];
          if (last) {
            setFocusedPath(last.node.path);
            const el = treeContainerRef.current?.querySelector(
              `[data-path="${CSS.escape(last.node.path)}"]`,
            );
            el?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "F2": {
          e.preventDefault();
          if (focusedPath) {
            setRenamingPath(focusedPath);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          if (focusedPath) {
            const node = flatNodes.find((n) => n.node.path === focusedPath);
            if (node) {
              handleDelete(node.node.path, node.node.type === "directory");
            }
          }
          break;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      flatNodes,
      focusedPath,
      renamingPath,
      creatingIn,
      effectiveExpandedPaths,
      treeRoot,
      selectedFiles,
      setFocusedPath,
      expandDirectory,
      collapseDirectory,
      collapseCompacted,
      selectFile,
      handleDelete,
      handleDuplicate,
      handleCopy,
      handleCut,
      clipboardPaths,
      systemClipboardHasFiles,
      pasteFiles,
      t,
      // `treeContainerRef` is a ref and `setRenamingPath` a setState identity;
      // both are stable, and listing them would only churn the callback.
    ],
  );
}
