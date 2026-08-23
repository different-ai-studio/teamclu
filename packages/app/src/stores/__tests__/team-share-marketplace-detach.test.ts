import { describe, expect, test } from 'vitest'
import { shouldDetachFromMarketplace } from '../team-share-browser'

describe('shouldDetachFromMarketplace', () => {
  test('publishing over an adopted, still-subscribed skill ends the subscription', () => {
    expect(
      shouldDetachFromMarketplace({ marketplaceOrigin: 'marketplace', upstreamSubscribed: true }),
    ).toBe(true)
  })

  test('a skill the team wrote itself has nothing to detach from', () => {
    expect(
      shouldDetachFromMarketplace({ marketplaceOrigin: 'local', upstreamSubscribed: false }),
    ).toBe(false)
    // `origin` is what decides, not the flag: a local skill can never carry a
    // live subscription, and detaching one would be a 4xx from the server.
    expect(
      shouldDetachFromMarketplace({ marketplaceOrigin: 'local', upstreamSubscribed: true }),
    ).toBe(false)
  })

  test('an already-detached adoption is not detached twice', () => {
    expect(
      shouldDetachFromMarketplace({ marketplaceOrigin: 'marketplace', upstreamSubscribed: false }),
    ).toBe(false)
  })

  test('missing provenance is treated as local, never as a live subscription', () => {
    expect(shouldDetachFromMarketplace({})).toBe(false)
  })
})
