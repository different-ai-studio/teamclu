import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

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
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamConflictsStore } from '@/stores/team-conflicts'
import { teamSyncKeyForPath } from '@/lib/team-skill-paths'
import { formatDateTime } from '@/lib/date-format'

/** One entry of a document's cloud history, as the daemon reports it. */
interface CloudVersion {
  ref: string
  author: string | null
  timestamp: string
}

/**
 * What the cloud currently holds for one document, as text.
 *
 * Deliberately not a diff. The question this answers is "what do my teammates
 * see" — and when the answer differs from the local file, the user is usually
 * about to overwrite one with the other, not to study line-by-line deltas.
 * Version history remains the place for that.
 */
export function KnowledgeCloudVersion({ path }: { path: string }) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const knowledgeDir = useTeamConflictsStore((s) => s.knowledgeDir)
  const loadConflicts = useTeamConflictsStore((s) => s.load)

  const syncKey = React.useMemo(
    () => teamSyncKeyForPath(path, { knowledgeDir, workspacePath }),
    [path, knowledgeDir, workspacePath],
  )

  const [content, setContent] = React.useState<string | null>(null)
  const [current, setCurrent] = React.useState<CloudVersion | null>(null)
  const [state, setState] = React.useState<'loading' | 'ready' | 'missing' | 'unreadable'>(
    'loading',
  )
  const [restoring, setRestoring] = React.useState(false)

  // The knowledge dir is resolved by the conflicts store; without it a path
  // cannot be turned into the sync key every daemon call takes.
  React.useEffect(() => {
    if (!knowledgeDir) void loadConflicts()
  }, [knowledgeDir, loadConflicts])

  // Deliberately component-local rather than the shared version-history store.
  // That store keeps ONE list for the whole app, so a second document's view
  // read the first one's `versions[0]` before its own load finished — and since
  // blobs are content-addressed, the daemon happily returned that other
  // document's text under this document's name. Nothing about this view is
  // worth sharing across tabs.
  React.useEffect(() => {
    let cancelled = false
    if (!teamId || !syncKey) return
    setState('loading')
    setContent(null)
    setCurrent(null)
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ versions: CloudVersion[] }>('team_file_versions', {
          teamId,
          path: syncKey,
        })
        if (cancelled) return
        // Newest first (FC orders by version desc), so [0] is what the cloud
        // holds now and the rest is history.
        const top = list.versions?.[0] ?? null
        if (!top) {
          setState('missing')
          return
        }
        setCurrent(top)
        const res = await invoke<{ content: string | null }>('team_file_content', {
          teamId,
          path: syncKey,
          ref: top.ref,
        })
        if (cancelled) return
        setContent(res.content ?? null)
        // Null means the daemon could not turn the blob into text: an old
        // encrypted version this device has no key for, or a binary document.
        setState(res.content == null ? 'unreadable' : 'ready')
      } catch {
        if (!cancelled) setState('unreadable')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, syncKey])

  const name = path.slice(path.lastIndexOf('/') + 1)

  const restore = React.useCallback(async () => {
    if (!teamId || !syncKey || !current) return
    setRestoring(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('team_restore_file_version', { teamId, path: syncKey, ref: current.ref })
      toast.success(t('cloudVersion.restored', 'The cloud version was written to this document'))
    } catch (e) {
      toast.error(t('cloudVersion.restoreFailed', 'Could not restore: {{msg}}', { msg: String(e) }))
    } finally {
      setRestoring(false)
    }
  }, [teamId, syncKey, current, t])

  if (!syncKey) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
        {t('cloudVersion.notTeamContent', 'This file is not part of the team knowledge base.')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-start gap-3 border-b border-border px-4 py-3"
        data-tauri-drag-region
      >
        <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t('cloudVersion.title', 'Cloud version')}
          </div>
          <div className="truncate text-[15px] font-bold text-foreground">{name}</div>
          {current && (
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {t('cloudVersion.subtitle', 'Last changed {{time}}{{by}}', {
                time: formatDateTime(current.timestamp),
                by: current.author ? t('cloudVersion.byAuthor', ' by {{who}}', { who: current.author }) : '',
              })}
            </div>
          )}
        </div>
        {state === 'ready' && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={restoring}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t('cloudVersion.useThis', 'Overwrite my copy with this')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('cloudVersion.useThisTitle', 'Overwrite the local document?')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    'cloudVersion.useThisDescription',
                    'The cloud version replaces what is on this disk. Anything you have not pushed is lost.',
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void restore()}>
                  {t('cloudVersion.useThisConfirm', 'Overwrite')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {state === 'loading' ? (
          <div className="flex items-center gap-2 px-4 py-8 text-[13px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading', 'Loading...')}
          </div>
        ) : state === 'missing' ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
            {t(
              'cloudVersion.notPushed',
              'This document only exists here — the cloud has no copy of it yet.',
            )}
          </div>
        ) : state === 'unreadable' ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
            {t(
              'cloudVersion.unreadable',
              'The cloud copy cannot be read here: it is binary.',
            )}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed">
            {content}
          </pre>
        )}
      </ScrollArea>
    </div>
  )
}
