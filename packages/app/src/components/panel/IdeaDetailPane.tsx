import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Archive, ArrowUp, Check, Lightbulb, Loader2, MoreHorizontal, Plus, RotateCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatRelativeTime } from '@/lib/ui/date-format'
import {
  createIdeaActivity,
  recordIdeaStatusChange,
  updateIdea,
  type IdeaStatus,
} from '@/lib/team/idea-mutations'
import { useIdeaDetailStore, type IdeaDetailTarget } from '@/stores/idea-detail'
import { useCurrentTeamStore } from '@/stores/current-team'
import type { IdeaRow } from '@/components/panel/IdeasView'
import {
  AutosizeTextarea,
  IDEA_STATUSES,
  IdeaActorDisc,
  archiveIdeaWithUndo,
  ideaStatusDotClass,
  ideaStatusLabel,
  normalizeIdeaStatus,
} from '@/components/panel/idea-ui'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'

type IdeaDetail = IdeaRow & {
  description: string | null
  workspace_id: string | null
  team_id: string
  created_at: string
}

type IdeaActivity = {
  id: string
  actor_id: string
  activity_type: 'progress' | 'status_change' | 'reorder' | string
  content: string | null
  metadata?: Record<string, unknown> | null
  created_at: string
}

type ActorSummary = {
  id: string
  display_name: string | null
  actor_type?: string | null
}

/** What autosave last wrote, in the normalized shape `update_idea` stores. */
type SavedSnapshot = {
  title: string
  description: string | null
  status: IdeaStatus
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** Long enough to skip a save per keystroke, short enough that a pause feels saved. */
const AUTOSAVE_DELAY_MS = 800

const TITLE_CLASS =
  'min-h-0 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-[24px] font-bold leading-[1.3] text-foreground shadow-none outline-none placeholder:text-faint focus-visible:ring-0 md:text-[24px] dark:bg-transparent'

const DESCRIPTION_CLASS =
  'resize-none rounded-none border-0 bg-transparent px-0 py-0 text-[15px] leading-7 text-ink-2 shadow-none outline-none placeholder:text-faint focus-visible:ring-0 md:text-[15px] dark:bg-transparent'

/** Enter confirms an IME composition before it is ours to act on. */
function isPlainEnter(event: React.KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
}

function PaneHeader({
  eyebrow,
  children,
  actions,
}: {
  eyebrow: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Lightbulb className="h-[17px] w-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{eyebrow}</div>
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}

function IdeaCreatePane({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const openEdit = useIdeaDetailStore((s) => s.openEdit)
  const clearDetail = useIdeaDetailStore((s) => s.clearDetail)
  const notifyMutated = useIdeaDetailStore((s) => s.notifyMutated)
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const descriptionRef = React.useRef<HTMLTextAreaElement | null>(null)

  const trimmed = title.trim()
  const canSubmit = !!trimmed && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const row = await getBackend().ideas.createIdea({
        teamId,
        title: trimmed,
        workspaceId: null,
        body: description.trim() || null,
      })
      notifyMutated()
      // Stay on the fresh idea so the discussion can start right away.
      openEdit({
        id: row.id,
        title: row.title,
        status: (row.status as IdeaRow['status']) ?? null,
        created_by_actor_id: row.created_by_actor_id ?? '',
        sort_order: row.sort_order ?? 0,
        updated_at: row.updated_at ?? new Date().toISOString(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.createFailed', 'Failed to create idea: {{msg}}', { msg }))
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent, field: 'title' | 'description') => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      clearDetail()
      return
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      void submit()
    } else if (field === 'title' && !event.shiftKey) {
      // A title is one line: Enter moves on to the body instead of breaking it.
      event.preventDefault()
      descriptionRef.current?.focus()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        eyebrow={t('ideas.detail.eyebrow', 'Idea')}
        actions={
          <>
            <span className="mr-1 hidden font-mono text-[11px] text-faint sm:inline">⌘↵</span>
            <Button
              type="button"
              variant="outline"
              onClick={clearDetail}
              disabled={submitting}
              className="h-8 gap-1.5 text-[13px]"
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t('ideas.createButton', 'Create')}
            </Button>
          </>
        }
      >
        <div className="truncate text-[15px] font-bold text-foreground">{t('ideas.newIdea', 'New idea')}</div>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <section className="mx-auto w-full max-w-[760px]">
          <AutosizeTextarea
            autoFocus
            rows={1}
            value={title}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => handleKeyDown(e, 'title')}
            placeholder={t('ideas.titlePlaceholder', 'Idea title')}
            disabled={submitting}
            className={TITLE_CLASS}
          />
          <AutosizeTextarea
            ref={descriptionRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, 'description')}
            placeholder={t('ideas.descriptionPlaceholder', "What's the constraint, what's the win?")}
            disabled={submitting}
            rows={8}
            className={cn(DESCRIPTION_CLASS, 'mt-4 min-h-[220px]')}
          />
          <p className="mt-4 text-[12px] leading-5 text-faint">
            {t('ideas.newIdeaDescription', 'Capture an idea, problem, or proposal for the team.')}
          </p>
        </section>
      </div>
    </div>
  )
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const { t } = useTranslation()
  if (state === 'idle') return null
  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="mr-1 inline-flex items-center gap-1 rounded-[7px] px-1.5 py-1 text-[11.5px] text-destructive hover:bg-selected"
      >
        <RotateCw className="h-3 w-3" />
        {t('ideas.detail.saveRetry', 'Not saved · retry')}
      </button>
    )
  }
  return (
    <span className="mr-1 inline-flex items-center gap-1 text-[11.5px] text-faint" aria-live="polite">
      {state === 'saving' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      {state === 'saving' ? t('ideas.detail.saving', 'Saving…') : t('ideas.detail.saved', 'Saved')}
    </span>
  )
}

