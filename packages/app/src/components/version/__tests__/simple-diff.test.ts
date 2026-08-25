import { describe, it, expect } from 'vitest'
import { canDiff, computeSimpleDiff } from '../simple-diff'

describe('canDiff', () => {
  it('allows the sizes real notes have', () => {
    const doc = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n')
    expect(canDiff(doc, doc)).toBe(true)
  })

  it('refuses a comparison whose table would freeze the tab', () => {
    // The conflict view runs this unattended as soon as a tab opens, and the
    // documents most likely to conflict are the long shared ones. 1500×1500 is
    // 2.25M cells, allocated on the main thread, one DOM node per line.
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n')
    expect(canDiff(big, big)).toBe(false)
  })
})

describe('computeSimpleDiff', () => {
  it('marks what each side has', () => {
    const lines = computeSimpleDiff('a\nb\n', 'a\nc\n')
    expect(lines.filter((l) => l.type === 'removed').map((l) => l.content)).toEqual(['b'])
    expect(lines.filter((l) => l.type === 'added').map((l) => l.content)).toEqual(['c'])
  })
})
