import * as React from 'react'
import { useAppsStore } from '@/stores/apps-store'
import { AppListColumn } from '@/components/sidebar/AppListColumn'
import { AppSessionsColumn } from '@/components/sidebar/AppSessionsColumn'
import { resolveAppLocality } from '@/lib/apps/app-locality'

/**
 * Column two, Apps section — two levels in one column.
 *
 * Level one is the list of the team's apps; picking one drills into that app's
 * sessions, and the back button in that header returns here. The whole of the
 * switch is `selectedAppId`, so anything that selects an app (creating one,
 * downloading one) drills in for free, and anything that clears it — the nav
 * row, the back button, deleting the selected app — comes back out.
 */
export function AppsColumn() {
  const selectedAppId = useAppsStore((s) => s.selectedAppId)
  const items = useAppsStore((s) => s.items)
  const localAppIds = useAppsStore((s) => s.localAppIds)

  const app = React.useMemo(
    () => (selectedAppId ? items.find((a) => a.id === selectedAppId) ?? null : null),
    [items, selectedAppId],
  )

  // An id that resolves to nothing is a stale selection (deleted elsewhere, or
  // a team switch): show the list rather than an empty app.
  if (!app) return <AppListColumn />
  // Neither is an app whose checkout is not on this machine — its sessions
  // exist in the cloud but there is nothing here for an agent to run in, so
  // the list (which offers the download) is the only useful thing to show.
  // `null` is "the daemon has not answered", and does not close the level.
  if (resolveAppLocality(localAppIds, app.id) === false) return <AppListColumn />
  return <AppSessionsColumn app={app} />
}
