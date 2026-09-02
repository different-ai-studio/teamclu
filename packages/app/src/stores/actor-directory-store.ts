import * as React from 'react'
import { create } from 'zustand'
import { getBackend } from '@/lib/backend'
import {
  loadActorsForTeam,
  upsertActorsBatch,
  type ActorRow as CachedActorRow,
} from '@/lib/local-cache'
import { isTauri } from '@/lib/utils'
import { isActorOnline, resolveActorOnlineStatus } from '@/lib/actor-online'
import { useCurrentTeamStore } from '@/stores/current-team'

export { isActorOnline, resolveActorOnlineStatus }

/**
 * actor-directory-store — single reactive source of truth for a team's actor
 * directory (members + agents), shared by the Contacts panel, the left-sidebar
 * RECENTS group, and the new-session picker.
 *
 * Replaces the old per-component `useActorsForTeam` fetch-once hook. The old
 * hook loaded once per `[teamId]` and never re-read, so a cold first launch
 * (empty libsql cache) captured whatever the single early fetch returned —
 * often before this session's presence/heartbeat had populated `last_active_at`
 * — and stayed frozen until the app was restarted (which read the now-warm
 * cache). This store keeps the list live via three signals:
 *
 *   1. cache-first read + one network reconcile on first `ensure(teamId)`
 *   2. `notifyActorDirectorySynced(teamId)` — the background `syncActorsForTeam`
 *      (App.tsx, fired after MQTT connects) calls this on completion, so the
 *      list re-reads once fresh server data lands without a restart
 *   3. a 60s periodic reconcile (tauri only) so member `last_active_at` and the
 *      relative-time labels age correctly during a long session
 */

/**
 * The three actor kinds. `external` is a gateway contact (WeCom / WeChat /
 * Feishu / Discord / KOOK / SeaTalk / email) that amuxd created on the first
 * inbound message — a real row in the same team directory, but not a teammate
 * and not an agent: it has no team role, no membership, and cannot be mentioned
 * or added to a session from the client.
 *
 * It used to be flattened into `member` here, which put every WeCom contact in
 * the members list wearing the "Team" subtitle.
 */
type ActorKind = 'member' | 'agent' | 'external'

export type ActorRow = {
  id: string
  actor_type: ActorKind
  display_name: string
  // Real avatar image URL; the detail dialog falls back to display-name initials
  // when absent. Carried on the network directory row (not the libsql cache).
  avatar_url?: string | null
  member_status: string | null
  agent_status: string | null
  last_active_at: string | null
  agent_types?: string[] | null
  default_agent_type?: string | null
  default_workspace_id?: string | null
  user_id?: string | null
  created_at?: string | null
  // Member: 'owner' | 'admin' | 'member'. Agent: undefined.
  team_role?: string | null
  // Agent: 'team' | 'personal'. Member: undefined.
  visibility?: string | null
  /** Agent owner member actor id — used for personal-agent delete gating. */
  owner_member_id?: string | null
  // Member contact — null for agents and anonymous members. Only carried on the
  // network directory row (the libsql first-paint cache does not persist it).
  email?: string | null
  phone?: string | null
  /**
   * External actors only: the gateway they came in through and their id in it.
   * Network-only, like the contact fields — the libsql cache has no column for
   * them, so a cold-start row carries neither until the reconcile lands.
   */
  source?: string | null
  source_id?: string | null
}

/** Narrow an arbitrary server/cache string to a kind we can render. */
export function toActorKind(raw: string | null | undefined): ActorKind {
  return raw === 'agent' ? 'agent' : raw === 'external' ? 'external' : 'member'
}

/** Optimistically refresh the local member row after a successful heartbeat. */
export function patchMemberLastActive(teamId: string, memberActorId: string, lastActiveAt: string): void {
  useActorDirectoryStore.setState((s) => {
    const slice = s.byTeam[teamId]
    if (!slice) return s
    const actors = slice.actors.map((row) =>
      row.id === memberActorId ? { ...row, last_active_at: lastActiveAt } : row,
    )
    return { byTeam: { ...s.byTeam, [teamId]: { ...slice, actors } } }
  })
}

interface TeamSlice {
  actors: ActorRow[]
  loading: boolean
  error: boolean
  /** Whether `ensure` has kicked off the initial load for this team. */
  started: boolean
}

