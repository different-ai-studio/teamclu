import * as React from 'react'
import { Sparkles, User } from 'lucide-react'
import { toast } from 'sonner'
import type { TFunction } from 'i18next'
import { Textarea } from '@/components/ui/textarea'
import { actorAvatarColor } from '@/lib/actor/actor-color'
import { getBackend } from '@/lib/backend'
import { useIdeaDetailStore } from '@/stores/idea-detail'
import type { IdeaStatus } from '@/lib/team/idea-mutations'
import { cn } from '@/lib/utils'

/** Display order everywhere a status is listed: what is moving first, then the backlog, then shipped. */
export const IDEA_STATUSES: readonly IdeaStatus[] = ['in_progress', 'open', 'done']

/** A row with no status reads as `open` — the server default. */
export function normalizeIdeaStatus(status: string | null | undefined): IdeaStatus {
  return status === 'in_progress' || status === 'done' ? status : 'open'
}

export function ideaStatusDotClass(status: string | null | undefined): string {
  const normalized = normalizeIdeaStatus(status)
  if (normalized === 'in_progress') return 'bg-coral'
  if (normalized === 'done') return 'bg-emerald-500'
  return 'bg-faint'
}

export function ideaStatusLabel(t: TFunction, status: string | null | undefined): string {
  const normalized = normalizeIdeaStatus(status)
  if (normalized === 'in_progress') return t('ideas.status.inProgress', 'In progress')
  if (normalized === 'done') return t('ideas.status.done', 'Done')
  return t('ideas.status.open', 'Open')
}

/**
 * Letter disc per AGENTS.md §4.5: a stable color per actor, agents as a rounded
 * square so the type reads without a badge.
 */
export function IdeaActorDisc({
  actorId,
  name,
  isAgent = false,
  size = 20,
  className,
}: {
  actorId: string | null | undefined
  name: string | null | undefined
  isAgent?: boolean
  size?: number
  className?: string
}) {
  const colors = actorAvatarColor(actorId || name)
  const initial = name?.trim().slice(0, 1).toUpperCase() || ''
  const Fallback = isAgent ? Sparkles : User
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold leading-none',
        isAgent ? 'rounded-[5px]' : 'rounded-full',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: colors.bg,
        color: colors.fg,
        fontSize: Math.round(size * 0.5),
      }}
    >
      {initial || <Fallback style={{ width: size * 0.55, height: size * 0.55 }} />}
    </span>
  )
}

function supportsFieldSizing(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')
}

/**
 * A textarea as tall as its text. `Textarea` already asks for
 * `field-sizing: content`; WebKit only honours that from macOS 26, so on an
 * older webview the height is set by hand. `min-h-*` / `max-h-*` still bound it.
 */
export function AutosizeTextarea({ ref, value, ...props }: React.ComponentProps<typeof Textarea>) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
  React.useLayoutEffect(() => {
    const el = innerRef.current
    if (!el || supportsFieldSizing()) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <Textarea
      {...props}
      value={value}
      ref={(node) => {
        innerRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
    />
  )
}

/**
 * Archiving is one click with an Undo on the toast rather than a confirm
 * dialog: the desktop has no archive browser, so the toast is the way back.
 */
export async function archiveIdeaWithUndo(t: TFunction, ideaId: string): Promise<void> {
  const backend = getBackend()
  try {
    await backend.ideas.archiveIdea(ideaId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toast.error(t('ideas.archiveFailed', 'Failed to archive idea: {{msg}}', { msg }))
    return
  }
  const store = useIdeaDetailStore.getState()
  if (store.target?.kind === 'edit' && store.target.idea.id === ideaId) store.clearDetail()
  store.notifyMutated()
  toast(t('ideas.archived', 'Idea archived'), {
    action: {
      label: t('common.undo', 'Undo'),
      onClick: () => {
        void backend.ideas.archiveIdea(ideaId, false)
          .then(() => useIdeaDetailStore.getState().notifyMutated())
          .catch((e) => console.warn('[ideas] failed to restore archived idea', e))
      },
    },
  })
}
