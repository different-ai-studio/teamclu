import * as React from 'react'
import { User, Sparkles, Loader2, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  useSessionParticipantStore,
  type SessionParticipantInfo,
} from '@/stores/session-participant-store'
import {
  presenceOnlineFlag,
  resolveAgentDevicePresenceSync,
} from '@/lib/agent-device-reachability'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { isSupersededLocalAgent } from '@/lib/local-daemon-identity'
import { type MentionedPerson } from '@/packages/ai/prompt-input'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

export type { MentionedPerson }

type MemberMentionSelectOptions = {
  clearEngagedAgent: boolean
}

interface MentionPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  /** Composer session for @-mention roster (defaults to active session selection). */
  sessionId?: string | null
  /** Engaged agent pill in the composer footer — triggers E2 confirm when @-mentioning a human. */
  engagedAgent?: AttachedAgent | null
  onSelectMember: (person: MentionedPerson, options?: MemberMentionSelectOptions) => void
  onSelectAgent: (agent: AttachedAgent) => void
}

type ParticipantRow = {
  id: string
  actor_type: 'member' | 'agent' | 'external'
  display_name: string
}

/** `external` selects like a member — it is a person, not a runtime — so the
 *  composer keeps one insertion path for humans. Where they differ is what the
 *  mention *does*: the daemon pushes the message out to that person's chat. */
type MentionItem = ParticipantRow & { itemType: 'member' | 'agent' | 'external' }

type PopoverStep = 'browse' | 'confirm'

function participantsToMentionRows(
  participants: SessionParticipantInfo[],
  excludeMemberActorId?: string | null,
): ParticipantRow[] {
  return participants
    .filter(
      (p) =>
        p.isAgent ||
        !excludeMemberActorId ||
        p.actorId !== excludeMemberActorId,
    )
    .map((p) => ({
      id: p.actorId,
      actor_type: p.isAgent ? 'agent' : p.isExternal ? 'external' : 'member',
      display_name: p.displayName,
    }))
}

function filter(rows: ParticipantRow[], query: string): ParticipantRow[] {
  if (!query) return rows
  const q = query.toLowerCase()
  return rows.filter(r => r.display_name.toLowerCase().includes(q))
}

function ConfirmOption({
  highlighted,
  title,
  subtitle,
  onMouseEnter,
  onClick,
}: {
  highlighted: boolean
  title: string
  subtitle: string
  onMouseEnter: () => void
  onClick: () => void
}) {
  return (
    <div
      role="option"
      aria-selected={highlighted}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'flex items-start gap-2.5 rounded-md px-2.5 py-2.5 cursor-pointer select-none transition-colors',
        highlighted ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 transition-colors',
          highlighted ? 'border-coral bg-coral' : 'border-border bg-transparent',
        )}
        style={highlighted ? { boxShadow: 'inset 0 0 0 2px var(--paper)' } : undefined}
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold leading-snug">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  )
}