const EMPTY_SLICE: TeamSlice = { actors: [], loading: false, error: false, started: false }
const EMPTY_ACTORS: ActorRow[] = []

interface DirectoryState {
  byTeam: Record<string, TeamSlice>
  /** Most recently `ensure`d team — the one the periodic reconcile targets. */
  activeTeamId: string | null
  ensure: (teamId: string) => void
  refetch: (teamId: string) => Promise<void>
}

/**
 * Statuses that retire an agent. The server already drops these from
 * `listActorDirectory`, but the libsql cache is append-only (rows are upserted,
 * never swept), so a cold start would paint agents that the server has since
 * stopped returning. Mirrors services/fc/src/lib/agent-status.ts — and like it,
 * hides only a positively-recognised retired status: rows cached before
 * agent_status was carried have it null and stay visible.
 */
const RETIRED_AGENT_STATUSES = new Set(['disabled', 'archived'])

export function isListableActor(row: Pick<ActorRow, 'actor_type' | 'agent_status'>): boolean {
  if (row.actor_type !== 'agent') return true
  return !(row.agent_status != null && RETIRED_AGENT_STATUSES.has(row.agent_status))
}

export function mapCacheRow(r: CachedActorRow): ActorRow {
  return {
    id: r.id,
    actor_type: toActorKind(r.actorType),
    display_name: r.displayName,
    member_status: r.memberStatus ?? null,
    agent_status: r.agentStatus ?? null,
    last_active_at: r.lastActiveAt ?? null,
    team_role: r.teamRole ?? null,
    visibility: r.agentVisibility ?? null,
    owner_member_id: r.ownerMemberId ?? null,
  }
}

// Order rows the SAME way the server (FC listTeamActors) does — last_active_at
// desc (nulls last), then display_name asc — so the cache first-paint and the
// network result don't visibly reshuffle when the fetch lands.
function byRecencyThenName(a: ActorRow, b: ActorRow): number {
  const at = a.last_active_at
  const bt = b.last_active_at
  if (at !== bt) {
    if (!at) return 1
    if (!bt) return -1
    return at < bt ? 1 : -1
  }
  return a.display_name.localeCompare(b.display_name)
}

async function writeCache(teamId: string, rows: ActorRow[]): Promise<void> {
  if (!isTauri() || rows.length === 0) return
  const now = new Date().toISOString()
  const cached: CachedActorRow[] = rows.map((r) => ({
    id: r.id,
    teamId,
    actorType: r.actor_type,
    displayName: r.display_name,
    memberStatus: r.member_status,
    agentStatus: r.agent_status,
    lastActiveAt: r.last_active_at,
    teamRole: r.team_role,
    agentVisibility: r.visibility,
    ownerMemberId: r.owner_member_id,
    createdAt: now,
    updatedAt: now,
    syncedAt: now,
  }))
  await upsertActorsBatch(cached).catch((e) => {
    console.warn('[actor-directory] cache write failed', e)
  })
}

// Coalesce concurrent loads for the same team (ensure + sync signal + interval
// can all fire close together) so we never double-fetch.
const inflight = new Set<string>()
let intervalStarted = false

// Bound to the store's internal `load` when the store is created, so module-level
// helpers (called from non-React code like actor-sync) can drive a reconcile.
let loadTeamDirectory: ((teamId: string, initial: boolean) => Promise<void>) | null = null

