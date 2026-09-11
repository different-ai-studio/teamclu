/**
 * Whether an app's files are on THIS machine.
 *
 * An app row is cloud state and follows the account onto every machine it signs
 * in on; the checkout does not. The daemon answers `GET /v1/apps/local` by
 * scanning its own disk, so "downloaded" is a per-machine fact and everything
 * that offers to open an app has to ask this first.
 */
import * as React from 'react'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import type { AppRow } from '@/lib/backend/types'

/**
 * Three answers, not two.
 *
 * `null` means the daemon has not said yet, and it is never a synonym for
 * "no": greying a row out — or shutting a composer down — for the second amuxd
 * takes to start would be a worse lie than the one this exists to fix. Every
 * caller reads `null` as "carry on as before".
 */
export function resolveAppLocality(
  localAppIds: string[] | null,
  appId: string | null | undefined,
): boolean | null {
  if (!appId) return null
  if (localAppIds === null) return null
  return localAppIds.includes(appId)
}

/** Reactive {@link resolveAppLocality} for one app id. */
export function useAppLocality(appId: string | null | undefined): boolean | null {
  const localAppIds = useAppsStore((s) => s.localAppIds)
  return React.useMemo(() => resolveAppLocality(localAppIds, appId), [localAppIds, appId])
}

/**
 * The app a session belongs to, and whether that app is on this machine.
 *
 * The session list store is the only client-side place a session's `app_id`
 * lives — the libsql cache does not mirror the column, so a row painted from
 * cache carries null until the server page lands. A session whose app cannot be
 * resolved answers `{ app: null, local: null }` rather than `false`, so a chat
 * is never shut down by a column that has merely not arrived yet.
 */
export function useSessionApp(sessionId: string | null | undefined): {
  app: AppRow | null
  local: boolean | null
} {
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const appId = useSessionListStore((s) =>
    sessionId ? s.rows.find((r) => r.id === sessionId)?.app_id ?? null : null,
  )
  const items = useAppsStore((s) => s.items)
  const localAppIds = useAppsStore((s) => s.localAppIds)
  const load = useAppsStore((s) => s.load)
  const refreshLocalApps = useAppsStore((s) => s.refreshLocalApps)

  // Only once a session actually claims an app: the chat has no other reason to
  // hold the app list, and asking unconditionally would fetch it for every team
  // that never opens the Apps section.
  React.useEffect(() => {
    if (!appId || !teamId) return
    void load(teamId)
    void refreshLocalApps(teamId)
  }, [appId, teamId, load, refreshLocalApps])

  const app = React.useMemo(
    () => (appId ? items.find((a) => a.id === appId) ?? null : null),
    [items, appId],
  )
  const local = React.useMemo(
    () => (app ? resolveAppLocality(localAppIds, app.id) : null),
    [localAppIds, app],
  )

  return { app, local }
}
