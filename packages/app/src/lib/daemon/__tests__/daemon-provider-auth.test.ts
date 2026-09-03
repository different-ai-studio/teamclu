import { describe, expect, it } from 'vitest'
import {
  fallbackProviderAuthMethods,
  mergeProviderAuthMethods,
} from '@/lib/daemon/daemon-provider-auth'

describe('daemon-provider-auth', () => {
  it('includes OpenAI OAuth in the static fallback catalog', () => {
    expect(fallbackProviderAuthMethods().openai).toEqual([
      { type: 'oauth', label: 'Browser login' },
    ])
  })

  it('adds OAuth fallback when the API catalog omits it', () => {
    const merged = mergeProviderAuthMethods({
      openai: [{ type: 'api', label: 'API key' }],
    })
    expect(merged.openai).toEqual([
      { type: 'oauth', label: 'Browser login' },
      { type: 'api', label: 'API key' },
    ])
  })

  it('does not override OAuth returned by the API', () => {
    const merged = mergeProviderAuthMethods({
      openai: [{ type: 'oauth', label: 'ChatGPT login' }],
    })
    expect(merged.openai).toEqual([{ type: 'oauth', label: 'ChatGPT login' }])
  })
})
