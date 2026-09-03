import { describe, expect, it } from 'vitest'
import { customProviderIdFromName, slugifyProviderId } from '@/lib/opencode/config'

describe('opencode provider ids', () => {
  it('slugifies latin provider names', () => {
    expect(slugifyProviderId('My Custom Provider')).toBe('my-custom-provider')
  })

  it('slugifies unicode provider names', () => {
    expect(slugifyProviderId('通义千问')).toBe('通义千问')
  })

  it('builds custom provider ids with a stable prefix', () => {
    expect(customProviderIdFromName('OpenAI Proxy')).toBe('custom-openai-proxy')
    expect(customProviderIdFromName('通义千问')).toBe('custom-通义千问')
    expect(customProviderIdFromName('!!!')).toBeNull()
  })
})
