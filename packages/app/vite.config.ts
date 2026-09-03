import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'node:module'
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'

const tauriPluginMcpPath = path.resolve(__dirname, '../../.tauri-plugin-mcp')
// An E2E build is driven through the plugin's socket, so it needs the real
// package bundled in: the stub's `setupPluginListeners` is a no-op, and an
// externalized bare specifier does not resolve inside the webview — either way
// `execute_js` gets no answer and the whole harness times out. The npm
// dependency provides the same listeners as the linked dev checkout.
const isTauriMcpE2EBuild = process.env.VITE_TEAMCLU_E2E === 'true'
const useTauriPluginMcpStub =
  !isTauriMcpE2EBuild && !existsSync(path.join(tauriPluginMcpPath, 'package.json'))

// --- Build config: read build.config.json + optional environment/local overrides ---
function readJSON(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function deepMerge(base: Record<string, unknown>, ...overrides: (Record<string, unknown> | null)[]): Record<string, unknown> {
  const result = { ...base }
  for (const override of overrides) {
    if (!override) continue
    for (const key of Object.keys(override)) {
      const baseVal = result[key]
      const overVal = override[key]
      if (
        baseVal && overVal &&
        typeof baseVal === 'object' && !Array.isArray(baseVal) &&
        typeof overVal === 'object' && !Array.isArray(overVal)
      ) {
        result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>)
      } else if (overVal !== undefined) {
        result[key] = overVal
      }
    }
  }
  return result
}

const rootDir = path.resolve(__dirname, '../..')
const nodeRequire = createRequire(import.meta.url)
const { resolveBuildEnv } = nodeRequire(path.join(rootDir, 'scripts/lib/resolve-build-env.js')) as {
  resolveBuildEnv: (repoRoot: string, env?: NodeJS.ProcessEnv) => string | undefined
}
const buildEnv = resolveBuildEnv(rootDir)
const baseConfig = readJSON(path.join(rootDir, 'build.config.json'))
const envConfig = buildEnv ? readJSON(path.join(rootDir, `build.config.${buildEnv}.json`)) : null
const buildConfig = deepMerge(baseConfig || {}, envConfig)

// Same resolver the extension build uses, so `extension.hosts` (branding repo)
// and `extensions.settings` (repo configs) reach the app identically.
const { resolveExtensionPack } = nodeRequire(
  path.join(rootDir, 'scripts/lib/extension-config.js'),
) as { resolveExtensionPack: (buildConfig: unknown) => { settings: unknown; [key: string]: unknown } }
const resolvedExtensionPack = resolveExtensionPack(buildConfig)

const { resolveBrandTheme, generateBrandThemeCss, extractRootTokenNames } =
  nodeRequire(path.join(rootDir, 'scripts/lib/brand-theme.js')) as {
    resolveBrandTheme: (buildConfig: unknown, repoRoot: string) => { palette: string; tokens: Record<string, string> } | null
    generateBrandThemeCss: (palette: string, tokens: Record<string, string>, allowed: Set<string>) => string
    extractRootTokenNames: (css: string) => Set<string>
  }

// Derive shortName if not explicitly set
if (!(buildConfig as any).app?.shortName) {
  const app = (buildConfig as any).app || ((buildConfig as any).app = {})
  app.shortName = (app.name || 'TeamClu')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
}

// Validate shortName
const sn = (buildConfig as any).app?.shortName as string | undefined
if (!sn || sn.length > 20 || !/^[a-z0-9]+$/.test(sn)) {
  throw new Error(`app.shortName must be 1-20 chars, [a-z0-9] only, got: '${sn}'`)
}

// --- Per-brand theme palette: generate a :root[data-palette="<brand>"] block ---
let brandThemeStyle = ''
const brandTheme = resolveBrandTheme(buildConfig as any, rootDir)
if (brandTheme) {
  const globalsCss = readFileSync(
    path.resolve(__dirname, 'src/styles/globals.css'),
    'utf-8'
  )
  const allowed = extractRootTokenNames(globalsCss)
  const block = generateBrandThemeCss(brandTheme.palette, brandTheme.tokens, allowed)
  brandThemeStyle = `<style id="brand-theme">${block}</style>`
}

