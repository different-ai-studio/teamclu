import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowUpDown, Check, Loader2, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useOssSyncStore } from '@/stores/oss-sync'
import { useTeamConflictsStore } from '@/stores/team-conflicts'
import { useTeamSyncStatusStore } from '@/stores/team-sync-status'
import { useWorkspaceStore } from '@/stores/workspace'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTeamCloudSync } from '@/hooks/use-team-cloud-sync'
import { openKnowledgeConflict } from '@/lib/tabs/knowledge-tabs'
import { formatRelativeTime, formatDateTime } from '@/lib/date-format'

/** How long a sync has to run before the bar is worth showing. */
const SHOW_AFTER_MS = 300
/** How long a finished bar stays at 100% so the eye can catch it. */
const LINGER_MS = 800
/** Poll interval while a sync runs. Loopback HTTP to the local daemon. */
const POLL_MS = 400

function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}

/**
 * The Knowledge column's bottom bar: what the team tree's sync is doing, and
 * the one place a conflict can be reached from without hunting for a red row.
 *
 * Deliberately not a copy of the header's refresh button. That one re-reads the
 * local list; this one is about the cloud — it reports state and runs a sync.
 */
export function KnowledgeSyncFooter() {
  const { t } = useTranslation()
  const syncing = useOssSyncStore((s) => s.syncing)
  const progress = useOssSyncStore((s) => s.progress)
  const lastSyncAt = useOssSyncStore((s) => s.lastSyncAt)
  const failed = useOssSyncStore((s) => s.failed)
  const lastError = useOssSyncStore((s) => s.lastError)
  const refresh = useOssSyncStore((s) => s.refresh)
  const conflicts = useTeamConflictsStore((s) => s.entries)
  const absPathFor = useTeamConflictsStore((s) => s.absPathFor)
  const localBySyncKey = useTeamSyncStatusStore((s) => s.localBySyncKey)
  const remoteBySyncKey = useTeamSyncStatusStore((s) => s.remoteBySyncKey)
  const stuckBySyncKey = useTeamSyncStatusStore((s) => s.stuckBySyncKey)
  const selectFile = useWorkspaceStore((s) => s.selectFile)
  const refreshSyncStatus = useTeamSyncStatusStore((s) => s.refresh)
  const loadConflicts = useTeamConflictsStore((s) => s.load)
  const { available, syncNow } = useTeamCloudSync()

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // The daemon syncs on its own timer whether this window is focused or not, so
  // coming back to it is the moment this bar is most likely to be lying — it
  // has no other way to hear about a background tick. Throttled in the store,
  // and free apart from one status read.
  React.useEffect(() => {
    const onFocus = () => {
      void refresh()
      void loadConflicts()
      void refreshSyncStatus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, loadConflicts, refreshSyncStatus])

  // Progress only exists inside a running tick, and the daemon is the only one
  // who knows it — hence a poll, and only while something is running.
  React.useEffect(() => {
    if (!syncing) return
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [syncing, refresh])

  // Most syncs move nothing and return in well under a second. Showing a bar
  // for those is a flash of noise, so it has to earn its place by lasting.
  const [showBar, setShowBar] = React.useState(false)
  React.useEffect(() => {
    if (syncing) {
      const id = setTimeout(() => setShowBar(true), SHOW_AFTER_MS)
      return () => clearTimeout(id)
    }
    if (!showBar) return
    const id = setTimeout(() => setShowBar(false), LINGER_MS)
    return () => clearTimeout(id)
  }, [syncing, showBar])

  const phaseLabel = React.useMemo(() => {
    switch (progress?.phase) {
      case 'pulling':
        return t('knowledgeSync.phasePulling', 'Downloading')
      case 'pushing':
        return t('knowledgeSync.phasePushing', 'Uploading')
      case 'deleting':
        return t('knowledgeSync.phaseDeleting', 'Removing')
      case 'checking':
      default:
        return t('knowledgeSync.phaseChecking', 'Checking')
    }
  }, [progress?.phase, t])

  // One line, in the order that decides what the user should look at first:
  // something that needs a decision beats something that needs a retry, and
  // both beat the running sync's own chatter.
  const conflicted = conflicts.length > 0
  const broken = !syncing && (failed > 0 || !!lastError)
  const outgoing = Object.keys(localBySyncKey).length
  const incoming = Object.keys(remoteBySyncKey).length
  const pending = outgoing + incoming > 0

  // Everything that is not settled, in the order it deserves attention. This
  // list is the only place some of it can be seen at all: a deleted document
  // has no row left in the tree, and a file the pull cannot apply never had one.
  const groups = React.useMemo(() => {
    const fileName = (key: string) => key.slice(key.lastIndexOf('/') + 1)
    const open = (syncKey: string) => {
      const abs = absPathFor(syncKey)
      return abs ? () => selectFile(abs) : undefined
    }
    return [
      {
        id: 'conflict',
        label: t('knowledgeSync.groupConflict', 'Needs a decision'),
        tone: 'text-red-500',
        items: conflicts.map((c) => ({
          key: c.sidecar,
          name: fileName(c.path),
          note: t('knowledgeSync.itemConflict', 'both sides changed it'),
          onClick: () => {
            const abs = absPathFor(c.path)
            if (abs) openKnowledgeConflict(abs, t('knowledgeConflict.tabLabel', 'Conflict'))
          },
        })),
      },
      {
        id: 'stuck',
        label: t('knowledgeSync.groupStuck', 'Cannot sync'),
        tone: 'text-red-500',
        items: Object.entries(stuckBySyncKey).map(([key, s]) => ({
          key,
          name: fileName(key),
          // The reason is the only thing that tells a person whether this is
          // theirs to fix (a key they can paste) or nobody's (a lost one).
          note: t('knowledgeSync.itemStuck', 'retried {{count}}× · {{reason}}', {
            count: s.attempts,
            reason: s.reason,
          }),
          onClick: undefined,
        })),
      },
      {
        id: 'outgoing',
        label: t('knowledgeSync.groupOutgoing', 'Waiting to upload'),
        tone: '',
        items: Object.entries(localBySyncKey).map(([key, status]) => ({
          key,
          name: fileName(key),
          note:
            status === 'new'
              ? t('knowledgeSync.itemNew', 'new')
              : status === 'deleted'
                ? t('knowledgeSync.itemDeleted', 'deleted')
                : t('knowledgeSync.itemModified', 'edited'),
          onClick: status === 'deleted' ? undefined : open(key),
        })),
      },
      {
        id: 'incoming',
        label: t('knowledgeSync.groupIncoming', 'Waiting to download'),
        tone: '',
        items: Object.entries(remoteBySyncKey).map(([key, item]) => ({
          key,
          name: fileName(key),
          note: item.deleted
            ? t('knowledgeSync.itemRemoteDeleted', 'deleted by a teammate')
            : t('knowledgeSync.itemRemoteUpdated', 'updated'),
          onClick: undefined,
        })),
      },
    ].filter((g) => g.items.length > 0)
  }, [conflicts, stuckBySyncKey, localBySyncKey, remoteBySyncKey, absPathFor, selectFile, t])

  const hasList = groups.length > 0

  const bar = (
    <button
      type="button"
      onClick={hasList ? undefined : () => void syncNow()}
      // With something to list, the bar is always openable — reading the list
      // during a sync is exactly when a person wants it. With nothing to list
      // it is just the sync button, and that needs the cloud side to be there.
      disabled={hasList ? false : !available || syncing}
      data-testid="knowledge-sync-footer"
      className={cn(
        // Same slot and chrome as the skills column's scan-paths bar.
        'flex w-full shrink-0 flex-col gap-1 border-t border-border bg-panel/60 px-3 py-2 text-left text-[11.5px] transition-colors',
        'hover:bg-black/[0.03] disabled:hover:bg-transparent',
      )}
      title={
        lastSyncAt
          ? t('knowledgeSync.lastSyncTooltip', 'Last sync: {{time}}', {
              time: formatDateTime(lastSyncAt),
            })
          : undefined
      }
    >
      <span className="flex w-full items-center gap-1.5">
        {conflicted ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
            <span className="min-w-0 flex-1 truncate text-red-500">
              {t('knowledgeSync.conflicts', '{{count}} conflicts need a decision', {
                count: conflicts.length,
              })}
            </span>
          </>
        ) : broken ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
            <span className="min-w-0 flex-1 truncate text-red-500">
              {failed > 0
                ? t('knowledgeSync.failedFiles', '{{count}} files cannot sync · retrying', {
                    count: failed,
                  })
                : t('knowledgeSync.failed', 'Sync failed')}
            </span>
            <RefreshCw className="h-3 w-3 shrink-0 text-red-500" />
          </>
        ) : showBar ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{phaseLabel}</span>
            {progress && progress.total > 0 && (
              <span className="shrink-0 tabular-nums text-faint">
                {progress.done}/{progress.total}
              </span>
            )}
          </>
        ) : (
          <>
            {pending ? (
              <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {pending
                ? // What is waiting, in the direction it is waiting to go. This
                  // is the line that tells the user their edit has not left the
                  // machine yet — the one thing the bar could not say before.
                  t('knowledgeSync.pending', '↑{{out}} ↓{{in}} · click to sync', {
                    out: outgoing,
                    in: incoming,
                  })
                : lastSyncAt
                  ? t('knowledgeSync.syncedAt', 'Synced · {{time}}', {
                      time: formatRelativeTime(lastSyncAt),
                    })
                  : t('knowledgeSync.never', 'Not synced yet')}
            </span>
          </>
        )}
      </span>

      {showBar && !conflicted && (
        <span className="block h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]">
          <span
            className={cn(
              'block h-full rounded-full bg-foreground/40 transition-[width] duration-200',
              // The manifest walk has no denominator to report, so it gets a
              // moving bar rather than a fake 0%.
              !progress || progress.total === 0 ? 'w-1/3 animate-pulse' : '',
            )}
            style={
              progress && progress.total > 0
                ? { width: `${percent(progress.done, progress.total)}%` }
                : undefined
            }
          />
        </span>
      )}
    </button>
  )

  if (!hasList) return bar

  return (
    <Popover>
      <PopoverTrigger asChild>{bar}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[320px] p-0" data-testid="knowledge-sync-list">
        {/* Radix wraps the viewport's children in a `display: table` div, which
            sizes to the widest row — so a long document name would widen the
            list instead of ellipsing. `!block` puts the rows back on the
            popover's own width, which is what `truncate` needs. */}
        <ScrollArea className="max-h-[280px] [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="py-1">
            {groups.map((group) => (
              <div key={group.id}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={item.onClick}
                    disabled={!item.onClick}
                    className={cn(
                      'flex w-full items-baseline gap-2 px-3 py-1 text-left text-[12px]',
                      item.onClick ? 'hover:bg-black/[0.04]' : 'cursor-default',
                    )}
                  >
                    <span className={cn('min-w-0 flex-1 truncate', group.tone)}>{item.name}</span>
                    <span className="shrink-0 text-[10.5px] text-faint">{item.note}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-end border-t border-border px-3 py-2">
          <Button size="sm" onClick={() => void syncNow()} disabled={syncing || !available}>
            {syncing
              ? t('knowledgeSync.syncing', 'Syncing…')
              : t('knowledgeSync.syncNowAction', 'Sync now')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
