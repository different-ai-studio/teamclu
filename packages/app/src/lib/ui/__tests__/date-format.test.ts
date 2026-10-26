import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage
const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach(k => delete store[k]) },
})

import { formatDate, formatTime, formatDateTime, formatRelativeDate, formatSessionDate, formatRelativeTime, formatMessageBubbleTime } from '@/lib/ui/date-format'
import { appShortName } from '@/lib/config/build-config'

beforeEach(() => {
  store[`${appShortName}-language`] = 'en'
})

describe('date-format', () => {
  it('formatDate returns a formatted date string', () => {
    const result = formatDate(new Date('2025-06-15'))
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('formatTime returns a formatted time string', () => {
    const result = formatTime(new Date('2025-06-15T14:30:00'))
    expect(result).toBeTruthy()
  })

  it('formatDateTime returns combined date and time', () => {
    const result = formatDateTime(new Date('2025-06-15T14:30:00'))
    expect(result).toBeTruthy()
  })

  it('formatRelativeDate returns relative string', () => {
    const result = formatRelativeDate(new Date())
    expect(result).toBeTruthy()
  })

  it('formatSessionDate formats a session date', () => {
    const result = formatSessionDate(new Date('2025-06-15'))
    expect(result).toBeTruthy()
  })

  it('formatRelativeTime returns relative time', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
    const result = formatRelativeTime(fiveMinAgo)
    expect(result).toBeTruthy()
  })

  it('handles string date input', () => {
    const result = formatDate('2025-06-15')
    expect(result).toBeTruthy()
  })

  it('handles numeric timestamp input', () => {
    const result = formatDate(Date.now())
    expect(result).toBeTruthy()
  })

  it('formatMessageBubbleTime shows the clock on the same local day', () => {
    const now = new Date(2026, 9, 26, 15, 0, 0)
    const today = new Date(2026, 9, 26, 11, 22, 0)
    expect(formatMessageBubbleTime(today, now)).toMatchObject({
      label: '11:22',
      title: '2026/10/26 11:22',
    })
  })

  it('formatMessageBubbleTime prefixes the month and day on another day', () => {
    const now = new Date(2026, 9, 26, 15, 0, 0)
    const older = new Date(2026, 9, 25, 18, 4, 0)
    expect(formatMessageBubbleTime(older, now)).toMatchObject({
      label: '10/25 18:04',
      title: '2026/10/25 18:04',
    })
  })

  it('formatMessageBubbleTime returns null for an invalid time', () => {
    expect(formatMessageBubbleTime(new Date('not-a-date'))).toBeNull()
  })
})
