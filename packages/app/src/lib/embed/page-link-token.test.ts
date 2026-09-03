import { describe, expect, it } from 'vitest'
import {
  encodePageLinkToken,
  pageLinkChipLabel,
  parsePageLinkToken,
} from '@/lib/embed/page-link-token'

const ctx = {
  title: 'T',
  url: 'https://a.com',
  text: 'body',
  selection: 'SeaBank-6901',
}

describe('page-link-token', () => {
  it('round-trips PageContext', () => {
    const token = encodePageLinkToken(ctx)
    expect(parsePageLinkToken(token)).toEqual(ctx)
  })

  it('label prefers selection then text', () => {
    expect(pageLinkChipLabel(ctx)).toBe('SeaBank-6901')
  })

  it('round-trips special characters and long body', () => {
    const rich = {
      title: 'T|itle',
      url: 'https://a.com?q=%7D%7C',
      text: 'x'.repeat(5000),
      selection: 'pick|me}',
    }
    const token = encodePageLinkToken(rich)
    expect(parsePageLinkToken(token)).toEqual(rich)
  })

  it('truncates and sanitizes chip labels', () => {
    const long = 'x'.repeat(120)
    expect(pageLinkChipLabel({ title: 'T', url: 'u', text: long, selection: '' }).length).toBeLessThanOrEqual(80)
    expect(pageLinkChipLabel({ title: 'T', url: 'u', text: '', selection: 'a]b' })).toBe('ab')
  })
})
