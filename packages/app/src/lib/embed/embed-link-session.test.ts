import { describe, expect, it } from 'vitest'
import { isPendingLinkOpenPayload } from '@/lib/embed/embed-link-session'

describe('embed-link-session guards', () => {
  it('accepts pending link-open payload', () => {
    expect(
      isPendingLinkOpenPayload({
        page: { title: 'T', url: 'https://a.com', text: 'body', selection: 'link' },
        linkKey: 'https://a.com',
        source: 'link-hover',
      }),
    ).toBe(true)
  })

  it('rejects malformed payload', () => {
    expect(isPendingLinkOpenPayload({ linkKey: 'x' })).toBe(false)
    expect(isPendingLinkOpenPayload(null)).toBe(false)
  })
})
