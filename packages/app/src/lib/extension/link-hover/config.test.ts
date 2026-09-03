import { describe, expect, it } from 'vitest'

import {
  addDomainToConfig,
  addUrlPatternToConfig,
  isHostAllowed,
  isLinkHoverEnabledForHost,
  isLinkUrlAllowed,
  matchUrlGlob,
  normalizeDomainEntry,
  normalizeUrlPattern,
  parseLinkHoverConfig,
  removeDomainFromConfig,
  removeUrlPatternFromConfig,
} from './config'

describe('normalizeDomainEntry', () => {
  it('strips protocol, path, www, and port', () => {
    expect(normalizeDomainEntry('https://www.Example.com/path?q=1')).toBe('example.com')
    expect(normalizeDomainEntry('app.example.com:8443')).toBe('app.example.com')
  })

  it('rejects invalid hostnames', () => {
    expect(normalizeDomainEntry('')).toBeNull()
    expect(normalizeDomainEntry('not a domain')).toBeNull()
    expect(normalizeDomainEntry('-bad.com')).toBeNull()
  })
})

describe('isHostAllowed', () => {
  it('matches exact host and subdomains', () => {
    const domains = ['example.com']
    expect(isHostAllowed('example.com', domains)).toBe(true)
    expect(isHostAllowed('www.example.com', domains)).toBe(true)
    expect(isHostAllowed('app.example.com', domains)).toBe(true)
    expect(isHostAllowed('other.com', domains)).toBe(false)
  })

  it('is false when allowlist is empty', () => {
    expect(isHostAllowed('example.com', [])).toBe(false)
  })
})

describe('matchUrlGlob', () => {
  it('treats * as any characters including slashes', () => {
    expect(
      matchUrlGlob(
        'https://accounting.i.shopee.io/adminv2/recon/id/file-transfer/record/253776',
        'https://accounting.i.shopee.io/adminv2/*/253776',
      ),
    ).toBe(true)
    expect(
      matchUrlGlob(
        'https://accounting.i.shopee.io/adminv2/recon/id/file-transfer/record/253776',
        '*://*.shopee.io/*/record/*',
      ),
    ).toBe(true)
    expect(matchUrlGlob('https://example.com/a', 'https://example.com/b')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchUrlGlob('https://Example.COM/Path', 'https://example.com/*')).toBe(true)
  })
})

describe('isLinkUrlAllowed', () => {
  it('allows all urls when patterns are empty', () => {
    expect(isLinkUrlAllowed('https://example.com/x', [])).toBe(true)
  })

  it('requires any pattern match when configured', () => {
    const patterns = ['https://example.com/tickets/*', '*/orders/*']
    expect(isLinkUrlAllowed('https://example.com/tickets/1', patterns)).toBe(true)
    expect(isLinkUrlAllowed('https://other.com/orders/9', patterns)).toBe(true)
    expect(isLinkUrlAllowed('https://example.com/home', patterns)).toBe(false)
  })
})

describe('normalizeUrlPattern', () => {
  it('trims and rejects empty', () => {
    expect(normalizeUrlPattern('  */tickets/*  ')).toBe('*/tickets/*')
    expect(normalizeUrlPattern('')).toBeNull()
    expect(normalizeUrlPattern('   ')).toBeNull()
  })
})

describe('parseLinkHoverConfig', () => {
  it('defaults to empty allowlists', () => {
    expect(parseLinkHoverConfig(undefined)).toEqual({ domains: [], urlPatterns: [] })
    expect(
      parseLinkHoverConfig({
        domains: ['bad', 'example.com', 'example.com'],
        urlPatterns: ['', '*/a/*', '*/a/*', '  */b/*  '],
      }),
    ).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/a/*', '*/b/*'],
    })
  })

  it('preserves domains when urlPatterns is omitted (legacy storage)', () => {
    expect(parseLinkHoverConfig({ domains: ['example.com'] })).toEqual({
      domains: ['example.com'],
      urlPatterns: [],
    })
  })
})

describe('isLinkHoverEnabledForHost', () => {
  it('requires a non-empty allowlist match', () => {
    expect(
      isLinkHoverEnabledForHost('app.example.com', { domains: ['example.com'], urlPatterns: [] }),
    ).toBe(true)
    expect(isLinkHoverEnabledForHost('app.example.com', { domains: [], urlPatterns: [] })).toBe(
      false,
    )
  })
})

describe('addDomainToConfig', () => {
  it('rejects invalid and duplicate domains', () => {
    const base = { domains: ['example.com'], urlPatterns: [] }
    expect(addDomainToConfig(base, 'not valid')).toEqual({ ok: false, error: 'invalid' })
    expect(addDomainToConfig(base, 'example.com')).toEqual({ ok: false, error: 'duplicate' })
    expect(addDomainToConfig(base, 'other.example.com')).toEqual({
      ok: true,
      config: { domains: ['example.com', 'other.example.com'], urlPatterns: [] },
    })
  })
})

describe('removeDomainFromConfig', () => {
  it('removes a domain entry', () => {
    expect(
      removeDomainFromConfig({ domains: ['a.com', 'b.com'], urlPatterns: ['*'] }, 'a.com'),
    ).toEqual({
      domains: ['b.com'],
      urlPatterns: ['*'],
    })
  })
})

describe('addUrlPatternToConfig / removeUrlPatternFromConfig', () => {
  it('adds and removes patterns', () => {
    const base = { domains: ['example.com'], urlPatterns: [] }
    expect(addUrlPatternToConfig(base, '')).toEqual({ ok: false, error: 'invalid' })
    const added = addUrlPatternToConfig(base, '*/tickets/*')
    expect(added).toEqual({
      ok: true,
      config: { domains: ['example.com'], urlPatterns: ['*/tickets/*'] },
    })
    if (!added.ok) return
    expect(addUrlPatternToConfig(added.config, '*/tickets/*')).toEqual({
      ok: false,
      error: 'duplicate',
    })
    expect(removeUrlPatternFromConfig(added.config, '*/tickets/*')).toEqual({
      domains: ['example.com'],
      urlPatterns: [],
    })
  })
})