export function MentionPopover({
  open,
  onOpenChange,
  searchQuery,
  sessionId: sessionIdProp,
  engagedAgent = null,
  onSelectMember,
  onSelectAgent,
}: MentionPopoverProps) {
  const { t } = useTranslation()
  const selectedSessionId = useSessionSelectionStore(s => s.currentSessionId)
  const sessionId = sessionIdProp ?? selectedSessionId
  const currentMemberActorId = useCurrentTeamStore(s => s.currentMember?.id ?? null)
  const ensureParticipants = useSessionParticipantStore(s => s.ensureParticipants)
  const sessionParticipants = useSessionParticipantStore(s =>
    sessionId ? s.participantsBySession[sessionId] : undefined,
  )
  const loading = useSessionParticipantStore(s =>
    sessionId ? s.loadingBySession[sessionId] ?? false : false,
  )
  const loadError = useSessionParticipantStore(s =>
    sessionId ? s.errorBySession[sessionId] ?? null : null,
  )
  // Keep a subscription so agent status labels refresh with presence changes.
  useActorPresenceStore((s) => s.byActorId)
  const [step, setStep] = React.useState<PopoverStep>('browse')
  const [pendingMember, setPendingMember] = React.useState<MentionedPerson | null>(null)
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const [confirmIndex, setConfirmIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  const confirmRef = React.useRef<HTMLDivElement>(null)
  const allItemsRef = React.useRef<MentionItem[]>([])
  const highlightedIndexRef = React.useRef(0)
  const confirmIndexRef = React.useRef(0)
  const stepRef = React.useRef<PopoverStep>('browse')
  const pendingMemberRef = React.useRef<MentionedPerson | null>(null)

  // Only ask about a pill the user actually engaged. In a solo session the
  // composer owns it — the "clear" branch cannot remove it and the "keep"
  // branch promises routing that the message's own mentions decide.
  const needsAgentClearConfirm = Boolean(engagedAgent?.id && !engagedAgent.auto)

  React.useEffect(() => {
    if (!open || !sessionId) return
    void ensureParticipants([sessionId])
  }, [open, sessionId, ensureParticipants])

  const rows = React.useMemo(
    () => participantsToMentionRows(sessionParticipants ?? [], currentMemberActorId),
    [sessionParticipants, currentMemberActorId],
  )

  const filtered = React.useMemo(() => filter(rows, searchQuery), [rows, searchQuery])
  const members = React.useMemo(
    () => filtered.filter(r => r.actor_type === 'member'),
    [filtered],
  )
  const agents = React.useMemo(
    () => filtered.filter(r => r.actor_type === 'agent'),
    [filtered],
  )
  const externals = React.useMemo(
    () => filtered.filter(r => r.actor_type === 'external'),
    [filtered],
  )
  const allItems = React.useMemo<MentionItem[]>(
    () => [
      ...members.map(m => ({ ...m, itemType: 'member' as const })),
      ...agents.map(a => ({ ...a, itemType: 'agent' as const })),
      ...externals.map(e => ({ ...e, itemType: 'external' as const })),
    ],
    [members, agents, externals],
  )

  allItemsRef.current = allItems
  stepRef.current = step
  pendingMemberRef.current = pendingMember
  confirmIndexRef.current = confirmIndex

  const resetConfirmState = React.useCallback(() => {
    setStep('browse')
    setPendingMember(null)
    setConfirmIndex(0)
    confirmIndexRef.current = 0
    pendingMemberRef.current = null
    stepRef.current = 'browse'
  }, [])

  React.useEffect(() => {
    if (!open) {
      setHighlightedIndex(0)
      highlightedIndexRef.current = 0
      resetConfirmState()
    }
  }, [open, resetConfirmState])

  React.useEffect(() => {
    if (step === 'confirm') return
    setHighlightedIndex(0)
    highlightedIndexRef.current = 0
  }, [searchQuery, allItems.length, step])

  const finalizeMember = React.useCallback((person: MentionedPerson, clearEngagedAgent: boolean) => {
    if (needsAgentClearConfirm) {
      onSelectMember(person, { clearEngagedAgent })
    } else {
      onSelectMember(person)
    }
    resetConfirmState()
    onOpenChange(false)
  }, [needsAgentClearConfirm, onSelectMember, onOpenChange, resetConfirmState])

  const beginMemberConfirm = React.useCallback((person: MentionedPerson) => {
    setPendingMember(person)
    pendingMemberRef.current = person
    setConfirmIndex(0)
    confirmIndexRef.current = 0
    setStep('confirm')
    stepRef.current = 'confirm'
  }, [])

  const handleSelect = React.useCallback((item: MentionItem) => {
    if (item.itemType === 'member' || item.itemType === 'external') {
      const person = { id: item.id, name: item.display_name }
      if (needsAgentClearConfirm) {
        beginMemberConfirm(person)
        return
      }
      finalizeMember(person, false)
      return
    }
    onSelectAgent({ id: item.id, displayName: item.display_name })
    resetConfirmState()
    onOpenChange(false)
  }, [
    needsAgentClearConfirm,
    beginMemberConfirm,
    finalizeMember,
    onSelectAgent,
    onOpenChange,
    resetConfirmState,
  ])

  React.useEffect(() => {
    if (!listRef.current || step !== 'browse') return
    const item = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, step])

  React.useEffect(() => {
    if (!confirmRef.current || step !== 'confirm') return
    const item = confirmRef.current.querySelector(`[data-confirm-index="${confirmIndex}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [confirmIndex, step])

  React.useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (stepRef.current === 'confirm') {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          setConfirmIndex(() => {
            const next = confirmIndexRef.current === 0 ? 1 : 0
            confirmIndexRef.current = next
            return next
          })
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          setConfirmIndex(() => {
            const next = confirmIndexRef.current === 0 ? 1 : 0
            confirmIndexRef.current = next
            return next
          })
        } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
          if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) return
          e.preventDefault()
          e.stopPropagation()
          const person = pendingMemberRef.current
          if (!person) return
          finalizeMember(person, confirmIndexRef.current === 1)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          resetConfirmState()
        }
        return
      }

      const currentItems = allItemsRef.current
      if (currentItems.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => {
          const nextIndex = (i + 1) % currentItems.length
          highlightedIndexRef.current = nextIndex
          return nextIndex
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => {
          const nextIndex = (i - 1 + currentItems.length) % currentItems.length
          highlightedIndexRef.current = nextIndex
          return nextIndex
        })
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) return
        e.preventDefault()
        e.stopPropagation()
        const item = currentItems[highlightedIndexRef.current]
        if (item) handleSelect(item)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onOpenChange(false)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, handleSelect, onOpenChange, finalizeMember, resetConfirmState])

  if (!open) return null

  const showLoading = loading && sessionParticipants === undefined
  const showError = Boolean(loadError)
  const isEmpty = !showLoading && !showError && filtered.length === 0
  let currentIndex = 0
  const agentName = engagedAgent?.displayName ?? ''
  const memberName = pendingMember?.name ?? ''

  return (
    <div className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border bg-popover shadow-lg z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center justify-between px-3 py-2 text-[10px] text-muted-foreground border-b bg-muted/30">
        <span className="font-medium">
          {step === 'confirm'
            ? t('chat.mentionAgentClearConfirm.title')
            : t('chat.mentionPopoverTitle')}
        </span>
        {step === 'browse' && searchQuery ? (
          <span className="text-[9px] text-primary font-mono">
            {searchQuery}
          </span>
        ) : step === 'browse' && filtered.length > 0 ? (
          <span className="text-[9px]">
            {filtered.length}
          </span>
        ) : null}
      </div>

      {step === 'confirm' && pendingMember && engagedAgent ? (
        <div ref={confirmRef} className="p-1" role="listbox">
          <div className="px-2.5 py-1.5 text-[10px] font-mono text-faint">
            {t('chat.mentionAgentClearConfirm.backHint')}
          </div>
          <div data-confirm-index={0}>
            <ConfirmOption
              highlighted={confirmIndex === 0}
              title={t('chat.mentionAgentClearConfirm.keepTitle', {
                agent: agentName,
                name: memberName,
              })}
              subtitle={t('chat.mentionAgentClearConfirm.keepSubtitle')}
              onMouseEnter={() => {
                setConfirmIndex(0)
                confirmIndexRef.current = 0
              }}
              onClick={() => finalizeMember(pendingMember, false)}
            />
          </div>
          <div data-confirm-index={1}>
            <ConfirmOption
              highlighted={confirmIndex === 1}
              title={t('chat.mentionAgentClearConfirm.clearTitle', {
                agent: agentName,
                name: memberName,
              })}
              subtitle={t('chat.mentionAgentClearConfirm.clearSubtitle')}
              onMouseEnter={() => {
                setConfirmIndex(1)
                confirmIndexRef.current = 1
              }}
              onClick={() => finalizeMember(pendingMember, true)}
            />
          </div>
        </div>
      ) : (
        <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
          {showLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          )}
          {showError && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t('chat.mentionPopoverError')}
            </div>
          )}
          {isEmpty && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {searchQuery
                ? t('chat.mentionPopoverNoMatch', { query: searchQuery })
                : t('chat.mentionEmptyState')}
            </div>
          )}
          {members.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                {t('chat.mentionGroupMembers')}
              </div>
              {members.map(m => {
                const index = currentIndex++
                return (
                  <div
                    key={m.id}
                    data-index={index}
                    onClick={() => handleSelect({ ...m, itemType: 'member' })}
                    onMouseEnter={() => {
                      setHighlightedIndex(index)
                      highlightedIndexRef.current = index
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors',
                      index === highlightedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50',
                    )}
                  >
                    <User className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium truncate">{m.display_name}</span>
                  </div>
                )
              })}
            </>
          )}
          {agents.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                {t('chat.mentionGroupAgents')}
              </div>
              {agents.map(a => {
                const index = currentIndex++
                const online = presenceOnlineFlag(resolveAgentDevicePresenceSync(a.id))
                const stale = isSupersededLocalAgent(a.id)
                const statusLabel = stale
                  ? t('chat.sessionAgent.mentionStale')
                  : online === false
                    ? t('chat.sessionAgent.mentionOffline')
                    : online === true
                      ? null
                      : t('chat.sessionAgent.mentionConnecting')
                return (
                  <div
                    key={a.id}
                    data-index={index}
                    onClick={() => handleSelect({ ...a, itemType: 'agent' })}
                    onMouseEnter={() => {
                      setHighlightedIndex(index)
                      highlightedIndexRef.current = index
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors',
                      index === highlightedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50',
                    )}
                  >
                    <Sparkles className="h-4 w-4 text-orange-500 shrink-0" />
                    <span className="text-xs font-medium truncate flex-1">{a.display_name}</span>
                    {statusLabel ? (
                      <span className="text-[10px] text-faint shrink-0">{statusLabel}</span>
                    ) : null}
                  </div>
                )
              })}
            </>
          )}
          {externals.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">
                {t('chat.mentionGroupExternal')}
              </div>
              {externals.map(e => {
                const index = currentIndex++
                return (
                  <div
                    key={e.id}
                    data-index={index}
                    onClick={() => handleSelect({ ...e, itemType: 'external' })}
                    onMouseEnter={() => {
                      setHighlightedIndex(index)
                      highlightedIndexRef.current = index
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors',
                      index === highlightedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50',
                    )}
                  >
                    <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium truncate flex-1">{e.display_name}</span>
                    <span className="text-[10px] text-faint shrink-0">
                      {t('chat.mentionExternalHint')}
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
