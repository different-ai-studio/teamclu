import { describe, expect, it, vi } from 'vitest'
import {
  LINK_HOVER_SCRIPT_ID,
  linkHoverOriginsForDomain,
  syncLinkHoverContentScript,
  type DynamicContentScriptDeps,
} from './dynamic-content-script'

function deps(overrides: Partial<DynamicContentScriptDeps> = {}): DynamicContentScriptDeps {
  return {
    manifestHasStaticContentScripts: () => false,
    readDomains: async () => [],
    hasOrigins: async () => true,
    getRegisteredIds: async () => [],
    unregister: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('syncLinkHoverContentScript', () => {
  it('registers nothing when no domain is allow-listed', async () => {
    const d = deps()
    expect(await syncLinkHoverContentScript(d)).toEqual([])
    expect(d.register).not.toHaveBeenCalled()
  })

  it('registers only domains whose host access was granted', async () => {
    const d = deps({
      readDomains: async () => ['granted.com', 'denied.com'],
      hasOrigins: async (o) => o[0].includes('granted.com'),
    })
    const matches = await syncLinkHoverContentScript(d)
    expect(matches).toEqual(linkHoverOriginsForDomain('granted.com'))
    expect(d.register).toHaveBeenCalledWith(linkHoverOriginsForDomain('granted.com'))
  })

  it('replaces a previous registration and unregisters when the list empties', async () => {
    const d = deps({ getRegisteredIds: async () => [LINK_HOVER_SCRIPT_ID] })
    await syncLinkHoverContentScript(d)
    expect(d.unregister).toHaveBeenCalledWith([LINK_HOVER_SCRIPT_ID])
    expect(d.register).not.toHaveBeenCalled()
  })

  it('leaves branded packages with a static content script alone', async () => {
    const d = deps({
      manifestHasStaticContentScripts: () => true,
      readDomains: async () => ['x.com'],
    })
    expect(await syncLinkHoverContentScript(d)).toEqual([])
    expect(d.register).not.toHaveBeenCalled()
    expect(d.unregister).not.toHaveBeenCalled()
  })
})
