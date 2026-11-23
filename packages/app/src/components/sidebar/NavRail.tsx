import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, Lightbulb, Keyboard, ChevronDown, MoreHorizontal } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useUIStore } from '@/stores/ui'
import { useSessionListStore } from '@/stores/session-list-store'
import {
  aggregateAttentionByKind,
  totalAttention,
} from '@/lib/session/session-list-attention'

// Clicking 会话 doubles as a "something looks stale" fallback: refetch
// the first page of sessions (cloud + local hydrate). Throttled so rapid
// tab-switching doesn't hammer the Cloud API.
let lastSessionListRefreshAt = 0
function refreshSessionListThrottled(): void {
  const now = Date.now()
  if (now - lastSessionListRefreshAt < 5_000) return
  lastSessionListRefreshAt = now
  void useSessionListStore.getState().loadFirstPage(50, 'regular').catch(() => {})
}
import { useCronStore } from '@/stores/cron'
import { createQuickSession, describeQuickSessionFailure } from '@/lib/session/create-quick-session'
import { useQuickChatReadiness } from '@/hooks/use-quick-chat-readiness'
import { ContactsNavEntry } from '@/components/sidebar/ContactsNavEntry'
import {
  TeamShareNavSection,
  useTeamShareCountsLoader,
} from '@/components/sidebar/TeamShareNavSection'
import { NewChatSplitButton } from '@/components/sidebar/NewChatSplitButton'
import { AppsNavSection } from '@/components/sidebar/AppsNavSection'
import { useFeatures } from '@/lib/config/remote-features'
import { cn } from '@/lib/utils'
import { NAV_ROW_TRAILING_SLOT } from '@/components/sidebar/nav-row'
import { MentionSignal, UnreadSignal } from '@/components/sidebar/session-attention-signal'
import {
  isRailMode,
  navRowBox,
  navRowIcon,
  navRowLabel,
  navRowSignal,
  NavRailModeContext,
  useNavRailMode,
} from '@/components/sidebar/nav-rail-mode'

interface TopEntryProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active?: boolean
  /** Attention signal: mention text or hollow unread ring (no counts). */
  signal?: React.ReactNode
  onClick: () => void
}

function TopEntry({ label, icon: Icon, active, signal, onClick }: TopEntryProps) {
  const mode = useNavRailMode()
  return (
    <button
      type="button"
      onClick={onClick}
      title={mode === 'rail' ? label : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg text-left text-[13px] transition-[background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
        navRowBox(mode),
        active
          ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
          : 'font-normal text-ink-2 hover:bg-black/[0.04]',
      )}
    >
      <Icon
        className={cn(navRowIcon(mode), active ? 'text-foreground' : 'text-muted-foreground')}
      />
      <span className={navRowLabel(mode)}>{label}</span>
      {signal ? <span className={cn(NAV_ROW_TRAILING_SLOT, navRowSignal(mode))}>{signal}</span> : null}
    </button>
  )
}

/** How long the pointer rests on 更多 before its menu opens, and how long it
 * may be off both tile and menu before it closes. The close delay lets the
 * pointer cross the gap between them. */
const MORE_OPEN_DELAY_MS = 120
const MORE_CLOSE_DELAY_MS = 200

/**
 * The 更多 tile on the rail. Hovering (or clicking) opens the folded
 * destinations to its right as list rows; picking one closes it. The tile is
 * marked active while one of them is the open section, since its row is not
 * on the rail to show that.
 */
