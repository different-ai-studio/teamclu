import React, { useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  File,
  Loader2,
  Pencil,
  Terminal,
  FilePlus,
  FolderPlus,
  Trash2,
  Copy,
  CopyPlus,
  Scissors,
  ClipboardPaste,
  ExternalLink,
  MessageSquarePlus,
  Lock,
  AppWindow,
  History,
  AlertTriangle,
  Cloud,
} from "lucide-react";

import { cn } from '@/lib/utils';
import { ObsidianIcon } from './ObsidianIcon';
import { useTabsStore } from '@/stores/tabs';
import { useCurrentTeamStore } from '@/stores/current-team';
import { useVersionHistoryStore } from '@/stores/version-history';
import { encodeVersionHistoryTarget } from '@/lib/tabs/teamshare-target';
import type { SyncBadge } from '@/lib/team-sync-badges';
import { openKnowledgeConflict, openCloudVersion } from '@/lib/tabs/knowledge-tabs';
import { getFileIcon } from '@/lib/file-icons';
import { formatDateTime, formatRelativeTime } from '@/lib/date-format';
import type { FileNode } from "@/stores/workspace";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";

/**
 * Open version history for one file.
 *
 * The path goes into the target rather than into shared store state: a tab is
 * addressed by its target string, so two files' histories can be open at once
 * and neither depends on what happens to be selected. The store preselect is
 * only so the view has data before its own effect runs.
 */
export function openVersionHistory(path: string, label: string) {
  const teamId = useCurrentTeamStore.getState().team?.id;
  useVersionHistoryStore.getState().selectFile(path);
  if (teamId) void useVersionHistoryStore.getState().loadFileVersions(teamId, path);
  useTabsStore.getState().openTab({
    type: "native",
    target: encodeVersionHistoryTarget(path),
    label,
  });
}

function getSyncStatusTextColor(status: SyncBadge): string {
  switch (status) {
    case 'local-new': return 'text-green-500'
    case 'local-modified': return 'text-yellow-500'
    case 'remote-ahead': return 'text-blue-500'
    // Both sides touched it: the next sync WILL conflict. Loud enough to act on
    // before that happens, quieter than the conflict that already did.
    case 'both': return 'text-orange-500'
    case 'conflict': return 'text-red-500'
  }
}

/** Hover text: a colour on its own does not say what to do about it. */
function syncStatusHint(status: SyncBadge, t: (k: string, d: string) => string): string {
  switch (status) {
    case 'local-new':
      return t('syncBadge.localNew', 'New here — not in the cloud yet')
    case 'local-modified':
      return t('syncBadge.localModified', 'Edited here — not pushed yet')
    case 'remote-ahead':
      return t('syncBadge.remoteAhead', 'A newer version is waiting in the cloud')
    case 'both':
      return t('syncBadge.both', 'Changed on both sides — the next sync will conflict')
    case 'conflict':
      return t('knowledgeConflict.rowHint', 'Both sides changed this document — pick which version to keep')
  }
}

// Inline editing input component
export function InlineInput({
  defaultValue,
  onConfirm,
  onCancel,
  level,
  icon,
}: {
  defaultValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  level: number;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);
  // Stable refs to avoid re-creating effects when parent re-renders
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);
  onConfirmRef.current = onConfirm;
  onCancelRef.current = onCancel;

  const doConfirm = useCallback(() => {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    const value = inputRef.current?.value.trim();
    if (value) onConfirmRef.current(value);
    else onCancelRef.current();
  }, []);

  // Focus and select on mount — retry until focused
  React.useEffect(() => {
    let cancelled = false;
    const tryFocus = (attempt: number) => {
      if (cancelled || confirmedRef.current) return;
      const input = inputRef.current;
      if (input) {
        input.scrollIntoView({ block: "nearest" });
        input.focus({ preventScroll: true });
        input.select();
        // Verify focus was acquired, retry if not (up to 10 attempts)
        if (document.activeElement !== input && attempt < 10) {
          setTimeout(() => tryFocus(attempt + 1), 50);
        }
      }
    };
    // Initial delay to let React settle after expandDirectory
    setTimeout(() => tryFocus(0), 50);
    return () => { cancelled = true; };
  }, []);

  // Click-outside detection: confirms when user clicks outside the input
  React.useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (confirmedRef.current) return;
      const input = inputRef.current;
      if (input && !input.contains(e.target as Node)) {
        doConfirm();
      }
    };
    // Delay registration so the context menu click that opened this doesn't trigger
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleMouseDown, true);
    }, 200);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleMouseDown, true);
    };
  }, [doConfirm]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      doConfirm();
    } else if (e.key === "Escape") {
      confirmedRef.current = true;
      onCancelRef.current();
    }
  };

  // No onBlur handler — focus loss is ignored entirely.
  // Confirmation only happens via: Enter, Escape, click-outside, or unmount.

  return (
    <div
      className="flex items-center gap-1 py-0.5 px-2 w-full"
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {icon}
      <input
        ref={inputRef}
        defaultValue={defaultValue}
        onKeyDown={handleKeyDown}
        className="inline-edit-input flex-1 bg-transparent border border-primary/50 rounded px-1 py-0 text-[13px] outline-none focus:border-primary min-w-0"
      />
    </div>
  );
}

