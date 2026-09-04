import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, Loader2, MessageSquare, Pin, Archive, Pencil, Ellipsis, Info, SquarePen, SlidersHorizontal, X, ListChecks, Check, HelpCircle, Stamp, Clock } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCronStore } from '@/stores/cron'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getKnownLocalDaemonActorId } from '@/lib/daemon/local-daemon-identity'
import { useSessionParticipantStore } from '@/stores/session-participant-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { createQuickSession, describeQuickSessionFailure } from '@/lib/session/create-quick-session'
import { toast } from 'sonner'
import { useSidebarSafe } from '@/components/ui/sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { AnimatedClock } from '@/components/ui/animated-clock'
import { SessionSearchDialog } from '@/components/sidebar/session-search-dialog'
import { SessionDetailDialog, type SessionDetailListHints } from '@/components/sidebar/SessionDetailDialog'
import { SessionLiquidGlass } from '@/components/sidebar/SessionLiquidGlass'
import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar'
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
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/ui/date-format'
import { useTypeAhead } from '@/hooks/use-type-ahead'
import type { SessionListActivity } from '@/lib/session/session-list-activity'
import { useSessionListActivityMap } from '@/hooks/use-session-list-activity-map'
import { loadSessionIdsForActor } from '@/lib/session/session-by-actor'
import { loadSessionIdsForWorkspace } from '@/lib/session/session-by-workspace'
import { actorAvatarColor } from '@/lib/actor/actor-color'
import { useSessionWorkspaceLabels } from '@/hooks/use-session-workspace-labels'
import { compareSessionListByRecency } from '@/lib/session/session-list-sort'
import { buildSessionListGlassLayoutKey } from '@/lib/ui/session-list-glass-layout-key'
import { isScheduledSession } from '@/lib/session/session-origin'

/**
 * Merged row shape consumed by the rendering pipeline. Combines list-canonical
 * fields from `useSessionListStore.rows` (title, last_message_*, idea_id) with
 * per-user state (pin) we need for sorting.
 */
type ListRow = {
  id: string
  title: string
  teamId: string
  lastMessageAt: Date | null
  createdAt: Date | null
  lastMessagePreview: string | null
  ideaId: string | null
  isPinned: boolean
  hasUnread: boolean
  source: string | null
}

function entryToRow(entry: SessionListEntry, isPinned: boolean): ListRow {
  return {
    id: entry.id,
    title: entry.title,
    teamId: entry.team_id,
    lastMessageAt: entry.last_message_at ? new Date(entry.last_message_at) : null,
    createdAt: entry.created_at ? new Date(entry.created_at) : null,
    lastMessagePreview: entry.last_message_preview,
    ideaId: entry.idea_id,
    isPinned,
    hasUnread: entry.has_unread,
    source: entry.source ?? null,
  }
}

/**
 * Below this many rows we render the plain (non-virtualized) list so short
 * lists keep identical DOM/behavior (and unit tests, which render a handful of
 * rows, exercise the unchanged path). Above it we switch to a windowed list to
 * avoid mounting hundreds of session rows at once.
 */
const VIRTUAL_SESSION_THRESHOLD = 40

/** Tighter header padding and title when the column is very narrow. */
const COMPACT_HEADER_MAX_WIDTH = 360

function useCompactColumnHeader(threshold = COMPACT_HEADER_MAX_WIDTH) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [compact, setCompact] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    const sync = (width: number) => {
      if (width <= 0) return
      setCompact(width < threshold)
    }
    sync(el.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      sync(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])

  return { ref, compact }
}

/** Flattened item consumed by the virtualizer (header / divider / session). */
type VirtualRow =
  | { key: string; kind: 'pinned-header' }
  | { key: string; kind: 'divider' }
  | { key: string; kind: 'session'; row: ListRow }

function sessionActivityLabel(
  activity: SessionListActivity,
  t: (key: string, fallback: string) => string,
): string {
  if (activity.state === 'running') return t('sidebar.sessionRunning', 'Running')
  if (activity.kind === 'question') return t('sessions.detail.awaitingQuestion', 'Awaiting answer')
  if (activity.kind === 'permission') return t('sidebar.awaitingConfirmation', 'Awaiting confirmation')
  return t('sessions.detail.waiting', 'Waiting')
}

/** D方案：18px 图标 pill，完整文案走 title / aria-label；不增行高。 */
function SessionActivityBadge({ activity }: { activity?: SessionListActivity }) {
  const { t } = useTranslation()
  if (!activity) return null

  const label = sessionActivityLabel(activity, t)

  if (activity.state === 'running') {
    return (
      <span
        className="mr-1 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center"
        title={label}
        aria-label={label}
        data-testid="v2-session-activity-badge"
        data-kind="streaming"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
      </span>
    )
  }

  const isQuestion = activity.kind === 'question'
  const isPermission = activity.kind === 'permission'
  return (
    <span
      className={cn(
        'mr-1 inline-grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border',
        isQuestion
          ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-600'
          : isPermission
            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
            : 'border-amber-500/20 bg-amber-500/10 text-amber-700',
      )}
      title={label}
      aria-label={label}
      data-testid="v2-session-activity-badge"
      data-kind={activity.kind}
    >
      {isQuestion ? (
        <HelpCircle className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      ) : isPermission ? (
        <Stamp className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      ) : (
        <Clock className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      )}
    </span>
  )
}

