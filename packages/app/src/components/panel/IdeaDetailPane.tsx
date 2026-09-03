import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Lightbulb, ListChecks, Loader2, MessageSquarePlus, MoreHorizontal, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatRelativeTime } from '@/lib/ui/date-format'
import { updateIdea, createIdeaActivity, type IdeaStatus } from '@/lib/team/idea-mutations'
import { useIdeaDetailStore, type IdeaDetailTarget } from '@/stores/idea-detail'
import type { IdeaRow } from '@/components/panel/IdeasView'
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
  created_at: string
}

type ActorSummary = {
  id: string
  display_name: string | null
  actor_type?: string | null
}

function activityLabel(type: string): string {
  if (type === 'status_change') return 'Status changed'
  if (type === 'reorder') return 'Reordered'
  return 'Progress'
}

function activityTone(type: string): string {
  if (type === 'status_change') return 'bg-selected text-ink-2'
  if (type === 'reorder') return 'bg-panel text-muted-foreground'
  return 'bg-coral/10 text-coral'
}

function PaneHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Lightbulb className="h-[17px] w-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-faint">Idea</div>
        <div className="truncate text-[15px] font-bold text-foreground">{title}</div>
      </div>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
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
      // Stay on the fresh idea so activity can be added right away.
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        title={t('ideas.newIdea', 'New idea')}
        actions={
          <>
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
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <section className="mx-auto w-full max-w-[760px]">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('ideas.titlePlaceholder', 'Idea title')}
            disabled={submitting}
            className="h-auto border-0 bg-transparent px-0 py-0 text-[24px] font-bold leading-tight shadow-none outline-none placeholder:text-faint focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('ideas.descriptionPlaceholder', "What's the constraint, what's the win?")}
            disabled={submitting}
            rows={8}
            className="mt-5 min-h-[220px] resize-none border-0 bg-transparent px-0 py-0 text-[15px] leading-7 text-ink-2 shadow-none outline-none placeholder:text-faint focus-visible:ring-0"
          />
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-ink-2">
              <span className="h-2 w-2 rounded-full bg-faint" />
              {t('ideas.contextMenu.statusOpen', 'Open')}
            </span>
            <span className="rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-muted-foreground">
              {t('ideas.newIdeaDescription', 'Capture an idea, problem, or proposal for the team.')}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

