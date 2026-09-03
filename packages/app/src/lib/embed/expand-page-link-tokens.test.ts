import { describe, expect, it } from 'vitest'
import { formatPageContext } from '@/lib/embed/embed-page-context'
import { encodePageLinkToken, base64urlEncode } from '@/lib/embed/page-link-token'
import {
  buildPageLinkChip,
  expandPageLinkTokensInText,
  parseSentPageChip,
} from '@/lib/embed/expand-page-link-tokens'

describe('expandPageLinkTokensInText', () => {
  const ctx = { title: 'T', url: 'u', text: 'b', selection: 's' }

  it('expands page token to structured Page chip prompt with plain url and b64 instruction', () => {
    const text = encodePageLinkToken(ctx)
    const expanded = expandPageLinkTokensInText(text)
    expect(expanded).toBe(buildPageLinkChip(ctx))
    expect(expanded).toContain('|url:u|instruction:b64:')
    const inner = expanded.slice('[Page: '.length, -1)
    const parsed = parseSentPageChip(inner)
    expect(parsed.url).toBe('u')
    expect(parsed.instruction).toBe(formatPageContext(ctx))
  })

  it('keeps instruction safe when page body contains ]', () => {
    const rich = {
      title: 'Doc',
      url: 'https://example.com/doc',
      text: 'array [1] and link [text](url)',
      selection: '',
    }
    const expanded = expandPageLinkTokensInText(encodePageLinkToken(rich))
    expect(expanded).toMatch(
      /^\[Page: [^\]]+\|url:https:\/\/example\.com\/doc\|instruction:b64:[A-Za-z0-9_-]+\]$/,
    )
    expect(expanded).toContain('|url:https://example.com/doc|')
    const inner = expanded.slice('[Page: '.length, -1)
    const parsed = parseSentPageChip(inner)
    expect(parsed.instruction).toContain('[1]')
    expect(parsed.url).toBe('https://example.com/doc')
  })

  it('parses legacy sent chips without explicit url segment', () => {
    const legacyCtx = {
      title: 'T',
      url: 'https://a.com',
      text: 'b',
      selection: 's',
    }
    const legacy = `SeaBank|instruction:b64:${base64urlEncode(formatPageContext(legacyCtx))}`
    const parsed = parseSentPageChip(legacy)
    expect(parsed.url).toBe('https://a.com')
  })
})
