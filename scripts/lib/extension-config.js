'use strict'

/**
 * Chrome extension pack options from `build.config*.json` → `extensions`.
 * No CLI / env overrides — config file is the only source.
 *
 * Two spellings reach this module and both must work. The repo's own configs
 * (build.config.example.json) use `extensions.domains`; every brand in the
 * enterprise-branding repo uses `extension.hosts`. Until this was reconciled,
 * `extension.hosts` parsed to nothing, so brands that meant to scope the
 * extension to a handful of domains silently shipped `<all_urls>` instead.
 * `resolveExtensionPack` is the single entry point that accepts either.
 */

function asStringList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function asLocalizedStrings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [locale, message] of Object.entries(raw)) {
    if (typeof message !== 'string') continue
    const normalizedLocale = locale.trim()
    const normalizedMessage = message.trim()
    if (!normalizedLocale || !normalizedMessage) continue
    out[normalizedLocale] = normalizedMessage
  }
  return out
}

/**
 * Normalize a domain entry for the side-panel host gate.
 * Accepts either `*.shopee.io` or a Chrome match pattern `https://*.shopee.io/*`.
 */
function toSidePanelDomain(raw) {
  let value = String(raw || '').trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  value = value.split('/')[0] || ''
  value = value.split('?')[0]?.split('#')[0] || ''
  value = value.replace(/\.$/, '')
  return value || null
}

/** Chrome match pattern for manifest host_permissions / content_scripts.matches. */
function toChromeMatchPattern(raw) {
  const value = String(raw || '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) {
    if (value.includes('*') || /\/./.test(value.slice(value.indexOf('://') + 3))) {
      return value
    }
    return value.endsWith('/') ? `${value}*` : `${value}/*`
  }
  return `https://${value}/*`
}

function parseExtensionsConfig(raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const domainsRaw = [...asStringList(row.domains), ...asStringList(row.hosts)]
  const domains = []
  const seen = new Set()
  for (const item of domainsRaw) {
    const domain = toSidePanelDomain(item)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    domains.push(domain)
  }

  const settingsRaw = row.settings && typeof row.settings === 'object' ? row.settings : {}
  const linkHoverRaw =
    settingsRaw.linkHover && typeof settingsRaw.linkHover === 'object'
      ? settingsRaw.linkHover
      : {}
  const teamOnboardingRaw =
    row.teamOnboarding && typeof row.teamOnboarding === 'object'
      ? row.teamOnboarding
      : {}

  return {
    solo: row.solo === true,
    /** When false, extension embed hides agent-reply thread fork UI. Omitted → enabled. */
    agentReplyFork: row.agentReplyFork !== false,
    domains,
    teamOnboarding: {
      autoCreateTeam: teamOnboardingRaw.autoCreateTeam !== false,
      noTeamMessage: asLocalizedStrings(teamOnboardingRaw.noTeamMessage),
    },
    settings: {
      hideButton: settingsRaw.hideButton === true,
      linkHover: {
        domains: asStringList(linkHoverRaw.domains),
        urlPatterns: asStringList(linkHoverRaw.urlPatterns),
      },
    },
  }
}

/**
 * Resolve the extension pack from a whole merged build config, accepting both
 * the `extensions` (repo) and `extension` (branding repo) blocks. When both are
 * present the canonical `extensions` block wins on scalars and settings, while
 * host lists from either spelling are unioned — a brand that adds `extension.hosts`
 * on top of a repo default should widen the allowlist, not silently replace it.
 */
function resolveExtensionPack(buildConfig) {
  const cfg = buildConfig && typeof buildConfig === 'object' ? buildConfig : {}
  const canonical = cfg.extensions && typeof cfg.extensions === 'object' ? cfg.extensions : {}
  const alias = cfg.extension && typeof cfg.extension === 'object' ? cfg.extension : {}

  return parseExtensionsConfig({
    ...alias,
    ...canonical,
    domains: [
      ...asStringList(canonical.domains),
      ...asStringList(canonical.hosts),
      ...asStringList(alias.domains),
      ...asStringList(alias.hosts),
    ],
    solo: canonical.solo === true || alias.solo === true,
    agentReplyFork:
      canonical.agentReplyFork !== false && alias.agentReplyFork !== false,
    teamOnboarding: {
      ...(alias.teamOnboarding && typeof alias.teamOnboarding === 'object'
        ? alias.teamOnboarding
        : {}),
      ...(canonical.teamOnboarding && typeof canonical.teamOnboarding === 'object'
        ? canonical.teamOnboarding
        : {}),
      noTeamMessage: {
        ...(alias.teamOnboarding?.noTeamMessage && typeof alias.teamOnboarding.noTeamMessage === 'object'
          ? alias.teamOnboarding.noTeamMessage
          : {}),
        ...(canonical.teamOnboarding?.noTeamMessage && typeof canonical.teamOnboarding.noTeamMessage === 'object'
          ? canonical.teamOnboarding.noTeamMessage
          : {}),
      },
    },
    settings: {
      ...(alias.settings && typeof alias.settings === 'object' ? alias.settings : {}),
      ...(canonical.settings && typeof canonical.settings === 'object' ? canonical.settings : {}),
    },
  })
}