function StatusOption({ status }: { status: IdeaStatus }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', ideaStatusDotClass(status))} />
      {ideaStatusLabel(t, status)}
    </span>
  )
}

/** A comment: who, when, and what they said. */
function CommentItem({ activity, actor }: { activity: IdeaActivity; actor: ActorSummary | undefined }) {
  const { t } = useTranslation()
  const name = actor?.display_name ?? t('ideas.detail.unknownActor', 'Unknown')
  return (
    <li className="flex gap-2.5 py-2.5">
      <IdeaActorDisc
        actorId={activity.actor_id}
        name={actor?.display_name}
        isAgent={actor?.actor_type === 'agent'}
        size={24}
        className="mt-px"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-foreground">{name}</span>
          <span className="shrink-0 font-mono text-[11px] text-faint">
            {formatRelativeTime(new Date(activity.created_at))}
          </span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] leading-[1.7] text-ink-2">
          {activity.content || activity.activity_type}
        </p>
      </div>
    </li>
  )
}

/** Status changes and reorders are the thread's margin notes, not turns in it. */
function EventItem({ activity, actor }: { activity: IdeaActivity; actor: ActorSummary | undefined }) {
  const { t } = useTranslation()
  const name = actor?.display_name ?? t('ideas.detail.unknownActor', 'Unknown')
  const toStatus = typeof activity.metadata?.to_status === 'string' ? activity.metadata.to_status : null
  const text =
    activity.activity_type === 'reorder'
      ? t('ideas.detail.eventReordered', '{{actor}} reordered this idea', { actor: name })
      : toStatus
        ? t('ideas.detail.eventStatusChanged', '{{actor}} set status to {{status}}', {
          actor: name,
          status: ideaStatusLabel(t, toStatus),
        })
        : `${name} · ${activity.content || activity.activity_type}`
  return (
    <li className="flex items-center gap-2.5 py-1.5 text-[12px] text-muted-foreground">
      <span className="flex w-6 shrink-0 justify-center">
        <span className={cn('h-1.5 w-1.5 rounded-full', toStatus ? ideaStatusDotClass(toStatus) : 'bg-faint')} />
      </span>
      <span className="min-w-0 truncate">{text}</span>
      <span className="shrink-0 font-mono text-[11px] text-faint">
        {formatRelativeTime(new Date(activity.created_at))}
      </span>
    </li>
  )
}