// SEC-12 — a CSP for the non-Tauri build.
//
// `VITE_APP_PLATFORM=web` has exactly one consumer today: the MV3 side panel
// (`apps/extension/build.mjs` runs `build:web` and copies `dist/` to
// `dist/sidepanel/`). Nothing serves this bundle from a hosted origin — no
// workflow builds it, no compose service publishes it — so the audit's "is it
// even deployed" is answered: as an extension page, not a website.
//
// It still ships the auth session (access + refresh token) in `localStorage`,
// and it shipped with no policy of its own. The extension origin is isolated
// and MV3 applies its own default, but a bundle that can be served from
// anywhere should not depend on where it happens to be served from. So the
// non-Tauri build carries a policy in the document.
//
// Tauri builds get nothing here: Tauri injects its own CSP (with per-script
// nonces) from `tauri.conf.json`, and a second policy would intersect with it
// and silently break the app.
function webCspMeta(isDevServer: boolean): string {
  // Dev is Vite's own HMR client: inline bootstrap scripts and `eval`.
  const scriptSrc = isDevServer
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
    : "script-src 'self' 'wasm-unsafe-eval'"
  // `connect-src` stays broad on purpose: the Cloud API and MQTT hosts are
  // per-brand and injected at build time by `apps/extension/build.mjs`, so an
  // enumerated list here would lock branded packages out of their own backend.
  // The directive that matters for token theft is `script-src`.
  const connectSrc = isDevServer
    ? "connect-src 'self' https: wss: ws: http://127.0.0.1:* http://localhost:*"
    : "connect-src 'self' https: wss:"
  const policy = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    connectSrc,
    "worker-src 'self' blob:",
    "frame-src 'self' data: blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
}