export interface FileTreeItemProps {
  node: FileNode;
  level: number;
  isSelected: boolean;
  isFocused: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  isRenaming: boolean;
  isDragOver: boolean;
  /** Whether this is the root teamclu-team directory (for visual styling) */
  isTeamCluTeam?: boolean;
  /** Whether the team directory is currently syncing */
  teamSyncing?: boolean;
  /** ISO timestamp of last successful team repo sync (for relative-time label) */
  teamLastSyncAt?: string | null;
  /**
   * What this document's sync state is, for team knowledge. `null` for
   * everything else — a workspace file has no cloud counterpart to differ from.
   */
  syncStatus?: SyncBadge | null;
  /**
   * The ignore rules exclude this row from sync.
   *
   * Deliberately not a sixth `SyncBadge`. Those five are one scale — where a
   * document sits on the sync path, ordered by urgency — and an ignored file is
   * not a point on it, it is off the path entirely. So this reads as absence
   * (dimmed) rather than as another colour to rank against the others.
   */
  syncIgnored?: boolean;
  /** True for a team-knowledge document, which has a cloud copy to look at. */
  isTeamKnowledge?: boolean;
  compactName?: string;
  compactedPaths?: string[];
  onCollapseCompacted: (paths: string[]) => void;
  onSelectFile: (path: string) => void;
  onSelectFileRange: (path: string) => void; // Shift+Click range selection
  onToggleFileSelection: (path: string) => void; // Ctrl/Cmd+Click toggle
  onExpandDirectory: (path: string) => void;
  onCollapseDirectory: (path: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  onRename: (path: string) => void;
  onRenameConfirm: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  onDelete: (path: string, isDirectory: boolean) => void;
  /**
   * Open the "who can see this folder" dialog. Directories only, and only
   * supplied for directories inside the team knowledge tree — the workspace
   * file browser passes nothing and the item does not render.
   */
  onManagePermissions?: (path: string) => void;
  /**
   * Name to draw instead of the on-disk one.
   *
   * Used for the two fixed sync roots, which are `documents` and `knowledge` on
   * disk — ASCII, stable, safe on every filesystem — and «资料库» / «知识库» to
   * read. Only the caller knows a node is one of those roots; a directory named
   * `knowledge` three levels down is an ordinary folder and keeps its name.
   */
  localizedName?: string;
  /**
   * Refuse "new file" / "new folder" on this node.
   *
   * Set for the sync root itself: the tree has exactly two roots and a third
   * one would never sync — the scanner only descends into the fixed prefixes,
   * so anything else is invisible to it. Better to not offer the action than to
   * let someone create a folder that quietly goes nowhere.
   */
  disallowCreate?: boolean;
  /**
   * This folder carries a permission rule of its OWN.
   *
   * Not set for folders that merely sit under a restricted parent: they are
   * drawn nested beneath the folder that is marked, so repeating the lock all
   * the way down would be noise rather than information.
   *
   * Only ever true for someone who can manage the team — the rule list is
   * owner/admin-only, so nobody else can be told which folders are restricted
   * (the names are the sensitive part).
   */
  isPermissionRestricted?: boolean;
  onCopyPath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpenDefault: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onAddToAgent: (path: string) => void;
  onDragStart: (e: React.DragEvent, path: string) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent, targetPath: string) => void;
  onCut: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onPaste: (targetDir: string) => void;
  onDuplicate: (path: string) => void;
  hasClipboard: boolean;
  isClipboardCut: boolean;
  clipboardPaths: string[];
}

