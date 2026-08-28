import { useTabsStore } from '@/stores/tabs'
import type { AppRow } from '@/lib/backend/types'

const APP_DATA_PREFIX = 'app-data:'

/** Tab target for one table in an app's live Postgres. */
export function encodeAppDataTarget(appId: string, table: string): string {
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
