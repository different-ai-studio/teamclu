import * as React from 'react'
import { runtimeHintsForAgents } from '@/lib/agent/runtime-state-resolve'
import { attachmentsForSession } from '@/stores/runtime-state-store'
import { useTranslation } from 'react-i18next'
import { AtSign, Loader2, Search, Users, User as UserIcon, Sparkles, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { getBackend } from '@/lib/backend'
import { loadActorsForTeam, loadActorsByIds, loadSessionParticipants } from '@/lib/cache/local-cache'
import {
  getSessionCreatedByActorId,
  resolveSessionCreatedByActorId,
} from '@/lib/session/session-created-by-cache'
import { syncActorsForTeam } from '@/lib/sync/actor-sync'
import { syncParticipantsForSession } from '@/lib/sync/session-participant-sync'
import { cn } from '@/lib/utils'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import {
  presenceOnlineFlag,
  resolveAgentDevicePresenceSync,
} from '@/lib/agent/agent-device-reachability'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { resolveAmuxAgentType } from '@/lib/agent/amux-agent-type'
import { useSessionParticipantStore } from '@/stores/session-participant-store'
import { isAgentActorType } from '@/lib/actor/actor-type'
import { actorAvatarColor } from '@/lib/actor/actor-color'
import {
  loadAgentWorkspaceLookups,
  resolveAgentRuntimeWorkspaceId,
  runtimeStartWorkspaceArgs,
} from '@/lib/teamclu/resolve-runtime-start-workspace'

/** Temporarily disabled — re-enable when session kick/remove is ready to ship. */
const SESSION_REMOVE_PARTICIPANT_ENABLED = false

// ── Types ──────────────────────────────────────────────────────────────────

type Row = {
  id: string
  /// `external` is the person on the other end of a gateway chat (WeCom,
  /// Feishu). They are participants like anyone else — the panel used to
  /// filter them out, so its header counted three and its list showed two.
  actor_type: 'member' | 'agent' | 'external'
  display_name: string
  member_status: string | null
  agent_status: string | null
  agent_types: string[]
  default_agent_type: string | null
  last_active_at: string | null
}

type CandidateActor = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
  member_status: string | null
  agent_status: string | null
  agent_types: string[]
  default_agent_type: string | null
  last_active_at: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isOnline(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false
  const t = Date.parse(lastActiveAt)
  if (Number.isNaN(t)) return false
  return Date.now() - t < 5 * 60 * 1000
}

function normalizeAgentTypes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
}

function pickAgentBackend(
  defaultAgentType: string | null | undefined,
  agentTypes: string[],
  priorBackendType: string | null | undefined,
): string | null {
  const normalizedDefault = defaultAgentType === 'claude_code' || defaultAgentType === 'claude-code'
    ? 'claude'
    : defaultAgentType ?? null
  if (normalizedDefault && (agentTypes.length === 0 || agentTypes.includes(normalizedDefault))) {
    return normalizedDefault
  }
  return agentTypes[0] ?? priorBackendType ?? null
}

function computeDotStateAndAnimation(
  actor: Row,
  runtimeInfo: RuntimeInfo | undefined,
  agentDeviceOnline: boolean | undefined,
): { color: string; breathing: boolean } {
  if (actor.actor_type === 'member') {
    return {
      color: isOnline(actor.last_active_at) ? 'bg-emerald-500' : 'bg-muted-foreground/40',
      breathing: false,
    }
  }
  // Agent. Offline-wins: MQTT ActorPresence (LWT-backed) is authoritative for
  // "is the daemon reachable?". An ACTIVE runtime retain can linger on the
  // broker after the daemon dies, so suppress green when device is offline.
  if (agentDeviceOnline === false) {
    return { color: 'bg-muted-foreground/40', breathing: false }
  }
  if (!runtimeInfo) {
    return { color: 'bg-muted-foreground/40', breathing: false }
  }
  switch (runtimeInfo.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', breathing: false }
    case RuntimeLifecycle.STARTING:
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
      return { color: 'bg-muted-foreground/40', breathing: false }
    case RuntimeLifecycle.ACTIVE:
      switch (runtimeInfo.status) {
        case AgentStatus.ACTIVE:
          return { color: 'bg-emerald-500', breathing: true }
        case AgentStatus.IDLE:
          return { color: 'bg-emerald-500', breathing: false }
        case AgentStatus.ERROR:
          return { color: 'bg-red-500', breathing: false }
        default:
          return { color: 'bg-muted-foreground/40', breathing: false }
      }
    default:
      return { color: 'bg-muted-foreground/40', breathing: false }
  }
}

