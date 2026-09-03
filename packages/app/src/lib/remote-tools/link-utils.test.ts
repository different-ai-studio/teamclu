import { describe, expect, it } from 'vitest'

import {
  defaultLabelForLink,
  parsePageNavLinksArgs,
  parsePageNavLinksFromToolCall,
} from '@/lib/remote-tools/link-utils'

describe('parsePageNavLinksArgs', () => {
  it('parses links with default labels', () => {
    const out = parsePageNavLinksArgs({
      links: ['https://example.com/docs', '/pricing'],
    })
    expect(out.links).toEqual(['https://example.com/docs', '/pricing'])
    expect(out.labels).toHaveLength(2)
    expect(out.labels[1]).toBe('/pricing')
  })

  it('uses provided labels', () => {
    const out = parsePageNavLinksArgs({
      links: ['https://example.com/a'],
      labels: ['文档'],
    })
    expect(out.labels).toEqual(['文档'])
  })

  it('coerces JSON string links from agent', () => {
    const out = parsePageNavLinksArgs({
      links: '["https://example.com/docs"]',
    })
    expect(out.links).toEqual(['https://example.com/docs'])
  })

  it('coerces single url string', () => {
    const out = parsePageNavLinksArgs({
      links: 'https://example.com/only',
    })
    expect(out.links).toEqual(['https://example.com/only'])
  })

  it('parses from rawInput object', () => {
    const out = parsePageNavLinksFromToolCall(
      { links: '["https://example.com/x"]' },
      { links: ['https://example.com/x'] },
    )
    expect(out?.links).toEqual(['https://example.com/x'])
  })

  it('rejects empty links', () => {
    expect(() => parsePageNavLinksArgs({ links: [] })).toThrow()
  })

  it('rejects unsupported schemes', () => {
    expect(() => parsePageNavLinksArgs({ links: ['javascript:alert(1)'] })).toThrow()
  })
})

describe('defaultLabelForLink', () => {
  it('shortens hash links', () => {
    expect(defaultLabelForLink('#section-one')).toBe('#section-one')
  })
})
