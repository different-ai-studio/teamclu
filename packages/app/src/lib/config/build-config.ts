// Build-time configuration injected by Vite's `define` from build.config.json.
// See build.config.example.json for all available fields.

import {
  DEFAULT_EXTENSION_PACK_CONFIG,
  parseExtensionPackConfig,
  type ExtensionPackConfig,
  type ExtensionSettingsBake,
  type ExtensionTeamOnboardingBake,
} from '@/lib/extension/extension-settings-bake'

export type {
  ExtensionSettingsBake,
  ExtensionLinkHoverBake,
  ExtensionPackConfig,
  ExtensionTeamOnboardingBake,
} from '@/lib/extension/extension-settings-bake'


export interface ChannelsFeatureConfig {
  discord: boolean
  feishu: boolean
  email: boolean
  kook: boolean
  wecom: boolean
  wechat: boolean
  seatalk: boolean
}

export interface TeamModelOption {
  id: string
  name: string
}

export interface BuildConfig {
  /** Cloud API base URL (e.g. https://cloud.ucar.cc) baked into the build as the
   *  default backend endpoint. The VITE_CLOUD_API_URL env var overrides it at
   *  build/dev time; at runtime an explicit user override (the "Custom server"
   *  entry in onboarding) wins over both — see lib/server-config.ts. */
  cloudApiUrl?: string
  /** Browser MQTT-over-WebSocket endpoint (ws/wss, e.g.
   *  wss://mqtt.example.com/mqtt), overriding the TCP broker that
   *  `/v1/config/bootstrap` hands out. Web/extension builds only — a
   *  chrome-extension:// secure context cannot reach a plaintext broker. Read by
   *  `apps/extension/build.mjs`, which passes it to vite as VITE_MQTT_WS_URL so
   *  a brand's package points at the brand's broker; the desktop build ignores
   *  it and keeps using the bootstrap address. Also accepted under the
   *  `extension` / `extensions` block. */
  mqttWsUrl?: string
  /**
   * Retired: `lockLlmConfig` is a Cloud API flag now
   * (services/fc/src/lib/feature-profiles.ts). Kept optional and unread so an
   * existing brand config carrying it still parses.
   */
  team?: {
    lockLlmConfig?: boolean
  }
  app: {
    /** Bundle identity: drives `productName`, the .app / installer filename, and
     *  the derived `shortName`. Keep it filename-clean (ASCII, no spaces is
     *  safest) — for the human-facing label use `displayName` instead. */
    name: string
    /** Human-facing label: the window title and every in-app mention of the
     *  product. Omitted → falls back to `app.name`. Set this when the UI name
     *  should differ from the bundle name (e.g. name "TeamClu" keeps the .app
     *  and download URL clean while displayName "TeamClu 龙虾团" shows in the UI). */
    displayName?: string
    shortName?: string
    /** Visual palette flavor. Omitted / "default" → Editorial Calm.
     *  "teal" → anodized-teal build flavor (see styles/globals.css). Applied
     *  as data-palette on <html> at first paint. */
    palette?: string
    /** Build-time white-label: path (relative to repo root) to a square source
     *  PNG (≥512px, ideally 1024×1024). When set, the prebuild step regenerates
     *  the OS icon set and the in-app logo from it. Omitted → keep committed assets. */
    logo?: string
    /** Build-time white-label: OS bundle identifier (reverse-DNS, e.g.
     *  "com.acme.app"). Omitted → keep the default com.teamclu.app. */
    identifier?: string
    /** Build-time white-label: deep-link URL scheme (e.g. "acme" →
     *  acme://invite?token=…). Omitted → "teamclu". */
    scheme?: string
  }
  /**
   * Build-time inputs only. Feature FLAGS moved to the Cloud API
   * (services/fc/src/lib/feature-profiles.ts) and are no longer read from
   * here — adding one back to a build config would have no effect.
   *
   * What is left is the one thing a server must not be able to decide.
   */
  features: {
    /** Enables the in-app updater UI (About → check/install) and the startup
     *  auto-check. The update *server* URL is configured separately via
     *  `app.updater.endpoints` (baked into tauri.conf at build time).
     *
     *  Never server-controlled: it gates the auto-check itself, so a wrong
     *  remote value would strand every installed client with no way to update
     *  out of the mistake. Absent means on. */
    updater?: boolean
  }
  /** Which local agent runtime this build targets. "opencode" (default) drives
   *  the official opencode over `opencode serve` HTTP; "pi" selects the pi
   *  coding-agent RPC backend; "cursor" selects the Cursor SDK bridge
   *  (see docs/architecture/cursor-sdk-backend.md).
   *  Flows into the daemon config (`agents.local_agent`) during onboarding. */
  localAgent?: 'opencode' | 'pi' | 'cursor' | 'claude-code' | 'claude_code' | 'claude'
  defaults: {
    theme: string
  }
  /**
   * Chrome extension pack options (`solo`, side-panel `domains`, `settings`).
   * Sole source for extension packaging — no SOLO/DOMAINS CLI overrides.
   */
  extensions?: Omit<Partial<ExtensionPackConfig>, 'settings' | 'teamOnboarding'> & {
    teamOnboarding?: Partial<ExtensionTeamOnboardingBake>
    settings?: Partial<ExtensionSettingsBake> & {
      linkHover?: Partial<ExtensionSettingsBake['linkHover']>
    }
  }
}

