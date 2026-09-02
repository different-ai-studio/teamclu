import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight, Filter, Lightbulb, Loader2, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useIdeaDetailStore } from '@/stores/idea-detail'
import { formatRelativeTime } from '@/lib/date-format'
import { cn, isTauri } from '@/lib/utils'
import * as localCache from '@/lib/local-cache'
import { syncIdeasForTeam } from '@/lib/sync/idea-sync'

export type IdeaRow = {
  id: string
  title: string
  status: 'open' | 'in_progress' | 'done' | null
  created_by_actor_id: string
  sort_order: number
  updated_at: string
}

type IdeaCreatorMap = Map<string, string>

interface UseIdeasForTeamResult {
  ideas: IdeaRow[]
  creators: IdeaCreatorMap
  loading: boolean
  error: boolean
  teamId: string | null
  refetch: () => void
}

function useIdeasForTeam(): UseIdeasForTeamResult {
  const currentTeamId = useCurrentTeamStore(s => s.team?.id ?? null)
  const [teamId, setTeamId] = React.useState<string | null>(null)
  const [ideas, setIdeas] = React.useState<IdeaRow[]>([])
  const [creators, setCreators] = React.useState<IdeaCreatorMap>(new Map())
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [refreshTick, setRefreshTick] = React.useState(0)

  React.useEffect(() => {
    if (teamId) return
    if (currentTeamId) {
      setTeamId(currentTeamId)
      return
    }
    let cancelled = false
    void (async () => {
      const backend = getBackend()
      const session = await backend.auth.getSession()
      const userId = session?.user.id
      if (!userId) return
      const actorRow = await backend.directory.resolveFirstMemberActorForUser(userId)
      if (cancelled) return
      if (actorRow?.team_id) setTeamId(actorRow.team_id)
    })()
    return () => { cancelled = true }
  }, [currentTeamId, teamId])

  React.useEffect(() => {
    if (!teamId) return
    let cancelled = false
    setLoading(true)
    setError(false)
    void (async () => {
      if (isTauri()) {
        const cached = await localCache.loadIdeasForTeam(teamId)
        if (cancelled) return
        const rows = cached
          .filter(r => r.archived === 0 && !r.deletedAt)
          .sort((a, b) => {
            const bySortOrder = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
            if (bySortOrder !== 0) return bySortOrder
            return b.updatedAt.localeCompare(a.updatedAt)
          })
          .map(r => ({
            id: r.id,
            title: r.title,
            status: r.status as IdeaRow['status'],
            created_by_actor_id: r.createdBy ?? '',
            sort_order: r.sortOrder ?? 0,
            updated_at: r.updatedAt,
          }))
        setIdeas(rows)
        const creatorIds = Array.from(new Set(rows.map(r => r.created_by_actor_id).filter(Boolean)))
        if (creatorIds.length > 0) {
          const actors = await localCache.loadActorsByIds(creatorIds)
          if (cancelled) return
          const map = new Map<string, string>()
          for (const a of actors) map.set(a.id, a.displayName)
          setCreators(map)
        } else {
          setCreators(new Map())
        }
        setLoading(false)
      } else {
        try {
          const backend = getBackend()
          const rows = (await backend.ideas.listIdeas(teamId)).map((row) => ({
            id: row.id,
            title: row.title,
            status: (row.status as IdeaRow['status']) ?? null,
            created_by_actor_id: row.created_by_actor_id ?? '',
            sort_order: row.sort_order ?? 0,
            updated_at: row.updated_at ?? '',
          }))
          if (cancelled) return
          setIdeas(rows)
          const creatorIds = Array.from(new Set(rows.map(r => r.created_by_actor_id).filter(Boolean)))
          if (creatorIds.length > 0) {
            const actorRows = await backend.actors.listActorDirectory(teamId)
            if (cancelled) return
            const map = new Map<string, string>()
            for (const r of actorRows) {
              if (creatorIds.includes(r.id) && r.display_name) map.set(r.id, r.display_name)
            }
            setCreators(map)
          } else {
            setCreators(new Map())
          }
          setLoading(false)
        } catch (e) {
          if (cancelled) return
          console.warn('[IdeasView] failed to load ideas', e)
          setError(true)
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [teamId, refreshTick])

  const refetch = React.useCallback(() => {
    if (isTauri() && teamId) {
      void syncIdeasForTeam(teamId).then(() => setRefreshTick(n => n + 1))
    } else {
      setRefreshTick(n => n + 1)
    }
  }, [teamId])

  return { ideas, creators, loading, error, teamId, refetch }
}

function StatusBadge({ status }: { status: IdeaRow['status'] }) {
  if (!status) return null
  const styles =
    status === 'in_progress' ? 'bg-coral'
    : status === 'done' ? 'bg-emerald-500'
    : 'bg-faint'
  const label =
    status === 'in_progress' ? 'In progress'
    : status === 'done' ? 'Done'
    : 'Open'
  return <span className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', styles)} aria-label={label} />
}

type IdeaStatusFilter = 'all' | 'in_progress' | 'open' | 'done'

const IDEAS_PAGE_SIZE = 20

type DragOverlay = {
  left: number
  top: number
  width: number
}

function reorderIdeaRows(rows: IdeaRow[], activeId: string, overId: string): IdeaRow[] {
  if (activeId === overId) return rows
  const activeIndex = rows.findIndex((row) => row.id === activeId)
  const overIndex = rows.findIndex((row) => row.id === overId)
  if (activeIndex < 0 || overIndex < 0) return rows
  const next = [...rows]
  const [active] = next.splice(activeIndex, 1)
  next.splice(overIndex, 0, active)
  return next.map((row, index) => ({ ...row, sort_order: (index + 1) * 1000 }))
}

function IdeaRowView({
  canReorder,
  creatorName,
  dragging,
  dragOverlay,
  dragOffsetY,
  idea,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
  onPointerUp,
  onView,
  selected,
}: {
  canReorder: boolean
  creatorName: string | undefined
  dragging: boolean
  dragOverlay: DragOverlay | null
  dragOffsetY: number
  idea: IdeaRow
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>, ideaId: string) => void
  onPointerEnter: (ideaId: string) => void
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void
  onPointerUp: () => void
  onView: (idea: IdeaRow) => void
  selected: boolean
}) {
  const relative = formatRelativeTime(new Date(idea.updated_at))
  return (
    <button
      type="button"
      aria-label={`Drag idea ${idea.title}`}
      data-idea-id={idea.id}
      onPointerDown={(event) => onPointerDown(event, idea.id)}
      onPointerEnter={() => onPointerEnter(idea.id)}
      onPointerMove={onPointerMove}
      onPointerCancel={onPointerUp}
      onPointerUp={onPointerUp}
      onClick={() => onView(idea)}
      style={dragging && dragOverlay
        ? {
            left: dragOverlay.left,
            position: 'fixed',
            top: dragOverlay.top + dragOffsetY,
            transform: 'scale(1.015)',
            width: dragOverlay.width,
          }
        : undefined}
      className={cn(
        'relative flex w-full items-start gap-2.5 border-b border-border-soft px-4 py-2.5 text-left transition-[background-color,box-shadow,transform] duration-150 hover:bg-selected focus:outline-none focus-visible:bg-selected',
        selected && 'bg-selected',
        canReorder && 'touch-none select-none cursor-grab active:cursor-grabbing',
        dragging && 'z-50 pointer-events-none bg-paper shadow-[0_18px_34px_-24px_rgba(26,26,20,0.5)] ring-1 ring-border transition-none',
      )}
    >
      <StatusBadge status={idea.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-[19px] text-foreground">{idea.title}</div>
        <div className="mt-0.5 truncate text-[11.5px] leading-[18px] text-muted-foreground">
          {creatorName ? `${creatorName} · ${relative}` : relative}
        </div>
      </div>
      <span className="ml-2 shrink-0 pt-[1px] font-mono text-[11.5px] leading-[19px] text-faint">{relative}</span>
    </button>
  )
}

function FilterRow({
  active,
  count,
  dotClassName,
  label,
  onSelect,
}: {
  active: boolean
  count: number
  dotClassName?: string
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-left text-[12.5px] font-semibold text-foreground',
        active && 'bg-coral-soft/35',
      )}
    >
      {dotClassName ? <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClassName)} /> : <span className="w-2" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[11.5px] font-normal text-faint">{count}</span>
      {active && <Check className="h-3.5 w-3.5 text-coral" />}
    </button>
  )
}

export function IdeasView() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const { ideas, creators, loading, error, teamId, refetch } = useIdeasForTeam()
  const [orderedIdeas, setOrderedIdeas] = React.useState<IdeaRow[]>([])
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [filter, setFilter] = React.useState<IdeaStatusFilter>('all')
  const [page, setPage] = React.useState(0)
  const openCreate = useIdeaDetailStore((s) => s.openCreate)
  const openEdit = useIdeaDetailStore((s) => s.openEdit)
  const selectedIdeaId = useIdeaDetailStore((s) =>
    s.target?.kind === 'edit' ? s.target.idea.id : null,
  )
  const mutationTick = useIdeaDetailStore((s) => s.mutationTick)
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverlay, setDragOverlay] = React.useState<DragOverlay | null>(null)
  const [dragOffsetY, setDragOffsetY] = React.useState(0)
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragStartOrderRef = React.useRef<string[]>([])
  const dragStartYRef = React.useRef(0)
  const latestDraggingIdRef = React.useRef<string | null>(null)
  const suppressNextClickRef = React.useRef(false)

  React.useEffect(() => {
    setOrderedIdeas(ideas)
  }, [ideas])

  React.useEffect(() => {
    latestDraggingIdRef.current = draggingId
  }, [draggingId])

  // The detail pane lives in the main content column; when it creates or edits
  // an idea it bumps this tick so the list refetches.
  const lastMutationTickRef = React.useRef(mutationTick)
  React.useEffect(() => {
    if (mutationTick === lastMutationTickRef.current) return
    lastMutationTickRef.current = mutationTick
    refetch()
  }, [mutationTick, refetch])

  const counts = React.useMemo(() => ({
    all: orderedIdeas.length,
    in_progress: orderedIdeas.filter((idea) => idea.status === 'in_progress').length,
    open: orderedIdeas.filter((idea) => idea.status === 'open' || !idea.status).length,
    done: orderedIdeas.filter((idea) => idea.status === 'done').length,
  }), [orderedIdeas])

  const visibleIdeas = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return orderedIdeas.filter((idea) => {
      if (filter !== 'all') {
        if (filter === 'open' && idea.status && idea.status !== 'open') return false
        if (filter !== 'open' && idea.status !== filter) return false
      }
      if (!normalizedQuery) return true
      const creator = creators.get(idea.created_by_actor_id) ?? ''
      return `${idea.title} ${creator}`.toLowerCase().includes(normalizedQuery)
    })
  }, [creators, filter, orderedIdeas, query])

  // Reset to the first page whenever the visible set changes shape.
  React.useEffect(() => {
    setPage(0)
  }, [filter, query])

  const pageCount = Math.max(1, Math.ceil(visibleIdeas.length / IDEAS_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedIdeas = React.useMemo(
    () => visibleIdeas.slice(currentPage * IDEAS_PAGE_SIZE, (currentPage + 1) * IDEAS_PAGE_SIZE),
    [currentPage, visibleIdeas],
  )

  const canReorder = filter === 'all' && query.trim().length === 0

  const persistIdeaOrder = React.useCallback(async (rows: IdeaRow[]) => {
    const backend = getBackend()
    await Promise.all(rows.map((idea) => (
      backend.ideas.updateIdea({ ideaId: idea.id, sortOrder: idea.sort_order })
    )))
  }, [])

  const clearLongPressTimer = React.useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const handleDragStart = React.useCallback((event: React.PointerEvent<HTMLButtonElement>, ideaId: string) => {
    if (!canReorder) return
    clearLongPressTimer()
    const row = event.currentTarget
    const rect = row.getBoundingClientRect()
    dragStartYRef.current = event.clientY
    setDragOffsetY(0)
    dragStartOrderRef.current = orderedIdeas.map((idea) => idea.id)
    longPressTimerRef.current = setTimeout(() => {
      setDragOverlay({ left: rect.left, top: rect.top, width: rect.width })
      setDraggingId(ideaId)
      suppressNextClickRef.current = true
    }, 300)
  }, [canReorder, clearLongPressTimer, orderedIdeas])

  const reorderFromPoint = React.useCallback((clientX: number, clientY: number) => {
    const activeId = latestDraggingIdRef.current
    if (!activeId || !canReorder) return
    const hitElements = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)].filter(Boolean) as Element[]
    const hitRow = hitElements
      .map((element) => element.closest<HTMLElement>('[data-idea-id]'))
      .find((element): element is HTMLElement => Boolean(element && element.dataset.ideaId !== activeId))
    const overId = hitRow?.dataset.ideaId
    if (!overId) return
    setOrderedIdeas((current) => reorderIdeaRows(current, activeId, overId))
  }, [canReorder])

  const handleDragMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!draggingId || !canReorder) return
    setDragOffsetY(event.clientY - dragStartYRef.current)
    reorderFromPoint(event.clientX, event.clientY)
  }, [canReorder, draggingId, reorderFromPoint])

  const handleDragEnter = React.useCallback((ideaId: string) => {
    if (!draggingId || !canReorder) return
    setOrderedIdeas((current) => reorderIdeaRows(current, draggingId, ideaId))
  }, [canReorder, draggingId])

  const finishDrag = React.useCallback(() => {
    clearLongPressTimer()
    const activeId = latestDraggingIdRef.current
    if (!activeId) return
    latestDraggingIdRef.current = null
    setDraggingId(null)
    setDragOverlay(null)
    setDragOffsetY(0)
    setOrderedIdeas((current) => {
      const before = dragStartOrderRef.current.join('|')
      const after = current.map((idea) => idea.id).join('|')
      if (before !== after) {
        void persistIdeaOrder(current).catch((e) => {
          console.warn('[IdeasView] failed to persist idea order', e)
          refetch()
        })
      }
      return current
    })
  }, [clearLongPressTimer, persistIdeaOrder, refetch])

  const handleViewIdea = React.useCallback((idea: IdeaRow) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    openEdit(idea)
  }, [openEdit])

  React.useEffect(() => {
    if (!draggingId || !canReorder) return
    const handleWindowMove = (event: PointerEvent) => {
      setDragOffsetY(event.clientY - dragStartYRef.current)
      reorderFromPoint(event.clientX, event.clientY)
    }
    window.addEventListener('pointermove', handleWindowMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', handleWindowMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [canReorder, draggingId, finishDrag, reorderFromPoint])

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mb-2 h-5 w-5 animate-spin" />
          <span>{t('ideas.loading', 'Loading ideas...')}</span>
        </div>
      )
    }

    if (error) {
      return <div className="px-4 py-3 text-sm text-destructive">{t('ideas.error', 'Failed to load ideas')}</div>
    }

    if (orderedIdeas.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
          <Lightbulb className="mb-2 h-8 w-8 text-muted-foreground" />
          <span>{t('ideas.empty', 'No ideas yet')}</span>
        </div>
      )
    }

    if (visibleIdeas.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('ideas.noMatches', 'No matching ideas')}
        </div>
      )
    }

    return (
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {pagedIdeas.map(idea => (
          <IdeaRowView
            key={idea.id}
            canReorder={canReorder}
            dragging={draggingId === idea.id}
            dragOverlay={dragOverlay}
            dragOffsetY={draggingId === idea.id ? dragOffsetY : 0}
            idea={idea}
            creatorName={creators.get(idea.created_by_actor_id)}
            onPointerDown={handleDragStart}
            onPointerEnter={handleDragEnter}
            onPointerMove={handleDragMove}
            onPointerUp={finishDrag}
            onView={handleViewIdea}
            selected={selectedIdeaId === idea.id}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="border-b border-border px-4 py-3" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          {sidebarCollapsed && (
            <div className="flex items-center gap-1 shrink-0">
              <TrafficLights />
              <SidebarCollapseToggle />
            </div>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-7 text-foreground">
            {t('ideas.allTitle', 'Ideas')}
            <span className="ml-2 font-mono text-[12.5px] font-normal text-faint">· {visibleIdeas.length}</span>
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground', searchOpen && 'bg-selected text-foreground')}
            aria-label={t('common.search', 'Search')}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
                aria-label={t('ideas.filterStatus', 'Filter by status')}
              >
                <Filter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[260px] rounded-[14px] border-border bg-paper p-2 shadow-[0_18px_45px_-28px_rgba(26,26,20,0.45)]">
              <div className="px-3 pb-1 pt-1 text-[11.5px] font-semibold text-faint">{t('ideas.statusFilterLabel', 'Status')}</div>
              <FilterRow active={filter === 'all'} count={counts.all} label={t('common.all', 'All')} onSelect={() => setFilter('all')} />
              <FilterRow active={filter === 'in_progress'} count={counts.in_progress} dotClassName="bg-coral" label={t('ideas.status.inProgress', 'In progress')} onSelect={() => setFilter('in_progress')} />
              <FilterRow active={filter === 'open'} count={counts.open} dotClassName="bg-faint" label={t('ideas.status.open', 'Open')} onSelect={() => setFilter('open')} />
              <FilterRow active={filter === 'done'} count={counts.done} dotClassName="bg-emerald-500" label={t('ideas.status.done', 'Done')} onSelect={() => setFilter('done')} />
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
            aria-label={t('ideas.create', 'Create idea')}
            disabled={!teamId}
            onClick={() => { if (teamId) openCreate(teamId) }}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {searchOpen && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('ideas.searchPlaceholder', 'Search ideas')}
            className="mt-2 h-8 w-full rounded-[8px] border border-border bg-paper px-3 text-[12.5px] outline-none placeholder:text-faint focus:border-border"
          />
        )}
      </div>
      {renderBody()}
      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
            aria-label={t('common.previous', 'Previous')}
            disabled={currentPage === 0}
            onClick={() => setPage(Math.max(0, currentPage - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-[11.5px] text-faint">
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
            aria-label={t('common.next', 'Next')}
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