function SessionRenameInput({ defaultValue, onConfirm, onCancel }: {
  defaultValue: string
  onConfirm: (v: string) => void
  onCancel: () => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { ref.current?.focus(); ref.current?.select() }, [defaultValue])
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const v = ref.current?.value.trim()
          if (v) onConfirm(v); else onCancel()
        } else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        const v = ref.current?.value.trim()
        if (v) onConfirm(v); else onCancel()
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 bg-transparent border border-primary/50 rounded px-1.5 py-0.5 text-sm outline-none focus:border-primary min-w-0"
    />
  )
}

export function SessionListColumn({
  showNewSessionActions,
  onDismiss,
}: {
  showNewSessionActions?: boolean
  /** When embedded in a sheet/modal, render an inline close control in the header. */
  onDismiss?: () => void
} = {}) {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const embedMode = useUIStore((s) => s.embedMode)

  // List source: v2 canonical store. Entries already carry last_message_at,
  // last_message_preview, idea_id — no extra Supabase round-trip needed.
  const listRows = useSessionListStore((s) => s.rows)
  const listLoading = useSessionListStore((s) => s.loading)
  const loadMoreSessions = useSessionListStore((s) => s.loadMore)

  // Activity badges: useSessionListActivityMap (legacy + v2 ACP permissions).
  const activeSessionId = useSessionSelectionStore((s) => s.activeSessionId)
  const pinnedSessionIds = useSessionListStore((s) => s.pinnedSessionIds)
  const highlightedSessionIds = useSessionListStore((s) => s.highlightedSessionIds)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const updateSessionTitle = useSessionListStore((s) => s.updateSessionTitle)
  const toggleSessionPinned = useSessionListStore((s) => s.toggleSessionPinned)
  const initPinnedSessionIds = useSessionListStore((s) => s.initPinnedSessionIds)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const showCronSessions = useCronStore((s) => s.showCronSessions)
  const toggleShowCronSessions = useCronStore((s) => s.toggleShowCronSessions)
  const listHasMore = useSessionListStore((s) =>
    showCronSessions ? s.cronHasMore : s.regularHasMore,
  )

  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const hasWorkspace = !!workspacePath
  const sessionHeaderActionsEnabled = hasWorkspace || embedMode
  const { state: sidebarState } = useSidebarSafe()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const { ref: columnRef, compact: compactHeader } = useCompactColumnHeader()

  const [searchOpen, setSearchOpen] = React.useState(false)
  const [creatingSession, setCreatingSession] = React.useState(false)
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null)
  /** C2 inline more-actions dock — at most one row open. */
  const [actionsOpenSessionId, setActionsOpenSessionId] = React.useState<string | null>(null)
  const [detailSessionId, setDetailSessionId] = React.useState<string | null>(null)
  const [detailHints, setDetailHints] = React.useState<SessionDetailListHints | null>(null)
  const [actorSessionIds, setActorSessionIds] = React.useState<Set<string> | null>(null)
  const [actorLoading, setActorLoading] = React.useState(false)
  // Batch archive — additive select mode; idle list UI stays unchanged.
  const [batchSelecting, setBatchSelecting] = React.useState(false)
  const [batchSelectedIds, setBatchSelectedIds] = React.useState<Set<string>>(() => new Set())
  const [batchConfirmOpen, setBatchConfirmOpen] = React.useState(false)
  const [batchArchiving, setBatchArchiving] = React.useState(false)
  const participantsBySession = useSessionParticipantStore((s) => s.participantsBySession)
  const ensureParticipants = useSessionParticipantStore((s) => s.ensureParticipants)

  // Load actor-session set when filter switches to actor mode.
  // teamId is only used for cache namespacing; the supabase query is by actor_id.
  const teamIdFromList = useCurrentTeamStore((s) => s.team?.id ?? '')
  const currentMemberId = useCurrentTeamStore((s) => s.currentMember?.id ?? '')
  const sessionWorkspaceLabels = useSessionWorkspaceLabels(teamIdFromList || null)
  React.useEffect(() => {
    initPinnedSessionIds(teamIdFromList || null)
  }, [initPinnedSessionIds, teamIdFromList])
  React.useEffect(() => {
    if (filter.kind !== 'actor') {
      setActorSessionIds(null)
      return
    }
    let cancelled = false
    setActorLoading(true)
    void loadSessionIdsForActor(filter.actorId, teamIdFromList).then((ids) => {
      if (!cancelled) {
        setActorSessionIds(ids)
        setActorLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [filter, teamIdFromList])

  // Load workspace-session set when filter switches to workspace mode.
  // Reads the LOCAL libsql cache only — no cloud round-trip.
  const [workspaceSessionIds, setWorkspaceSessionIds] = React.useState<Set<string> | null>(null)
  React.useEffect(() => {
    if (filter.kind !== 'workspace') {
      setWorkspaceSessionIds(null)
      return
    }
    let cancelled = false
    void loadSessionIdsForWorkspace(teamIdFromList, { workspaceId: filter.workspaceId, path: filter.path })
      .then((ids) => { if (!cancelled) setWorkspaceSessionIds(ids) })
    return () => { cancelled = true }
  }, [filter, teamIdFromList])

  // ⌘K opens search
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (sessionHeaderActionsEnabled) setSearchOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [sessionHeaderActionsEnabled])

  /**
   * Apply cron / pin / idea / actor filters and sort by last_message_at DESC.
   * Pinned vs unpinned split happens at render time for the "all" filter.
   */
  const filteredRows = React.useMemo<ListRow[]>(() => {
    const pinnedSet = new Set(pinnedSessionIds)
    let base = listRows.map((r) => entryToRow(r, pinnedSet.has(r.id)))
    const isClockView = filter.kind === 'all' && showCronSessions

    const isCron = (r: ListRow) => isScheduledSession(r, cronSessionIds)
    base = base.filter((r) => (isClockView ? isCron(r) : !isCron(r)))

    if (filter.kind === 'pinned') {
      base = base.filter((r) => r.isPinned)
    } else if (filter.kind === 'idea') {
      base = base.filter((r) => r.ideaId === filter.ideaId)
    } else if (filter.kind === 'actor') {
      if (!actorSessionIds) return []
      base = base.filter((r) => actorSessionIds.has(r.id))
    } else if (filter.kind === 'workspace') {
      if (!workspaceSessionIds) return []
      base = base.filter((r) => workspaceSessionIds.has(r.id))
    }

    return base.sort(compareSessionListByRecency)
  }, [listRows, pinnedSessionIds, cronSessionIds, showCronSessions, filter, actorSessionIds, workspaceSessionIds])

  const { pinnedRows, regularRows } = React.useMemo(() => {
    if (filter.kind !== 'all') {
      return { pinnedRows: [] as ListRow[], regularRows: filteredRows }
    }
    return {
      pinnedRows: filteredRows.filter((r) => r.isPinned),
      regularRows: filteredRows.filter((r) => !r.isPinned),
    }
  }, [filteredRows, filter.kind])

  // Flatten the pinned-header / pinned rows / divider / regular rows into a
  // single sequence so the virtualizer can window over one index space. Mirrors
  // exactly what the non-virtual JSX renders below.
  const virtualRows = React.useMemo<VirtualRow[]>(() => {
    const items: VirtualRow[] = []
    if (filter.kind === 'all' && pinnedRows.length > 0) {
      items.push({ key: '__pinned-header', kind: 'pinned-header' })
      for (const row of pinnedRows) items.push({ key: row.id, kind: 'session', row })
      if (regularRows.length > 0) items.push({ key: '__pinned-divider', kind: 'divider' })
    }
    const tail = filter.kind === 'all' ? regularRows : filteredRows
    for (const row of tail) items.push({ key: row.id, kind: 'session', row })
    return items
  }, [filter.kind, pinnedRows, regularRows, filteredRows])

  const shouldVirtualize = virtualRows.length > VIRTUAL_SESSION_THRESHOLD
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const listRootRef = React.useRef<HTMLDivElement>(null)
  const sessionVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
    gap: 2,
    getItemKey: (index) => virtualRows[index].key,
  })

  React.useEffect(() => {
    if (!shouldVirtualize) return
    const frame = requestAnimationFrame(() => {
      sessionVirtualizer.measure()
    })
    const timer = window.setTimeout(() => {
      sessionVirtualizer.measure()
    }, 280)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [actionsOpenSessionId, shouldVirtualize, sessionVirtualizer])

  /** Load participants for any visible row we haven't seen yet. */
  const visibleIds = filteredRows.map((r) => r.id).join('|')
  React.useEffect(() => {
    if (filteredRows.length === 0) return
    void ensureParticipants(filteredRows.map((r) => r.id))
  }, [ensureParticipants, filteredRows, visibleIds])

  const sessionActivityMap = useSessionListActivityMap(activeSessionId)

  const glassLayoutKey = React.useMemo(() => {
    const rowOrder = virtualRows.map((v) => (v.kind === 'session' ? v.row.id : v.key))
    const rowLayoutHints: Array<{ sessionId: string; participantCount: number }> = []
    for (const v of virtualRows) {
      if (v.kind !== 'session') continue
      const participantCount = participantsBySession[v.row.id]?.length ?? 0
      if (participantCount > 0) {
        rowLayoutHints.push({ sessionId: v.row.id, participantCount })
      }
    }
    return buildSessionListGlassLayoutKey({
      activeSessionId,
      actionsOpenSessionId,
      rowOrder,
      rowLayoutHints,
      shouldVirtualize,
    })
  }, [
    activeSessionId,
    actionsOpenSessionId,
    participantsBySession,
    shouldVirtualize,
    virtualRows,
  ])

  const title = (() => {
    if (filter.kind === 'all') {
      return showCronSessions
        ? t('sidebar.scheduledSessions', 'Scheduled sessions')
        : t('sidebar.sessions', 'Sessions')
    }
    if (filter.kind === 'pinned') return t('sidebar.pinned', 'Pinned')
    if (filter.kind === 'idea') return filter.title
    if (filter.kind === 'actor') return filter.displayName
    if (filter.kind === 'workspace') return filter.name
    return ''
  })()

  const handleSelectSession = (id: string) => {
    setActionsOpenSessionId(null)
    void useUIStore.getState().switchToSession(id)
    // Narrow sheet / embed: selecting a session should close the list overlay.
    onDismiss?.()
  }

  const showNewChatButton = embedMode || (showNewSessionActions && !compactHeader)

  const handleNewChatClick = React.useCallback(() => {
    if (embedMode) {
      if (creatingSession) return
      setCreatingSession(true)
      void createQuickSession()
        .then((result) => {
          if (result.ok) {
            onDismiss?.()
            return
          }
          const { title, description } = describeQuickSessionFailure(result.reason, t)
          toast.error(title, {
            description,
            ...(result.reason === 'no_agent'
              ? {
                  action: {
                    label: t('chat.quickSessionSetDefaultAgent', 'Set default agent'),
                    onClick: () => useUIStore.getState().openSettings('daemonGeneral'),
                  },
                }
              : {}),
          })
        })
        .catch((e) => {
          console.error('[SessionListColumn] quick create failed', e)
          const { title, description } = describeQuickSessionFailure('server_error', t)
          toast.error(title, { description })
        })
        .finally(() => setCreatingSession(false))
      return
    }
    useUIStore.getState().startNewChat()
  }, [creatingSession, embedMode, onDismiss, t])

  // Native list type-ahead: with no input focused, typing letters / digits /
  // CJK jumps to the first session whose title starts with the buffer.
  const typeAheadItems = React.useMemo(
    () => filteredRows.map((r) => ({ id: r.id, label: r.title })),
    [filteredRows],
  )
  useTypeAhead({
    enabled: filteredRows.length > 0 && !batchSelecting,
    items: typeAheadItems,
    onMatch: handleSelectSession,
  })

  React.useEffect(() => {
    // Leaving a filter resets multi-select so selection can't leak across views.
    setBatchSelecting(false)
    setBatchSelectedIds(new Set())
    setBatchConfirmOpen(false)
    setActionsOpenSessionId(null)
  }, [
    filter.kind,
    filter.kind === 'idea' ? filter.ideaId : '',
    filter.kind === 'actor' ? filter.actorId : '',
    filter.kind === 'workspace' ? filter.workspaceId : '',
  ])

  const exitBatchSelect = React.useCallback(() => {
    setBatchSelecting(false)
    setBatchSelectedIds(new Set())
    setBatchConfirmOpen(false)
  }, [])

  const enterBatchSelect = React.useCallback(() => {
    setActionsOpenSessionId(null)
    setBatchSelecting(true)
    setBatchSelectedIds(new Set())
    setBatchConfirmOpen(false)
  }, [])

  const toggleBatchSelected = React.useCallback((id: string) => {
    setBatchSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAllVisible = React.useCallback(() => {
    setBatchSelectedIds(new Set(filteredRows.map((r) => r.id)))
  }, [filteredRows])

  const handleBatchArchiveConfirm = React.useCallback(async () => {
    const ids = [...batchSelectedIds]
    if (ids.length === 0 || batchArchiving) return
    setBatchArchiving(true)
    try {
      // Sequential: archiveSession clears active-session state when needed.
      // It swallows backend errors (no throw), so detect failure by whether the
      // row is still present after each call.
      const remaining = new Set(ids)
      let failed = 0
      for (const id of ids) {
        await archiveSession(id)
        const stillPresent = useSessionListStore.getState().rows.some((r) => r.id === id)
        if (stillPresent) {
          failed += 1
        } else {
          remaining.delete(id)
        }
      }
      if (failed === 0) {
        exitBatchSelect()
      } else {
        setBatchSelectedIds(remaining)
        toast.error(
          t('sidebar.batchArchivePartialFail', 'Archived {{ok}}, {{failed}} failed', {
            ok: ids.length - failed,
            failed,
          }),
        )
      }
    } finally {
      setBatchArchiving(false)
      setBatchConfirmOpen(false)
    }
  }, [archiveSession, batchArchiving, batchSelectedIds, exitBatchSelect, t])

  const handleStartRename = (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation()
    setActionsOpenSessionId(null)
    setRenamingSessionId(id)
  }
  const handleRenameConfirm = async (id: string, newTitle: string) => {
    const current = listRows.find((r) => r.id === id)?.title
    if (newTitle.trim() && newTitle !== current) {
      try { await updateSessionTitle(id, newTitle.trim()) }
      catch (e) { console.error('[SessionListColumn] rename failed:', e) }
    }
    setRenamingSessionId(null)
  }
  const handleArchive = async (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation()
    setActionsOpenSessionId(null)
    await archiveSession(id)
  }
  const handleTogglePinned = (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation()
    toggleSessionPinned(id, teamIdFromList || null)
  }
  const handleViewDetail = (e: React.SyntheticEvent, row: ListRow) => {
    e.stopPropagation()
    setActionsOpenSessionId(null)
    setDetailHints({
      title: row.title,
      ideaId: row.ideaId,
      isPinned: row.isPinned,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: row.lastMessagePreview,
    })
    setDetailSessionId(row.id)
  }

  const renderSessionItem = (row: ListRow) => {
    const isHighlighted = highlightedSessionIds.includes(row.id)
    const isRenaming = renamingSessionId === row.id
    const isActive = row.id === activeSessionId
    const isBatchChecked = batchSelectedIds.has(row.id)
    const actionsOpen = actionsOpenSessionId === row.id
    const activity = sessionActivityMap.get(row.id)
    const parts = participantsBySession[row.id] ?? []
    // Hide the participants row for solo sessions — only me and/or my own local
    // agent. Once anyone else joins (a teammate or a remote agent) it shows again.
    const localAgentId = getKnownLocalDaemonActorId()
    const isSoloWithLocalAgent =
      parts.length > 0 &&
      parts.every(
        (p) => p.actorId === currentMemberId || p.actorId === localAgentId,
      )
    const workspaceLabel = sessionWorkspaceLabels.get(row.id)
    const showWorkspaceSubline = filter.kind !== 'workspace' && !!workspaceLabel
    const actionsId = `v2-session-actions-${row.id}`
    const actionBtnClass =
      'grid h-[34px] place-items-center rounded-lg bg-black/[0.045] text-ink-2 transition-colors hover:bg-black/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-white/[0.06] dark:hover:bg-white/10'
    const selectSession = () => {
      if (isRenaming) return
      if (batchSelecting) {
        toggleBatchSelected(row.id)
        return
      }
      handleSelectSession(row.id)
    }
    return (
      <SidebarMenuItem
        key={row.id}
        onMouseLeave={() => {
          setActionsOpenSessionId((prev) => (prev === row.id ? null : prev))
        }}
        onBlur={(e) => {
          const next = e.relatedTarget
          if (next instanceof Node && e.currentTarget.contains(next)) return
          setActionsOpenSessionId((prev) => (prev === row.id ? null : prev))
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !actionsOpen) return
          e.preventDefault()
          e.stopPropagation()
          setActionsOpenSessionId(null)
        }}
      >
        {/* Soft Comfort capsule — whole card selects; ⋯ / dock stopPropagation. */}
        <div
          data-testid="v2-session-row"
          data-session-id={row.id}
          data-active={isActive ? 'true' : 'false'}
          data-batch-checked={isBatchChecked ? 'true' : 'false'}
          className={cn(
            'relative z-[1] my-px w-full rounded-[11px] px-2.5 py-2 transition-[background-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
            !isRenaming && 'cursor-pointer',
            compactHeader && 'px-2',
            // Selection chrome is the shared liquid-glass pill — keep the row transparent when active.
            !isActive && !batchSelecting && 'hover:bg-black/[0.035]',
            isHighlighted && !isActive && !batchSelecting && 'bg-emerald-500/15 ring-1 ring-emerald-500/30',
            batchSelecting && isBatchChecked && 'bg-selected',
          )}
          onClick={selectSession}
          onDoubleClick={(e) => {
            if (batchSelecting || isRenaming) return
            e.stopPropagation()
            handleStartRename(e, row.id)
          }}
        >
          <div className="flex w-full min-w-0 items-start">
            {batchSelecting ? (
              <span
                role="checkbox"
                aria-checked={isBatchChecked}
                data-testid="v2-session-row-checkbox"
                className={cn(
                  'mt-0.5 mr-2 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border-[1.5px]',
                  isBatchChecked
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/20 bg-paper',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleBatchSelected(row.id)
                }}
              >
                {isBatchChecked ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
              </span>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
              {/* Title row: title + meta + sibling more (more stops propagation). */}
              <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden">
                {row.isPinned && <Pin className="h-3 w-3 shrink-0 fill-amber-500/20 text-amber-500" />}
                {isRenaming ? (
                  <div
                    className="min-w-0 flex-1"
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <SessionRenameInput
                      defaultValue={row.title}
                      onConfirm={(v) => handleRenameConfirm(row.id, v)}
                      onCancel={() => setRenamingSessionId(null)}
                    />
                  </div>
                ) : (
                  <>
                    <span
                      className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-foreground"
                      data-testid="v2-session-row-title"
                    >
                      {row.title || t('chat.newChat', 'New Chat')}
                    </span>
                    <div className="flex min-w-0 shrink-0 items-center">
                      {!isActive && row.hasUnread && (
                        <span
                          className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-coral"
                          aria-label={t('sidebar.unread', 'Unread')}
                        />
                      )}
                      {!isActive && isHighlighted && (
                        <span className="mr-1.5 shrink-0 rounded-full bg-coral px-1.5 py-px text-[10px] font-semibold leading-4 text-coral-foreground">
                          {t('chat.newSessionBadge', 'NEW')}
                        </span>
                      )}
                      {activity ? <SessionActivityBadge activity={activity} /> : null}
                      {row.lastMessageAt && (
                        <span className="shrink-0 px-0.5 text-[11px] leading-[22px] tabular-nums text-faint">
                          {formatRelativeTime(row.lastMessageAt)}
                        </span>
                      )}
                      {!batchSelecting && (
                        <button
                          type="button"
                          data-testid="v2-session-row-more"
                          aria-label={actionsOpen
                            ? t('sidebar.closeActions', 'Close actions')
                            : t('sidebar.moreActions', 'More actions')}
                          aria-expanded={actionsOpen}
                          aria-controls={actionsId}
                          title={t('sidebar.moreActions', 'More actions')}
                          className={cn(
                            'inline-grid h-[22px] place-items-center overflow-hidden rounded-md text-muted-foreground',
                            'pointer-events-none w-0 opacity-0',
                            'transition-[width,opacity,margin,background-color,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
                            // Hover reveal. Avoid group-focus-within (row focus would pin ⋯).
                            'group-hover/menu-item:pointer-events-auto group-hover/menu-item:ml-0.5 group-hover/menu-item:w-[22px] group-hover/menu-item:opacity-100',
                            'focus-visible:pointer-events-auto focus-visible:ml-0.5 focus-visible:w-[22px] focus-visible:opacity-100',
                            // Touch / no-hover: keep a hittable ⋯ without relying on hover.
                            '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:ml-0.5 [@media(hover:none)]:w-[22px] [@media(hover:none)]:opacity-100',
                            'hover:bg-black/[0.08] hover:text-foreground dark:hover:bg-white/10',
                            // While dock is open, keep ⋯ visible even after focus moves into the dock.
                            actionsOpen && 'pointer-events-auto ml-0.5 w-[22px] bg-black/[0.08] text-foreground opacity-100 dark:bg-white/10',
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            setActionsOpenSessionId((prev) => {
                              if (prev === row.id) return null
                              requestAnimationFrame(() => {
                                document.getElementById(`v2-session-action-pin-${row.id}`)?.focus()
                              })
                              return row.id
                            })
                          }}
                        >
                          {actionsOpen
                            ? <X className="h-3 w-3" strokeWidth={2} />
                            : <Ellipsis className="h-3 w-3" strokeWidth={2} />}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>

              {!isRenaming && showWorkspaceSubline && (
                <span
                  className="w-full truncate font-mono text-[10.5px] leading-tight text-faint"
                  data-testid="v2-session-row-workspace"
                >
                  {workspaceLabel}
                </span>
              )}
              {!isRenaming && row.lastMessagePreview && (
                <span
                  className={cn(
                    'w-full truncate text-[12px] leading-snug text-muted-foreground transition-opacity duration-150',
                    actionsOpen && 'opacity-50',
                  )}
                  data-testid="v2-session-row-preview"
                >
                  {row.lastMessagePreview.split(/(@[\w.\-\u4e00-\u9fff]+)/g).map((part, i) =>
                    part.startsWith('@') ? (
                      <em key={i} className="font-medium not-italic text-coral">
                        {part}
                      </em>
                    ) : (
                      <React.Fragment key={i}>{part}</React.Fragment>
                    ),
                  )}
                </span>
              )}
              {!isRenaming && parts.length > 0 && !isSoloWithLocalAgent && (
                <div className="flex w-full items-center gap-1.5" data-testid="v2-session-row-participants">
                  <div className="flex -space-x-1.5">
                    {parts.slice(0, 3).map((p) => {
                      const c = actorAvatarColor(p.actorId)
                      return (
                        <Avatar
                          key={p.actorId}
                          className={cn(
                            'h-4 w-4 ring-1 ring-paper',
                            p.isAgent ? 'rounded-[3px]' : 'rounded-full',
                          )}
                        >
                          {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt={p.displayName} />}
                          <AvatarFallback
                            className={cn(
                              'text-[8px] font-semibold',
                              p.isAgent ? 'rounded-[3px]' : 'rounded-full',
                            )}
                            style={{ background: c.bg, color: c.fg }}
                          >
                            {p.displayName.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      )
                    })}
                  </div>
                  <span className="text-[10.5px] text-faint">
                    {t('sidebar.participantCount', { count: parts.length, defaultValue: '{{count}} 位' })}
                  </span>
                </div>
              )}

              {/* C2 dock — stopPropagation so icon clicks don't also select the session. */}
              {!isRenaming && !batchSelecting && (
                <div
                  id={actionsId}
                  role="group"
                  aria-label={t('sidebar.moreActions', 'More actions')}
                  className={cn(
                    'grid w-full transition-[grid-template-rows] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                    actionsOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                  data-testid="v2-session-row-actions"
                  data-open={actionsOpen ? 'true' : 'false'}
                  aria-hidden={!actionsOpen}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div
                      className={cn(
                        'mt-2 border-t border-border-soft pt-2',
                        !actionsOpen && 'pointer-events-none',
                      )}
                    >
                      <div className="grid grid-cols-4 gap-1">
                        <button
                          type="button"
                          id={`v2-session-action-pin-${row.id}`}
                          tabIndex={actionsOpen ? 0 : -1}
                          title={row.isPinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pinToTop', 'Pin to top')}
                          aria-label={row.isPinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pinToTop', 'Pin to top')}
                          className={actionBtnClass}
                          onClick={(e) => handleTogglePinned(e, row.id)}
                        >
                          <Pin className={cn('h-3.5 w-3.5', row.isPinned && 'fill-amber-500/20 text-amber-500')} />
                        </button>
                        <button
                          type="button"
                          tabIndex={actionsOpen ? 0 : -1}
                          title={t('sidebar.rename', 'Rename')}
                          aria-label={t('sidebar.rename', 'Rename')}
                          className={actionBtnClass}
                          onClick={(e) => handleStartRename(e, row.id)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          tabIndex={actionsOpen ? 0 : -1}
                          title={t('sidebar.viewDetail', 'View detail')}
                          aria-label={t('sidebar.viewDetail', 'View detail')}
                          className={actionBtnClass}
                          onClick={(e) => handleViewDetail(e, row)}
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          tabIndex={actionsOpen ? 0 : -1}
                          title={t('sidebar.archive', 'Archive')}
                          aria-label={t('sidebar.archive', 'Archive')}
                          className={cn(actionBtnClass, 'hover:bg-coral-soft hover:text-coral')}
                          onClick={(e) => { void handleArchive(e, row.id) }}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </SidebarMenuItem>
    )
  }

  const renderPinnedHeader = () => (
    <div
      className="px-4 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint"
      data-testid="v2-session-pinned-header"
    >
      {t('sidebar.pinned', 'Pinned')}{' '}
      <span className="font-mono text-faint/80">· {pinnedRows.length}</span>
    </div>
  )

  const renderPinnedDivider = () => (
    <div
      className="mx-4 my-2 border-t border-border-soft"
      data-testid="v2-session-pinned-divider"
      role="separator"
      aria-hidden
    />
  )

  const renderVirtualRow = (v: VirtualRow) => {
    if (v.kind === 'pinned-header') return renderPinnedHeader()
    if (v.kind === 'divider') return renderPinnedDivider()
    return renderSessionItem(v.row)
  }

  return (
    <div
      ref={columnRef}
      className="flex h-full flex-col min-w-0 border-r border-black/[0.06] bg-[#F8F7F4] dark:border-border dark:bg-background"
      data-testid="v2-session-list-column"
    >
      <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <SessionDetailDialog
        sessionId={detailSessionId}
        teamId={teamIdFromList || null}
        hints={detailHints}
        participants={detailSessionId ? participantsBySession[detailSessionId] ?? [] : []}
        activity={detailSessionId ? sessionActivityMap.get(detailSessionId) : undefined}
        activeSessionId={activeSessionId}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSessionId(null)
            setDetailHints(null)
          }
        }}
        onOpenSession={handleSelectSession}
      />

      <div
        className={cn(
          'flex min-w-0 items-center justify-between gap-1 py-3',
          compactHeader ? 'px-2' : 'px-3.5',
        )}
        data-tauri-drag-region
      >
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'flex items-center gap-2 truncate font-bold tracking-tight text-foreground',
              compactHeader ? 'text-[14px]' : 'text-[14px]',
            )}
          >
            <span className="truncate">{title}</span>
            <span
              className="inline-flex h-5 shrink-0 items-center rounded-full bg-black/[0.05] px-2 font-mono text-[11px] font-medium text-muted-foreground dark:bg-white/10"
              data-testid="v2-session-list-count"
            >
              · {filteredRows.length}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!batchSelecting && showNewChatButton ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleNewChatClick}
                disabled={embedMode && creatingSession}
                title={t('chat.newChat', 'New Chat')}
              >
                {embedMode && creatingSession ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SquarePen className="h-4 w-4" />
                )}
              </Button>
              {!embedMode ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => useUIStore.getState().openNewSessionDialog()}
                  title={t('chat.advancedSession', 'Advanced session')}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          ) : null}
          {!batchSelecting ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
              disabled={!sessionHeaderActionsEnabled}
              onClick={() => setSearchOpen(true)}
              title={t('sidebar.searchWithShortcut', 'Search (⌘K)')}
            >
              <Search className="h-4 w-4" />
            </Button>
          ) : null}
          {!batchSelecting && !embedMode && filter.kind === 'all' && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7 transition-colors disabled:opacity-40',
                showCronSessions ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
              )}
              disabled={!sessionHeaderActionsEnabled}
              onClick={() => {
                const nextKind = showCronSessions ? 'regular' : 'cron'
                toggleShowCronSessions()
                void useSessionListStore.getState().loadFirstPage(50, nextKind)
              }}
              title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
            >
              <AnimatedClock className="h-4 w-4" animate={showCronSessions} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-7 w-7 transition-colors disabled:opacity-40',
              batchSelecting
                ? 'bg-selected text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            disabled={!sessionHeaderActionsEnabled || filteredRows.length === 0}
            onClick={() => {
              if (batchSelecting) exitBatchSelect()
              else enterBatchSelect()
            }}
            title={t('sidebar.batchManage', 'Batch manage')}
            aria-label={t('sidebar.batchManage', 'Batch manage')}
            aria-pressed={batchSelecting}
            data-testid="v2-session-batch-toggle"
          >
            <ListChecks className="h-4 w-4" />
          </Button>
          {!batchSelecting && onDismiss ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
              title={t('common.close', 'Close')}
              aria-label={t('common.close', 'Close')}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {batchSelecting ? (
        <div
          className={cn(
            'flex min-w-0 items-center gap-2 border-b border-border-soft bg-panel py-2',
            compactHeader ? 'px-2' : 'px-3',
          )}
          data-testid="v2-session-batch-bar"
        >
          <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-2">
            {t('sidebar.batchSelected', 'Selected')}{' '}
            <span className="font-mono text-[11.5px] font-semibold text-foreground">
              {batchSelectedIds.size}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-[12px] font-semibold text-ink-2"
            onClick={selectAllVisible}
          >
            {t('sidebar.batchSelectAll', 'Select all')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-[12px] font-medium text-muted-foreground"
            onClick={exitBatchSelect}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      ) : null}

      <ScrollArea
        className="session-list-scroll-area min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
        viewportRef={scrollRef}
        viewportClassName="overflow-x-hidden px-2"
      >
        {filter.kind === 'actor' && actorLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : listLoading && filteredRows.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">
              {filter.kind === 'workspace'
                ? t('sidebar.noWorkspaceSessions', 'No sessions in this workspace yet')
                : t('sidebar.noConversations', 'No conversations')}
            </p>
          </div>
        ) : (
          <div ref={listRootRef} className="relative">
            <SessionLiquidGlass
              rootRef={listRootRef}
              scrollRef={scrollRef}
              activeSessionId={activeSessionId}
              disabled={batchSelecting}
              layoutKey={glassLayoutKey}
            />
            {shouldVirtualize ? (
              <div
                style={{ height: `${sessionVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}
                data-testid="v2-session-list-virtual"
              >
                {sessionVirtualizer.getVirtualItems().map((virtualItem) => {
                  const v = virtualRows[virtualItem.index]
                  return (
                    <div
                      key={v.key}
                      ref={(el) => { if (el) sessionVirtualizer.measureElement(el) }}
                      data-index={virtualItem.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      {renderVirtualRow(v)}
                    </div>
                  )
                })}
              </div>
            ) : (
              <SidebarMenu className="gap-0">
                {filter.kind === 'all' && pinnedRows.length > 0 && (
                  <>
                    {renderPinnedHeader()}
                    {pinnedRows.map(renderSessionItem)}
                    {regularRows.length > 0 && renderPinnedDivider()}
                  </>
                )}
                {(filter.kind === 'all' ? regularRows : filteredRows).map(renderSessionItem)}
              </SidebarMenu>
            )}
          </div>
        )}
        {listHasMore && (
          <div className="px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center rounded-md text-[12px] text-muted-foreground hover:text-foreground"
              disabled={listLoading}
              onClick={() => void loadMoreSessions()}
            >
              {listLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : t('sidebar.loadMoreSessions', 'Load more')}
            </Button>
          </div>
        )}
      </ScrollArea>

      {batchSelecting ? (
        <div
          className={cn(
            'flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-paper py-2.5 shadow-[0_-8px_24px_-16px_rgba(20,20,15,0.2)]',
            compactHeader ? 'px-2' : 'px-3',
          )}
          data-testid="v2-session-batch-footer"
        >
          <div className="min-w-0 flex-1 basis-[8rem] truncate text-[12px] text-muted-foreground">
            {t('sidebar.batchArchiveHint', 'Archive {{count}} sessions', {
              count: batchSelectedIds.size,
            })}
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:flex-none">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-[12px] font-medium text-muted-foreground"
              onClick={exitBatchSelect}
              disabled={batchArchiving}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 min-w-[4.5rem] flex-1 bg-foreground text-[12px] font-semibold text-background hover:bg-foreground/90 sm:flex-none"
              disabled={batchSelectedIds.size === 0 || batchArchiving}
              onClick={() => setBatchConfirmOpen(true)}
              data-testid="v2-session-batch-archive"
            >
              {batchArchiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : batchSelectedIds.size > 0
                ? t('sidebar.batchArchiveCount', 'Archive {{count}}', { count: batchSelectedIds.size })
                : t('sidebar.archive', 'Archive')}
            </Button>
          </div>
        </div>
      ) : null}

      <AlertDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}>
        <AlertDialogContent size="sm" className="max-w-[360px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sidebar.batchArchiveConfirmTitle', 'Archive selected sessions?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'sidebar.batchArchiveConfirmBody',
                'Archive {{count}} sessions. You can restore them from Archived later; messages are not deleted.',
                { count: batchSelectedIds.size },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchArchiving}>
              {t('sidebar.batchArchiveThinkAgain', 'Not now')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={batchArchiving || batchSelectedIds.size === 0}
              onClick={(e) => {
                e.preventDefault()
                void handleBatchArchiveConfirm()
              }}
              data-testid="v2-session-batch-archive-confirm"
            >
              {batchArchiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('sidebar.batchArchiveConfirmAction', 'Archive')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