export const FileTreeItem = React.memo(function FileTreeItem({
  node,
  level,
  isSelected,
  isFocused,
  isExpanded,
  isLoading,
  isRenaming,
  isDragOver,
  isTeamCluTeam,
  teamSyncing,
  teamLastSyncAt,
  isTeamKnowledge,
  syncStatus,
  syncIgnored = false,
  onSelectFile,
  onSelectFileRange,
  onToggleFileSelection,
  onExpandDirectory,
  onCollapseDirectory,
  onNewFile,
  onNewFolder,
  onRename,
  onRenameConfirm,
  onRenameCancel,
  onDelete,
  onManagePermissions,
  localizedName,
  disallowCreate,
  isPermissionRestricted,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  onOpenDefault,
  onOpenTerminal,
  onAddToAgent,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
  compactName,
  compactedPaths,
  onCollapseCompacted,
  onCut,
  onCopy,
  onPaste,
  onDuplicate,
  hasClipboard,
  isClipboardCut,
  clipboardPaths,
}: FileTreeItemProps) {
  const { t } = useTranslation();
  const isDirectory = node.type === "directory";
  // Every role gets the full context menu, team files included — file ops are
  // not role-gated in the tree.
  const isCutTarget = clipboardPaths?.includes(node.path) && isClipboardCut;
  const displayName = localizedName || compactName || node.name;
  const contextMenuOpenedAtRef = useRef(0);

  const handleClick = (e: React.MouseEvent) => {
    // Ignore click events that are part of opening the context menu
    // (e.g. ctrl+click on macOS, or synthetic click after right-click gesture).
    if (Date.now() - contextMenuOpenedAtRef.current < 220) {
      return;
    }
    if (isDirectory) {
      if (isExpanded) {
        if (compactedPaths && compactedPaths.length > 1) {
          onCollapseCompacted(compactedPaths);
        } else {
          onCollapseDirectory(node.path);
        }
      } else {
        onExpandDirectory(node.path);
      }
    } else {
      if (e.shiftKey) {
        onSelectFileRange(node.path);
      } else if (e.metaKey || e.ctrlKey) {
        onToggleFileSelection(node.path);
      } else {
        onSelectFile(node.path);
      }
    }
  };

  const guardedMenuAction = useCallback((action: () => void) => {
    return (event: Event) => {
      // Prevent accidental immediate selection caused by the opening pointer gesture.
      if (Date.now() - contextMenuOpenedAtRef.current < 140) {
        event.preventDefault();
        return;
      }
      action();
    };
  }, []);

  const fileIconInfo = !isDirectory ? getFileIcon(node.name) : null;
  const FileIcon = fileIconInfo?.icon || File;
  const fileIconColor = fileIconInfo?.color || "text-muted-foreground";
  const isKnowledgeDir = isDirectory && node.name === 'team-knowledge' && !node.path.includes('/.trash/');
  // A team document both sides changed. The row is red either way; this is what
  // decides whether it also offers the way in to resolving it.
  const needsConflictDecision = syncStatus === 'conflict' && !isDirectory;

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={node.name}
        onConfirm={(newName) => onRenameConfirm(node.path, newName)}
        onCancel={onRenameCancel}
        level={level}
        icon={
          isDirectory ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rotate-90" />
          ) : (
            <FileIcon className={cn("h-4 w-4 shrink-0", fileIconColor)} />
          )
        }
      />
    );
  }

  const rowContent = (
    <button
      draggable
      onClick={handleClick}
      onDragStart={(e) => onDragStart(e, node.path)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => isDirectory ? onDragOver(e, node.path) : undefined}
      onDragLeave={(e) => isDirectory ? onDragLeave(e) : undefined}
      onDrop={(e) => isDirectory ? onDrop(e, node.path) : undefined}
      onContextMenu={() => {
        contextMenuOpenedAtRef.current = Date.now();
        window.getSelection()?.removeAllRanges();
      }}
      data-path={node.path}
      data-testid="file-tree-item"
      className={cn(
        "flex items-center gap-1 py-1 px-2 text-left text-[13px] hover:bg-primary/10 data-[state=open]:bg-primary/10 rounded transition-colors whitespace-nowrap w-full select-none",
        isSelected &&
          "bg-primary/20 text-primary font-medium ring-1 ring-inset ring-primary/30",
        isFocused && !isSelected &&
          "ring-1 ring-inset ring-primary/40 bg-primary/5",
        isDragOver && isDirectory &&
          "bg-primary/20 ring-2 ring-inset ring-primary/40",
        isCutTarget && "opacity-50",
        // Present but not carried. Dimmed rather than coloured — see
        // `syncIgnored` on the props.
        syncIgnored && "opacity-45",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      title={
        syncIgnored
          ? t('syncBadge.ignored', 'Not synced — excluded by the ignore rules')
          : syncStatus
            ? syncStatusHint(syncStatus, t)
            : undefined
      }
    >
      {isDirectory ? (
        <span className="w-4 h-4 flex items-center justify-center shrink-0">
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                isExpanded && "rotate-90",
              )}
            />
          )}
        </span>
      ) : (
        <FileIcon
          className={cn(
            "h-4 w-4 shrink-0",
            syncStatus ? getSyncStatusTextColor(syncStatus) : fileIconColor,
          )}
        />
      )}

      {isTeamCluTeam && (
        teamSyncing
          ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          : <img src="/logo-64.png" alt="" className="h-3.5 w-3.5 shrink-0" />
      )}

      {isKnowledgeDir && !isTeamCluTeam && (
        <ObsidianIcon className="h-3.5 w-3.5 shrink-0" style={{ color: '#7C3AED' }} />
      )}

      {isPermissionRestricted && (
        <Lock
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-label={t("fileExplorer.restrictedFolder", "Restricted to specific people")}
        />
      )}

      <span
        className={cn(
          "pr-2 flex-1",
          syncStatus && getSyncStatusTextColor(syncStatus),
        )}
      >
        {displayName}
      </span>

      {needsConflictDecision && (
        // The row is already red; this is the part that says a HUMAN has to do
        // something, and is the only entry point into the decision view.
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            openKnowledgeConflict(node.path, t('knowledgeConflict.tabLabel', 'Conflict'));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.stopPropagation();
            openKnowledgeConflict(node.path, t('knowledgeConflict.tabLabel', 'Conflict'));
          }}
          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-500 hover:bg-red-500/10"
          title={t('knowledgeConflict.rowHint', 'Both sides changed this document — pick which version to keep')}
        >
          <AlertTriangle className="h-3 w-3" />
          {t('knowledgeConflict.needsDecision', 'Decide')}
        </span>
      )}

      {isTeamCluTeam && !teamSyncing && teamLastSyncAt && (
        <span
          className="ml-auto pl-2 text-[10px] text-muted-foreground/70 font-normal shrink-0"
          title={t('fileExplorer.teamLastSyncTooltip', 'Last sync: {{time}}', { time: formatDateTime(teamLastSyncAt) })}
        >
          {formatRelativeTime(teamLastSyncAt)}
        </span>
      )}
      {isTeamCluTeam && teamSyncing && (
        <span className="ml-auto pl-2 text-[10px] text-muted-foreground/70 font-normal shrink-0">
          {t('fileExplorer.teamSyncing', 'Syncing…')}
        </span>
      )}
    </button>
  );

  // Determine terminal path: for files, use parent directory
  const terminalPath = isDirectory
    ? node.path
    : node.path.substring(0, node.path.lastIndexOf("/"));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {isDirectory && !disallowCreate && (
          <>
            <ContextMenuItem onSelect={guardedMenuAction(() => onNewFile(node.path))}>
              <FilePlus className="h-4 w-4" />
              {t("fileExplorer.newFile", "New File")}
              <ContextMenuShortcut>⌘N</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={guardedMenuAction(() => onNewFolder(node.path))}>
              <FolderPlus className="h-4 w-4" />
              {t("fileExplorer.newFolder", "New Folder")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={guardedMenuAction(() => onAddToAgent(node.path))}>
          <MessageSquarePlus className="h-4 w-4" />
          {t("fileExplorer.addToAgent", "Add to Agent")}
        </ContextMenuItem>
        {/*
          Only for directories inside the team knowledge tree, and only for
          someone who can manage the team: the caller decides both by passing
          the handler at all. The folder is the one that was right-clicked, so
          there is nothing to choose and no path to mistype.
        */}
        {isDirectory && onManagePermissions && (
          <ContextMenuItem onSelect={guardedMenuAction(() => onManagePermissions(node.path))}>
            <Lock className="h-4 w-4" />
            {t("fileExplorer.managePermissions", "Permissions…")}
          </ContextMenuItem>
        )}
        {!isDirectory && (
          <ContextMenuItem onSelect={guardedMenuAction(() => onOpenDefault(node.path))}>
            <AppWindow className="h-4 w-4" />
            {t("fileExplorer.openWithDefault", "Open with Default App")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={guardedMenuAction(() => onCopyPath(node.path))}>
          <Copy className="h-4 w-4" />
          {t("fileExplorer.copyPath", "Copy Path")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={guardedMenuAction(() => onCopyRelativePath(node.path))}>
          <Copy className="h-4 w-4" />
          {t("fileExplorer.copyRelativePath", "Copy Relative Path")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={guardedMenuAction(() => onCopy([node.path]))}>
          <Copy className="h-4 w-4" />
          {t("fileExplorer.copyFile", "Copy")}
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={guardedMenuAction(() => onCut([node.path]))}>
          <Scissors className="h-4 w-4" />
          {t("fileExplorer.cutFile", "Cut")}
          <ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        {hasClipboard && (
          <ContextMenuItem onSelect={guardedMenuAction(() => onPaste(
            isDirectory ? node.path : node.path.substring(0, node.path.lastIndexOf("/"))
          ))}>
            <ClipboardPaste className="h-4 w-4" />
            {t("fileExplorer.pasteFile", "Paste")}
            <ContextMenuShortcut>⌘V</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={guardedMenuAction(() => onDuplicate(node.path))}>
          <CopyPlus className="h-4 w-4" />
          {t("fileExplorer.duplicate", "Duplicate")}
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        {needsConflictDecision && (
          <ContextMenuItem
            onSelect={guardedMenuAction(() => openKnowledgeConflict(node.path, t('knowledgeConflict.tabLabel', 'Conflict')))}
          >
            <AlertTriangle className="h-4 w-4" />
            {t('knowledgeConflict.resolveAction', 'Resolve conflict')}
          </ContextMenuItem>
        )}
        {isTeamKnowledge && (
          <ContextMenuItem
            onSelect={guardedMenuAction(() => openCloudVersion(node.path, t('cloudVersion.tabLabel', 'Cloud version')))}
          >
            <Cloud className="h-4 w-4" />
            {t('cloudVersion.menuItem', 'Show the cloud version')}
          </ContextMenuItem>
        )}
        {!isDirectory && (
          <ContextMenuItem
            onSelect={guardedMenuAction(() => openVersionHistory(node.path, t("versionHistory.title", "Version history")))}
          >
            <History className="h-4 w-4" />
            {t("versionHistory.title", "Version history")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={guardedMenuAction(() => onRename(node.path))}>
          <Pencil className="h-4 w-4" />
          {t("fileExplorer.rename", "Rename")}
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={guardedMenuAction(() => onDelete(node.path, isDirectory))}
        >
          <Trash2 className="h-4 w-4" />
          {t("fileExplorer.delete", "Delete")}
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={guardedMenuAction(() => onOpenTerminal(terminalPath))}>
          <Terminal className="h-4 w-4" />
          {t("fileExplorer.openInTerminal", "Open in Terminal")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={guardedMenuAction(() => onReveal(node.path))}>
          <ExternalLink className="h-4 w-4" />
          {t("fileExplorer.revealInFinder", "Reveal in Finder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
