// apps/extension/build.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const repoRoot = resolve(here, '../..')
const appDir = resolve(here, '../../packages/app')
const linkHoverShared = resolve(appDir, 'src/lib/extension/link-hover')
const linkSessionShared = resolve(appDir, 'src/lib/extension/link-session')
const nodeRequire = createRequire(import.meta.url)
const {
  resolveExtensionPack,
  resolveExtensionBackend,
  domainsToSidePanelCsv,
  SIDE_PANEL_PRUNE_DIRS,
} = nodeRequire(resolve(repoRoot, 'scripts/lib/extension-config.js'))

const esbuildAlias = {
  '@teamclu/extension-link-hover': resolve(linkHoverShared, 'index.ts'),
  '@teamclu/extension-link-session': resolve(linkSessionShared, 'index.ts'),
}

function readJSON(filePath) {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function deepMerge(base, overlay) {
  if (!overlay) return base
  const result = { ...base }
  for (const key of Object.keys(overlay)) {
    const baseVal = result[key]
    const overVal = overlay[key]
    if (
      baseVal &&
      overVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal)
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }
  return result
}

/** Same merge as packages/app/vite.config.ts — base + build.config.<BUILD_ENV>.json. */
function loadMergedBuildConfig() {
  const { resolveBuildEnv } = nodeRequire(resolve(repoRoot, 'scripts/lib/resolve-build-env.js'))
  const buildEnv = resolveBuildEnv(repoRoot)
  const baseConfig = readJSON(resolve(repoRoot, 'build.config.json')) || {}
  const envConfig = buildEnv ? readJSON(resolve(repoRoot, `build.config.${buildEnv}.json`)) : null
  return deepMerge(baseConfig, envConfig)
}

const mergedBuildConfig = loadMergedBuildConfig()
const extensionPack = resolveExtensionPack(mergedBuildConfig)
const domainsCsv = domainsToSidePanelCsv(extensionPack.domains)
const extensionSettingsBake = extensionPack.settings
const backend = resolveExtensionBackend(mergedBuildConfig)

// A package with no backend is not a degraded package, it is a dead one: every
// request and the sign-in screen have nowhere to go. Refusing to build is the
// only outcome that cannot end up on the Chrome Web Store, and it is strictly
// better than the previous behaviour, where .env.web quietly supplied the
// TeamClu backend to a brand that meant to ship its own.
if (!backend.cloudApiUrl) {
  console.error(
    '[extension] build.config.json declares no cloudApiUrl — refusing to build a package\n' +
      '            with no backend. Add "cloudApiUrl" to the brand config (brands/<brand>/\n' +
      '            build.config.json in the enterprise-branding repo) and re-run.',
  )
  process.exit(1)
}

// mqttWsUrl gets the same treatment, for the same reason one step removed. It
// used to be a console warning that let the build through, and what shipped was
// a package whose API talked to the brand's cluster while realtime kept the
// TeamClu broker baked into .env.web. That package does not fail loudly — it
// signs in fine and then every session reports `runtime_start_failure:
// transport_offline`, because the broker it reaches has no idea who the user is.
// A build error names the missing field; the runtime symptom does not.
if (!backend.mqttWsUrl) {
  console.error(
    '[extension] build.config.json declares no mqttWsUrl — refusing to build a package\n' +
      '            whose realtime transport would fall back to the TeamClu broker while\n' +
      '            its API points elsewhere. Add "mqttWsUrl" (top level, or under the\n' +
      '            "extensions" block) to the brand config and re-run.',
  )
  process.exit(1)
}

const esbuildAliasWithAllowlist = {
  ...esbuildAlias,
  '@teamclu/side-panel-host-allowlist': resolve(appDir, 'src/lib/extension/side-panel-host-allowlist.ts'),
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 1) Build the web app in forced-embed mode with relative base.
// EXT_ENV=test targets the wss-capable self-host test deployment
// (.env.web.test); otherwise the default .env.web is used.
// solo / domains come from build.config*.json → extensions (baked via __BUILD_CONFIG__).
//
// The backend comes from the build config and is passed as a real env var,
// which vite ranks above any .env.* file — see resolveExtensionBackend for why
// the committed .env.web values otherwise won. EXT_ENV=test is the one case
// where the env file is meant to be authoritative: it exists precisely to point
// a local build at the self-host test deployment, so leave it alone.
const webBuildScript = process.env.EXT_ENV === 'test' ? 'build:web:test' : 'build:web'
const backendEnv =
  process.env.EXT_ENV === 'test'
    ? {}
    : {
        VITE_CLOUD_API_URL: backend.cloudApiUrl,
        VITE_MQTT_WS_URL: backend.mqttWsUrl,
      }
console.log(
  '[extension] web build ->',
  webBuildScript,
  extensionPack.solo ? '(solo)' : '',
  domainsCsv ? `(domains: ${domainsCsv})` : '(domains: ungated)',
)
if (process.env.EXT_ENV === 'test') {
  console.log('[extension] backend -> .env.web.test (EXT_ENV=test)')
} else {
  console.log('[extension] backend -> cloudApiUrl:', backend.cloudApiUrl)
  console.log('[extension] backend -> mqttWsUrl:', backend.mqttWsUrl)
}
execSync(`pnpm ${webBuildScript}`, {
  cwd: appDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_APP_PLATFORM: 'web',
    VITE_FORCE_EMBED: 'chat',
    ...backendEnv,
  },
})
cpSync(resolve(appDir, 'dist'), resolve(dist, 'sidepanel'), { recursive: true })

// vite copies packages/app/public/ verbatim, so anything parked there ships in
// a package that is publicly downloadable from the Chrome Web Store. Drop the
// directories nothing in the side panel requests — see SIDE_PANEL_PRUNE_DIRS
// for what and why, and the guardrail tests that keep the list honest.
for (const dir of SIDE_PANEL_PRUNE_DIRS) {
  const target = resolve(dist, 'sidepanel', dir)
  if (!existsSync(target)) continue
  rmSync(target, { recursive: true, force: true })
  console.log('[extension] pruned sidepanel/%s (not requested at runtime)', dir)
}

// 2) Bundle background (module worker) + content script (IIFE).
await build({
  entryPoints: { background: resolve(here, 'src/background.ts') },
  outdir: dist, bundle: true, format: 'esm', target: 'chrome110', platform: 'browser',
  alias: esbuildAliasWithAllowlist,
  define: {
    __SIDE_PANEL_DOMAINS__: JSON.stringify(domainsCsv),
  },
})
await build({
  entryPoints: { 'content-script': resolve(here, 'src/content-script.ts') },
  outdir: dist, bundle: true, format: 'iife', target: 'chrome110', platform: 'browser',
  alias: esbuildAliasWithAllowlist,
  define: {
    __TEAMCLU_EXTENSION_SETTINGS__: JSON.stringify(extensionSettingsBake),
  },
})

// 3) Copy manifest, locales, and icons.
cpSync(resolve(here, 'manifest.json'), resolve(dist, 'manifest.json'))
if (existsSync(resolve(here, '_locales'))) {
  cpSync(resolve(here, '_locales'), resolve(dist, '_locales'), { recursive: true })
}
if (existsSync(resolve(here, 'icons'))) {
  cpSync(resolve(here, 'icons'), resolve(dist, 'icons'), { recursive: true })
}
console.log('[extension] built ->', dist)
