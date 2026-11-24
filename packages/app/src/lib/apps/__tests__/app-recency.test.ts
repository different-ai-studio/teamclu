import { describe, it, expect } from 'vitest'
import { latestSessionActivityByApp, sortAppsByLastActivity } from '../app-recency'

const app = (id: string, updatedAt = '2026-01-01T00:00:00.000Z') => ({ id, updatedAt })

describe('app recency', () => {
  it('takes the newer of opened-here and session activity', () => {
    const activity = latestSessionActivityByApp(
      [
        { id: 's1', app_id: 'a', last_message_at: '2026-11-01T00:00:00.000Z', updated_at: null },
        { id: 's2', app_id: null, last_message_at: '2026-11-03T00:00:00.000Z', updated_at: null },
        { id: 's3', app_id: null, last_message_at: null, updated_at: null },
      ],
      { s2: 'b' },
    )
    const sorted = sortAppsByLastActivity([app('a'), app('b'), app('c')], { c: '2026-11-02T00:00:00.000Z' }, activity)
    expect(sorted.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('falls back to updatedAt only for an app with no use of mine, and keeps ties in order', () => {
    const sorted = sortAppsByLastActivity(
      [app('old'), app('tie1', '2026-05-01T00:00:00.000Z'), app('tie2', '2026-05-01T00:00:00.000Z'), app('used')],
      { used: '2026-03-01T00:00:00.000Z' },
      {},
    )
    expect(sorted.map((x) => x.id)).toEqual(['tie1', 'tie2', 'used', 'old'])
  })
})