function mapCachedActor(a: {
  id: string
  actorType: string
  displayName: string
  memberStatus?: string | null
  agentStatus?: string | null
}): Row {
  return {
    id: a.id,
    actor_type: a.actorType as 'member' | 'agent' | 'external',
    display_name: a.displayName,
    member_status: a.memberStatus ?? null,
    agent_status: a.agentStatus ?? null,
    agent_types: [],
    default_agent_type: null,
    last_active_at: null,
  }
}

async function fetchParticipantsFromSupabase(sessionId: string): Promise<{ ids: string[]; rows: Row[] }> {
  const actors = await getBackend().sessionMembers.listParticipants(sessionId)
  const ids = actors.map((p) => p.id).filter(Boolean)
  return {
    ids,
    rows: actors
      .filter(
        (a) =>
          a.actor_type === 'member' ||
          a.actor_type === 'agent' ||
          a.actor_type === 'external',
      )
      .map((a) => ({
        id: a.id,
        actor_type: a.actor_type as 'member' | 'agent' | 'external',
        display_name: a.display_name || '',
        member_status: a.member_status ?? null,
        agent_status: a.agent_status ?? null,
        agent_types: normalizeAgentTypes(a.agent_types),
        default_agent_type: a.default_agent_type ?? null,
        last_active_at: a.last_active_at ?? null,
      })),
  }
}

// Rows built from the local libsql cache only mirror columns on public.actors,
// so agent_types / default_agent_type (which live on public.agents) come back
// null. Patch them in via a single actor_directory lookup so the subline can
// render "<backend> · <model>" for cached agent rows too.
async function enrichAgentMetadata<T extends { id: string; agent_types: string[]; default_agent_type: string | null }>(
  rows: T[],
  isAgent: (row: T) => boolean,
): Promise<T[]> {
  const missingIds = rows
    .filter((r) => isAgent(r) && (r.agent_types.length === 0 || r.default_agent_type == null))
    .map((r) => r.id)
  if (missingIds.length === 0) return rows
  let data: Awaited<ReturnType<ReturnType<typeof getBackend>['runtime']['listAgentDefaults']>>
  try {
    data = await getBackend().runtime.listAgentDefaults(missingIds)
  } catch (error) {
    console.warn('[SessionActorSheet] agent metadata enrichment failed', error)
    return rows
  }
  const byId = new Map(
    data
      .map((d) => [d.id, d] as const),
  )
  return rows.map((r) => {
    const extra = byId.get(r.id)
    if (!extra) return r
    return {
      ...r,
      agent_types: r.agent_types.length > 0 ? r.agent_types : normalizeAgentTypes(extra.agent_types),
      default_agent_type: r.default_agent_type ?? extra.default_agent_type ?? null,
    }
  })
}

async function fetchCandidateActorsFromSupabase(teamId: string, presentIds: Set<string>): Promise<CandidateActor[]> {
  return (await getBackend().sessionMembers.listCandidateActors(teamId, Array.from(presentIds)))
    .filter((a) => a.actor_type === 'member' || a.actor_type === 'agent')
    .map((a) => ({
      id: a.id,
      actor_type: a.actor_type as 'member' | 'agent',
      display_name: a.display_name || '',
      member_status: a.member_status ?? null,
      agent_status: a.agent_status ?? null,
      agent_types: normalizeAgentTypes(a.agent_types),
      default_agent_type: a.default_agent_type ?? null,
      last_active_at: a.last_active_at ?? null,
    }))
}

// ── ActorRowView ───────────────────────────────────────────────────────────

