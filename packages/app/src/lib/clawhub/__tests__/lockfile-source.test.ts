import { describe, it, expect } from 'vitest'
import { clawhubInstalledSlugs, isClawHubLockfileSource } from '@/lib/clawhub/types'

describe('isClawHubLockfileSource', () => {
  it('treats absent and empty source as ClawHub (legacy lockfile rows)', () => {
    expect(isClawHubLockfileSource(undefined)).toBe(true)
    expect(isClawHubLockfileSource(null)).toBe(true)
    expect(isClawHubLockfileSource('')).toBe(true)
    expect(isClawHubLockfileSource('clawhub')).toBe(true)
  })

  it('rejects team (and any other) sources', () => {
    expect(isClawHubLockfileSource('team')).toBe(false)
    expect(isClawHubLockfileSource('import')).toBe(false)
  })
})

describe('clawhubInstalledSlugs', () => {
  it('keeps ClawHub and legacy rows, drops team rows', () => {
    expect(
      clawhubInstalledSlugs({
        version: 1,
        skills: {
          'from-clawhub': { version: '1', installedAt: 1, source: 'clawhub' },
          'legacy-row': { version: '1', installedAt: 1 },
          'from-team': { version: '3', installedAt: 1, source: 'team' },
        },
      }),
    ).toEqual(['from-clawhub', 'legacy-row'])
  })
})