function IdeaEditPane({ idea }: { idea: IdeaRow }) {
  const { t } = useTranslation()
  const notifyMutated = useIdeaDetailStore((s) => s.notifyMutated)
  const [detail, setDetail] = React.useState<IdeaDetail | null>(null)
  const [activities, setActivities] = React.useState<IdeaActivity[]>([])
  const [actors, setActors] = React.useState<Map<string, ActorSummary>>(new Map())
  const [title, setTitle] = React.useState(idea.title)
  const [description, setDescription] = React.useState('')
  const [status, setStatus] = React.useState<IdeaStatus>((idea.status as IdeaStatus | null) ?? 'open')
  const [activityText, setActivityText] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [submittingActivity, setSubmittingActivity] = React.useState(false)

  const loadDetail = React.useCallback(async () => {
    setLoading(true)
    try {
      const ideaData = await getBackend().ideas.getIdeaDetail(idea.id)
      if (!ideaData) throw new Error('idea not found')

      const nextDetail = ideaData as IdeaDetail
      setDetail(nextDetail)
      setTitle(nextDetail.title)
      setDescription(nextDetail.description ?? '')
      setStatus((nextDetail.status as IdeaStatus | null) ?? 'open')

      setActivities((ideaData.activities ?? []) as IdeaActivity[])
      setActors(new Map(((ideaData.actors ?? []) as ActorSummary[]).map((actor) => [actor.id, actor])))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.detail.loadFailed', 'Failed to load idea: {{msg}}', { msg }))
    } finally {
      setLoading(false)
    }
  }, [idea.id, t])

  React.useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const changed = !!detail
    && (title.trim() !== detail.title
      || description !== (detail.description ?? '')
      || status !== ((detail.status as IdeaStatus | null) ?? 'open'))
  const canSave = !!detail && !!title.trim() && changed && !saving
  const canSubmitActivity = !!detail && !!activityText.trim() && !submittingActivity
  const creator = detail ? actors.get(detail.created_by_actor_id) : null
  const lastUpdatedAt = (detail ?? idea).updated_at

  const save = async () => {
    if (!detail || !canSave) return
    setSaving(true)
    try {
      await updateIdea(detail.id, {
        title: title.trim(),
        description: description.trim() || null,
        status,
        workspaceId: detail.workspace_id,
      })
      notifyMutated()
      await loadDetail()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.detail.saveFailed', 'Save failed: {{msg}}', { msg }))
    } finally {
      setSaving(false)
    }
  }

  const submitActivity = async () => {
    if (!detail || !canSubmitActivity) return
    setSubmittingActivity(true)
    try {
      await createIdeaActivity(detail.id, {
        activityType: 'progress',
        content: activityText.trim(),
      })
      setActivityText('')
      notifyMutated()
      await loadDetail()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.detail.activityFailed', 'Activity failed: {{msg}}', { msg }))
    } finally {
      setSubmittingActivity(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        title={`#${Math.max(1, Math.round(((detail ?? idea).sort_order ?? 1000) / 1000))} · ${t('ideas.detail.edit', 'Edit')}`}
        actions={
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('ideas.detail.save', 'Save')}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-[760px]">
          {loading && !detail ? (
            <div className="flex h-44 items-center justify-center text-[12px] text-faint">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('ideas.loading', 'Loading ideas...')}
            </div>
          ) : (
            <section>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-auto border-0 bg-transparent px-0 py-0 text-[24px] font-bold leading-tight shadow-none outline-none placeholder:text-faint focus-visible:ring-0"
                placeholder={t('ideas.titlePlaceholder', 'Idea title')}
              />
              <p className="mt-3 text-[13px] leading-6 text-ink-2">
                {creator?.display_name
                  ? t('ideas.detail.summaryWithCreator', '{{creator}} · {{count}} activities · updated {{when}}', {
                    creator: creator.display_name,
                    count: activities.length,
                    when: formatRelativeTime(new Date(lastUpdatedAt)),
                  })
                  : t('ideas.detail.summary', '{{count}} activities · updated {{when}}', {
                    count: activities.length,
                    when: formatRelativeTime(new Date(lastUpdatedAt)),
                  })}
              </p>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                className="mt-5 min-h-[136px] resize-none border-0 bg-transparent px-0 py-0 text-[15px] leading-7 text-ink-2 shadow-none outline-none placeholder:text-faint focus-visible:ring-0"
                placeholder={t('ideas.descriptionPlaceholder', "What's the constraint, what's the win?")}
              />
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Select value={status} onValueChange={(v) => setStatus(v as IdeaStatus)}>
                  <SelectTrigger className="h-8 w-auto min-w-[132px] rounded-full border-border-soft bg-paper px-3 text-[12.5px] shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">{t('ideas.contextMenu.statusOpen', 'Open')}</SelectItem>
                    <SelectItem value="in_progress">{t('ideas.contextMenu.statusInProgress', 'In progress')}</SelectItem>
                    <SelectItem value="done">{t('ideas.contextMenu.statusDone', 'Done')}</SelectItem>
                  </SelectContent>
                </Select>
                <span className="rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-muted-foreground">
                  {t('ideas.detail.priorityPlaceholder', '--- Priority')}
                </span>
                <span className="rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink-2">
                  {creator?.display_name ?? t('ideas.detail.unknownActor', 'Unknown')}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5" />
                  {t('ideas.detail.tags', 'Tags')}
                </span>
                <span className="rounded-full border border-border-soft bg-paper px-3 py-1.5 font-mono text-[11px] text-faint">
                  {formatRelativeTime(new Date(lastUpdatedAt))}
                </span>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border-soft bg-paper text-muted-foreground">
                  <MoreHorizontal className="h-4 w-4" />
                </span>
              </div>
            </section>
          )}

          <section className="mt-7">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                {t('ideas.detail.timeline', 'Activity')}
                <span className="ml-1 font-mono font-normal tracking-normal">· {activities.length}</span>
              </div>
            </div>
            <div>
              {activities.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">
                  {t('ideas.detail.noActivity', 'No activity yet.')}
                </div>
              ) : (
                activities.map((activity) => {
                  const actor = actors.get(activity.actor_id)
                  return (
                    <div key={activity.id} className="py-3">
                      <div className="flex items-center gap-2">
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', activityTone(activity.activity_type))}>
                          {activityLabel(activity.activity_type)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">
                          {actor?.display_name ?? t('ideas.detail.unknownActor', 'Unknown')}
                        </span>
                        <span className="font-mono text-[11px] text-faint">
                          {formatRelativeTime(new Date(activity.created_at))}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5 text-foreground">
                        {activity.content || activity.activity_type}
                      </p>
                    </div>
                  )
                })
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="border-t border-border-soft bg-paper px-5 py-3">
        <div className="mx-auto flex w-full max-w-[760px] items-center gap-2">
          <Input
            value={activityText}
            onChange={(e) => setActivityText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submitActivity()
              }
            }}
            className="h-9 flex-1 rounded-[10px] border-border-soft bg-background text-[13px] shadow-none"
            placeholder={t('ideas.detail.activityPlaceholder', 'Post progress, decision notes, or next action...')}
          />
          <Button size="sm" onClick={() => void submitActivity()} disabled={!canSubmitActivity} className="h-9 rounded-[9px]">
            {submittingActivity
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <MessageSquarePlus className="h-3.5 w-3.5" />}
            {t('ideas.detail.postActivity', 'Post activity')}
          </Button>
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

/** The Ideas section's main-content column: the selected idea, or a quiet hint. */
export function IdeasDetailColumn() {
  const { t } = useTranslation()
  const target = useIdeaDetailStore((s) => s.target)
  if (target) return <IdeaDetailContent target={target} />
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
      data-tauri-drag-region
    >
      <Lightbulb className="h-8 w-8" />
      <span className="text-sm">
        {t('ideas.detailEmpty', 'Select an idea to view, or create a new one')}
      </span>
    </div>
  )
}
