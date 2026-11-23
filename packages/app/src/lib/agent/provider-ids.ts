/**
 * Shared types and helpers for provider IDs.
 *
 * LLM providers are persisted via the daemon workspace-control API — do not
 * read or write `opencode.json` from the desktop webview.
 */

// Model configuration for custom provider
interface CustomModelConfig {
  modelId: string
  modelName?: string
  limit?: {
    context?: number
    output?: number
  }
  modalities?: {
    input: string[]
    output: string[]
  }
}

// Shape of a custom provider entry in opencode.json
export interface CustomProviderConfig {
  name: string
  baseURL: string
  apiKey?: string
  models: CustomModelConfig[]
}

/**
 * Slugify a provider name into a valid ID.
 * e.g. "My Custom Provider" -> "my-custom-provider"
 */
export function slugifyProviderId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Stable custom-provider id prefix used by the daemon workspace-control API. */
export function customProviderIdFromName(name: string): string | null {
  const slug = slugifyProviderId(name)
  return slug ? `custom-${slug}` : null
}

/**
 * Generate the keychain key name for a provider's API key.
 */
export function providerApiKeyName(providerId: string): string {
  return `${providerId}_api_key`
}
