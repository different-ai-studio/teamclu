import { getBackend } from '@/lib/backend'
import type { AppRow } from '@/lib/backend/types'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { openAppSession } from '@/lib/apps/app-session'

/**
 * Link a session in which an agent created an app to that app, and move the
 * session's agent onto the app's checkout (#1885).
 *
 * 1. `POST /v1/sessions/:id/app` writes `sessions.app_id`.
 * 2. The session-list row takes the app id, so the session moves from 会话 to
 *    the app's sessions, and the app is remembered as this session's.
 * 3. `openAppSession` seats the local daemon and moves its seat onto the
 *    checkout (the #1430 path every app session goes through), then the open
 *    session resolves its workspace again so the file tree follows.
 *
 * Throws when the link is refused; a failed seat move is left to the next
 * open, as for any app session.
 */
export async function linkSessionToApp(sessionId: string, appId: string): Promise<AppRow | null> {
  await getBackend().sessions.linkApp(sessionId, appId)

  const list = useSessionListStore.getState()
  const row = list.rows.find((r) => r.id === sessionId)
  if (row && row.app_id !== appId) list.upsertRows([{ ...row, app_id: appId }])
  useAppsStore.getState().recordAppSession(appId, sessionId)

  // The app was created a moment ago by an agent: this list may predate it.
  const teamId = useCurrentTeamStore.getState().team?.id
  let app = useAppsStore.getState().items.find((a) => a.id === appId) ?? null
  if (!app) {
    app = await getBackend().apps.getApp(appId)
    if (teamId) void useAppsStore.getState().load(teamId, { force: true })
  }
  if (!app) return null

  try {
    await openAppSession(app, sessionId)
  } catch (e) {
    console.warn('[link-session-app] could not seat the session on the app checkout (non-fatal):', e)
    return app
  }
  if (teamId && useSessionSelectionStore.getState().activeSessionId === sessionId) {
    try {
      const { switchToSessionWorkspaceIfNeeded } = await import('@/lib/session/session-by-workspace')
      await switchToSessionWorkspaceIfNeeded(teamId, sessionId)
    } catch (e) {
      console.warn('[link-session-app] could not switch to the app workspace', e)
    }
  }
  return app
}
