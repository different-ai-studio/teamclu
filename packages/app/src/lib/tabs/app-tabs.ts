import { useTabsStore } from '@/stores/tabs'
import type { AppRow } from '@/lib/backend/types'

const APP_DATA_PREFIX = 'app-data:'

/** Tab target for one table in an app's live Postgres. */
function encodeAppDataTarget(appId: string, table: string): string {
  return `${APP_DATA_PREFIX}${appId}/${table}`
}

export function decodeAppDataTarget(
  target: string,
): { appId: string; table: string } | null {
  if (!target.startsWith(APP_DATA_PREFIX)) return null
  const body = target.slice(APP_DATA_PREFIX.length)
  const slash = body.indexOf('/')
  if (slash <= 0) return null
  const appId = body.slice(0, slash)
  const table = body.slice(slash + 1)
  if (!appId || !table) return null
  return { appId, table }
}

export function openAppDataTable(app: AppRow, table: string): void {
  useTabsStore.getState().openTab({
    type: 'native',
    target: encodeAppDataTarget(app.id, table),
    label: `${app.name} · ${table}`,
  })
}

/** Open the deployed site in the main content area (webview tab). */
export function openAppPreview(app: AppRow): void {
  const url = app.publicUrl ?? app.fcEndpoint
  if (!url) return
  useTabsStore.getState().openTab({
    type: 'webview',
    target: url,
    label: app.name,
  })
}

const APP_LIBRARY_TARGET = 'app-library'

export function isAppLibraryTarget(target: string): boolean {
  return target === APP_LIBRARY_TARGET
}

/**
 * Every app the team has, in the main column.
 *
 * A tab rather than a dialog: it is a browsing surface next to the column-two
 * list of what is already here, and downloading from it changes that list —
 * both need to be on screen at the same time.
 *
 * The label is passed in because this module has no translator; there is one
 * caller and it has one.
 */
export function openAppLibrary(label: string): void {
  useTabsStore.getState().openTab({
    type: 'native',
    target: APP_LIBRARY_TARGET,
    label,
  })
}
