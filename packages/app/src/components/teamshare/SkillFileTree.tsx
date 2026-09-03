import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  FileCode,
  FileText,
  FilePlus,
  FolderPlus,
  Folder,
  FolderOpen,
  Trash2,
  FolderSearch,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { InlineInput } from '@/components/workspace/FileTreeNode'
import {
  createNewFile,
  createNewFolder,
  deleteItem,
  revealInFinder,
} from '@/components/workspace/file-tree-operations'
import { cn } from '@/lib/utils'

/**
 * The package's own bookkeeping directory, hidden the same way the packer hides
 * it: only at the pack root. One nested deeper belongs to the skill, and
 * `zip_skill_dir` ships it — so the tree has to show it, or the author edits a
 * package whose contents they cannot fully see.
 */
const ORIGIN_DIR = '.clawhub'

interface Entry {
  name: string
  rel: string
  isDirectory: boolean
}

/** SKILL.md first, then directories, then everything else — each alphabetical.
 *
 * SKILL.md is pinned because it is the only file every skill has and the one
 * the agent actually reads; alphabetical order would bury it under `assets/`
 * in exactly the packages that have the most files. */
function sortEntries(entries: Entry[], atRoot: boolean): Entry[] {
  return [...entries].sort((a, b) => {
    if (atRoot) {
      if (a.name === 'SKILL.md') return -1
      if (b.name === 'SKILL.md') return 1
    }
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function fileIcon(name: string) {
  return /\.(md|markdown|txt)$/i.test(name) ? FileText : FileCode
}

type Creating = { parentRel: string; kind: 'file' | 'folder' }

interface SkillFileTreeProps {
  /** Absolute path of the skill package root. */
  packDir: string
  /** Currently open file, relative to `packDir`. */
  selectedRel: string | null
  onSelectFile: (rel: string) => void
  /** A file (or directory) left the package — whatever showed it should close. */
  onFileRemoved?: (rel: string) => void
  /**
   * Fired after the tree changes the package on disk. Adding a file leaves a
   * team pack clean (the baseline only tracks what the package shipped), but
   * deleting one makes it dirty and pauses auto-follow — the caller has to
   * re-inspect either way rather than guess which happened.
   */
  onMutated?: () => void
  /** Bumping this re-reads the tree from disk. */
  refreshKey?: number
  /**
   * Starts a create at the package root. The root has no row of its own inside
   * this tree — it is the skill row above it — so its menu lives with the
   * caller and reaches in through here.
   */
  rootCreate?: 'file' | 'folder' | null
  onRootCreateDone?: () => void
}

export function SkillFileTree({
  packDir,
  selectedRel,
  onSelectFile,
  onFileRemoved,
  onMutated,
  refreshKey = 0,
  rootCreate = null,
  onRootCreateDone,
}: SkillFileTreeProps) {
  const { t } = useTranslation()
  const [children, setChildren] = React.useState<Record<string, Entry[]>>({})
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [creating, setCreating] = React.useState<Creating | null>(null)
  const [deleting, setDeleting] = React.useState<Entry | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const abs = React.useCallback((rel: string) => (rel ? `${packDir}/${rel}` : packDir), [packDir])

  const loadDir = React.useCallback(
    async (rel: string) => {
      try {
        const { readDir } = await import('@tauri-apps/plugin-fs')
        const entries = await readDir(abs(rel))
        const mapped: Entry[] = entries
          .filter((e) => Boolean(e.name))
          .filter((e) => !(rel === '' && e.name === ORIGIN_DIR))
          .map((e) => ({
            name: e.name,
            rel: rel ? `${rel}/${e.name}` : e.name,
            isDirectory: Boolean(e.isDirectory),
          }))
        setChildren((prev) => ({ ...prev, [rel]: sortEntries(mapped, rel === '') }))
        setError(null)
      } catch (e) {
        // A pack that is mid-install, or a personal skill the user just moved,
        // reads as an error rather than an empty directory. Saying so beats
        // rendering a folder that looks empty.
        if (rel === '') setError(e instanceof Error ? e.message : String(e))
      }
    },
    [abs],
  )

  React.useEffect(() => {
    setChildren({})
    setExpanded(new Set())
    setCreating(null)
    void loadDir('')
  }, [packDir, refreshKey, loadDir])

  const toggleDir = React.useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(rel)) {
          next.delete(rel)
        } else {
          next.add(rel)
          void loadDir(rel)
        }
        return next
      })
    },
    [loadDir],
  )

  React.useEffect(() => {
    if (rootCreate) setCreating({ parentRel: '', kind: rootCreate })
  }, [rootCreate])

  const startCreate = React.useCallback(
    (parentRel: string, kind: 'file' | 'folder') => {
      if (parentRel !== '') {
        setExpanded((prev) => new Set(prev).add(parentRel))
        void loadDir(parentRel)
      }
      setCreating({ parentRel, kind })
    },
    [loadDir],
  )

  const confirmCreate = React.useCallback(
    async (name: string) => {
      if (!creating) return
      const { parentRel, kind } = creating
      setCreating(null)
      onRootCreateDone?.()
      const trimmed = name.trim()
      // Path separators would put the file somewhere the tree is not showing,
      // which is the one outcome a user creating a file here cannot predict.
      // `.clawhub` at the root is the installer's, and a package that ships one
      // overwrites its own bookkeeping on the next install.
      const invalid =
        !trimmed ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        trimmed === '.' ||
        trimmed === '..' ||
        (parentRel === '' && trimmed === ORIGIN_DIR)
      if (invalid) {
        toast.error(t('teamShare.skillFileNameInvalid', 'Enter a plain file name'))
        return
      }
      const parentAbs = abs(parentRel)
      const ok =
        kind === 'folder'
          ? await createNewFolder(parentAbs, trimmed)
          : await createNewFile(parentAbs, trimmed)
      if (!ok) {
        toast.error(t('teamShare.skillFileCreateFailed', 'Could not create {{name}}', { name: trimmed }))
        return
      }
      await loadDir(parentRel)
      onMutated?.()
      if (kind === 'file') onSelectFile(parentRel ? `${parentRel}/${trimmed}` : trimmed)
    },
    [creating, abs, loadDir, onMutated, onSelectFile, onRootCreateDone, t],
  )

  const executeDelete = React.useCallback(async () => {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    const ok = await deleteItem(abs(target.rel), target.isDirectory)
    if (!ok) {
      toast.error(t('teamShare.skillFileDeleteFailed', 'Could not delete {{name}}', { name: target.name }))
      return
    }
    const parentRel = target.rel.includes('/') ? target.rel.slice(0, target.rel.lastIndexOf('/')) : ''
    await loadDir(parentRel)
    onMutated?.()
    // Whatever was showing this file — or anything inside this directory — is
    // now pointed at something that does not exist.
    onFileRemoved?.(target.rel)
  }, [deleting, abs, loadDir, onMutated, onFileRemoved, t])

  const renderRows = (rel: string, depth: number): React.ReactNode => {
    const rows = children[rel]
    if (!rows) return null
    return (
      <>
        {creating?.parentRel === rel && (
          <InlineInput
            key="__creating"
            defaultValue=""
            level={depth + 2}
            icon={
              creating.kind === 'folder' ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )
            }
            onConfirm={(value) => void confirmCreate(value)}
            onCancel={() => {
              setCreating(null)
              onRootCreateDone?.()
            }}
          />
        )}
        {rows.map((entry) => {
          const Icon = entry.isDirectory
            ? expanded.has(entry.rel)
              ? FolderOpen
              : Folder
            : fileIcon(entry.name)
          const active = !entry.isDirectory && selectedRel === entry.rel
          return (
            <React.Fragment key={entry.rel}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() =>
                      entry.isDirectory ? toggleDir(entry.rel) : onSelectFile(entry.rel)
                    }
                    style={{ paddingLeft: `${depth * 12 + 28}px` }}
                    className={cn(
                      'flex w-full items-center gap-1.5 border-l-2 py-[3px] pr-4 text-left transition-colors',
                      active
                        ? 'border-coral bg-selected/50'
                        : 'border-transparent hover:bg-selected/40',
                    )}
                    data-testid={`skill-file-${entry.rel}`}
                  >
                    {entry.isDirectory ? (
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 shrink-0 text-faint transition-transform',
                          expanded.has(entry.rel) && 'rotate-90',
                        )}
                      />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span
                      className={cn(
                        'truncate font-mono text-[11.5px]',
                        active ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {entry.name}
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  {entry.isDirectory && (
                    <>
                      <ContextMenuItem onSelect={() => startCreate(entry.rel, 'file')}>
                        <FilePlus className="mr-2 h-3.5 w-3.5" />
                        {t('teamShare.skillFileNew', 'New file')}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => startCreate(entry.rel, 'folder')}>
                        <FolderPlus className="mr-2 h-3.5 w-3.5" />
                        {t('teamShare.skillFolderNew', 'New folder')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  <ContextMenuItem onSelect={() => void revealInFinder(abs(entry.rel))}>
                    <FolderSearch className="mr-2 h-3.5 w-3.5" />
                    {t('fileExplorer.revealInFinder', 'Reveal in Finder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    // SKILL.md is what makes the directory a skill: without it
                    // every loader in the app stops seeing this package at all.
                    disabled={entry.rel === 'SKILL.md'}
                    onSelect={() => setDeleting(entry)}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    {t('fileExplorer.delete', 'Delete')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {entry.isDirectory && expanded.has(entry.rel) && renderRows(entry.rel, depth + 1)}
            </React.Fragment>
          )
        })}
      </>
    )
  }

  return (
    <div className="pb-1">
      {error ? (
        <div className="px-4 py-1.5 pl-11 text-[11px] text-faint">
          {t('teamShare.skillFilesUnavailable', 'Package files are not readable on this machine')}
        </div>
      ) : (
        renderRows('', 0)
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('fileExplorer.confirmDeleteTitle', 'Delete "{{name}}"?', {
                name: deleting?.name ?? '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.isDirectory
                ? t(
                    'fileExplorer.confirmDeleteDirDesc',
                    'This will permanently delete this folder and all its contents.',
                  )
                : t('fileExplorer.confirmDeleteFileDesc', 'This will permanently delete this file.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void executeDelete()}>
              {t('fileExplorer.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Menu items for the package root, rendered by the skill row that owns it. */
export function SkillRootMenuItems({
  onNewFile,
  onNewFolder,
  onReveal,
}: {
  onNewFile: () => void
  onNewFolder: () => void
  onReveal: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <ContextMenuItem onSelect={onNewFile}>
        <FilePlus className="mr-2 h-3.5 w-3.5" />
        {t('teamShare.skillFileNew', 'New file')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onNewFolder}>
        <FolderPlus className="mr-2 h-3.5 w-3.5" />
        {t('teamShare.skillFolderNew', 'New folder')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onReveal}>
        <FolderSearch className="mr-2 h-3.5 w-3.5" />
        {t('fileExplorer.revealInFinder', 'Reveal in Finder')}
      </ContextMenuItem>
    </>
  )
}