const allChannelsEnabled: ChannelsFeatureConfig = {
  discord: true,
  feishu: true,
  email: true,
  kook: true,
  wecom: true,
  wechat: true,
  seatalk: true,
}

/**
 * Normalize channels config: `true` → all enabled, `false` → all disabled, object → as-is.
 */
export function resolveChannelsConfig(channels: boolean | ChannelsFeatureConfig): ChannelsFeatureConfig {
  if (typeof channels === 'boolean') {
    return channels
      ? { ...allChannelsEnabled }
      : { discord: false, feishu: false, email: false, kook: false, wecom: false, wechat: false, seatalk: false }
  }
  return channels
}

/** Whether at least one channel is enabled. */
export function hasAnyChannel(channels: boolean | ChannelsFeatureConfig): boolean {
  if (typeof channels === 'boolean') return channels
  return Object.values(channels).some(Boolean)
}

/**
 * Values used when no `build.config.*.json` is baked in.
 *
 * Exported because it is a contract worth asserting on: features that must be
 * opt-in (webSSO) have to default off here, and a test that reads the merged
 * `buildConfig` instead cannot check that — locally the merge has already
 * layered `build.config.dev.json` on top.
 */
export const FALLBACK_BUILD_CONFIG: BuildConfig = {
  app: { name: 'TeamClu', shortName: 'teamclu' },
  // Feature flags are the Cloud API's now; only the two build-time inputs live
  // here. `updater: true` matches the resolver's default — an absent flag must
  // not silently disable updates.
  features: { updater: true },
  defaults: { theme: 'system' },
}

function deepMerge(base: any, override: any): any {
  if (!override) return base
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const baseVal = result[key]
    const overVal = override[key]
    if (
      baseVal && overVal &&
      typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      typeof overVal === 'object' && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal)
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }
  return result
}

export const buildConfig: BuildConfig = typeof __BUILD_CONFIG__ !== 'undefined' && __BUILD_CONFIG__
  ? deepMerge(FALLBACK_BUILD_CONFIG, __BUILD_CONFIG__) as BuildConfig
  : FALLBACK_BUILD_CONFIG

function deriveShortName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

/**
 * The one official brand short name. Mirrors
 * `teamclu_runtime_env::storage_namespace::OFFICIAL_STORAGE_DIR`; the mirror is
 * held by a parity test (`__tests__/brand-parity.test.ts`) that reads the Rust
 * source, because the two are compiled by different toolchains and a shared
 * constant would need a codegen step for one string.
 */
export const OFFICIAL_BRAND_SHORT_NAME = 'teamclu'

/**
 * Exactly one name is official. `teamcludev`, `teamclaw` and `teamclawdev` are
 * deliberately white-label — see `docs/architecture/amuxd-home-layout-v2.md` §6.
 */
export function isOfficialBrand(shortName: string): boolean {
  return shortName === OFFICIAL_BRAND_SHORT_NAME
}

/** Home dir + localStorage prefix (`teamclu` for the official build). */
function resolveStorageDirName(shortName: string): string {
  return isOfficialBrand(shortName) ? OFFICIAL_BRAND_SHORT_NAME : shortName
}

/**
 * Local amuxd state folder under `$HOME` (no leading dot).
 * Official → `amuxd` (`~/.amuxd`); white-label → `amuxd-<brand>`.
 */
export function resolveAmuxdDirName(shortName: string): string {
  return isOfficialBrand(shortName) ? 'amuxd' : `amuxd-${shortName}`
}

