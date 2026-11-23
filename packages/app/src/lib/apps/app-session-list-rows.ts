import type { AppSessionRow } from '@/lib/backend/types'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'

/**
 * Put an app's sessions into the session-list cache.
 *
 * The 应用 column lists an app's sessions from its own endpoint, but the rest
 * of the app looks a session up in the session-list cache: its team (to load
 * message history from the local cache and the Cloud API), its title (the chat
 * header), its attention state. Cron sessions opened from run history are
 * upserted the same way. The 会话 list filters by kind, so these rows do not
 * show there.
 *
 * A row already in the cache keeps what only it knows (last-message preview,
 * unread and mention flags kept live by MQTT); the app's list supplies the
 * fields it is the authority for.
 */
export function upsertAppSessionsIntoList(appId: string, rows: AppSessionRow[]): void {
  if (rows.length === 0) return
  const store = useSessionListStore.getState()
  const existing = new Map(store.rows.map((row) => [row.id, row] as const))
  store.upsertRows(rows.map((row) => appSessionListEntry(appId, row, existing.get(row.id))))
}

export function appSessionListEntry(
  appId: string,
  row: AppSessionRow,
  existing?: SessionListEntry,
): SessionListEntry {
  const lastMessageAt = latest(existing?.last_message_at ?? null, row.lastMessageAt)
  return {
    last_message_preview: null,
    idea_id: null,
    has_unread: false,
    has_mention: false,
    cron_job_id: null,
    ...existing,
    id: row.id,
    team_id: row.teamId,
    title: row.title || existing?.title || '',
    mode: (row.mode as SessionListEntry['mode']) || existing?.mode || 'collab',
    app_id: appId,
    source: 'user',
    last_message_at: lastMessageAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}
