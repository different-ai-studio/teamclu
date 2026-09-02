import { getBackend } from '@/lib/backend'
import type { SessionDetailRow } from '@/lib/backend/types'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { type SessionListEntry, useSessionListStore } from '@/stores/session-list-store'
import { useUIStore } from '@/stores/ui'
import i18n from '@/lib/i18n'
import { toast } from 'sonner'

const PENDING_SESSION_DEEPLINK_KEY = 'teamclu.pendingSessionDeeplink'

type PendingSessionDeeplink = {
  sessionId: string
  teamId: string | null
  /**
   * `listCurrentActorSessions` is paginated. Keep the row returned by the
   * successful join so a linked older session remains renderable even when it
   * does not land in the first page after a team switch.
   */
  sessionRow?: SessionListEntry
}

function readPendingRaw(): PendingSessionDeeplink | null {
  try {
    const raw = localStorage.getItem(PENDING_SESSION_DEEPLINK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingSessionDeeplink
    if (!parsed?.sessionId) return null
    return {
      sessionId: parsed.sessionId,
      teamId: parsed.teamId ?? null,
      sessionRow: parsed.sessionRow,
    }
  } catch {
    return null
  }
}

export function readPendingSessionDeeplink(): PendingSessionDeeplink | null {
  return readPendingRaw()
}

export function stashPendingSessionDeeplink(
  sessionId: string,
  teamId: string | null = null,
  sessionRow?: SessionListEntry,
): void {
  const payload: PendingSessionDeeplink = { sessionId, teamId, sessionRow }
  try {
    localStorage.setItem(PENDING_SESSION_DEEPLINK_KEY, JSON.stringify(payload))
  } catch {
    // Private mode / quota — in-memory only via zustand-less module state is
    // enough for hot delivery; cold launch just retries from getCurrent().
  }
}

export function clearPendingSessionDeeplink(): void {
  try {
    localStorage.removeItem(PENDING_SESSION_DEEPLINK_KEY)
  } catch {
    // ignore
  }
}

function isAuthedRealUser(): boolean {
  const session = useAuthStore.getState().session
  return Boolean(session)
}

function sessionDetailToListEntry(session: SessionDetailRow): SessionListEntry {
  const mode = session.mode === 'solo' || session.mode === 'control'
    ? session.mode
    : 'collab'
  return {
    id: session.id,
    title: session.title,
    team_id: session.team_id,
    last_message_at: session.last_message_at,
    last_message_preview: session.last_message_preview,
    mode,
    idea_id: session.idea_id,
    has_unread: false,
    source: session.source ?? null,
    cron_job_id: session.cron_job_id ?? null,
    created_at: session.created_at,
    updated_at: session.updated_at,
  }
}

async function navigateToSession(
  sessionId: string,
  sessionRow?: SessionListEntry,
): Promise<void> {
  // A linked session may be older than the first page (50 rows) returned by
  // listCurrentActorSessions. Seed it before selecting so the chat header and
  // desktop message sync can resolve its team, then re-apply it after the
  // paginated reconcile which replaces the list rows.
  if (sessionRow) useSessionListStore.getState().upsertRows([sessionRow])
  await useUIStore.getState().switchToSession(sessionId)
  await useSessionListStore.getState().load()
  if (sessionRow) useSessionListStore.getState().upsertRows([sessionRow])
  clearPendingSessionDeeplink()
}

function reportOpenFailure(err: unknown): void {
  if (err instanceof CloudApiError && err.status === 403) {
    toast.error(i18n.t('session.deeplink.noAccess', '无权访问该会话'))
  } else if (err instanceof CloudApiError && err.status === 404) {
    toast.error(i18n.t('session.deeplink.notFound', '会话不存在或已被删除'))
  } else {
    toast.error(i18n.t('session.deeplink.openFailed', '打开会话失败'))
  }
  console.error('[session-deeplink] open failed', err)
}

/**
 * Join the linked session and navigate to it. When the session lives in a
 * different team, activate that team first and defer navigation until the
 * chat-state reset triggered by the org switch has finished — otherwise
 * resetClientChatState clears the selection we just set.
 */
export async function openSessionFromDeeplink(sessionId: string): Promise<boolean> {
  if (!isAuthedRealUser()) {
    stashPendingSessionDeeplink(sessionId)
    return false
  }

  try {
    const session = await getBackend().sessions.joinSession(sessionId)
    const teamId = session.team_id ?? null
    const sessionRow = sessionDetailToListEntry(session)
    const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null

    if (teamId && teamId !== currentTeamId) {
      stashPendingSessionDeeplink(sessionId, teamId, sessionRow)
      await useCurrentTeamStore.getState().enterTeam(teamId)
      return true
    }

    await navigateToSession(sessionId, sessionRow)
    return true
  } catch (err) {
    clearPendingSessionDeeplink()
    reportOpenFailure(err)
    return false
  }
}

/**
 * Finish a cross-team deeplink after enterTeam() and resetClientChatState().
 */
export async function completePendingSessionDeeplink(): Promise<boolean> {
  const pending = readPendingSessionDeeplink()
  if (!pending) return false
  if (!isAuthedRealUser()) return false

  const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null
  if (pending.teamId && pending.teamId !== currentTeamId) return false

  try {
    await navigateToSession(pending.sessionId, pending.sessionRow)
    return true
  } catch (err) {
    clearPendingSessionDeeplink()
    reportOpenFailure(err)
    return false
  }
}
