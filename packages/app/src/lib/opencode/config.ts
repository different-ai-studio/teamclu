/**
 * Shared types and helpers for provider IDs and skill-permission resolution.
 *
 * LLM providers and skill permissions are persisted via the daemon workspace-control
 * API — do not read or write `opencode.json` from the desktop webview.
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

export type SkillPermission = 'allow' | 'deny' | 'ask'

export type SkillPermissionMap = Record<string, SkillPermission>

export interface ResolvedPermission {
  permission: SkillPermission
  matchedPattern: string
  isExact: boolean
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

function matchesPattern(skillName: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === skillName
  const prefix = pattern.slice(0, -1)
  return skillName.startsWith(prefix)
}

/**
 * Resolve the effective permission for a skill name against a permission map.
 * Priority: exact match > prefix wildcard (longer prefix wins) > global wildcard "*"
 */
export function resolveSkillPermission(
  skillName: string,
  permissions: SkillPermissionMap
): ResolvedPermission {
  if (permissions[skillName]) {
    return { permission: permissions[skillName], matchedPattern: skillName, isExact: true }
  }

  let bestMatch: { pattern: string; prefixLen: number } | null = null
  for (const pattern of Object.keys(permissions)) {
    if (pattern === '*' || pattern === skillName) continue
    if (matchesPattern(skillName, pattern)) {
      const prefixLen = pattern.length
      if (!bestMatch || prefixLen > bestMatch.prefixLen) {
        bestMatch = { pattern, prefixLen }
      }
    }
  }

  if (bestMatch) {
    return { permission: permissions[bestMatch.pattern], matchedPattern: bestMatch.pattern, isExact: false }
  }

  if (permissions['*']) {
    return { permission: permissions['*'], matchedPattern: '*', isExact: false }
  }

  return { permission: 'allow', matchedPattern: '*', isExact: false }
}
