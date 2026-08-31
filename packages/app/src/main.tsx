import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initSentry, withSentry } from './lib/telemetry/capture'
import { invoke } from '@tauri-apps/api/core'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthGate } from './components/auth/AuthGate'
import { SidePanelHostGateOverlay } from './components/extension/SidePanelHostGateOverlay'
import { LocalAgentPanelApp } from './components/LocalAgentPanelApp'
import './styles/globals.css'
import './stores/dev-expose'
import './lib/i18n'; // Initialize i18n
import { appStoragePrefix, buildConfig } from './lib/build-config'
import { fetchPublicConfig } from './lib/bootstrap'

import { ensureBundledAmuxdCurrent } from './lib/daemon-version-upgrade'
import { initJwtBridge } from './lib/jwt-bridge'
import { installConsoleCapture } from './lib/console-capture'
import { markStartup } from './lib/startup-perf'
import { removeStartupSkeleton } from './lib/utils'
import { E2E_BUILD } from './lib/e2e/v2-control-active'

markStartup('main:start')

// Sync the Supabase JWT into teamclu.json so FC-backed commands (team share,
// the team AI gateway, OSS sync) can authenticate. Must run at startup, before any of those
// features open. No-op outside Tauri.
initJwtBridge()

// Pull the public (unauthenticated) config: the Web SSO target and the
// login-method feature flags.
//
// Unconditional, and here rather than in useAppInit, because `App` renders
// INSIDE <AuthGate> — the login screen never reaches useAppInit, and the login
// screen is precisely what these flags configure. Fire-and-forget: the last
// known snapshot already painted, and this only updates it.
void fetchPublicConfig()
void ensureBundledAmuxdCurrent()

// Initialize Sentry for frontend error tracking. The import is dynamic (see
// `initSentry`) so the SDK stays out of the startup chunk; captures raised
// before it settles are queued rather than dropped.
void initSentry({
  dsn: 'https://87ad99c36806946fe743be71ed87fffe@o60909.ingest.us.sentry.io/4511110370295808',
  release: `teamclu-web@${import.meta.env.PACKAGE_VERSION ?? '0.0.0'}`,
  environment: import.meta.env.DEV ? 'development' : 'production',
  sendDefaultPii: true,
})

// Capture console output for Settings → Diagnostics live viewer (ring buffer in memory).
installConsoleCapture()

// Apply persisted theme immediately to prevent flash of wrong theme
;(() => {
  const theme = localStorage.getItem(`${appStoragePrefix}-theme`) || buildConfig.defaults?.theme || 'system'
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else if (theme === 'system') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark')
    }
  }
  // Build-flavor palette (mirrors the index.html early script). No-op for the
  // default Editorial Calm palette.
  const palette = buildConfig.app?.palette
  if (palette && palette !== 'default') {
    root.setAttribute('data-palette', palette)
  }
})()

// Text entry defaults to command/config/chat style input. Mobile WebView and
// some IMEs otherwise auto-capitalize the first Latin character, which is wrong
// for paths, identifiers, prompts, feedback, and mixed Chinese/English text.
function applyTextEntryDefaults(root: ParentNode) {
  root
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
      'input, textarea, [contenteditable="true"]',
    )
    .forEach((el) => {
      if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'off')
      if (!el.hasAttribute('autocorrect')) el.setAttribute('autocorrect', 'off')
    })
}

applyTextEntryDefaults(document)
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement) {
        applyTextEntryDefaults(node)
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true })

// Global unhandled error logging
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] Unhandled promise rejection:', event.reason)
  void withSentry((Sentry) => Sentry.captureException(event.reason))
})

// Disable browser context menu for native desktop feel
// Allow it only in dev mode via Ctrl+Shift+RightClick
document.addEventListener('contextmenu', (event) => {
  if (import.meta.env.DEV && event.ctrlKey && event.shiftKey) return
  event.preventDefault()
})

// Mirror the macOS user-chosen accent color onto a CSS variable so focus
// rings and selection states track what the rest of the OS does. Returns
// null on Windows/Linux today; CSS falls back to the brand `--ring`.
invoke<string | null>('get_system_accent_color')
  .then((hex) => {
    if (hex) document.documentElement.style.setProperty('--system-accent', hex)
  })
  .catch(() => { /* non-tauri context or pre-init — fall through */ })

markStartup('react-mount')

const panelMode =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('panel')
    : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="TeamClu">
      {panelMode === 'local-agent' ? (
        <AuthGate>
          <LocalAgentPanelApp />
        </AuthGate>
      ) : (
        <>
          <SidePanelHostGateOverlay />
          {/*
            An E2E build mounts App without AuthGate. The harness never signs
            in — it drives the app over the MCP socket and seeds sessions,
            actors and messages straight into the stores — so there is no
            session for the gate to pass. Inside AuthGate, App simply never
            mounts at the login screen, and it takes the tauri-plugin-mcp
            listeners and the `window.__TEAMCLU_V2_E2E__` control surface down
            with it, leaving the harness with nothing to talk to.

            `E2E_BUILD` is a build-time constant: a normal build folds this to
            the AuthGate branch and the bundler drops the other one.
          */}
          {E2E_BUILD ? (
            <App />
          ) : (
            <AuthGate>
              <App />
            </AuthGate>
          )}
        </>
      )}
    </ErrorBoundary>
  </StrictMode>,
)

// Backstop: the skeleton is normally handed off by AuthGate/App once real UI is
// ready (see removeStartupSkeleton call sites). If startup wedges before any of
// those fire, force it down after a generous deadline so the user is never stuck
// staring at a frozen skeleton with no way forward.
setTimeout(() => removeStartupSkeleton(), 20000)