export const useActorDirectoryStore = create<DirectoryState>((set, get) => {
  const patch = (teamId: string, p: Partial<TeamSlice>) =>
    set((s) => ({
      byTeam: { ...s.byTeam, [teamId]: { ...(s.byTeam[teamId] ?? EMPTY_SLICE), ...p } },
    }))

  const load = async (teamId: string, initial: boolean): Promise<void> => {
    if (inflight.has(teamId)) return
    inflight.add(teamId)
    try {
      patch(teamId, { error: false })

      let hadData = (get().byTeam[teamId]?.actors.length ?? 0) > 0
      // Cache-first paint only on the initial load (refetch keeps the list
      // visible and just reconciles against the network).
      if (initial && !hadData && isTauri()) {
        const local = await loadActorsForTeam(teamId)
        if (local.length > 0) {
          const cached = local.map(mapCacheRow).filter(isListableActor).sort(byRecencyThenName)
          if (cached.length > 0) {
            patch(teamId, { actors: cached, loading: false })
            hadData = true
          }
        }
      }
      if (!hadData) patch(teamId, { loading: true })

      let data
      try {
        data = await getBackend().actors.listActorDirectory(teamId)
      } catch (e) {
        console.error('[actor-directory] fetch failed', e)
        if (!hadData) patch(teamId, { error: true })
        patch(teamId, { loading: false })
        return
      }

      // Filtered here too, not just server-side: FC deployments are per-brand
      // and hand-rolled, so a client can outrun the API that serves it.
      const rows = (data ?? []).map((row): ActorRow => ({
        id: row.id,
        actor_type: toActorKind(row.actor_type),
        display_name: row.display_name || row.id,
        avatar_url: row.avatar_url ?? null,
        member_status: row.member_status ?? null,
        agent_status: row.agent_status ?? null,
        last_active_at: row.last_active_at ?? null,
        agent_types: row.agent_types ?? null,
        default_agent_type: row.default_agent_type ?? null,
        default_workspace_id: row.default_workspace_id ?? null,
        user_id: row.user_id ?? null,
        created_at: row.created_at ?? null,
        team_role: row.team_role ?? null,
        visibility: row.visibility ?? null,
        owner_member_id: row.agent_owner_member_id ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        source: row.source ?? null,
        source_id: row.source_id ?? null,
      })).filter(isListableActor)
      patch(teamId, { actors: rows, loading: false })
      await writeCache(teamId, rows)
    } finally {
      inflight.delete(teamId)
    }
  }

  const startInterval = () => {
    if (intervalStarted || !isTauri() || typeof setInterval !== 'function') return
    intervalStarted = true
    setInterval(() => {
      const tid = get().activeTeamId
      if (tid && get().byTeam[tid]?.started) void load(tid, false)
    }, 60_000)
  }

  // Exposed for the sync signal + manual refetch (module-level helpers below).
  loadTeamDirectory = load

  return {
    byTeam: {},
    activeTeamId: null,
    ensure: (teamId) => {
      if (get().activeTeamId !== teamId) set({ activeTeamId: teamId })
      if (get().byTeam[teamId]?.started) return
      patch(teamId, { started: true })
      void load(teamId, true)
      startInterval()
    },
    refetch: (teamId) => load(teamId, false),
  }
})

/**
 * Called by the background `syncActorsForTeam` (App.tsx, NewSessionDialog, …)
 * after it writes fresh server data into the libsql cache. Re-reconciles the
 * directory for that team if it's currently being shown, so a cold first launch
 * fills in without a restart.
 */
export function notifyActorDirectorySynced(teamId: string): void {
  const slice = useActorDirectoryStore.getState().byTeam[teamId]
  if (slice?.started && loadTeamDirectory) void loadTeamDirectory(teamId, false)
}

interface UseActorDirectoryResult {
  actors: ActorRow[]
  loading: boolean
  error: boolean
  teamId: string | null
  refetch: () => void
}

export function useActorDirectory(): UseActorDirectoryResult {
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const [fallbackTeamId, setFallbackTeamId] = React.useState<string | null>(null)
  const teamId = currentTeamId ?? fallbackTeamId

  // When there's no current team yet (cold start before bootstrap), resolve the
  // user's first member actor so the directory can still load optimistically.
  React.useEffect(() => {
    if (currentTeamId) {
      setFallbackTeamId(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const session = await getBackend().auth.getSession()
        if (!session?.user || cancelled) return
        const actorRow = await getBackend().directory.resolveFirstMemberActorForUser(session.user.id)
        if (!cancelled) setFallbackTeamId(actorRow?.team_id ?? null)
      } catch {
        // Cold start / tests without cloud config — leave fallback unset.
      }
    })()
    return () => { cancelled = true }
  }, [currentTeamId])

  React.useEffect(() => {
    if (teamId) useActorDirectoryStore.getState().ensure(teamId)
  }, [teamId])

  const slice = useActorDirectoryStore((s) => (teamId ? s.byTeam[teamId] : undefined))
  const refetch = React.useCallback(() => {
    if (teamId) void useActorDirectoryStore.getState().refetch(teamId)
  }, [teamId])

  return {
    actors: slice?.actors ?? EMPTY_ACTORS,
    loading: slice?.loading ?? false,
    error: slice?.error ?? false,
    teamId,
    refetch,
  }
}
