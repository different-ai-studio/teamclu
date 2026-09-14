import * as React from 'react'
import { create } from 'zustand'
import { appStoragePrefix } from '@/lib/config/build-config'
import { APP_RELATIONSHIP_FILTERS, type AppRelationshipFilter } from '@/lib/apps/app-relationship'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { useAuthStore } from '@/stores/auth-store'

/**
 * The Apps quick filter (All / Mine / Invited / Team), one per team.
 *
 * Shared by the sidebar list and the library on purpose: narrowing to "Invited"
 * in one and opening the other should not show everything again. Kept across
 * restarts because the filter people pick is the one they keep wanting.
 */

const STORAGE_KEY = `${appStoragePrefix}-apps-relationship-filter`

function isFilter(value: unknown): value is AppRelationshipFilter {
  return typeof value === 'string' && (APP_RELATIONSHIP_FILTERS as readonly string[]).includes(value)
}

function readStored(): Record<string, AppRelationshipFilter> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, AppRelationshipFilter] =>
        isFilter(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

interface AppRelationshipFilterState {
  byTeam: Record<string, AppRelationshipFilter>
  setFilter: (teamId: string, filter: AppRelationshipFilter) => void
}

export const useAppRelationshipFilterStore = create<AppRelationshipFilterState>((set, get) => ({
  byTeam: readStored(),
  setFilter: (teamId, filter) => {
    if (!teamId || get().byTeam[teamId] === filter) return
    const byTeam = { ...get().byTeam }
    // `all` is the default, so it is not worth a stored entry.
    if (filter === 'all') delete byTeam[teamId]
    else byTeam[teamId] = filter
    set({ byTeam })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(byTeam))
    } catch {
      // Storage unavailable — the filter still holds for this run.
    }
  },
}))

export function useAppRelationshipFilter(
  teamId: string,
): [AppRelationshipFilter, (filter: AppRelationshipFilter) => void] {
  const filter = useAppRelationshipFilterStore((s) => (teamId ? s.byTeam[teamId] ?? 'all' : 'all'))
  const setFilter = useAppRelationshipFilterStore((s) => s.setFilter)
  const set = React.useCallback((next: AppRelationshipFilter) => setFilter(teamId, next), [setFilter, teamId])
  return [filter, set]
}

/**
 * My member actor in the current team, from the directory — null until it
 * loads. Only the fallback for a server that does not send `relationship` uses
 * it, to tell my apps from ones shared with me.
 */
export function useMyMemberActorId(): string | null {
  const userId = useAuthStore((s) => s.session?.user?.id ?? null)
  const { actors } = useActorDirectory()
  return React.useMemo(() => {
    if (!userId) return null
    return actors.find((a) => a.actor_type === 'member' && a.user_id === userId)?.id ?? null
  }, [actors, userId])
}
