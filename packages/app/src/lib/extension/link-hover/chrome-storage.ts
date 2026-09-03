import {
  DEFAULT_LINK_HOVER_CONFIG,
  LINK_HOVER_CONFIG_KEY,
  type LinkHoverConfig,
  parseLinkHoverConfig,
} from './config'
import { parseExtensionSettingsBake } from '../extension-settings-bake'

type ChromeStorageLocal = {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
}

type ChromeStorage = {
  local?: ChromeStorageLocal
  onChanged?: {
    addListener: (
      listener: (
        changes: Record<string, { newValue?: unknown }>,
        areaName: string,
      ) => void,
    ) => void
    removeListener: (
      listener: (
        changes: Record<string, { newValue?: unknown }>,
        areaName: string,
      ) => void,
    ) => void
  }
}

function readChromeStorage(): ChromeStorage | undefined {
  return (globalThis as { chrome?: { storage?: ChromeStorage } }).chrome?.storage
}

/**
 * Build-time defaults for link-hover. Prefer the esbuild/Vite define (content
 * script + sidepanel), fall back to empty allowlists.
 */
export function getBakedLinkHoverConfig(): LinkHoverConfig {
  const fromDefine =
    typeof __TEAMCLU_EXTENSION_SETTINGS__ !== 'undefined'
      ? __TEAMCLU_EXTENSION_SETTINGS__
      : undefined
  if (fromDefine !== undefined) {
    return parseLinkHoverConfig(parseExtensionSettingsBake(fromDefine).linkHover)
  }
  return { ...DEFAULT_LINK_HOVER_CONFIG, domains: [], urlPatterns: [] }
}

/**
 * Legacy packs only persisted `{ domains }`. Treat a missing `urlPatterns` key
 * as "never migrated" and fill from bake once. An explicit `urlPatterns: []`
 * (user cleared in settings) must not be overwritten.
 */
function needsLegacyUrlPatternSeed(raw: unknown, baked: LinkHoverConfig): boolean {
  if (baked.urlPatterns.length === 0) return false
  if (!raw || typeof raw !== 'object') return false
  return !Object.prototype.hasOwnProperty.call(raw, 'urlPatterns')
}

export async function readLinkHoverConfig(): Promise<LinkHoverConfig> {
  const baked = getBakedLinkHoverConfig()
  const storage = readChromeStorage()?.local
  if (!storage) return baked

  try {
    const bag = await storage.get(LINK_HOVER_CONFIG_KEY)
    const raw = bag[LINK_HOVER_CONFIG_KEY]
    if (!(LINK_HOVER_CONFIG_KEY in bag) || raw == null) {
      if (baked.domains.length > 0 || baked.urlPatterns.length > 0) {
        await storage.set({ [LINK_HOVER_CONFIG_KEY]: baked })
      }
      return baked
    }

    const parsed = parseLinkHoverConfig(raw)
    if (needsLegacyUrlPatternSeed(raw, baked)) {
      const merged: LinkHoverConfig = {
        domains: parsed.domains,
        urlPatterns: [...baked.urlPatterns],
      }
      await storage.set({ [LINK_HOVER_CONFIG_KEY]: merged })
      return merged
    }

    return parsed
  } catch {
    return baked
  }
}

export async function writeLinkHoverConfig(config: LinkHoverConfig): Promise<void> {
  const storage = readChromeStorage()?.local
  if (!storage) return

  const parsed = parseLinkHoverConfig(config)
  await storage.set({ [LINK_HOVER_CONFIG_KEY]: parsed })
}

export function watchLinkHoverConfig(
  onChange: (config: LinkHoverConfig) => void,
): () => void {
  const storage = readChromeStorage()
  if (!storage?.onChanged) return () => {}

  const listener = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return
    if (!(LINK_HOVER_CONFIG_KEY in changes)) return
    onChange(parseLinkHoverConfig(changes[LINK_HOVER_CONFIG_KEY]?.newValue))
  }

  storage.onChanged.addListener(listener)
  return () => storage.onChanged?.removeListener(listener)
}
