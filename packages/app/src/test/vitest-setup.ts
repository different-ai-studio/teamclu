/**
 * Vitest / jsdom shims: globals that exist in real browsers but are missing or
 * incomplete in the test environment, which would otherwise cause unhandled
 * rejections and a non-zero exit code despite all assertions passing.
 */
import '@testing-library/jest-dom'

// --- i18n bootstrap ---------------------------------------------------------
// Initialize the shared i18n singleton (and bind it to react-i18next) for every
// test file. Components only call useTranslation(); whether the real i18n
// instance was initialized used to depend on whether a test's import graph
// happened to pull in '@/lib/i18n', so the same component rendered translated
// copy in one test and raw keys in another. Importing it here makes that
// deterministic. VITE_LOCALE=zh-CN (vite.config test.env) pins it to the
// production-default Chinese locale.
// PERF-15: the catalogue is a dynamic import now, so awaiting the bootstrap
// promise is what keeps a component's rendered copy deterministic. Without it
// the strings arrive a microtask after the first render and tests see keys.
import { i18nReady } from '@/lib/i18n'
await i18nReady

// --- CSS.escape (used by FileTree querySelector selectors) -----------------
// In some Vitest worker contexts `globalThis.CSS` is undefined.
function cssEscapeIdent(value: string): string {
  const string = String(value)
  const length = string.length
  let index = -1
  let result = ''
  const firstCodeUnit = string.charCodeAt(0)
  while (++index < length) {
    const codeUnit = string.charCodeAt(index)
    if (codeUnit === 0x0000) {
      result += '\uFFFD'
      continue
    }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 &&
        codeUnit >= 0x0030 &&
        codeUnit <= 0x0039 &&
        firstCodeUnit === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `
      continue
    }
    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += string.charAt(index)
      continue
    }
    result += `\\${string.charAt(index)}`
  }
  return result
}

if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: cssEscapeIdent },
    configurable: true,
    writable: true,
  })
} else if (typeof globalThis.CSS.escape !== 'function') {
  Object.assign(globalThis.CSS, { escape: cssEscapeIdent })
}

// --- localStorage polyfill (some jsdom worker contexts lack it or have broken impl) ---
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage?.clear !== 'function') {
  const store: Record<string, string> = {}
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = String(value) },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { for (const k of Object.keys(store)) delete store[k] },
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
    },
    configurable: true,
    writable: true,
  })
}

// --- ResizeObserver (jsdom stub — used by cmdk and other layout-aware libs) ---
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// --- Element.scrollIntoView (jsdom stub) -------------------------------------
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function (_options?: ScrollIntoViewOptions) {
    // no-op — layout is not simulated in tests
  }
}

// --- Focus re-entrancy guard (jsdom + Radix FocusScope) ----------------------
// A Radix Select rendered inside a *modal* Radix Dialog mounts two trapped
// FocusScopes. When the Select opens, its content is portaled outside the
// dialog's DOM subtree, so each scope sees focus "leave" its boundary and
// programmatically yanks it back. In a real browser this settles; in jsdom
// focus events dispatch synchronously, so the two scopes bounce focus
// (A.focus() → focusin → B.focus() → focusin → A.focus() → …) until the call
// stack overflows — crashing the worker (manifests as a RangeError locally and
// a RegExpCompiler OOM under CI's tighter memory). It's a jsdom artifact, not a
// product bug. Guard against it by ignoring any focus() invoked *synchronously
// while another focus dispatch is already in flight* — the exact re-entrant
// trap-fight. Legitimate autofocus (run from effects, not nested inside a focus
// event) and ordinary sequential focus() calls are unaffected.
if (typeof HTMLElement !== 'undefined') {
  const proto = HTMLElement.prototype as unknown as {
    focus: (this: HTMLElement, options?: FocusOptions) => void
  }
  const realFocus = proto.focus
  let focusing = false
  proto.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (focusing) return
    focusing = true
    try {
      return realFocus.call(this, options)
    } finally {
      focusing = false
    }
  }
}

// --- Tauri event plugin (listen() teardown calls into internals) ------------
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (...args: unknown[]) => void }
  }
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
    unregisterListener: () => {},
  }
}
