import { describe, expect, it } from 'vitest'
import { formatRelative } from '../format-relative'

describe('formatRelative (daemon settings)', () => {
  const now = Date.parse('2026-11-19T12:00:00Z')

  it('handles missing and unparseable values', () => {
    expect(formatRelative(null, now)).toBe('-')
    expect(formatRelative('not a date', now)).toBe('not a date')
  })

  it('formats minutes, hours and days', () => {
    expect(formatRelative('2026-11-19T11:59:30Z', now)).toBe('just now')
    expect(formatRelative('2026-11-19T11:55:00Z', now)).toBe('5m ago')
    expect(formatRelative('2026-11-19T09:00:00Z', now)).toBe('3h ago')
    expect(formatRelative('2026-11-17T12:00:00Z', now)).toBe('2d ago')
  })
})
