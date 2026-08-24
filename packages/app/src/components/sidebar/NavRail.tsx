import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, Lightbulb, Keyboard, AppWindow, ChevronDown } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useSessionListStore } from '@/stores/session-list-store'

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
import { createQuickSession, describeQuickSessionFailure } from '@/lib/create-quick-session'
import { useQuickChatReadiness } from '@/hooks/use-quick-chat-readiness'
import { ContactsNavEntry } from '@/components/sidebar/ContactsNavEntry'
import {
  TeamShareNavSection,
  useTeamShareCountsLoader,
} from '@/components/sidebar/TeamShareNavSection'
import { NewChatSplitButton } from '@/components/sidebar/NewChatSplitButton'
import { NAV_ROW_TRAILING_SLOT } from '@/components/sidebar/nav-row'
import { useFeatures } from '@/lib/remote-features'
import { isScheduledSession } from '@/lib/session-origin'
import { cn } from '@/lib/utils'

interface TopEntryProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active?: boolean
  badge?: number | null
  onClick: () => void
}

function TopEntry({ label, icon: Icon, active, badge, onClick }: TopEntryProps) {
  // Soft Comfort: active = elevated paper capsule; count badge turns coral when active.
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-left text-[13px] transition-[background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
        active
          ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
          : 'font-normal text-ink-2 hover:bg-black/[0.04]',
      )}
    >
      <Icon
        className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && (
        <span
          className={cn(
            // Same hit box for active/inactive so counts share a right edge.
            NAV_ROW_TRAILING_SLOT,
            'text-[10.5px] font-semibold tabular-nums',
            active
              ? 'bg-coral text-coral-foreground shadow-[0_2px_6px_rgba(232,90,74,0.28)]'
              : 'text-muted-foreground',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const features = useFeatures()
  const embedMode = useUIStore((s) => s.embedMode)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const advancedExpanded = useUIStore((s) => s.advancedNavExpanded)
  const toggleAdvanced = useUIStore((s) => s.toggleAdvancedNav)
  const setAdvancedExpanded = useUIStore((s) => s.setAdvancedNavExpanded)
  const listRows = useSessionListStore((s) => s.rows)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const showCronSessions = useCronStore((s) => s.showCronSessions)
  const setShowCronSessions = useCronStore((s) => s.setShowCronSessions)
  const quickChatState = useQuickChatReadiness()
  const [creating, setCreating] = React.useState(false)

  // Counts feed rows in both groups, so the fetch lives here rather than in
  // either TeamShareNavSection instance.
  useTeamShareCountsLoader()

  const sessionsCount = React.useMemo(
    () => listRows.filter((r) => !isScheduledSession(r, cronSessionIds)).length,
    [listRows, cronSessionIds],
  )

  // Something else can select an advanced destination (default-tab setting,
  // deep link, a link from the chat pane) — unfold the group so the active row
  // is never hidden behind a collapsed header.
  const advancedFilterActive =
    filter.kind === 'ideas' ||
    filter.kind === 'apps' ||
    filter.kind === 'shortcuts' ||
    (filter.kind === 'teamShare' && (filter.section === 'mcp' || filter.section === 'env'))

  React.useEffect(() => {
    if (advancedFilterActive) setAdvancedExpanded(true)
  }, [advancedFilterActive, setAdvancedExpanded])

  const handleQuickNewChat = React.useCallback(() => {
    if (quickChatState.kind !== 'ready' || creating) return

    setCreating(true)
    void createQuickSession(quickChatState.target)
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

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2.5 overflow-y-auto px-2.5 pt-0 pb-3">
      <NewChatSplitButton
        quickChatState={quickChatState}
        creating={creating}
        onPrimaryClick={handleQuickNewChat}
      />

      {/* Everyday destinations. Everything else folds into 高级 below. */}
      <div className="flex flex-col gap-0.5">
        <TopEntry
          label={t('sidebar.sessions', 'Sessions')}
          icon={Inbox}
          active={filter.kind === 'all' && !showCronSessions}
          badge={sessionsCount}
          onClick={() => {
            setShowCronSessions(false)
            setFilter({ kind: 'all' })
            refreshSessionListThrottled()
          }}
        />
        <ContactsNavEntry />
        <TeamShareNavSection sections={['skills', 'knowledge']} />
      </div>

      <div className="flex flex-col">
        {/*
          A rule with the label floated in it, rather than another left-aligned
          header: the line is what separates the everyday rows from the folded
          ones, and the chevron rotating in place is the only motion needed to
          say which way it goes.
        */}
        <button
          type="button"
          onClick={toggleAdvanced}
          aria-expanded={advancedExpanded}
          className="group flex w-full items-center gap-2.5 py-2"
        >
          <span
            aria-hidden
            className="h-px flex-1 bg-border-soft transition-colors duration-150 group-hover:bg-border"
          />
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint transition-colors duration-150 group-hover:text-ink-2">
            {t('sidebar.advanced', 'Advanced')}
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
                advancedExpanded && 'rotate-180',
              )}
            />
          </span>
          <span
            aria-hidden
            className="h-px flex-1 bg-border-soft transition-colors duration-150 group-hover:bg-border"
          />
        </button>
        {advancedExpanded && (
          <div className="flex flex-col gap-0.5">
            {!embedMode ? (
              <TopEntry
                label={t('sidebar.ideas', 'Ideas')}
                icon={Lightbulb}
                active={filter.kind === 'ideas'}
                onClick={() => setFilter({ kind: 'ideas' })}
              />
            ) : null}
            {features.apps && (
              <TopEntry
                label={t('sidebar.apps', '演示及 APP')}
                icon={AppWindow}
                active={filter.kind === 'apps'}
                onClick={() => setFilter({ kind: 'apps' })}
              />
            )}
            {!embedMode ? (
              <TopEntry
                label={t('common.shortcuts', 'Shortcuts')}
                icon={Keyboard}
                active={filter.kind === 'shortcuts'}
                onClick={() => setFilter({ kind: 'shortcuts' })}
              />
            ) : null}
            <TeamShareNavSection sections={['mcp', 'env']} />
          </div>
        )}
      </div>
    </div>
  )
}
