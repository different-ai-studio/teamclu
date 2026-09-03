/**
 * Startup performance instrumentation.
 *
 * Records the boundaries of the cold-start sequence so we can see exactly where
 * the time goes between first paint and first content — and which gate is the
 * long blank wait users see after the skeleton is removed. Every boundary is
 * stamped with `markStartup(name)`:
 *
 *   - lands a standard User Timing mark (visible in devtools Performance and
 *     `performance.getEntriesByType('mark')`),
 *   - records `{ name, t }` (t = ms since navigation / `timeOrigin`) into an
 *     ordered list exposed on `window.__startupTimeline`,
 *   - first occurrence of each name wins, so it is safe to call from render
 *     bodies, effects that re-run, and StrictMode's double pass,
 *   - once marks stop arriving for a beat, a formatted timeline with per-phase
 *     deltas is logged.
 *
 * Marks are cheap (~µs), so they run in every build — useful for diagnosing a
 * slow user machine. The console dump is gated to dev / an opt-in flag so
 * production stays quiet: set `localStorage['<appShortName>-perf'] = '1'` in a
 * packaged build to turn the timeline log on, or call `dumpStartupTimeline()`
 * from the devtools console at any time.
 */
import { appStoragePrefix } from "@/lib/config/build-config";

export type StartupStamp = { name: string; t: number };

const stamps: StartupStamp[] = [];
const seen = new Set<string>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function dumpEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem(`${appStoragePrefix}-perf`) === "1";
  } catch {
    return false;
  }
}

/** Re-arm the "marks have settled" timer; the timeline logs once it fires. */
function scheduleDump(): void {
  if (typeof window === "undefined") return;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    logStartupTimeline();
  }, 1500);
}

/**
 * Stamp a startup boundary. Idempotent per name (first call wins), so repeated
 * effect runs and StrictMode double renders record a single, stable timeline.
 */
export function markStartup(name: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  let t = 0;
  try {
    t = performance.now();
    performance.mark(name);
  } catch {
    /* User Timing unavailable (old webview) — fall through with t = 0 */
  }
  stamps.push({ name, t });
  if (typeof window !== "undefined") {
    (window as unknown as { __startupTimeline?: StartupStamp[] }).__startupTimeline = stamps;
  }
  scheduleDump();
}

/** Ordered-by-time copy of the stamps collected so far. */
export function getStartupTimeline(): StartupStamp[] {
  return stamps.slice().sort((a, b) => a.t - b.t);
}

/** Pretty-print the timeline with per-phase deltas. Safe to call anytime. */
function logStartupTimeline(): void {
  if (!dumpEnabled()) return;
  const ordered = getStartupTimeline();
  if (ordered.length === 0) return;
  const rows = ordered.map((s, i) => ({
    phase: s.name,
    "since load": `${Math.round(s.t)}ms`,
    "Δ prev": i === 0 ? "—" : `+${Math.round(s.t - ordered[i - 1].t)}ms`,
  }));
  const total = Math.round(ordered[ordered.length - 1].t - ordered[0].t);
  console.groupCollapsed(
    `%c[startup] timeline — ${total}ms across ${ordered.length} marks`,
    "color:#e0644e;font-weight:600",
  );
  console.table(rows);
  console.groupEnd();
}

if (typeof window !== "undefined") {
  (window as unknown as { dumpStartupTimeline?: () => void }).dumpStartupTimeline = logStartupTimeline;
}
