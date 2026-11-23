import { describe, expect, it } from 'vitest'
import { formatBytes } from '../format-bytes'

describe('formatBytes', () => {
  it('returns null for a missing size', () => {
    expect(formatBytes(null)).toBeNull()
    expect(formatBytes(undefined)).toBeNull()
  })

  it('formats bytes and binary units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
  })
})
