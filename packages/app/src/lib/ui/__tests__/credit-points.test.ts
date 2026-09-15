import { describe, expect, it } from 'vitest'
import { CREDITS_PER_POINT, creditsToPoints, formatPoints } from '../credit-points'

describe('credit-points display unit', () => {
  it('uses 100_000 credits per displayed point', () => {
    expect(CREDITS_PER_POINT).toBe(100_000)
  })

  it('converts the usage headline example (41011 old points → ~4101)', () => {
    const storedCredits = 41_011 * 10_000 // what the old UI showed as 41011
    expect(creditsToPoints(storedCredits)).toBe(4_101.1)
    expect(formatPoints(storedCredits)).toBe((4_101).toLocaleString())
  })

  it('formats a package of 100_000_000 credits as 1,000 points', () => {
    expect(formatPoints(100_000_000)).toBe((1_000).toLocaleString())
  })
})