/** Trims trailing slashes and rejects anything that is not an http(s) URL. */
function normalizeHttpUrl(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '')
  if (!trimmed) return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return trimmed
}

/** Same shape check for the browser MQTT endpoint, which must be ws/wss. */
function normalizeWsUrl(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
  return trimmed
}

/**
 * The backend a packaged extension talks to, read from the merged build config.
 *
 * This exists because `packages/app/.env.web` pins `VITE_CLOUD_API_URL` /
 * `VITE_MQTT_WS_URL`, and `server-config.ts` lets the env var win over
 * `buildConfig.cloudApiUrl`. Every branded package therefore shipped pointing at
 * the TeamClu backend no matter which backend the brand declared — the same
 * class of bug as the `BUILD_ENV` trap documented in release-extension.yml, just
 * arriving through a committed env file instead. The extension build passes
 * these values to vite as real env vars, which outrank `.env.*` files, so the
 * brand's config is what gets baked and `.env.web` degrades to the fallback it
 * reads as.
 *
 * `mqttWsUrl` accepts the `extension` / `extensions` block as well as the top
 * level: it is a browser-only endpoint (a chrome-extension:// secure context
 * cannot reach the plaintext TCP broker that `/v1/config/bootstrap` hands out),
 * so a brand may reasonably file it under its extension block. `cloudApiUrl` is
 * top-level only — it is the same field the desktop pipeline reads.
 */
function resolveExtensionBackend(buildConfig) {
  const cfg = buildConfig && typeof buildConfig === 'object' ? buildConfig : {}
  const canonical = cfg.extensions && typeof cfg.extensions === 'object' ? cfg.extensions : {}
  const alias = cfg.extension && typeof cfg.extension === 'object' ? cfg.extension : {}

  const rawCloudApiUrl = cfg.cloudApiUrl
  const cloudApiUrl = normalizeHttpUrl(rawCloudApiUrl)
  if (rawCloudApiUrl && !cloudApiUrl) {
    throw new Error(
      `build config cloudApiUrl is not a valid http(s) URL: ${JSON.stringify(rawCloudApiUrl)}`,
    )
  }

  const rawMqttWsUrl = canonical.mqttWsUrl ?? alias.mqttWsUrl ?? cfg.mqttWsUrl
  const mqttWsUrl = normalizeWsUrl(rawMqttWsUrl)
  if (rawMqttWsUrl && !mqttWsUrl) {
    throw new Error(
      `build config mqttWsUrl is not a valid ws(s) URL: ${JSON.stringify(rawMqttWsUrl)}`,
    )
  }

  return { cloudApiUrl, mqttWsUrl }
}

function domainsToChromeMatchPatterns(domains) {
  const out = []
  const seen = new Set()
  for (const item of domains) {
    const pattern = toChromeMatchPattern(item)
    if (!pattern || seen.has(pattern)) continue
    seen.add(pattern)
    out.push(pattern)
  }
  return out
}

function domainsToSidePanelCsv(domains) {
  return parseExtensionsConfig({ domains }).domains.join(',')
}

/**
 * Directories under `packages/app/public/` that vite copies verbatim into the
 * app bundle but which nothing in the side panel ever requests, and which the
 * extension package therefore must not carry to the Chrome Web Store.
 *
 * `public/` means "ship this", so anything parked there reaches a published,
 * publicly downloadable package. That put eight internal design prototypes and
 * a TeamClu mascot into a Copilot 361 build — brand-leaking dead weight in an
 * artifact a store reviewer unzips.
 *
 * Pruning is deliberately a small, named allowlist rather than a heuristic:
 * deleting an asset that IS requested at runtime shows up as a broken image in
 * production, not as a build failure. The guardrail test in
 * extension-config.test.js greps packages/app/src for references to each entry,
 * so adding one that is actually in use fails the suite instead of the UI.
 */
const SIDE_PANEL_PRUNE_DIRS = [
  // Design prototypes: standalone HTML mockups kept for reference. Nothing
  // imports or links them; they are read by opening the file directly.
  'prototypes',
]

/**
 * A pruned directory may still be named by a source file without being live, if
 * that file is itself unreachable. Each exception below records the one file
 * allowed to reference a pruned directory, plus the export whose absence from
 * every import statement is what makes the reference dead.
 *
 * This exists so the dead-ness is asserted rather than assumed. The alternative
 * — deleting the component — would also satisfy the guardrail, but throws away
 * working code on the strength of a grep. Encoding the claim means the day
 * someone imports LobsterLoader, the suite fails and says to drop `lobster`
 * from the prune list, instead of the mascot quietly vanishing from the UI.
 */
const PRUNE_REFERENCE_EXCEPTIONS = []

module.exports = {
  parseExtensionsConfig,
  resolveExtensionPack,
  resolveExtensionBackend,
  toSidePanelDomain,
  toChromeMatchPattern,
  domainsToChromeMatchPatterns,
  domainsToSidePanelCsv,
  SIDE_PANEL_PRUNE_DIRS,
  PRUNE_REFERENCE_EXCEPTIONS,
}
