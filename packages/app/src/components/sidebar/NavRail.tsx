import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, Keyboard } from 'lucide-react'
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
import { NavGroupEntries, useTeamShareCountsLoader } from '@/components/sidebar/NavGroupEntries'
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
      title={mode === 'rail-collapsed' ? label : undefined}
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

export function NavRail() {
  const { t } = useTranslation()
  const mode = useNavRailMode()
  const rail = isRailMode(mode)
  const features = useFeatures()
  const embedMode = useUIStore((s) => s.embedMode)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
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

  // Team-share catalogs back both grouped entries and their columns; the nav is
  // always mounted, so the one fetch lives here.
  useTeamShareCountsLoader()

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

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col gap-2.5 overflow-hidden pt-0 pb-3', rail ? 'px-1.5' : 'px-2.5')}>
      <NewChatSplitButton
        quickChatState={quickChatState}
        creating={creating}
        onPrimaryClick={handleQuickNewChat}
      />

      {/*
        One list, no fold. Grouping knowledge + ideas into 知识 and skills + MCP
        + secrets into 能力 keeps it to six entries, few enough that every one
        shows with its label on the rail and in the list alike. Scrolls rather
        than clips, for a short window.
      */}
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
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
        <NavGroupEntries />
        {features.apps && <AppsNavSection />}
        {!embedMode ? (
          <TopEntry
            label={t('common.shortcuts', 'Shortcuts')}
            icon={Keyboard}
            active={filter.kind === 'shortcuts'}
            onClick={() => setFilter({ kind: 'shortcuts' })}
          />
        ) : null}
      </div>
    </div>
  )
}