function RailMoreEntry({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const timer = React.useRef<number | null>(null)
  const filter = useUIStore((s) => s.sidebarFilter)

  const clear = React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  const later = React.useCallback(
    (next: boolean, ms: number) => {
      clear()
      timer.current = window.setTimeout(() => {
        timer.current = null
        setOpen(next)
      }, ms)
    },
    [clear],
  )
  React.useEffect(() => clear, [clear])
  // Picking a destination is the end of the errand.
  React.useEffect(() => {
    clear()
    setOpen(false)
  }, [filter, clear])

  const label = t('sidebar.more', 'More')
  const mode = useNavRailMode()
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clear()
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => (open ? clear() : later(true, MORE_OPEN_DELAY_MS))}
          onMouseLeave={() => (open ? later(false, MORE_CLOSE_DELAY_MS) : clear())}
          className={cn(
            'flex w-full shrink-0 items-center rounded-lg text-[13px] transition-[background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
            navRowBox(mode),
            active
              ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
              : open
                ? 'bg-black/[0.04] font-normal text-ink-2'
                : 'font-normal text-ink-2 hover:bg-black/[0.04]',
          )}
        >
          <MoreHorizontal
            className={cn(navRowIcon(mode), active ? 'text-foreground' : 'text-muted-foreground')}
          />
          <span className={navRowLabel(mode)}>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        onMouseEnter={clear}
        onMouseLeave={() => later(false, MORE_CLOSE_DELAY_MS)}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[200px] rounded-xl border-black/[0.06] bg-sidebar p-1.5 shadow-[0_8px_24px_-8px_rgba(28,27,25,0.22)]"
      >
        <NavRailModeContext.Provider value="list">
          <div className="flex flex-col gap-0.5">{children}</div>
        </NavRailModeContext.Provider>
      </PopoverContent>
    </Popover>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const mode = useNavRailMode()
  const rail = isRailMode(mode)
  const features = useFeatures()
  const embedMode = useUIStore((s) => s.embedMode)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const moreExpanded = useUIStore((s) => s.moreNavExpanded)
  const toggleMore = useUIStore((s) => s.toggleMoreNav)
  const setMoreExpanded = useUIStore((s) => s.setMoreNavExpanded)
  const showCronSessions = useCronStore((s) => s.showCronSessions)
  const setShowCronSessions = useCronStore((s) => s.setShowCronSessions)
  const attentionBySessionId = useSessionListStore((s) => s.attentionBySessionId)
  const sessionsAttention = React.useMemo(
    () => totalAttention(aggregateAttentionByKind(attentionBySessionId)),
    [attentionBySessionId],
  )
  const quickChatState = useQuickChatReadiness()
  const [creating, setCreating] = React.useState(false)

  const sessionsSignal = React.useMemo(() => {
    if (sessionsAttention.mention > 0) {
      return (
        <MentionSignal
          aria-label={t('sidebar.mentioned', 'Mentioned')}
          data-testid="nav-sessions-mention"
        />
      )
    }
    if (sessionsAttention.unread > 0) {
      return (
        <UnreadSignal
          aria-label={t('sidebar.unread', 'Unread')}
          data-testid="nav-sessions-unread"
        />
      )
    }
    return null
  }, [sessionsAttention, t])

  // Counts feed rows in both groups, so the fetch lives here rather than in
  // either TeamShareNavSection instance.
  useTeamShareCountsLoader()

  // Something else can select one of the folded destinations (default-tab
  // setting, deep link, a link from the chat pane) — unfold the group so the
  // active row is never hidden behind a collapsed rule.
  const moreFilterActive =
    filter.kind === 'ideas' ||
    filter.kind === 'shortcuts' ||
    (filter.kind === 'teamShare' &&
      (filter.section === 'knowledge' || filter.section === 'mcp' || filter.section === 'env'))

  React.useEffect(() => {
    if (moreFilterActive) setMoreExpanded(true)
  }, [moreFilterActive, setMoreExpanded])

  const handleQuickNewChat = React.useCallback(() => {
    if (creating) return
    if (quickChatState.kind === 'no_team' || quickChatState.kind === 'no_agent') return

    setCreating(true)
    // Still resolving in the background: resolve here instead of making the
    // user wait for that pass and click again.
    void createQuickSession(quickChatState.kind === 'ready' ? quickChatState.target : null)
      .then((result) => {
        if (result.ok) return
        const { title, description } = describeQuickSessionFailure(result.reason, t)
        return import('sonner').then(({ toast }) => {
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
      })
      .catch((e) => {
        console.error('[NavRail] quick create failed', e)
        const { title, description } = describeQuickSessionFailure('server_error', t)
        void import('sonner').then(({ toast }) => {
          toast.error(title, { description })
        })
      })
      .finally(() => setCreating(false))
  }, [quickChatState, creating, t])

  // ⌘N — unified quick session (local agent, else effective default).
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        handleQuickNewChat()
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [handleQuickNewChat])

  const moreRows = (
    <>
      <TeamShareNavSection sections={['knowledge']} />
      {!embedMode ? (
        <TopEntry
          label={t('sidebar.ideas', 'Ideas')}
          icon={Lightbulb}
          active={filter.kind === 'ideas'}
          onClick={() => setFilter({ kind: 'ideas' })}
        />
      ) : null}
      {!embedMode ? (
        <TopEntry
          label={t('common.shortcuts', 'Shortcuts')}
          icon={Keyboard}
          active={filter.kind === 'shortcuts'}
          onClick={() => setFilter({ kind: 'shortcuts' })}
        />
      ) : null}
      <TeamShareNavSection sections={['mcp', 'env']} />
    </>
  )

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col gap-2.5 overflow-hidden pt-0 pb-3', rail ? 'px-1.5' : 'px-2.5')}>
      <NewChatSplitButton
        quickChatState={quickChatState}
        creating={creating}
        onPrimaryClick={handleQuickNewChat}
      />

      {/* Everyday destinations. Everything else folds into 更多 below. */}
      <div className="flex shrink-0 flex-col gap-0.5">
        <TopEntry
          label={t('sidebar.sessions', 'Sessions')}
          icon={Inbox}
          active={filter.kind === 'all' && !showCronSessions}
          signal={sessionsSignal}
          onClick={() => {
            setShowCronSessions(false)
            setFilter({ kind: 'all' })
            refreshSessionListThrottled()
          }}
        />
        <ContactsNavEntry />
        <TeamShareNavSection sections={['skills']} />
        {features.apps && <AppsNavSection />}
        {/* The rail has no room to unfold a group in place. 更多 is one more
            tile; resting on it opens the folded destinations beside the rail,
            drawn as the list draws them. */}
        {rail ? <RailMoreEntry active={moreFilterActive}>{moreRows}</RailMoreEntry> : null}
      </div>

      {rail ? null : (
      <div className="flex min-h-0 flex-1 flex-col">
        {/*
          A rule with the label floated in it, rather than another left-aligned
          header: the line is what separates the everyday rows from the folded
          ones, and the chevron rotating in place is the only motion needed to
          say which way it goes.
        */}
        <button
          type="button"
          onClick={toggleMore}
          aria-expanded={moreExpanded}
          className="group flex w-full items-center gap-2.5 py-2"
        >
          <span
            aria-hidden
            className="h-px flex-1 bg-border-soft transition-colors duration-150 group-hover:bg-border"
          />
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint transition-colors duration-150 group-hover:text-ink-2">
            {t('sidebar.more', 'More')}
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
                moreExpanded && 'rotate-180',
              )}
            />
          </span>
          <span
            aria-hidden
            className="h-px flex-1 bg-border-soft transition-colors duration-150 group-hover:bg-border"
          />
        </button>
        {/* Scrolls rather than clips: nothing in here grows to absorb slack any
            more (the app list that used to moved to column two), so on a short
            window the last rows would otherwise be cut off by the rail's own
            overflow-hidden. */}
        {moreExpanded && (
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
            {moreRows}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