export const appShortName: string = buildConfig.app.shortName ?? deriveShortName(buildConfig.app.name)
/** Prefix for localStorage keys — unified `teamclu` for official builds (Decision 1 = B). */
export const appStoragePrefix: string = resolveStorageDirName(appShortName)
/** The product name to show users. Prefer this over `buildConfig.app.name` in
 *  any UI string — `app.name` is the bundle identity and may differ. */
export const appDisplayName: string = buildConfig.app.displayName ?? buildConfig.app.name
/** Deep-link scheme used when a build does not declare `app.scheme`. */
const DEFAULT_APP_SCHEME = 'teamclu'
export const appScheme: string = buildConfig.app.scheme ?? DEFAULT_APP_SCHEME

/**
 * Schemes this build accepts on an inbound deeplink.
 *
 * A build that declares its own `app.scheme` speaks only that scheme.
 * `scripts/lib/branding.js` rewrites tauri.conf's deep-link list to exactly
 * `[app.scheme]`, so the OS never hands a `teamclu://` link to that build in the
 * first place — accepting them here only made a pasted official link look
 * supported. copilot361 (scheme `copilot361`) is such a build.
 *
 * Builds with no explicit scheme keep the legacy list: `teamclaw://` from before
 * the rename, and `amux://`, which is still what the `create_team_invite` RPC
 * emits. That covers the official builds and the betly brand, which ships on the
 * default `teamclu` scheme.
 */
export function resolveDeeplinkSchemes(scheme: string | undefined): string[] {
  const own = scheme ?? DEFAULT_APP_SCHEME
  return own === DEFAULT_APP_SCHEME ? [own, 'teamclaw', 'amux'] : [own]
}

export const deeplinkSchemes: readonly string[] = resolveDeeplinkSchemes(buildConfig.app.scheme)
/**
 * Local agent runtime for this build. Defaults to opencode.
 *
 * It is the runtime the dependency probe and the diagnostic report assume for
 * this build — NOT what onboarding writes into `agents.local_agent`; that is
 * the user's pick on the setup step (see `stores/daemon-onboarding.ts`). A
 * missing arm here still mislabels every one of those, so keep them in sync:
 * claude-code was missing, and its build.config value silently became opencode.
 */
export const localAgent: 'opencode' | 'pi' | 'cursor' | 'claude-code' =
  buildConfig.localAgent === 'pi'
    ? 'pi'
    : buildConfig.localAgent === 'cursor'
      ? 'cursor'
      : buildConfig.localAgent === 'claude-code' ||
          buildConfig.localAgent === 'claude_code' ||
          buildConfig.localAgent === 'claude'
        ? 'claude-code'
        : 'opencode'
export const DEFAULT_WORKSPACE_PATH = `~/${buildConfig.app.name}`
export const TEAMCLU_DIR = isOfficialBrand(appShortName) ? '.teamclu' : `.${appShortName}`
/** Team share link + global sync dir name. Fixed across brands so daemon, git, and all clients agree. */
export const TEAM_REPO_DIR = 'teamclu-team'
export const CONFIG_FILE_NAME = isOfficialBrand(appShortName) ? 'teamclu.json' : `${appShortName}.json`
export const TEAM_SYNCED_EVENT = `${appStoragePrefix}-team-synced`

/** Baked Chrome-extension pack config (`extensions` in build.config*.json). */
export const extensionPack: ExtensionPackConfig = parseExtensionPackConfig(
  typeof __TEAMCLU_EXTENSION_PACK__ !== 'undefined'
    ? __TEAMCLU_EXTENSION_PACK__
    : buildConfig.extensions ?? DEFAULT_EXTENSION_PACK_CONFIG,
)

/** Baked Chrome-extension settings (`extensions.settings`). */
const extensionSettings: ExtensionSettingsBake = extensionPack.settings

/** Extension-only policy for assigning a team after sign-in. */
export const extensionTeamOnboarding: ExtensionTeamOnboardingBake = extensionPack.teamOnboarding

/** When true, the extension side-panel hides the settings gear button. */
export const hideExtensionSettingsButton: boolean = extensionSettings.hideButton === true

/** Solo-agent extension build (`extensions.solo`). */
export const extensionSoloBuild: boolean = extensionPack.solo === true

/** Side-panel host gate patterns (`extensions.domains`). Empty = ungated. */
export const extensionSidePanelDomains: readonly string[] = extensionPack.domains