// https://vitejs.dev/config/
export default defineConfig({
  base: process.env.VITE_APP_PLATFORM === 'web' ? './' : '/',
  plugins: [
    react(),
    tailwindcss(),
    // Inject build-config values into index.html (skeleton theme script)
    {
      name: 'inject-app-short-name',
      transformIndexHtml(html, ctx) {
        const palette = ((buildConfig as any).app?.palette as string) || 'default'
        // The <title> was hardcoded to "TeamClu", so every branded build —
        // desktop window title and extension side panel alike — announced the
        // wrong product before React had rendered anything.
        const app = (buildConfig as any).app || {}
        const displayName = (app.displayName as string) || (app.name as string) || 'TeamClu'
        return html
          .replace(/__APP_SHORT_NAME__/g, sn as string)
          .replace(/__APP_NAME__/g, displayName)
          .replace(/__PALETTE__/g, palette)
          .replace(/<!--__BRAND_THEME__-->/g, brandThemeStyle)
          .replace(
            /<!--__WEB_CSP__-->/g,
            process.env.VITE_APP_PLATFORM === 'web' ? webCspMeta(Boolean(ctx.server)) : '',
          )
      },
    },
    // Bundle analysis: run with ANALYZE=true pnpm build
    process.env.ANALYZE && visualizer({
      open: !process.env.ANALYZE_RAW,
      template: process.env.ANALYZE_RAW ? 'raw-data' : 'treemap',
      filename: process.env.ANALYZE_RAW ? 'dist/bundle-analysis.json' : 'dist/bundle-analysis.html',
      gzipSize: true,
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      ...(useTauriPluginMcpStub && {
        'tauri-plugin-mcp': path.resolve(__dirname, 'src/lib/tauri-plugin-mcp-stub.ts'),
      }),
    },
  },
  // Dev server – MUST stay on 1420 for Tauri devUrl
  // When building for plain web (VITE_APP_PLATFORM=web), relax the port constraint
  // so the dev server can use any available port.
  server: {
    host: '127.0.0.1',
    port: process.env.VITE_APP_PLATFORM === 'web' ? undefined : 1420,
    // If 1420 is occupied, fail instead of switching ports,
    // otherwise the Tauri window will load the wrong (blank) URL.
    // In web mode, allow any port.
    strictPort: process.env.VITE_APP_PLATFORM !== 'web',
    watch: {
      ignored: ['**/apps/desktop/**'],
    },
  },
  define: {
    __BUILD_CONFIG__: JSON.stringify(buildConfig),
    __TEAMCLU_EXTENSION_PACK__: JSON.stringify(resolvedExtensionPack),
    __TEAMCLU_EXTENSION_SETTINGS__: JSON.stringify(resolvedExtensionPack.settings),
    // Inject build config defaults into import.meta.env so they work without .env files
    'import.meta.env.VITE_LOCALE': JSON.stringify((buildConfig as any).defaults?.locale ?? ''),
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(
      JSON.parse(readFileSync(path.join(rootDir, 'apps/desktop/tauri.conf.json'), 'utf-8')).version ?? '0.0.0'
    ),
    // Literal so the E2E control surface can be dead-code-eliminated. Read
    // through a bare `import.meta.env.VITE_TEAMCLU_E2E` the value would stay
    // a runtime lookup and the ~30KB `lib/e2e/v2-control` module would ship in
    // every production build.
    'import.meta.env.VITE_TEAMCLU_E2E': JSON.stringify(process.env.VITE_TEAMCLU_E2E ?? ''),
    // Sentry tree-shaking flags. We only use error capture + user feedback —
    // no performance tracing — and the SDK's own debug logging is dead weight
    // in a shipped build. Trims ~16KB off the (lazily loaded) Sentry chunk.
    __SENTRY_DEBUG__: false,
    __SENTRY_TRACING__: false,
  },
  // Prevent vite from obscuring rust errors
  clearScreen: false,
  // Env prefix for Tauri
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    globals: true,
    environment: 'jsdom',
    // A few suites must import their subject inside the test (their vi.mock
    // factories close over variables that are not initialized at module-eval
    // time). Under a fully parallel run those transforms queue behind hundreds
    // of other files, and the default 5s was tight enough to trip — the test
    // then timed out while its `render()` was still in flight, so the DOM
    // landed after cleanup and leaked into the next test. A genuinely hung
    // test still fails, just later.
    testTimeout: 15000,
    setupFiles: [path.resolve(__dirname, 'src/test/vitest-setup.ts')],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.tsx',
    ],
    env: {
      // Stub Supabase env vars so modules that still read them do not throw during test
      // module evaluation. lib/supabase-client.ts itself no longer exists.
      VITE_SUPABASE_URL: 'https://test.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      // Match the production default locale (buildConfig.defaults.locale). The
      // `define` injection of import.meta.env.VITE_LOCALE does not apply under
      // vitest, so without this the i18n singleton falls back to English and
      // every test asserting the Chinese-first UI copy fails.
      VITE_LOCALE: 'zh-CN',
    },
  },
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    // In web mode, target modern browsers (Chrome extension context).
    target: process.env.VITE_APP_PLATFORM === 'web' ? 'chrome105' : (process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13'),
    // Produce sourcemaps for error reporting
    sourcemap: !!process.env.TAURI_DEBUG,
    // Chunk splitting strategy (Vite 8 / Rolldown requires manualChunks as a function)
    rollupOptions: {
      // tauri-plugin-mcp is dev-only (linked from .tauri-plugin-mcp/, gitignored).
      // An E2E build is the exception — see isTauriMcpE2EBuild above.
      external: isTauriMcpE2EBuild ? [] : ['tauri-plugin-mcp'],
      output: {
        manualChunks(id) {
          const groups: Record<string, string[]> = {
            'react-vendor': ['react', 'react-dom'],
            radix: [
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-popover',
              '@radix-ui/react-scroll-area',
              '@radix-ui/react-select',
              '@radix-ui/react-tooltip',
              '@radix-ui/react-collapsible',
              '@radix-ui/react-avatar',
              '@radix-ui/react-separator',
              '@radix-ui/react-slot',
            ],
            markdown: ['react-markdown', 'remark-gfm'],
            tauri: [
              '@tauri-apps/api',
              '@tauri-apps/plugin-fs',
              '@tauri-apps/plugin-shell',
              '@tauri-apps/plugin-dialog',
              '@tauri-apps/plugin-notification',
              '@tauri-apps/plugin-process',
            ],
            i18n: ['i18next', 'react-i18next'],
          }
          for (const [chunk, pkgs] of Object.entries(groups)) {
            for (const pkg of pkgs) {
              if (id.includes(`/node_modules/${pkg}/`)) return chunk
            }
          }
        },
      },
    },
  },
})
