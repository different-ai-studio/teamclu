import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CloudDownload, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { SimpleDiff } from '@/components/version/simple-diff'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTabsStore } from '@/stores/tabs'
import {
  useTeamConflictsStore,
  type ConflictChoice,
  type TeamConflict,
} from '@/stores/team-conflicts'
import { teamSyncKeyForPath } from '@/lib/team-skill-paths'
import { encodeKnowledgeConflictTarget } from '@/lib/tabs/teamshare-target'
import { formatDateTime } from '@/lib/date-format'

async function readText(path: string): Promise<string | null> {
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    return await readTextFile(path)
  } catch {
    // A binary document, or one deleted between the scan and the read. Either
    // way the decision is still available — only the preview is not.
    return null
  }
}

/**
 * Decide one conflict: keep the local copy, or keep the cloud's.
 *
 * The state this renders is what the sync engine leaves behind: the document on
 * disk ALREADY holds the cloud version, and the copy the user wrote is parked in
 * a sidecar. So "my version" is read from the sidecar and "cloud version" from
 * the document itself — no network involved, which is why this opens instantly.
 */
export function KnowledgeConflictResolver({ path }: { path: string }) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const syncRoot = useTeamConflictsStore((s) => s.syncRoot)
  const bySyncKey = useTeamConflictsStore((s) => s.bySyncKey)
  const absPathFor = useTeamConflictsStore((s) => s.absPathFor)
  const load = useTeamConflictsStore((s) => s.load)
  const resolve = useTeamConflictsStore((s) => s.resolve)
  const closeWhere = useTabsStore((s) => s.closeWhere)

  const syncKey = React.useMemo(
    () => teamSyncKeyForPath(path, { syncRoot, workspacePath }),
    [path, syncRoot, workspacePath],
  )
  const conflicts = React.useMemo(
    () => (syncKey ? (bySyncKey[syncKey] ?? []) : []),
    [bySyncKey, syncKey],
  )

  const [selectedSidecar, setSelectedSidecar] = React.useState<string | null>(null)
  const selected: TeamConflict | null =
    conflicts.find((c) => c.sidecar === selectedSidecar) ?? conflicts[0] ?? null

  const [mine, setMine] = React.useState<string | null>(null)
  const [theirs, setTheirs] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<ConflictChoice | null>(null)

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    let cancelled = false
    if (!selected) {
      setMine(null)
      setTheirs(null)
      return
    }
    const sidecarPath = absPathFor(selected.sidecar)
    void (async () => {
      // Read one after the other rather than in parallel: both files are small
      // and local, so there is nothing to win, and a single reader keeps the
      // failure of one from deciding what the other shows.
      const local = sidecarPath ? await readText(sidecarPath) : null
      const remote = await readText(path)
      if (cancelled) return
      setMine(local)
      setTheirs(remote)
    })()
    return () => {
      cancelled = true
    }
  }, [selected, absPathFor, path])

  const name = path.slice(path.lastIndexOf('/') + 1)

  const decide = React.useCallback(
    async (choice: ConflictChoice) => {
      if (!selected) return
      setBusy(choice)
      try {
        await resolve(selected, choice)
        toast.success(
          choice === 'keepLocal'
            ? t('knowledgeConflict.keptLocalToast', 'Your version was restored and is syncing up')
            : t('knowledgeConflict.keptRemoteToast', 'Kept the cloud version'),
        )
        // Only this document's remaining conflicts matter here; when there are
        // none the tab has nothing left to decide, so it closes itself rather
        // than sitting there showing an empty state.
        const left = syncKey
          ? (useTeamConflictsStore.getState().bySyncKey[syncKey] ?? [])
          : []
        if (left.length === 0) {
          const target = encodeKnowledgeConflictTarget(path)
          closeWhere((tab) => tab.type === 'native' && tab.target === target)
        } else {
          setSelectedSidecar(left[0].sidecar)
        }
      } catch (e) {
        toast.error(
          t('knowledgeConflict.resolveFailed', 'Could not resolve: {{msg}}', { msg: String(e) }),
        )
      } finally {
        setBusy(null)
      }
    },
    [selected, resolve, t, syncKey, closeWhere, path],
  )

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
        {t('knowledgeConflict.none', 'This document has no conflict waiting for a decision.')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-start gap-3 border-b border-border px-4 py-3"
        data-tauri-drag-region
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-red-500">
            {t('knowledgeConflict.title', 'Conflict')}
          </div>
          <div className="truncate text-[15px] font-bold text-foreground">{name}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            {selected.conflictedAt
              ? t('knowledgeConflict.subtitleAt', {
                  defaultValue:
                    'The cloud overwrote this document at {{time}}. Your edits are kept here — pick which one survives.',
                  time: formatDateTime(selected.conflictedAt * 1000),
                })
              : t('knowledgeConflict.subtitle', {
                  defaultValue:
                    'The cloud overwrote this document. Your edits are kept here — pick which one survives.',
                })}
          </div>
        </div>
      </div>

      {conflicts.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2">
          <span className="mr-1 text-[11px] text-faint">
            {t('knowledgeConflict.multiple', '{{count}} conflicts on this document', {
              count: conflicts.length,
            })}
          </span>
          {conflicts.map((c) => (
            <button
              key={c.sidecar}
              type="button"
              onClick={() => setSelectedSidecar(c.sidecar)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11.5px] transition-colors',
                c.sidecar === selected.sidecar
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              {c.conflictedAt
                ? formatDateTime(c.conflictedAt * 1000)
                : t('knowledgeConflict.unknownTime', 'Unknown time')}
            </button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-4 border-b border-border px-4 py-1.5 text-[11px] text-muted-foreground">
        <span>
          <span className="mr-1 font-mono text-red-600 dark:text-red-400">-</span>
          {t('knowledgeConflict.legendMine', 'Your version')}
        </span>
        <span>
          <span className="mr-1 font-mono text-green-600 dark:text-green-400">+</span>
          {t('knowledgeConflict.legendTheirs', 'Cloud version (on disk now)')}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {mine === null || theirs === null ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
            {t(
              'knowledgeConflict.previewUnavailable',
              'Preview unavailable (the document is not text). You can still choose which version to keep.',
            )}
          </div>
        ) : (
          <SimpleDiff oldContent={mine} newContent={theirs} />
        )}
      </ScrollArea>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={busy !== null}>
              <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
              {t('knowledgeConflict.keepRemote', 'Discard mine, keep cloud')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('knowledgeConflict.keepRemoteTitle', 'Discard your version?')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(
                  'knowledgeConflict.keepRemoteDescription',
                  'Your copy is deleted and the document keeps the cloud version. This cannot be undone.',
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void decide('keepRemote')}>
                {t('knowledgeConflict.keepRemoteConfirm', 'Discard mine')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" disabled={busy !== null}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('knowledgeConflict.keepLocal', 'Keep mine, overwrite cloud')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('knowledgeConflict.keepLocalTitle', 'Overwrite the cloud version?')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(
                  'knowledgeConflict.keepLocalDescription',
                  'Your version is restored into the document and pushed to the team on the next sync, replacing what is in the cloud.',
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void decide('keepLocal')}>
                {t('knowledgeConflict.keepLocalConfirm', 'Keep mine')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
