import React, { useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquare, Loader2 } from 'lucide-react'
import { useSessionStore } from '@/stores/session'
import { useStreamingStore } from '@/stores/streaming'
import { useWorkspaceStore } from '@/stores/workspace'
import { useUIStore } from '@/stores/ui'
import { useCronStore } from '@/stores/cron'
import { cn } from '@/lib/utils'
import { formatRelativeDate } from '@/lib/date-format'
import { isScheduledSession } from '@/lib/session-origin'
import {
  resolvePendingPermissionActivityOwner,
  resolvePendingQuestionActivityOwner,
} from '@/lib/session-list-activity'

interface SessionListProps {
  compact?: boolean
  onSessionSelected?: () => void
}

// ── Memoized session item to prevent re-rendering all items on single change ──

interface SessionListItemProps {
  session: { id: string; title: string; updatedAt: string | Date; messageCount?: number }
  isActive: boolean
  isHighlighted: boolean
  compact?: boolean
  onSelect: (id: string) => void
  children?: React.ReactNode
}

function SessionStatusIndicator({ compact, sessionId }: { compact?: boolean; sessionId: string }) {
  const { t } = useTranslation()
  const sessions = useSessionStore(s => s.sessions)
  const sessionStatus = useSessionStore(s => s.sessionStatus)
  const pendingPermissions = useSessionStore(s => s.pendingPermissions)
  const pendingQuestions = useSessionStore(s => s.pendingQuestions)
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId)
  const hasPendingPermission = pendingPermissions.some(
    (entry) => resolvePendingPermissionActivityOwner(entry, sessions, sessionId) === sessionId,
  )
  const hasPendingQuestion = pendingQuestions.some(
    (question) => resolvePendingQuestionActivityOwner(question, sessions, sessionId) === sessionId,
  )

  if (hasPendingPermission || hasPendingQuestion) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
        {t('chat.waitingForConfirmationShort', 'Waiting')}
      </span>
    )
  }

  if (sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry' || streamingMessageId) {
    return (
      <Loader2 className={cn(
        "shrink-0 animate-spin text-muted-foreground/70",
        compact ? "h-3 w-3" : "h-3.5 w-3.5"
      )} />
    )
  }

  return null
}

const SessionListItem = React.memo(function SessionListItem({
  session,
  isActive,
  isHighlighted,
  compact,
  onSelect,
  children,
}: SessionListItemProps) {
  const { t } = useTranslation()

  return (
    <div>
      <button
        onClick={() => onSelect(session.id)}
        className={cn(
          "w-full text-left rounded-lg transition-all duration-200 group",
          compact ? "px-3 py-2" : "px-3 py-2.5",
          isHighlighted
            ? "bg-emerald-500/10 ring-1 ring-emerald-500/25 text-foreground"
            : isActive
              ? "bg-primary/8 text-foreground"
              : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
        )}
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <MessageSquare className={cn(
            "shrink-0 mt-0.5",
            compact ? "h-3.5 w-3.5" : "h-4 w-4",
            isActive ? "text-primary" : "text-muted-foreground/50 group-hover:text-muted-foreground/70",
          )} />
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={cn(
                "truncate leading-snug",
                compact ? "text-sm" : "text-[15px]",
                isActive && "font-medium",
              )}>
                {session.title}
              </span>
              {isActive ? (
                <SessionStatusIndicator compact={compact} sessionId={session.id} />
              ) : isHighlighted ? (
                <span className="shrink-0 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                  {t('chat.newSessionBadge', 'NEW')}
                </span>
              ) : null}
            </div>
            <span className={cn("text-muted-foreground/70", compact ? "text-xs" : "text-xs")}>
              {formatRelativeDate(session.updatedAt)}
              {session.messageCount !== undefined && (
                <> · {t('chat.messageCountShort', { count: session.messageCount })}</>
              )}
            </span>
          </div>
        </div>
      </button>
      {children}
    </div>
  )
})

// ── Virtualization constants ──
const VIRTUAL_THRESHOLD = 50
const ROW_HEIGHT = 52
const ROW_HEIGHT_COMPACT = 40

export function SessionList({ compact, onSessionSelected }: SessionListProps) {
  const allSessions = useSessionStore(s => s.sessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const cronSessionIds = useCronStore(s => s.cronSessionIds)
  const showCronSessions = useCronStore(s => s.showCronSessions)

  const parentSessions = useMemo(() => {
    const isCron = (s: typeof allSessions[number]) => isScheduledSession(s, cronSessionIds)
    return allSessions.filter(s => {
      if (s.parentID) return false
      return showCronSessions
        ? isCron(s)
        : !isCron(s) || s.id === activeSessionId
    })
  }, [allSessions, cronSessionIds, showCronSessions, activeSessionId])

  const isLoading = useSessionStore(s => s.isLoading)
  const highlightedSessionIds = useSessionStore(s => s.highlightedSessionIds)
  const setActiveSession = useSessionStore(s => s.setActiveSession)
  const clearSelection = useWorkspaceStore(s => s.clearSelection)

  const parentRef = useRef<HTMLDivElement>(null)
  const useVirtual = parentSessions.length > VIRTUAL_THRESHOLD
  const rowHeight = compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT

  const virtualizer = useVirtualizer({
    count: useVirtual ? parentSessions.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  })

  void setActiveSession
  void clearSelection

  const handleSelectSession = useCallback((id: string) => {
    useUIStore.getState().switchToSession(id)
    onSessionSelected?.()
  }, [onSessionSelected])

  if (isLoading && parentSessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className={cn("animate-spin text-muted-foreground", compact ? "h-4 w-4" : "h-5 w-5")} />
      </div>
    )
  }

  if (parentSessions.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8" : "py-12")}>
        <div className={cn("rounded-full bg-muted/50 mb-3", compact ? "p-2.5" : "p-3")}>
          <MessageSquare className={cn("text-muted-foreground/60", compact ? "h-5 w-5" : "h-6 w-6")} />
        </div>
        <p className={cn("text-muted-foreground/70 font-medium", compact ? "text-xs" : "text-sm")}>
          No conversations yet
        </p>
      </div>
    )
  }

  if (useVirtual) {
    return (
      <div
        ref={parentRef}
        className={cn("overflow-auto", compact ? "p-1" : "p-2")}
        style={{ height: '100%' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const session = parentSessions[virtualItem.index]
            return (
              <div
                key={session.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <SessionListItem
                  session={session}
                  isActive={session.id === activeSessionId}
                  isHighlighted={highlightedSessionIds.includes(session.id)}
                  compact={compact}
                  onSelect={handleSelectSession}
                />
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("space-y-0.5", compact ? "p-1.5" : "p-2")}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {(parentSessions as any[]).map((session: any) => (
        <SessionListItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          isHighlighted={highlightedSessionIds.includes(session.id)}
          compact={compact}
          onSelect={handleSelectSession}
        />
      ))}
    </div>
  )
}
