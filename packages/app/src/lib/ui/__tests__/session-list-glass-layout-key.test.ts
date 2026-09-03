import { describe, expect, it } from 'vitest'
import { buildSessionListGlassLayoutKey } from '@/lib/ui/session-list-glass-layout-key'

describe('buildSessionListGlassLayoutKey', () => {
  const base = {
    activeSessionId: 's-active',
    actionsOpenSessionId: null as string | null,
    rowOrder: ['s-a', 's-b', 's-c'],
    rowLayoutHints: [] as Array<{ sessionId: string; participantCount: number }>,
    shouldVirtualize: false,
  }

  it('changes when row order changes (re-sort after send)', () => {
    const before = buildSessionListGlassLayoutKey(base)
    const after = buildSessionListGlassLayoutKey({
      ...base,
      rowOrder: ['s-active', 's-a', 's-b'],
    })
    expect(before).not.toBe(after)
  })

  it('stays stable when only inactive preview text would change elsewhere', () => {
    const a = buildSessionListGlassLayoutKey(base)
    const b = buildSessionListGlassLayoutKey({ ...base })
    expect(a).toBe(b)
  })

  it('changes when participants load on a row', () => {
    const before = buildSessionListGlassLayoutKey(base)
    const after = buildSessionListGlassLayoutKey({
      ...base,
      rowLayoutHints: [{ sessionId: 's-b', participantCount: 2 }],
    })
    expect(before).not.toBe(after)
  })

  it('ignores activity-only hints (badge is inline in title row)', () => {
    const a = buildSessionListGlassLayoutKey(base)
    const b = buildSessionListGlassLayoutKey({ ...base, rowLayoutHints: [] })
    expect(a).toBe(b)
  })
})
