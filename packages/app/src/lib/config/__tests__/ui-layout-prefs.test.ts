import { describe, it, expect } from 'vitest'
import { reconcileUiLayoutPrefs } from '../ui-layout-prefs'

describe('reconcileUiLayoutPrefs', () => {
  it('lets the file win when localStorage disagrees (e.g. it was wiped)', () => {
    const { apply, backfill } = reconcileUiLayoutPrefs(
      { navPinned: true, sessionDrawerPinned: false },
      { navPinned: false, sessionDrawerPinned: false },
    )
    expect(apply).toEqual({ navPinned: true })
    expect(backfill).toEqual({})
  })

  it('writes keys the file lacks from memory, carrying older saves over', () => {
    const { apply, backfill } = reconcileUiLayoutPrefs(
      {},
      { navPinned: true, sessionDrawerPinned: false },
    )
    expect(apply).toEqual({})
    expect(backfill).toEqual({ navPinned: true, sessionDrawerPinned: false })
  })
})
