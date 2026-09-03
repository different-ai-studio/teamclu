import { describe, expect, it } from 'vitest'
import { linkSessionTitle } from './title'

describe('linkSessionTitle', () => {
  it('appends HH:mm and caps total length at 80', () => {
    const now = new Date('2026-07-01T14:32:00')
    const long = 'A'.repeat(100)
    const title = linkSessionTitle(long, now)
    expect(title).toHaveLength(80)
    expect(title.endsWith(' (14:32)')).toBe(true)
  })

  it('falls back to Link chat when text empty', () => {
    const now = new Date('2026-07-01T09:05:00')
    expect(linkSessionTitle('   ', now)).toBe('Link chat (09:05)')
  })
})
