import * as React from 'react'
import { useAppsStore } from '@/stores/apps-store'
import { AppListColumn } from '@/components/sidebar/AppListColumn'
import { AppSessionsColumn } from '@/components/sidebar/AppSessionsColumn'

/**
 * Column two, Apps section — two levels in one column.
 *
 * Level one is the list of apps on this machine; picking one drills into that
 * app's sessions, and the back button in that header returns here. The whole
 * of the switch is `selectedAppId`, so anything that selects an app (creating
 * one, downloading one) drills in for free, and anything that clears it — the
 * nav row, the back button, deleting the selected app — comes back out.
 */
export function AppsColumn() {
  const selectedAppId = useAppsStore((s) => s.selectedAppId)
  const items = useAppsStore((s) => s.items)

  const app = React.useMemo(
    () => (selectedAppId ? items.find((a) => a.id === selectedAppId) ?? null : null),
    [items, selectedAppId],
  )

  // An id that resolves to nothing is a stale selection (deleted elsewhere, or
  // a team switch): show the list rather than an empty app.
  if (!app) return <AppListColumn />
  return <AppSessionsColumn app={app} />
}