function IdeaEditPane({ idea }: { idea: IdeaRow }) {
  const { t } = useTranslation()
  const notifyMutated = useIdeaDetailStore((s) => s.notifyMutated)
  const patchOpenIdea = useIdeaDetailStore((s) => s.patchOpenIdea)
  const [detail, setDetail] = React.useState<IdeaDetail | null>(null)
  const [activities, setActivities] = React.useState<IdeaActivity[]>([])
  const [actors, setActors] = React.useState<Map<string, ActorSummary>>(new Map())
  const [title, setTitle] = React.useState(idea.title)
  const [description, setDescription] = React.useState('')
  const [status, setStatus] = React.useState<IdeaStatus>(normalizeIdeaStatus(idea.status))
  const [commentText, setCommentText] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saveState, setSaveState] = React.useState<SaveState>('idle')
  // The header's "updated" follows this pane's own saves, not just the row it opened with.
  const [updatedAt, setUpdatedAt] = React.useState(idea.updated_at)
  const [submittingComment, setSubmittingComment] = React.useState(false)

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const descriptionRef = React.useRef<HTMLTextAreaElement | null>(null)
  const mountedRef = React.useRef(true)
  const savedRef = React.useRef<SavedSnapshot | null>(null)
  const draftRef = React.useRef({ title: idea.title, description: '', status: normalizeIdeaStatus(idea.status) })
  const workspaceIdRef = React.useRef<string | null>(null)
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = React.useRef(false)
  const saveQueuedRef = React.useRef(false)
  const saveFailedRef = React.useRef(false)
  const scrollToEndRef = React.useRef(false)

  const applyThread = React.useCallback((data: { activities?: unknown; actors?: unknown }) => {
    const rows = [...((data.activities ?? []) as IdeaActivity[])]
    // The API serves newest first; a thread reads oldest first, ending at the composer.
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at))
    setActivities(rows)
    setActors(new Map(((data.actors ?? []) as ActorSummary[]).map((actor) => [actor.id, actor])))
  }, [])

  const loadDetail = React.useCallback(async () => {
    setLoading(true)
    try {
      const ideaData = await getBackend().ideas.getIdeaDetail(idea.id)
      if (!ideaData) throw new Error('idea not found')
      if (!mountedRef.current) return
      if (savedRef.current) {
        // A re-run (e.g. a language switch re-creating `t`) must not reset text being edited.
        applyThread(ideaData)
        return
      }

      const nextDetail = ideaData as IdeaDetail
      const nextStatus = normalizeIdeaStatus(nextDetail.status)
      setDetail(nextDetail)
      if (nextDetail.updated_at) setUpdatedAt(nextDetail.updated_at)
      setTitle(nextDetail.title)
      setDescription(nextDetail.description ?? '')
      setStatus(nextStatus)
      draftRef.current = { title: nextDetail.title, description: nextDetail.description ?? '', status: nextStatus }
      savedRef.current = {
        title: nextDetail.title.trim(),
        description: (nextDetail.description ?? '').trim() || null,
        status: nextStatus,
      }
      workspaceIdRef.current = nextDetail.workspace_id ?? null
      applyThread(ideaData)
    } catch (e) {
      if (!mountedRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.detail.loadFailed', 'Failed to load idea: {{msg}}', { msg }))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [applyThread, idea.id, t])

  // The text fields are the user's while this pane is open; a refresh only
  // brings in what other people added to the thread.
  const reloadThread = React.useCallback(async () => {
    const ideaData = await getBackend().ideas.getIdeaDetail(idea.id)
    if (ideaData && mountedRef.current) applyThread(ideaData)
  }, [applyThread, idea.id])

  React.useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const persist = React.useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const saved = savedRef.current
    if (!saved) return
    if (savingRef.current) {
      saveQueuedRef.current = true
      return
    }
    const draft = draftRef.current
    const next: SavedSnapshot = {
      // `update_idea` rejects an empty title: hold the last saved one until there is text again.
      title: draft.title.trim() || saved.title,
      description: draft.description.trim() || null,
      status: draft.status,
    }
    if (next.title === saved.title && next.description === saved.description && next.status === saved.status) return

    savingRef.current = true
    if (mountedRef.current) setSaveState('saving')
    try {
      await updateIdea(idea.id, { ...next, workspaceId: workspaceIdRef.current })
      savedRef.current = next
      saveFailedRef.current = false
      patchOpenIdea(idea.id, { title: next.title, status: next.status })
      notifyMutated()
      if (mountedRef.current) {
        setSaveState('saved')
        setUpdatedAt(new Date().toISOString())
      }
      if (next.status !== saved.status) {
        try {
          await recordIdeaStatusChange(idea.id, saved.status, next.status)
          await reloadThread()
        } catch (e) {
          console.warn('[IdeaDetailPane] failed to record status change', e)
        }
      }
    } catch (e) {
      if (mountedRef.current) setSaveState('error')
      // One toast per outage, not one per keystroke pause.
      if (!saveFailedRef.current) {
        saveFailedRef.current = true
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(t('ideas.detail.saveFailed', 'Save failed: {{msg}}', { msg }))
      }
    } finally {
      savingRef.current = false
      if (saveQueuedRef.current) {
        saveQueuedRef.current = false
        void persist()
      }
    }
  }, [idea.id, notifyMutated, patchOpenIdea, reloadThread, t])

  const scheduleSave = React.useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => void persist(), AUTOSAVE_DELAY_MS)
  }, [persist])

  // Leaving the idea (another row, another section) must not drop the last edit.
  const persistRef = React.useRef(persist)
  React.useEffect(() => {
    persistRef.current = persist
  }, [persist])
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void persistRef.current()
    }
  }, [])

  // A status set from the list's context menu is already persisted: adopt it,
  // so the next autosave does not write this pane's older value back over it.
  const rowStatus = normalizeIdeaStatus(idea.status)
  React.useEffect(() => {
    const saved = savedRef.current
    if (!saved || saved.status === rowStatus) return
    savedRef.current = { ...saved, status: rowStatus }
    draftRef.current.status = rowStatus
    setStatus(rowStatus)
    void reloadThread()
  }, [rowStatus, reloadThread])

  const handleStatusChange = (value: string) => {
    const next = normalizeIdeaStatus(value)
    setStatus(next)
    draftRef.current.status = next
    void persist()
  }

  const comments = React.useMemo(
    () => activities.filter((a) => a.activity_type !== 'status_change' && a.activity_type !== 'reorder'),
    [activities],
  )
  const canSubmitComment = !!detail && !!commentText.trim() && !submittingComment
  const creator = detail ? actors.get(detail.created_by_actor_id) : null

  const submitComment = async () => {
    if (!detail || !canSubmitComment) return
    setSubmittingComment(true)
    try {
      await createIdeaActivity(detail.id, {
        activityType: 'progress',
        content: commentText.trim(),
      })
      setCommentText('')
      notifyMutated()
      scrollToEndRef.current = true
      await reloadThread()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.detail.activityFailed', 'Activity failed: {{msg}}', { msg }))
    } finally {
      if (mountedRef.current) setSubmittingComment(false)
    }
  }

  React.useEffect(() => {
    if (!scrollToEndRef.current) return
    scrollToEndRef.current = false
    const el = scrollRef.current
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [activities])

  const when = formatRelativeTime(new Date(updatedAt))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        eyebrow={t('ideas.detail.eyebrow', 'Idea')}
        actions={
          <>
            <SaveIndicator state={saveState} onRetry={() => void persist()} />
            <Select value={status} onValueChange={handleStatusChange} disabled={!detail}>
              <SelectTrigger
                aria-label={t('ideas.statusFilterLabel', 'Status')}
                className="h-8 w-auto gap-2 rounded-[8px] border-border bg-paper px-2.5 text-[12.5px] font-medium shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {IDEA_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    <StatusOption status={value} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-8 w-8 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
                  aria-label={t('ideas.detail.more', 'More actions')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[150px]">
                <DropdownMenuItem onSelect={() => void archiveIdeaWithUndo(t, idea.id)}>
                  <Archive className="h-3.5 w-3.5" />
                  {t('ideas.archive', 'Archive')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-[22px] text-ink-2">
          {creator?.display_name && (
            <IdeaActorDisc
              actorId={creator.id}
              name={creator.display_name}
              isAgent={creator.actor_type === 'agent'}
              size={16}
            />
          )}
          <span className="truncate">
            {creator?.display_name
              ? t('ideas.detail.summaryWithCreator', '{{creator}} · {{count}} comments · updated {{when}}', {
                creator: creator.display_name,
                count: comments.length,
                when,
              })
              : t('ideas.detail.summary', '{{count}} comments · updated {{when}}', {
                count: comments.length,
                when,
              })}
          </span>
        </div>
      </PaneHeader>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-[760px]">
          {loading && !detail ? (
            <div className="flex h-44 items-center justify-center text-[12px] text-faint">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('ideas.loading', 'Loading ideas...')}
            </div>
          ) : (
            <section>
              <AutosizeTextarea
                rows={1}
                value={title}
                disabled={!detail}
                onChange={(e) => {
                  const value = e.target.value.replace(/\n/g, ' ')
                  setTitle(value)
                  draftRef.current.title = value
                  scheduleSave()
                }}
                onBlur={() => void persist()}
                onKeyDown={(e) => {
                  if (!isPlainEnter(e)) return
                  // A title is one line: Enter moves on to the body instead of breaking it.
                  e.preventDefault()
                  descriptionRef.current?.focus()
                }}
                className={TITLE_CLASS}
                placeholder={t('ideas.titlePlaceholder', 'Idea title')}
              />
              <AutosizeTextarea
                ref={descriptionRef}
                value={description}
                disabled={!detail}
                onChange={(e) => {
                  setDescription(e.target.value)
                  draftRef.current.description = e.target.value
                  scheduleSave()
                }}
                onBlur={() => void persist()}
                rows={3}
                className={cn(DESCRIPTION_CLASS, 'mt-3 min-h-[84px]')}
                placeholder={t('ideas.descriptionPlaceholder', "What's the constraint, what's the win?")}
              />
            </section>
          )}

          <section className="mt-6 border-t border-border-soft pt-4">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
              {t('ideas.detail.timeline', 'Discussion')}
              <span className="ml-1 font-mono font-normal tracking-normal">· {comments.length}</span>
            </div>
            {activities.length === 0 ? (
              <div className="py-6 text-[12.5px] leading-6 text-muted-foreground">
                {t('ideas.detail.noActivity', 'No discussion yet. Add a take, a constraint, or a decision.')}
              </div>
            ) : (
              <ul>
                {activities.map((activity) => {
                  const actor = actors.get(activity.actor_id)
                  return activity.activity_type === 'status_change' || activity.activity_type === 'reorder'
                    ? <EventItem key={activity.id} activity={activity} actor={actor} />
                    : <CommentItem key={activity.id} activity={activity} actor={actor} />
                })}
              </ul>
            )}
          </section>
        </div>
      </div>

      <div className="px-6 pb-4 pt-1">
        <div className="mx-auto w-full max-w-[760px] rounded-[14px] border border-border bg-paper shadow-[0_4px_16px_-10px_rgba(20,20,15,0.1)]">
          <AutosizeTextarea
            rows={1}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (!isPlainEnter(e)) return
              e.preventDefault()
              void submitComment()
            }}
            className="max-h-[168px] min-h-[42px] resize-none rounded-none border-0 bg-transparent px-3.5 pb-1.5 pt-3 text-[13.5px] leading-[1.6] shadow-none focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent"
            placeholder={t('ideas.detail.activityPlaceholder', 'Add a take, a constraint, or the next step...')}
          />
          <div className="flex items-center gap-2 px-2.5 pb-2 pt-1">
            <span className="ml-auto font-mono text-[11px] text-faint">
              {t('ideas.detail.composerHint', '↵ send · ⇧↵ newline')}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => void submitComment()}
              disabled={!canSubmitComment}
              className="h-7 gap-1 rounded-[8px] bg-coral px-3 text-[12.5px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
            >
              {submittingComment
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ArrowUp className="h-3.5 w-3.5" />}
              {t('ideas.detail.postActivity', 'Send')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function IdeaDetailContent({ target }: { target: IdeaDetailTarget }) {
  switch (target.kind) {
    case 'create':
      return <IdeaCreatePane key={`create:${target.teamId}`} teamId={target.teamId} />
    case 'edit':
      return <IdeaEditPane key={target.idea.id} idea={target.idea} />
  }
}

/** The Ideas section's main-content column: the selected idea, or an invitation to add one. */
export function IdeasDetailColumn() {
  const { t } = useTranslation()
  const target = useIdeaDetailStore((s) => s.target)
  const openCreate = useIdeaDetailStore((s) => s.openCreate)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  if (target) return <IdeaDetailContent target={target} />
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-tauri-drag-region
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-panel text-muted-foreground">
        <Lightbulb className="h-5 w-5" />
      </span>
      <div>
        <div className="text-[13px] font-semibold text-foreground">
          {t('ideas.detailEmpty', 'Select an idea to view, or create a new one')}
        </div>
        <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {t('ideas.detailEmptyHint', 'Half-formed is fine — the discussion is where it takes shape.')}
        </div>
      </div>
      {teamId && (
        <Button
          type="button"
          variant="outline"
          onClick={() => openCreate(teamId)}
          className="h-8 gap-1.5 rounded-[8px] text-[12.5px]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('ideas.newIdea', 'New idea')}
        </Button>
      )}
    </div>
  )
}
