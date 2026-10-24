/**
 * Link-hover content script, registered at runtime instead of declared in the
 * manifest.
 *
 * The unbranded package used to ship `content_scripts` + `host_permissions` on
 * every http(s) site and, on install, injected into every open tab. The Chrome
 * Web Store flagged that as far broader than the feature needs: the hover badge
 * only ever shows on domains the user allow-listed in Settings, and nothing else
 * in the content script runs unless the user (or an agent request the user
 * approved) asks for the page.
 *
 * Now: the user adds a domain in Settings → the side panel requests optional
 * host access for that domain → this module registers the content script for
 * exactly the allow-listed domains that have been granted. Branded packages
 * that declare a static, domain-scoped content script are left alone.
 */

export const LINK_HOVER_SCRIPT_ID = 'teamclu-link-hover'

/** Chrome match patterns for one allow-listed link-hover domain (apex + subdomains). */
export function linkHoverOriginsForDomain(domain: string): string[] {
  return [`http://*.${domain}/*`, `https://*.${domain}/*`]
}

export interface DynamicContentScriptDeps {
  manifestHasStaticContentScripts: () => boolean
  readDomains: () => Promise<string[]>
  hasOrigins: (origins: string[]) => Promise<boolean>
  getRegisteredIds: () => Promise<string[]>
  unregister: (ids: string[]) => Promise<void>
  register: (matches: string[]) => Promise<void>
}

/** Returns the match patterns now registered (empty when none / skipped). */
export async function syncLinkHoverContentScript(deps: DynamicContentScriptDeps): Promise<string[]> {
  if (deps.manifestHasStaticContentScripts()) return []

  const matches: string[] = []
  for (const domain of await deps.readDomains()) {
    const origins = linkHoverOriginsForDomain(domain)
    if (await deps.hasOrigins(origins)) matches.push(...origins)
  }

  const registered = await deps.getRegisteredIds()
  if (registered.includes(LINK_HOVER_SCRIPT_ID)) {
    await deps.unregister([LINK_HOVER_SCRIPT_ID])
  }
  if (matches.length > 0) {
    await deps.register(matches)
  }
  return matches
}

export function chromeDynamicContentScriptDeps(
  readDomains: () => Promise<string[]>,
): DynamicContentScriptDeps {
  return {
    manifestHasStaticContentScripts: () =>
      (chrome.runtime.getManifest().content_scripts?.length ?? 0) > 0,
    readDomains,
    hasOrigins: async (origins) => {
      try {
        return await chrome.permissions.contains({ origins })
      } catch {
        return false
      }
    },
    getRegisteredIds: async () =>
      (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
    unregister: async (ids) => {
      await chrome.scripting.unregisterContentScripts({ ids })
    },
    register: async (matches) => {
      await chrome.scripting.registerContentScripts([
        {
          id: LINK_HOVER_SCRIPT_ID,
          matches,
          js: ['content-script.js'],
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ])
    },
  }
}
