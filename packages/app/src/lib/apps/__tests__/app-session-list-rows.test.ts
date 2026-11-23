import { beforeEach, describe, expect, it } from 'vitest'
import { appSessionListEntry, upsertAppSessionsIntoList } from '@/lib/apps/app-session-list-rows'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'
import { isSessionListKind } from '@/lib/session/session-list-kind'
import type { AppSessionRow } from '@/lib/backend/types'

const row: AppSessionRow = {
  id: 's-app',
  teamId: 'team-1',
  title: '静态网页 test 方案确认',
  mode: 'collab',
  lastMessageAt: '2026-11-23T02:00:12Z',
  createdAt: '2026-11-23T01:58:00Z',
  updatedAt: '2026-11-23T02:00:12Z',
}

describe('app sessions in the session-list cache', () => {
  beforeEach(() => {
    useSessionListStore.setState({ rows: [], scopeTeamId: null } as Partial<ReturnType<typeof useSessionListStore.getState>>)
  })

  it('carries the team and title, and classifies as an app session', () => {
    upsertAppSessionsIntoList('app-1', [row])
    const cached = useSessionListStore.getState().rows.find((r) => r.id === 's-app')
    expect(cached?.team_id).toBe('team-1')
    expect(cached?.title).toBe('静态网页 test 方案确认')
    expect(cached?.app_id).toBe('app-1')
    // So the 会话 list, which filters by kind, does not show it.
    expect(isSessionListKind(cached!, 'regular')).toBe(false)
    expect(isSessionListKind(cached!, 'app')).toBe(true)
  })

  it('keeps what only the cached row knows', () => {
    const existing = {
      ...appSessionListEntry('app-1', row),
      last_message_preview: '改完了',
      has_unread: true,
      last_message_at: '2026-11-23T03:00:00Z',
    } satisfies SessionListEntry
    const merged = appSessionListEntry('app-1', row, existing)
    expect(merged.last_message_preview).toBe('改完了')
    expect(merged.has_unread).toBe(true)
    expect(merged.last_message_at).toBe('2026-11-23T03:00:00Z')
  })
})
