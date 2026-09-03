import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { actorAvatarColor } from '@/lib/actor-color'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import {
  formatEmptyThreadRosterNames,
  resolveEmptyThreadRoutingKind,
  type EmptyThreadParticipant,
} from '@/lib/session-empty-thread-starters'
import { isSoloBuild } from '@/lib/solo-build'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  useSessionParticipantStore,
  type SessionParticipantInfo,
} from '@/stores/session-participant-store'
import { useWorkspaceStore } from '@/stores/workspace'

type SessionEmptyThreadStateProps = {
  sessionId: string
}

function toParticipants(
  rows: SessionParticipantInfo[],
  currentActorId: string | null,
): EmptyThreadParticipant[] {
  return rows.map((row) => ({
    actorId: row.actorId,
    displayName: row.displayName,
    isAgent: row.isAgent,
    isSelf: !!currentActorId && row.actorId === currentActorId,
  }))
}

function ParticipantAvatar({ participant }: { participant: EmptyThreadParticipant }) {
  const colors = actorAvatarColor(
    participant.isSelf ? 'self' : participant.actorId,
  )
  const initial =
    participant.displayName.trim().charAt(0).toUpperCase() || '?'

  return (
    <span
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center text-[11px] font-semibold text-white',
        'ring-2 ring-background',
        participant.isAgent ? 'rounded-md' : 'rounded-full',
        '-ml-2 first:ml-0',
      )}
      style={{
        backgroundColor: participant.isSelf ? '#1a1a14' : colors.bg,
        boxShadow: participant.isAgent ? '0 0 0 1.5px var(--coral)' : undefined,
      }}
      title={participant.displayName}
      aria-hidden
    >
      {initial}
      {participant.isAgent ? (
        <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-coral ring-[1.5px] ring-background" />
      ) : null}
    </span>
  )
}

export function SessionEmptyThreadState({
  sessionId,
}: SessionEmptyThreadStateProps) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMemberId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  const authUserId = useAuthStore((s) => s.session?.user?.id ?? null)

  const participants = useSessionParticipantStore(
    (s) => s.participantsBySession[sessionId],
  )
  const loading = useSessionParticipantStore(
    (s) => s.loadingBySession[sessionId] ?? false,
  )

  const [currentActorId, setCurrentActorId] = React.useState<string | null>(null)

  React.useEffect(() => {
    void useSessionParticipantStore.getState().ensureParticipants([sessionId])
  }, [sessionId])

  React.useEffect(() => {
    let cancelled = false
    if (!teamId || !authUserId) {
      setCurrentActorId(null)
      return
    }
    void resolveCurrentMemberActorId(teamId, authUserId, {
      currentTeamId: teamId,
      currentMemberId,
    }).then((id) => {
      if (!cancelled) setCurrentActorId(id)
    })
    return () => {
      cancelled = true
    }
  }, [teamId, authUserId, currentMemberId])

  const roster = React.useMemo(
    () => toParticipants(participants ?? [], currentActorId),
    [participants, currentActorId],
  )

  const selfLabel = t('chat.sessionEmptyThread.selfLabel', 'You')
  const nameSeparator = t('chat.sessionEmptyThread.nameSeparator', ', ')
  const rosterNames = formatEmptyThreadRosterNames(roster, selfLabel, nameSeparator)
  const routingKind = resolveEmptyThreadRoutingKind(roster)

  const routingText = React.useMemo(() => {
    const soleAgent = roster.find((p) => p.isAgent && !p.isSelf)
    if (routingKind === 'soloAgent') {
      return t(
        'chat.sessionEmptyThread.routingSoloAgent',
        'Only one agent in this session — send directly, no @ needed.',
      )
    }
    if (routingKind === 'singleAgent' && soleAgent) {
      return t(
        'chat.sessionEmptyThread.routingSingleAgent',
        'Message everyone, or @{{name}} to reach that agent.',
        { name: soleAgent.displayName },
      )
    }
    return t(
      'chat.sessionEmptyThread.routingMultiAgent',
      'Multiple agents — @ a name to choose who replies.',
    )
  }, [routingKind, roster, t])

  const handleInvite = () => {
    useWorkspaceStore.getState().openPanel('actors')
  }

  const dayDivider = (
    <div className="mb-3 flex items-center gap-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
      <span className="h-px flex-1 bg-border-soft" aria-hidden />
      <span>{t('chat.sessionEmptyThread.dayDivider', 'New session · Start with a message')}</span>
      <span className="h-px flex-1 bg-border-soft" aria-hidden />
    </div>
  )

  // Solo-agent build: keep only the session divider; hide roster / Invite / routing.
  if (isSoloBuild()) {
    return <div className="w-full pb-2">{dayDivider}</div>
  }

  if (loading && roster.length === 0) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (roster.length === 0) {
    return null
  }

  return (
    <div className="w-full pb-2">
      {dayDivider}

      <div className="flex items-center gap-2.5 rounded-[14px] border border-border bg-paper px-3 py-[11px]">
        <div className="flex items-center pl-0.5">
          {roster.map((p) => (
            <ParticipantAvatar key={p.actorId} participant={p} />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-foreground">
            {rosterNames}
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {t('chat.sessionEmptyThread.participantCount', {
              count: roster.length,
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={handleInvite}
          className={cn(
            'shrink-0 rounded-lg border border-dashed border-border px-2.5 py-1.5',
            'text-[11px] font-semibold text-ink-2 transition-colors hover:bg-selected',
          )}
        >
          {t('chat.sessionEmptyThread.invite', 'Invite')}
        </button>
      </div>

      <p className="mt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        {routingText}
      </p>
    </div>
  )
}
