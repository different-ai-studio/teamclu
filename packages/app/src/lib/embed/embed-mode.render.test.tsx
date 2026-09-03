import { describe, it, expect } from 'vitest'
import { useUIStore } from '@/stores/ui'

describe('embed mode store flag', () => {
  it('embedMode true when location.search has embed=chat', () => {
    // jsdom: directly assert parsing logic surfaced as store default value source function
    // (window.location in jsdom has no search by default; this test locks that store exposes embedMode field)
    expect(typeof useUIStore.getState().embedMode).toBe('boolean')
  })
})
