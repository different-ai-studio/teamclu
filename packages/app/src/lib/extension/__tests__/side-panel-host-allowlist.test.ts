import { describe, expect, it } from 'vitest'
import {
  isChromeExtensionsPageUrl,
  isHostnameAllowedByPatterns,
  isUrlAllowedBySidePanelPatterns,
  parseSidePanelDomainPatterns,
} from '@/lib/extension/side-panel-host-allowlist'

describe('parseSidePanelDomainPatterns', () => {
  it('splits commas / spaces / semicolons and lowercases', () => {
    expect(parseSidePanelDomainPatterns(' *.Shopee.io, Admin.Example.com ;foo.com ')).toEqual([
      '*.shopee.io',
      'admin.example.com',
      'foo.com',
    ])
  })

  it('returns empty for blank input', () => {
    expect(parseSidePanelDomainPatterns('')).toEqual([])
    expect(parseSidePanelDomainPatterns(null)).toEqual([])
  })
})

describe('isHostnameAllowedByPatterns', () => {
  it('allows everything when patterns are empty', () => {
    expect(isHostnameAllowedByPatterns('anywhere.com', [])).toBe(true)
  })

  it('matches exact hosts', () => {
    expect(isHostnameAllowedByPatterns('admin.example.com', ['admin.example.com'])).toBe(true)
    expect(isHostnameAllowedByPatterns('other.example.com', ['admin.example.com'])).toBe(false)
  })

  it('matches wildcard including apex', () => {
    const patterns = ['*.shopee.io']
    expect(isHostnameAllowedByPatterns('shopee.io', patterns)).toBe(true)
    expect(isHostnameAllowedByPatterns('admin.shopee.io', patterns)).toBe(true)
    expect(isHostnameAllowedByPatterns('a.b.shopee.io', patterns)).toBe(true)
    expect(isHostnameAllowedByPatterns('shopee.com', patterns)).toBe(false)
  })
})

describe('isUrlAllowedBySidePanelPatterns', () => {
  const patterns = ['*.ucar.cc', 'localhost']

  it('allows matching http(s) urls', () => {
    expect(isUrlAllowedBySidePanelPatterns('https://api.ucar.cc/v1', patterns)).toBe(true)
    expect(isUrlAllowedBySidePanelPatterns('http://localhost:3000/', patterns)).toBe(true)
  })

  it('always allows chrome://extensions regardless of patterns', () => {
    expect(isUrlAllowedBySidePanelPatterns('chrome://extensions', patterns)).toBe(true)
    expect(isUrlAllowedBySidePanelPatterns('chrome://extensions/', patterns)).toBe(true)
    expect(
      isUrlAllowedBySidePanelPatterns('chrome://extensions/?id=abcdefghijklmnop', patterns),
    ).toBe(true)
  })

  it('rejects other non-http and non-matching hosts', () => {
    expect(isUrlAllowedBySidePanelPatterns('chrome://settings', patterns)).toBe(false)
    expect(isUrlAllowedBySidePanelPatterns('https://evil.com', patterns)).toBe(false)
    expect(isUrlAllowedBySidePanelPatterns(undefined, patterns)).toBe(false)
  })

  it('allows any url when ungated', () => {
    expect(isUrlAllowedBySidePanelPatterns('https://evil.com', [])).toBe(true)
  })
})

describe('isChromeExtensionsPageUrl', () => {
  it('matches chrome extension management URLs only', () => {
    expect(isChromeExtensionsPageUrl('chrome://extensions')).toBe(true)
    expect(isChromeExtensionsPageUrl('chrome://extensions/')).toBe(true)
    expect(isChromeExtensionsPageUrl('chrome://extensions/?id=abc')).toBe(true)
    expect(isChromeExtensionsPageUrl('chrome://settings')).toBe(false)
    expect(isChromeExtensionsPageUrl('https://extensions.example.com')).toBe(false)
  })
})
