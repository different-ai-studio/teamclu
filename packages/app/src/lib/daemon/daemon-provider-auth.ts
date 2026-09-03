/**
 * Provider auth catalog helpers — mirrors amuxd `provider-auth-methods` API.
 * Client-side fallback is used only when daemon HTTP is unreachable.
 */

export type ProviderAuthMethod = {
  type: 'oauth' | 'api'
  label: string
  prompts?: unknown[]
}

type ProviderAuthMethodsMap = Record<string, ProviderAuthMethod[]>

/** Built-in providers that expose browser OAuth (matches daemon Phase 1 catalog). */
const FALLBACK_OAUTH_AUTH_METHODS: ProviderAuthMethodsMap = {
  openai: [{ type: 'oauth', label: 'Browser login' }],
  anthropic: [{ type: 'oauth', label: 'Browser login' }],
  google: [{ type: 'oauth', label: 'Browser login' }],
}

export function mergeProviderAuthMethods(
  fromApi: ProviderAuthMethodsMap,
): ProviderAuthMethodsMap {
  const merged: ProviderAuthMethodsMap = { ...fromApi }

  for (const [providerId, fallback] of Object.entries(FALLBACK_OAUTH_AUTH_METHODS)) {
    const existing = merged[providerId] ?? []
    if (existing.some((m) => m.type === 'oauth')) continue
    merged[providerId] = [...fallback, ...existing]
  }

  return merged
}

export function fallbackProviderAuthMethods(): ProviderAuthMethodsMap {
  return { ...FALLBACK_OAUTH_AUTH_METHODS }
}
