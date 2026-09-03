import * as React from "react"
import { useTranslation } from "react-i18next"
import { File, Folder, ImageIcon, Loader2, Paperclip } from "lucide-react"
import { useWorkspaceStore } from "@/stores/workspace"
import { useTeamModeStore } from "@/stores/team-mode"
import { useSessionMessageStore } from "@/stores/session-message-store"
import { TEAMCLU_DIR } from "@/lib/config/build-config"
import { isTauri } from "@/lib/utils"
import { cn } from "@/lib/utils"
import {
  collectSessionAttachments,
  type SessionAttachmentRef,
} from "@/lib/attachments/session-attachments"

interface FileMentionPopoverProps {
  activeSessionId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  onSelect: (relativePath: string) => void
  onSelectSessionAttachment: (attachment: SessionAttachmentRef) => void
}

const ALWAYS_IGNORED_NAMES = new Set([
  "node_modules", ".git", ".DS_Store", "dist", "build", ".next",
  "__pycache__", ".cache", ".turbo", "target", ".idea", ".vscode",
  ".ruff_cache",
])

const DEV_ONLY_NAMES = new Set([TEAMCLU_DIR])

function isIgnoredName(name: string): boolean {
  if (useTeamModeStore.getState().devUnlocked) return false
  if (ALWAYS_IGNORED_NAMES.has(name)) return true
  if (DEV_ONLY_NAMES.has(name)) return true
  return false
}

interface FlatEntry {
  name: string
  relPath: string
  type: "file" | "directory"
  depth: number
}

type SelectableRow =
  | { kind: "session"; attachment: SessionAttachmentRef }
  | { kind: "workspace"; entry: FlatEntry }

// Module-level cache so re-opening the popover is instant
let cachedWorkspace: string | null = null
let cachedEntries: FlatEntry[] = []

function getRelativePath(fullPath: string, workspacePath: string): string {
  if (fullPath.startsWith(workspacePath)) {
    const rel = fullPath.slice(workspacePath.length)
    return rel.startsWith("/") ? rel.slice(1) : rel
  }
  return fullPath
}

async function scanRecursive(
  dir: string,
  workspacePath: string,
  depth: number,
  maxDepth: number,
  result: FlatEntry[],
): Promise<void> {
  if (depth > maxDepth) return
  const { readDir } = await import("@tauri-apps/plugin-fs")
  let raw: Awaited<ReturnType<typeof readDir>>
  try {
    raw = await readDir(dir)
  } catch {
    return
  }

  const sorted = [...raw]
    .filter(e => e.name && !isIgnoredName(e.name))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return (a.name || "").localeCompare(b.name || "")
    })

  for (const entry of sorted) {
    if (!entry.name) continue
    const fullPath = `${dir}/${entry.name}`
    const relPath = getRelativePath(fullPath, workspacePath)
    result.push({
      name: entry.name,
      relPath,
      type: entry.isDirectory ? "directory" : "file",
      depth,
    })
    if (entry.isDirectory) {
      await scanRecursive(fullPath, workspacePath, depth + 1, maxDepth, result)
    }
  }
}

const MAX_DISPLAY = 80

function filterByQuery<T extends { searchTarget: string }>(
  items: T[],
  searchQuery: string,
  limit: number,
): T[] {
  if (!searchQuery) return items.slice(0, limit)
  const tokens = searchQuery.toLowerCase().split(/[\s/\\]+/).filter(Boolean)
  return items
    .filter((item) => {
      const target = item.searchTarget.toLowerCase()
      return tokens.every((t) => target.includes(t))
    })
    .slice(0, limit)
}

