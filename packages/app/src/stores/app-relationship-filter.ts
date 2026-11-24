import * as React from 'react'
import { create } from 'zustand'
import { appStoragePrefix } from '@/lib/config/build-config'
import { APP_SIDEBAR_FILTERS, type AppSidebarFilter } from '@/lib/apps/app-relationship'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { useAuthStore } from '@/stores/auth-store'

/**
 * The Apps quick filters, one per team, kept across restarts because the
 * filter people pick is the one they keep wanting.
 */

function makeTeamFilterStore<F extends string>(storageKey: string, values: readonly F[], fallback: F) {
  const isFilter = (value: unknown): value is F =>
    typeof value === 'string' && (values as readonly string[]).includes(value)

  const readStored = (): Record<string, F> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      if (!parsed || typeof parsed !== 'object') return {}
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, F] => isFilter(entry[1])),
      )
    } catch {
      return {}
    }
  }

  const store = create<TeamFilterState<F>>((set, get) => ({
    byTeam: readStored(),
    setFilter: (teamId, filter) => {
      if (!teamId || get().byTeam[teamId] === filter) return
      const byTeam = { ...get().byTeam }
      // The default is not worth a stored entry.
      if (filter === fallback) delete byTeam[teamId]
      else byTeam[teamId] = filter
      set({ byTeam })
      try {
        localStorage.setItem(storageKey, JSON.stringify(byTeam))
      } catch {
        // Storage unavailable — the filter still holds for this run.
      }
    },
  }))

  const useFilter = (teamId: string): [F, (filter: F) => void] => {
    const filter = store((s) => (teamId ? s.byTeam[teamId] ?? fallback : fallback))
    const setFilter = store((s) => s.setFilter)
    const setForTeam = React.useCallback((next: F) => setFilter(teamId, next), [setFilter, teamId])
    return [filter, setForTeam]
  }

  return [store, useFilter] as const
}

interface TeamFilterState<F extends string> {
  byTeam: Record<string, F>
  setFilter: (teamId: string, filter: F) => void
}

/**
 * The sidebar's filter: On this machine / Mine / Invited. The library has
 * none — it is every app, each row naming its own relationship.
 */
export const [useAppSidebarFilterStore, useAppSidebarFilter] = makeTeamFilterStore<AppSidebarFilter>(
  `${appStoragePrefix}-apps-sidebar-filter`,
  APP_SIDEBAR_FILTERS,
  'local',
)

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
