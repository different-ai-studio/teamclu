import { describe, it, expect } from 'vitest'
import { sortAppSessionsForDisplay } from '../AppSessionsColumn'
import type { AppSessionRow } from '@/lib/backend/types'

function row(p: Partial<AppSessionRow>): AppSessionRow {
  return {
    id: 'id',
    teamId: 't',
    title: 'title',
    mode: 'collab',
    lastMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  }
}

describe('sortAppSessionsForDisplay', () => {
  it('orders by lastMessageAt then createdAt descending', () => {
    const sorted = sortAppSessionsForDisplay([
      row({ id: 'a', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: '2026-06-10T00:00:00.000Z' }),
      row({ id: 'c', lastMessageAt: null, createdAt: '2026-06-08T00:00:00.000Z' }),
    ])
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })
})
