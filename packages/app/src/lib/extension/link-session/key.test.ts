import { describe, expect, it } from 'vitest'
import { buildLinkSessionCompositeKey, normalizeLinkKey } from './key'

describe('normalizeLinkKey', () => {
  it('preserves SPA route hash', () => {
    expect(normalizeLinkKey('https://admin.com/app?x=1#/detail?q=2')).toBe(
      'https://admin.com/app?x=1#/detail?q=2',
    )
  })

  it('strips in-page anchor hash', () => {
    expect(normalizeLinkKey('https://admin.com/docs#section-2')).toBe(
      'https://admin.com/docs',
    )
  })

  it('preserves query string', () => {
    expect(normalizeLinkKey('https://admin.com/items?id=42')).toBe(
      'https://admin.com/items?id=42',
    )
  })
})

describe('buildLinkSessionCompositeKey', () => {
  it('builds composite key with team', () => {
    expect(buildLinkSessionCompositeKey('team-1', 'https://x.com/a')).toBe(
      'team-1::https://x.com/a',
    )
  })
})
