import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, MessageSquare, Users } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { formatRelativeTime } from '@/lib/date-format'
import { loadSessionIdsForActor } from '@/lib/session-by-actor'
import { ActorDetailContent } from '@/components/sidebar/ActorDetailContent'
import {
  useActorDirectory,
  toActorKind,
  type ActorRow,
} from '@/stores/actor-directory-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useUIStore } from '@/stores/ui'
import { useActorDetailStore } from '@/stores/actor-detail-store'

interface Props {
  actorId: string
}

/**
 * Actor profile in the main column, opened from the Contacts list.
 *
 * Clicking a row used to jump straight into a new draft session addressed to
 * that actor — which was wrong for an external gateway contact (nothing on our
 * side can deliver to them) and premature for everyone else. Now the click shows
 * who they are, and "Start session" is one explicit button inside the profile.
 */
export function ActorDetailPane({ actorId }: Props) {
  const { t } = useTranslation()
  const { actors, teamId, refetch } = useActorDirectory()

  const fromDirectory = React.useMemo(
    () => actors.find((a) => a.id === actorId) ?? null,
    [actors, actorId],
  )

  // The directory row paints immediately. A row the directory does not hold —
  // it was removed, or the tab was restored before the list loaded — is fetched
  // on its own so the pane can still show something real.
  const [fetched, setFetched] = React.useState<ActorRow | null>(null)
  const [resolving, setResolving] = React.useState(false)
  React.useEffect(() => {
    if (fromDirectory) return
    setResolving(true)
    let cancelled = false
    void (async () => {
      try {
        const entry = await getBackend().actors.getActorDirectoryEntry(actorId)
        if (cancelled || !entry) return
        setFetched({
          id: entry.id,
          actor_type: toActorKind(entry.actor_type),
          display_name: entry.display_name || entry.id,
          avatar_url: entry.avatar_url ?? null,
          member_status: entry.member_status ?? null,
          agent_status: entry.agent_status ?? null,
          last_active_at: entry.last_active_at ?? null,
          created_at: entry.created_at ?? null,
          team_role: entry.team_role ?? null,
          visibility: entry.visibility ?? null,
          owner_member_id: entry.agent_owner_member_id ?? null,
          agent_types: entry.agent_types ?? null,
          default_agent_type: entry.default_agent_type ?? null,
          default_workspace_id: entry.default_workspace_id ?? null,
          user_id: entry.user_id ?? null,
          email: entry.email ?? null,
          phone: entry.phone ?? null,
          source: entry.source ?? null,
          source_id: entry.source_id ?? null,
        })
      } catch {
        // Leave the not-found state below.
      } finally {
        if (!cancelled) setResolving(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [actorId, fromDirectory])

  const actor = fromDirectory ?? fetched

  if (!actor) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {resolving
          ? t('common.loading', 'Loading…')
          : t('actors.detail.notFound', 'This actor is no longer in the team directory.')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <ActorDetailContent
        actor={actor}
        teamId={teamId}
        onRemoved={refetch}
        extraSections={<ActorSessionsSection actorId={actor.id} teamId={teamId} />}
      />
    </div>
  )
}

/**
 * Sessions this actor takes part in.
 *
 * Resolved as "the ids they participate in" ∩ "the sessions already loaded",
 * the same way SessionContinueBanner does it — and with the same limitation: a
 * session older than the loaded pages is not listed.
 */
function ActorSessionsSection({ actorId, teamId }: { actorId: string; teamId: string | null }) {
  const { t } = useTranslation()
  const sessionRows = useSessionListStore((s) => s.rows)
  const [participatingIds, setParticipatingIds] = React.useState<Set<string> | null>(null)

  React.useEffect(() => {
    setParticipatingIds(null)
    if (!teamId) return
    let cancelled = false
    void (async () => {
      const ids = await loadSessionIdsForActor(actorId, teamId)
      if (!cancelled) setParticipatingIds(ids)
    })()
    return () => {
      cancelled = true
    }
  }, [actorId, teamId])

  const sessions = React.useMemo(() => {
    if (!participatingIds) return []
    return sessionRows.filter((row) => participatingIds.has(row.id)).slice(0, 20)
  }, [participatingIds, sessionRows])

  return (
    <div className="mt-8 border-t border-border-soft pt-5">
      <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        {t('actors.detail.sessions', 'Sessions')}
      </div>
      {sessions.length === 0 ? (
        <p className="text-[12.5px] leading-5 text-muted-foreground">
          {participatingIds === null
            ? t('common.loading', 'Loading…')
            : t('actors.detail.noSessions', 'No sessions with this actor yet.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => void useUIStore.getState().switchToSession(session.id)}
                className="flex w-full items-center gap-2.5 rounded-[10px] border border-border-soft bg-paper px-3 py-2.5 text-left transition-colors hover:bg-selected"
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {session.title || t('chat.untitledSession', '(untitled)')}
                  </span>
                  {session.last_message_preview && (
                    <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-muted-foreground">
                      {session.last_message_preview}
                    </span>
                  )}
                </span>
                {session.last_message_at && (
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    {formatRelativeTime(new Date(session.last_message_at))}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The Contacts section's main-content column: the selected profile, or a quiet hint. */
export function ActorsDetailColumn() {
  const { t } = useTranslation()
  const actorId = useActorDetailStore((s) => s.actorId)
  if (actorId) return <ActorDetailPane key={actorId} actorId={actorId} />
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
      data-tauri-drag-region
    >
      <Users className="h-8 w-8" />
      <span className="text-sm">
        {t('actors.detailEmpty', 'Select a contact to view their profile')}
      </span>
    </div>
  )
}
