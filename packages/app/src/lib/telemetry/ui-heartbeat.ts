import { invoke } from '@tauri-apps/api/core'
import { useUIStore } from '@/stores/ui'
import { withSentry } from './capture'

/**
 * Heartbeat for the Rust-side UI watchdog (`apps/desktop/src/ui_watchdog.rs`).
 *
 * A frozen renderer cannot report its own freeze, so the page only proves it
 * is alive; Rust notices when the beats stop and reports from there. Each beat
 * carries what Rust needs to make the report useful: which page was open and
 * the long tasks seen just before.
 *
 * Main window only — the watchdog tracks one page.
 */

const BEAT_INTERVAL_MS = 2_000
/** Long tasks past this go into a breadcrumb on the next error report. */
const LONG_TASK_BREADCRUMB_MS = 1_000
const LONG_TASK_WINDOW_MS = 60_000

type LongTaskSample = { durationMs: number; at: number }

let started = false
const recentLongTasks: LongTaskSample[] = []

export function currentUiRoute(): string {
  const { currentView, defaultNavTab, layoutMode } = useUIStore.getState()
  return [currentView, defaultNavTab, layoutMode].join('/')
}

/** @internal exported for tests */
export function buildBeat(now: number, visible: boolean, route: string, tasks: LongTaskSample[]) {
  const inWindow = tasks.filter((t) => now - t.at <= LONG_TASK_WINDOW_MS)
  const last = inWindow[inWindow.length - 1]
  return {
    visible,
    route,
    lastLongTask: last ? { durationMs: Math.round(last.durationMs), agoMs: Math.round(now - last.at) } : null,
    longTasksLastMinute: inWindow.length,
  }
}

function observeLongTasks(): void {
  // Chromium (WebView2) only; WKWebView has no `longtask` entries.
  if (typeof PerformanceObserver === 'undefined') return
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const at = performance.timeOrigin + entry.startTime + entry.duration
        recentLongTasks.push({ durationMs: entry.duration, at })
        if (entry.duration >= LONG_TASK_BREADCRUMB_MS) {
          const route = currentUiRoute()
          void withSentry((Sentry) =>
            Sentry.addBreadcrumb({
              category: 'ui.longtask',
              level: 'warning',
              message: `long task ${Math.round(entry.duration)}ms on ${route}`,
            }),
          )
        }
      }
      const cutoff = Date.now() - LONG_TASK_WINDOW_MS
      while (recentLongTasks.length && recentLongTasks[0].at < cutoff) recentLongTasks.shift()
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // Telemetry must never break the page.
  }
}

function sendBeat(): void {
  const beat = buildBeat(Date.now(), document.visibilityState === 'visible', currentUiRoute(), recentLongTasks)
  invoke('ui_heartbeat', { beat }).catch(() => {
    // An older desktop without the command, or the app is quitting.
  })
}

export function startUiHeartbeat(): void {
  if (started) return
  started = true
  observeLongTasks()
  sendBeat()
  setInterval(sendBeat, BEAT_INTERVAL_MS)
  // Tell Rust right away when the window hides: timers get throttled then, and
  // the missing beats must not read as a freeze.
  document.addEventListener('visibilitychange', sendBeat)
}