function ActorRowView({
  actor,
  runtimeInfo,
  canRemove,
  showOwnerLabel,
  onRemove,
}: {
  actor: Row
  runtimeInfo?: RuntimeInfo
  canRemove: boolean
  showOwnerLabel: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const initials = actor.display_name?.slice(0, 2).toUpperCase() || ''
  // Shared device-presence merge (same rule as runtime gate / sidebar).
  // Subscribe to MQTT presence so re-renders happen; resolve via sync helper
  // which can override stale LWT with cached local daemon signals.
  useActorPresenceStore((s) => (isAgent ? s.byActorId[actor.id]?.online : undefined))
  const agentDeviceOnline = isAgent
    ? presenceOnlineFlag(resolveAgentDevicePresenceSync(actor.id))
    : undefined
  const { color: dotColor, breathing } = computeDotStateAndAnimation(actor, runtimeInfo, agentDeviceOnline)
  // For agents, show "<backend type> · <model>" — e.g. "claude · claude-opus-4-7".
  // backend type = default_agent_type (claude | opencode | codex).
  // model = runtimeInfo.currentModel when a runtime is live; otherwise omitted.
  const modelName = isAgent ? (runtimeInfo?.currentModel || null) : null
  let subline: string
  if (isAgent) {
    const parts: string[] = []
    const backend = pickAgentBackend(actor.default_agent_type, actor.agent_types, null)
    if (backend) parts.push(backend)
    if (modelName) parts.push(modelName)
    subline = parts.join(' · ')
  } else {
    subline = actor.member_status || ''
  }
  const c = actorAvatarColor(actor.id)

  return (
    <div className="group relative flex items-center gap-3 px-[22px] py-[7px] hover:bg-selected/30">
      <div
        className={cn(
          'relative flex h-[25px] w-[25px] shrink-0 items-center justify-center text-[12.5px] font-semibold text-white',
          isAgent ? 'rounded-md' : 'rounded-full',
        )}
        style={{ background: c.bg, color: c.fg }}
      >
        {initials.slice(0, 1) || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-paper',
            dotColor,
            breathing && 'animate-pulse',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13.5px] font-semibold text-foreground">{actor.display_name}</div>
          {isAgent && (
            <span className="shrink-0 rounded-[5px] border border-coral px-[5px] py-[1px] font-mono text-[9.5px] font-semibold leading-none text-coral">
              AI
            </span>
          )}
        </div>
        {subline && (
          <div className="truncate text-[11px] leading-[17px] text-muted-foreground">{subline}</div>
        )}
      </div>
      {canRemove ? (
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-selected hover:text-ink-2"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={t('chat.actorSheet.removeAria', 'Remove')}
        >
          <X className="h-4 w-4" />
        </button>
      ) : showOwnerLabel ? (
        <span className="shrink-0 text-[11px] text-faint">{t('chat.actorSheet.ownerLabel', '所有者')}</span>
      ) : null}
    </div>
  )
}

function CandidateActorRowView({
  actor,
  adding,
  onAdd,
}: {
  actor: CandidateActor
  adding: boolean
  onAdd: () => void
}) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const c = actorAvatarColor(actor.id)
  const initials = actor.display_name?.slice(0, 1).toUpperCase() || ''
  const backend = isAgent ? pickAgentBackend(actor.default_agent_type, actor.agent_types, null) : null
  const subline = isAgent
    ? [actor.agent_status, backend].filter(Boolean).join(' · ')
    : actor.member_status || ''

  return (
    <div className="flex items-center gap-3 px-[22px] py-[7px]">
      <div
        className={cn(
          'relative flex h-[25px] w-[25px] shrink-0 items-center justify-center text-[12.5px] font-semibold text-white',
          isAgent ? 'rounded-md ring-2 ring-coral' : 'rounded-full',
        )}
        style={{ background: c.bg, color: c.fg }}
      >
        {initials || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-paper',
            isAgent ? 'border-2 border-coral bg-paper' : 'bg-emerald-500',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13.5px] font-semibold text-foreground">{actor.display_name}</div>
          {isAgent && (
            <span className="shrink-0 rounded-[5px] border border-coral px-[5px] py-[1px] font-mono text-[9.5px] font-semibold leading-none text-coral">
              AI
            </span>
          )}
        </div>
        {subline && <div className="truncate text-[11px] leading-[17px] text-muted-foreground">{subline}</div>}
      </div>
      <button
        type="button"
        className="shrink-0 rounded-[7px] border border-coral/35 px-2.5 py-[6px] text-[12px] font-semibold leading-none text-coral transition-colors hover:bg-coral-soft disabled:opacity-50"
        onClick={onAdd}
        disabled={adding}
        aria-label={t('chat.actorSheet.addCandidateAria', '+ 加入')}
      >
        {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('chat.actorSheet.addCandidate', '+ 加入')}
      </button>
    </div>
  )
}

