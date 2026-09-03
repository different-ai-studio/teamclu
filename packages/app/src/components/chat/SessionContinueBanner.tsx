import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'
import { useCronStore } from '@/stores/cron'
import { useUIStore } from '@/stores/ui'
import { isScheduledSession } from '@/lib/session/session-origin'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface Props {
  actorId: string
  actorName: string
  variant?: 'default' | 'dashed' | 'inline'
  className?: string
  /** Prefix with · when rendered inline after other links */
  withSeparator?: boolean
}

/**
 * Shown in the actor-draft empty state. Asks Supabase for sessions that
 * include the preselected actor, intersects with the in-memory session
 * list, and surfaces a click target to jump into one of them instead of
 * creating a fresh session. Hidden when zero matches.
 */
export function SessionContinueBanner({
  actorId,
  actorName,
  variant = 'default',
  className,
  withSeparator = false,
}: Props) {
  const { t } = useTranslation()
  const allRows = useSessionListStore((s) => s.rows)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const [matchingIds, setMatchingIds] = React.useState<Set<string> | null>(null)
  const [popoverOpen, setPopoverOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      let ids: string[]
      try {
        ids = await getBackend().sessionMembers.listSessionIdsForActor(actorId)
      } catch {
        ids = []
      }
      if (cancelled) return
      setMatchingIds(new Set(ids))
    })()
    return () => {
      cancelled = true
    }
  }, [actorId])

  if (!matchingIds || matchingIds.size === 0) return null

  // Scheduled runs are their own surface: NavRail, SessionListColumn and
  // SessionList all split them out via this same predicate. Continuing a
  // cron run by hand is not what this affordance is for, and a busy job
  // buries every real conversation. Filtered before .length is read, so
  // the trigger count and the popover list agree.
  const matching: SessionListEntry[] = allRows.filter(
    (r) => matchingIds.has(r.id) && !isScheduledSession(r, cronSessionIds),
  )
  if (matching.length === 0) return null

  const top5 = matching.slice(0, 5)

  const inlineTrigger = (
    <button
      type="button"
      className={cn(
        'text-left text-xs transition-colors',
        variant === 'inline'
          ? 'inline shrink-0 whitespace-nowrap border-none bg-transparent p-0 text-[12px] text-ink-2 underline decoration-border underline-offset-[3px] hover:text-foreground'
          : 'flex max-w-sm items-center gap-2',
        variant === 'dashed'
          ? 'mt-3 rounded-lg border border-dashed border-border bg-paper px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-selected'
          : variant === 'default'
            ? 'mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground hover:bg-muted/60'
            : undefined,
        className,
      )}
    >
      {variant === 'inline' ? (
        <span>
          {t('chat.localAgentWelcome.continueShort', '继续 ×{{count}}', {
            count: matching.length,
          })}
        </span>
      ) : (
        <>
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate">
            {t('chat.draftContinueBanner', '与 {{name}} 还有 {{count}} 个进行中', {
              name: actorName,
              count: matching.length,
            })}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        </>
      )}
    </button>
  )

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        {variant === 'inline' && withSeparator ? (
          <span className="inline-flex items-center">
            <span className="select-none text-[14px] text-border" aria-hidden>
              {' · '}
            </span>
            {inlineTrigger}
          </span>
        ) : (
          inlineTrigger
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground/80">
          {t('chat.draftContinueRecent', '最近会话')}
        </div>
        {top5.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              setPopoverOpen(false)
              void useUIStore.getState().switchToSession(entry.id)
            }}
            className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted/60"
          >
            <div className="truncate text-sm font-medium">
              {entry.title || t('chat.untitledSession', '(未命名)')}
            </div>
            {entry.last_message_preview && (
              <div className="truncate text-[11px] text-muted-foreground">{entry.last_message_preview}</div>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