export function FileMentionPopover({
  activeSessionId,
  open,
  onOpenChange,
  searchQuery,
  onSelect,
  onSelectSessionAttachment,
}: FileMentionPopoverProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const sessionMessages = useSessionMessageStore((s) =>
    activeSessionId ? s.messages[activeSessionId] : undefined,
  )
  const [allEntries, setAllEntries] = React.useState<FlatEntry[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  const selectableRowsRef = React.useRef<SelectableRow[]>([])
  const highlightedIndexRef = React.useRef(0)

  const sessionAttachments = React.useMemo(
    () => collectSessionAttachments(sessionMessages),
    [sessionMessages],
  )

  const filteredSessionAttachments = React.useMemo(
    () =>
      filterByQuery(
        sessionAttachments.map((attachment) => ({
          attachment,
          searchTarget: attachment.name,
        })),
        searchQuery,
        MAX_DISPLAY,
      ).map((row) => row.attachment),
    [sessionAttachments, searchQuery],
  )

  // Recursively scan workspace on open
  React.useEffect(() => {
    if (!open || !workspacePath || !isTauri()) return

    if (cachedWorkspace === workspacePath && cachedEntries.length > 0) {
      setAllEntries(cachedEntries)
      return
    }

    let cancelled = false
    setIsLoading(true)

    ;(async () => {
      const result: FlatEntry[] = []
      await scanRecursive(workspacePath, workspacePath, 0, 8, result)
      if (cancelled) return
      cachedWorkspace = workspacePath
      cachedEntries = result
      setAllEntries(result)
      setIsLoading(false)
    })()

    return () => { cancelled = true }
  }, [open, workspacePath])

  React.useEffect(() => {
    if (!open) {
      setHighlightedIndex(0)
    }
  }, [open])

  const filteredWorkspaceEntries = React.useMemo(() => {
    if (!isTauri()) return []
    return filterByQuery(
      allEntries.map((entry) => ({
        entry,
        searchTarget: entry.relPath,
      })),
      searchQuery,
      MAX_DISPLAY,
    ).map((row) => row.entry)
  }, [allEntries, searchQuery])

  const selectableRows = React.useMemo<SelectableRow[]>(() => {
    const rows: SelectableRow[] = []
    for (const attachment of filteredSessionAttachments) {
      rows.push({ kind: "session", attachment })
    }
    for (const entry of filteredWorkspaceEntries) {
      rows.push({ kind: "workspace", entry })
    }
    return rows
  }, [filteredSessionAttachments, filteredWorkspaceEntries])

  React.useEffect(() => {
    selectableRowsRef.current = selectableRows
  }, [selectableRows])

  React.useEffect(() => {
    highlightedIndexRef.current = highlightedIndex
  }, [highlightedIndex])

  React.useEffect(() => {
    setHighlightedIndex(0)
  }, [selectableRows])

  const handleSelectRow = React.useCallback((row: SelectableRow) => {
    if (row.kind === "session") {
      onSelectSessionAttachment(row.attachment)
    } else {
      onSelect(row.entry.relPath)
    }
    onOpenChange(false)
  }, [onSelect, onSelectSessionAttachment, onOpenChange])

  React.useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`)
    item?.scrollIntoView({ block: "nearest" })
  }, [highlightedIndex])

  React.useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      const currentRows = selectableRowsRef.current
      if (currentRows.length === 0) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => {
          const nextIndex = (i + 1) % currentRows.length
          highlightedIndexRef.current = nextIndex
          return nextIndex
        })
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => {
          const nextIndex = (i - 1 + currentRows.length) % currentRows.length
          highlightedIndexRef.current = nextIndex
          return nextIndex
        })
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) return
        e.preventDefault()
        e.stopPropagation()
        const row = currentRows[highlightedIndexRef.current]
        if (row) handleSelectRow(row)
      }
    }

    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open, handleSelectRow])

  if (!open) return null

  let rowIndex = 0
  const showSessionSection = filteredSessionAttachments.length > 0
  const showWorkspaceSection = isTauri()

  return (
    <div className="absolute bottom-full left-0 mb-2 w-96 rounded-lg border bg-popover shadow-lg z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center justify-between px-3 py-2 text-[10px] text-muted-foreground border-b bg-muted/30">
        <span className="font-medium">{t("chat.fileMention.title", "Reference a file")}</span>
        {searchQuery && (
          <span className="text-[9px] text-primary font-mono">
            {searchQuery}
          </span>
        )}
      </div>

      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {showSessionSection ? (
          <>
            <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t("chat.fileMention.sessionAttachments", "Session attachments")}
            </div>
            {filteredSessionAttachments.map((attachment) => {
              const index = rowIndex++
              return (
                <div
                  key={attachment.url}
                  data-index={index}
                  onClick={() => handleSelectRow({ kind: "session", attachment })}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                    index === highlightedIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/50",
                  )}
                >
                  {attachment.isImage ? (
                    <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-xs font-medium truncate">{attachment.name}</span>
                </div>
              )
            })}
          </>
        ) : null}

        {showWorkspaceSection ? (
          <>
            <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70 mt-1">
              {t("chat.fileMention.workspaceFiles", "Workspace files")}
            </div>
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("chat.fileMention.scanningWorkspace", "Scanning workspace…")}
              </div>
            ) : filteredWorkspaceEntries.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {searchQuery
                  ? t("chat.fileMention.noMatch", 'No match for "{{query}}"', { query: searchQuery })
                  : t("chat.fileMention.noFilesFound", "No files found")}
              </div>
            ) : (
              filteredWorkspaceEntries.map((entry) => {
                const index = rowIndex++
                return (
                  <div
                    key={entry.relPath}
                    data-index={index}
                    onClick={() => handleSelectRow({ kind: "workspace", entry })}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={cn(
                      "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                      index === highlightedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50",
                    )}
                  >
                    {entry.type === "directory" ? (
                      <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                    ) : (
                      <File className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                      <span className="text-xs font-medium truncate shrink-0">
                        {entry.name}
                      </span>
                      {entry.relPath !== entry.name && (
                        <span className="text-[10px] text-muted-foreground/60 truncate">
                          {entry.relPath}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </>
        ) : null}

        {!showSessionSection && !showWorkspaceSection ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {t("chat.fileMention.noAttachmentsInSession", "No attachments in this session")}
          </div>
        ) : null}

        {showSessionSection && !showWorkspaceSection && filteredSessionAttachments.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            {t("chat.fileMention.noSessionAttachmentsYet", "No session attachments yet")}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground/60 border-t">
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↑↓</kbd> {t("chat.fileMention.keyboardNavigate", "navigate")}</span>
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↵/Tab</kbd> {t("chat.fileMention.keyboardSelect", "select")}</span>
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">Esc</kbd> {t("chat.fileMention.keyboardClose", "close")}</span>
      </div>
    </div>
  )
}

export function invalidateFileMentionCache(): void {
  cachedWorkspace = null
  cachedEntries = []
}