// ── SessionActorPanel ──────────────────────────────────────────────────────
// Renders inline (e.g., inside the workspace RightPanel) — no Sheet wrapper.
// Visibility is controlled by the parent panel; this component just renders
// the list + handlers + confirm dialog.

interface SessionActorPanelProps {
  sessionId: string | null
  teamId: string | null
}

export function SessionActorPanel({ sessionId, teamId }: SessionActorPanelProps) {
  // Effect-trigger gate: when the panel mounts we want the same "open"
  // semantics as the old Sheet had (clear stale rows, refetch on
  // session/team change). The component is always "open" while mounted,
  // so we read the same flag from a hardcoded true below.
  const open = true
  const { t } = useTranslation()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [rows, setRows] = React.useState<Row[]>([])
  const [myActorId, setMyActorId] = React.useState<string | null>(null)
  const [createdByActorId, setCreatedByActorId] = React.useState<string | null>(
    () => (sessionId ? getSessionCreatedByActorId(sessionId) : null),
  )
  const [pendingRemove, setPendingRemove] = React.useState<Row | null>(null)
  const [candidateActors, setCandidateActors] = React.useState<CandidateActor[]>([])
  const [addingActorId, setAddingActorId] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')

  const runtimeStates = useRuntimeStateStore(s => s.byRuntimeId)

  React.useEffect(() => {
    // Clear stale data whenever the sheet closes or the session changes —
    // otherwise switching to a new session leaves the previous session's
    // rows visible until the new fetch lands (or forever, if the new
    // session is null/empty).
    setRows([])
    setMyActorId(null)
    setCreatedByActorId(sessionId ? getSessionCreatedByActorId(sessionId) : null)
    setError(false)
    setCandidateActors([])
    setAddingActorId(null)
    if (!open) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    // When there's no active session yet (brand-new chat) but we have a team
    // context, still query candidate agents so the + button can render. The
    // "+" handler itself guards against null sessionId.
    if (!sessionId) {
      if (teamId) {
        void (async () => {
          // Phase 1: load candidate agents from local cache instantly.
          const cached = await loadActorsForTeam(teamId)
          if (cancelled) return
          setCandidateActors(
            cached
              .filter(a => a.actorType === 'agent' || a.actorType === 'member')
              .map(a => ({
                id: a.id,
                actor_type: a.actorType === 'agent' ? 'agent' : 'member',
                display_name: a.displayName,
                member_status: a.memberStatus ?? null,
                agent_status: a.agentStatus ?? null,
                agent_types: [],
                default_agent_type: null,
                last_active_at: null,
              })),
          )
          setLoading(false)
          // Phase 2: refresh in background.
          void syncActorsForTeam(teamId)
        })()
      } else {
        setLoading(false)
      }
      return () => { cancelled = true }
    }

    /** Apply a snapshot of (participants, actors, candidate agents) to UI. */
    function applySnapshot(
      actorIds: string[],
      actorRows: Row[],
      candidates: CandidateActor[],
    ) {
      setRows(actorRows)
      setCandidateActors(candidates)
      // The roster this sheet just resolved is the same roster the mention
      // popover, the composer's auto-engage and the session list read out of
      // the participant store. Keeping it local is what let the sheet list an
      // agent nobody else could see. Detail (statuses, agent types, presence)
      // stays here; membership does not.
      if (!sessionId) return
      useSessionParticipantStore.getState().setParticipants(
        sessionId,
        actorRows.map((row) => ({
          actorId: row.id,
          displayName: row.display_name?.trim() || row.id,
          avatarUrl: null,
          isAgent: isAgentActorType(row.actor_type),
          // This sheet manages team membership and filters its rows to
          // member/agent, so it never carries an external. The store keeps
          // the ones it already knows rather than reading this as "they left".
          isExternal: false,
        })),
      )
    }

    void (async () => {
      // ────────────────────────────────────────────────────────────────
      // Phase 1: instant render from local libsql cache
      // ────────────────────────────────────────────────────────────────
      const [cachedParticipants, cachedTeamActors, creatorActorId] = await Promise.all([
        loadSessionParticipants(sessionId),
        teamId ? loadActorsForTeam(teamId) : Promise.resolve([]),
        resolveSessionCreatedByActorId(sessionId, teamId),
      ])
      if (cancelled) return
      setCreatedByActorId(creatorActorId)

      const cachedActorIds = cachedParticipants.map(p => p.actorId)
      const cachedPresentSet = new Set(cachedActorIds)
      const cachedById = new Map(cachedTeamActors.map(a => [a.id, a]))

      // If team cache misses any participant (rare), fall back to id-lookup.
      const missingIds = cachedActorIds.filter(id => !cachedById.has(id))
      if (missingIds.length > 0) {
        const extra = await loadActorsByIds(missingIds)
        if (cancelled) return
        for (const a of extra) cachedById.set(a.id, a)
      }

      let cachedRows: Row[] = cachedActorIds
        .map(id => cachedById.get(id))
        .filter((a): a is NonNullable<typeof a> => !!a)
        .map(mapCachedActor)

      let cachedCandidates: CandidateActor[] = cachedTeamActors
        .filter(a => (a.actorType === 'agent' || a.actorType === 'member') && !cachedPresentSet.has(a.id))
        .map(a => ({
          id: a.id,
          actor_type: a.actorType === 'agent' ? 'agent' : 'member',
          display_name: a.displayName,
          member_status: a.memberStatus ?? null,
          agent_status: a.agentStatus ?? null,
          // ActorRow cache lacks agent_types / default_agent_type today; the
          // Backend fallback supplies them when no cached row matches.
          agent_types: [],
          default_agent_type: null,
          last_active_at: null,
        }))

      let effectiveActorIds = cachedActorIds
      if (cachedRows.length === 0) {
        const live = await fetchParticipantsFromSupabase(sessionId)
        if (cancelled) return
        cachedRows = live.rows
        effectiveActorIds = live.ids
      } else {
        cachedRows = await enrichAgentMetadata(cachedRows, (r) => r.actor_type === 'agent')
        if (cancelled) return
      }
      if (teamId && cachedCandidates.length === 0) {
        cachedCandidates = await fetchCandidateActorsFromSupabase(
          teamId,
          new Set(effectiveActorIds),
        )
        if (cancelled) return
      } else {
        cachedCandidates = await enrichAgentMetadata(cachedCandidates, () => true)
        if (cancelled) return
      }

      applySnapshot(effectiveActorIds, cachedRows, cachedCandidates)
      setLoading(false)

      // ────────────────────────────────────────────────────────────────
      // Phase 2: background sync (participants + team actors), re-hydrate
      // ────────────────────────────────────────────────────────────────
      if (teamId) {
        await Promise.all([
          syncParticipantsForSession(sessionId, teamId),
          syncActorsForTeam(teamId),
        ])
        if (cancelled) return

        const [freshParticipants, freshTeamActors] = await Promise.all([
          loadSessionParticipants(sessionId),
          loadActorsForTeam(teamId),
        ])
        if (cancelled) return

        const freshIds = freshParticipants.map(p => p.actorId)
        const freshPresent = new Set(freshIds)
        const freshById = new Map(freshTeamActors.map(a => [a.id, a]))
        const stillMissing = freshIds.filter(id => !freshById.has(id))
        if (stillMissing.length > 0) {
          const extra = await loadActorsByIds(stillMissing)
          if (cancelled) return
          for (const a of extra) freshById.set(a.id, a)
        }

        let freshRows: Row[] = freshIds
          .map(id => freshById.get(id))
          .filter((a): a is NonNullable<typeof a> => !!a)
          .map(mapCachedActor)

        let freshCandidates: CandidateActor[] = freshTeamActors
          .filter(a => (a.actorType === 'agent' || a.actorType === 'member') && !freshPresent.has(a.id))
          .map(a => ({
          id: a.id,
          actor_type: a.actorType === 'agent' ? 'agent' : 'member',
          display_name: a.displayName,
          member_status: a.memberStatus ?? null,
          agent_status: a.agentStatus ?? null,
          // ActorRow cache lacks agent_types / default_agent_type today; the
          // Backend fallback supplies them when no cached row matches.
          agent_types: [],
          default_agent_type: null,
          last_active_at: null,
        }))

        let effectiveFreshIds = freshIds
        if (freshRows.length === 0) {
          const live = await fetchParticipantsFromSupabase(sessionId)
          if (cancelled) return
          freshRows = live.rows
          effectiveFreshIds = live.ids
        } else {
          freshRows = await enrichAgentMetadata(freshRows, (r) => r.actor_type === 'agent')
          if (cancelled) return
        }
        if (freshCandidates.length === 0) {
          freshCandidates = await fetchCandidateActorsFromSupabase(
            teamId,
            new Set(effectiveFreshIds),
          )
          if (cancelled) return
        } else {
          freshCandidates = await enrichAgentMetadata(freshCandidates, () => true)
          if (cancelled) return
        }

        applySnapshot(effectiveFreshIds, freshRows, freshCandidates)
      }

      try {
        // ──────────────────────────────────────────────────────────────
        // Live-state lookups that aren't cached: agent runtime hints +
        // my-actor. These must not hide the participant list when they fail.
        // ──────────────────────────────────────────────────────────────
        let finalActorIds = (await loadSessionParticipants(sessionId)).map(p => p.actorId)
        if (finalActorIds.length === 0) {
          finalActorIds = (await fetchParticipantsFromSupabase(sessionId)).ids
        }
        if (cancelled) return

        const authSession = await getBackend().auth.getSession()
        if (cancelled) return

        const user = authSession?.user
        if (user && teamId && finalActorIds.length > 0) {
          const myActor = await getBackend().directory.resolveCurrentMemberActor(teamId, user.id)
          if (cancelled) return
          setMyActorId(myActor && finalActorIds.includes(myActor.id) ? myActor.id : null)
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('[SessionActorSheet] enrichment failed', e)
        }
      }
    })().catch(e => {
      if (cancelled) return
      console.error('[SessionActorSheet] load failed', e)
      setError(true)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [open, sessionId, teamId])

  async function confirmRemove(actor: Row) {
    if (!sessionId) return
    const prevRows = rows
    // Optimistic: drop the row immediately
    setRows(prev => prev.filter(r => r.id !== actor.id))
    setPendingRemove(null)
    try {
      await getBackend().sessionMembers.removeParticipant(sessionId, actor.id)
      await useSessionParticipantStore.getState().refreshSession(sessionId, teamId)
    } catch (deleteErr) {
      console.error('[SessionActorSheet] remove failed:', deleteErr)
      // Rollback
      setRows(prevRows)
      // Toast
      const { toast } = await import('sonner')
      toast.error(t('chat.actorSheet.removeError', 'Failed to remove from session'))
    }
  }

  async function handleAddActor(candidate: CandidateActor) {
    if (!sessionId || !teamId) return
    if (addingActorId) return
    setAddingActorId(candidate.id)

    // Snapshot for rollback
    const prevRows = rows
    const prevCandidates = candidateActors

    // Optimistic: insert immediately so the split between current and invite
    // candidates feels direct.
    const newRow: Row = {
      id: candidate.id,
      actor_type: candidate.actor_type,
      display_name: candidate.display_name,
      member_status: candidate.member_status,
      agent_status: candidate.actor_type === 'agent' ? 'starting' : candidate.agent_status,
      agent_types: candidate.agent_types,
      default_agent_type: candidate.default_agent_type,
      last_active_at: candidate.last_active_at,
    }
    setRows(prev => [...prev, newRow])
    setCandidateActors(prev => prev.filter(c => c.id !== candidate.id))

    try {
      await getBackend().sessionMembers.addParticipant(sessionId, candidate.id)

      if (candidate.actor_type !== 'agent') {
        await useSessionParticipantStore.getState().refreshSession(sessionId, teamId)
        return
      }

      // 2. Resolve cloud workspace id for this agent (path resolved on target daemon).
      const priorRows = runtimeHintsForAgents(
        [candidate.id],
        useRuntimeStateStore.getState().byRuntimeId,
      )
      const workspaceLookups = await loadAgentWorkspaceLookups(teamId, sessionId, [candidate.id]).catch(() => new Map())
      const workspaceId = resolveAgentRuntimeWorkspaceId(
        workspaceLookups.get(candidate.id) ?? {},
      )
      // Prefer the agent's explicit default_agent_type (set via UI) over the
      // backend_type recorded from the agent's prior runtime — the prior value
      // can lag if the operator changed the default after the last spawn.
      const backendType = pickAgentBackend(
        candidate.default_agent_type,
        candidate.agent_types,
        priorRows?.[0]?.backend_type ?? null,
      )
      const agentType = resolveAmuxAgentType(backendType)

      // 3. Call runtimeStart RPC. Daemon may reject if it already has a
      //    runtime for this (session, agent) — treat that as success since
      //    the existing runtime will service the next prompt anyway.
      const { runtimeStart } = await import('@/lib/daemon/teamclu-rpc')
      try {
        const result = await runtimeStart({
          targetActorId: candidate.id,
          ...runtimeStartWorkspaceArgs(workspaceId),
          sessionId,
          agentType,
          initialPrompt: '',
        })
        if (!result.accepted) {
          // Tolerate "already running"-style rejections — log and proceed.
          console.warn('[SessionActorSheet] runtimeStart rejected (non-fatal):', result.rejectedReason)
        }
      } catch (rpcErr) {
        console.warn('[SessionActorSheet] runtimeStart threw (non-fatal):', rpcErr)
      }
      // RuntimeInfo retain will arrive via store subscription and update the dot/model automatically
      await useSessionParticipantStore.getState().refreshSession(sessionId, teamId)
    } catch (e) {
      console.error('[SessionActorSheet] add actor failed:', e)
      // Rollback
      setRows(prevRows)
      setCandidateActors(prevCandidates)
      const { toast } = await import('sonner')
      toast.error(t('chat.actorSheet.addError', 'Failed to add agent'))
    } finally {
      setAddingActorId(null)
    }
  }

  const members = rows.filter((a) => a.actor_type === 'member')
  const agents = rows.filter((a) => a.actor_type === 'agent')
  const externals = rows.filter((a) => a.actor_type === 'external')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleCandidates = normalizedQuery
    ? candidateActors.filter((a) => {
      const haystack = [
        a.display_name,
        a.member_status,
        a.agent_status,
        a.default_agent_type,
        ...a.agent_types,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(normalizedQuery)
    })
    : candidateActors

  return (
    <>
      <div className="flex h-full flex-col bg-paper text-foreground">
        <div className="flex h-[46px] shrink-0 items-center border-b border-border px-[22px]">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[13.5px] font-bold">{t('chat.actorSheet.title', '参与者')}</h2>
            <span className="font-mono text-[12px] text-faint">·</span>
            <span className="font-mono text-[12px] text-faint">{rows.length}</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {loading && (
              <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                <span>{t('chat.actorSheet.loading', 'Loading actors...')}</span>
              </div>
            )}

            {!loading && error && (
              <div className="px-4 py-3 text-sm text-destructive">
                {t('chat.actorSheet.error', 'Failed to load actors')}
              </div>
            )}

            {!loading && !error && members.length === 0 && agents.length === 0 && candidateActors.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
                <Users className="mb-2 h-8 w-8 text-muted-foreground" />
                <span>{t('chat.actorSheet.empty', 'No participants in this session')}</span>
              </div>
            )}

            {!loading && !error && (members.length > 0 || agents.length > 0 || externals.length > 0 || candidateActors.length > 0) && (
              <>
                {agents.length > 0 && (
                  <>
                    <div className="px-[22px] pb-1.5 pt-[13px] text-[9.5px] font-semibold uppercase tracking-[0.6px] text-faint">
                      {t('chat.actorSheet.agentSection', 'AGENT')} <span className="font-mono">· {agents.length}</span>
                    </div>
                    {agents.map((a) => {
                      // Look the attachment up by (actor, session), not by the
                      // runtime id: that id is the command address, while the
                      // store is keyed so two machines serving one session do
                      // not evict each other.
                      const info = attachmentsForSession(sessionId ?? '', runtimeStates).find(
                        (e) => e.daemonActorId === a.id,
                      )?.info
                      return (
                      <ActorRowView
                        key={a.id}
                        actor={a}
                        runtimeInfo={info}
                        canRemove={SESSION_REMOVE_PARTICIPANT_ENABLED && !!myActorId}
                        showOwnerLabel={!!createdByActorId && a.id === createdByActorId}
                        onRemove={() => setPendingRemove(a)}
                      />
                      )
                    })}
                  </>
                )}
                {members.length > 0 && (
                  <>
                    <div className="px-[22px] pb-1.5 pt-[13px] text-[9.5px] font-semibold uppercase tracking-[0.6px] text-faint">
                      {t('chat.actorSheet.teamSection', '团队')} <span className="font-mono">· {members.length}</span>
                    </div>
                    {members.map((m) => (
                      <ActorRowView
                        key={m.id}
                        actor={m}
                        canRemove={SESSION_REMOVE_PARTICIPANT_ENABLED && !!myActorId && m.id !== myActorId}
                        showOwnerLabel={!!createdByActorId && m.id === createdByActorId}
                        onRemove={() => setPendingRemove(m)}
                      />
                    ))}
                  </>
                )}
                {externals.length > 0 && (
                  <>
                    <div className="px-[22px] pb-1.5 pt-[13px] text-[9.5px] font-semibold uppercase tracking-[0.6px] text-faint">
                      {t('chat.actorSheet.externalSection', '外部联系人')}{' '}
                      <span className="font-mono">· {externals.length}</span>
                    </div>
                    {externals.map((e) => (
                      <ActorRowView
                        key={e.id}
                        actor={e}
                        // They joined by writing to the bot; removing them here
                        // would be undone by their next message.
                        canRemove={false}
                        showOwnerLabel={false}
                        onRemove={() => {}}
                      />
                    ))}
                  </>
                )}
                {candidateActors.length > 0 && (
                  <div className="mt-[18px] border-t border-border-soft pt-[13px]">
                    <div className="px-[22px] pb-2 text-[9.5px] font-semibold uppercase tracking-[0.6px] text-faint">
                      {t('chat.actorSheet.inviteSection', '邀请加入')} <span className="font-mono">· {candidateActors.length}</span>
                    </div>
                    <div className="px-[22px] pb-3">
                      <div className="flex h-[34px] items-center gap-2 rounded-[7px] border border-border bg-background px-2.5 text-muted-foreground">
                        <Search className="h-4 w-4 shrink-0 text-foreground" />
                        <input
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder={t('chat.actorSheet.searchPlaceholder', '搜索成员或 Agent...')}
                          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
                        />
                      </div>
                    </div>
                    {visibleCandidates.map((candidate) => (
                      <CandidateActorRowView
                        key={candidate.id}
                        actor={candidate}
                        adding={addingActorId === candidate.id}
                        onAdd={() => void handleAddActor(candidate)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
        </div>
        <div className="flex h-[44px] shrink-0 items-center gap-2.5 border-t border-border bg-background px-[22px] text-[11px] text-muted-foreground">
          <AtSign className="h-4 w-4" />
          <span>{t('chat.actorSheet.historyHint', '加入后将看到完整历史')}</span>
        </div>
      </div>

      <AlertDialog open={!!pendingRemove} onOpenChange={(open) => { if (!open) setPendingRemove(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.actorSheet.removeTitle', 'Remove from session?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove && t('chat.actorSheet.removeDesc', 'Remove {{name}} from this session?', { name: pendingRemove.display_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingRemove) void confirmRemove(pendingRemove) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('chat.actorSheet.removeConfirm', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
