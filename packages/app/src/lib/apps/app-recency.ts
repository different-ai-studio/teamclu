import { create } from 'zustand'
import { appStoragePrefix } from '@/lib/config/build-config'
import type { AppRow } from '@/lib/backend/types'

/**
 * When I last did something with an app, for ordering the 本机 list.
 *
 * Two signals, the newer one wins:
 * - when I last opened or downloaded it on this machine — kept here, because
 *   no server row knows which machine I used;
 * - the newest message in any of its sessions that the session list has
 *   loaded — so an app a teammate or a cron job worked in rises too.
 *
 * The app row's own `updatedAt` is only the fallback for an app with neither:
 * it moves on deploys and renames, which are not my use of the app.
 */

const STORAGE_KEY = `${appStoragePrefix}-apps-last-touched`

function readStored(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

interface AppTouchState {
  /** App id → ISO time I last opened or downloaded it here. */
  touchedAt: Record<string, string>
  touch: (appId: string, at?: Date) => void
}

export const useAppTouchStore = create<AppTouchState>((set, get) => ({
  touchedAt: readStored(),
  touch: (appId, at = new Date()) => {
    if (!appId) return
    const touchedAt = { ...get().touchedAt, [appId]: at.toISOString() }
    set({ touchedAt })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(touchedAt))
    } catch {
      // Storage unavailable — the order still holds for this run.
    }
  },
}))

/** Milliseconds, or 0 for a missing or unparseable time. */
function ms(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Newest session activity per app, from whatever session rows are loaded.
 *
 * `appIdOf` resolves a row's app: the row's own `app_id` when the server sent
 * it, else the session → app link the apps store recorded when the session was
 * opened from an app.
 */
export function latestSessionActivityByApp(
  rows: readonly { id: string; app_id?: string | null; last_message_at: string | null; updated_at: string | null }[],
  appIdBySessionId: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const appId = row.app_id ?? appIdBySessionId[row.id]
    if (!appId) continue
    const at = Math.max(ms(row.last_message_at), ms(row.updated_at))
    if (at > (out[appId] ?? 0)) out[appId] = at
  }
  return out
}

/** Newest first; ties keep the order they came in (the server's). */
export function sortAppsByLastActivity<T extends Pick<AppRow, 'id' | 'updatedAt'>>(
  apps: readonly T[],
  touchedAt: Record<string, string>,
  sessionActivity: Record<string, number>,
): T[] {
  const mine = (app: T) => Math.max(ms(touchedAt[app.id]), sessionActivity[app.id] ?? 0)
  return apps
    .map((app, index) => {
      const own = mine(app)
      return { app, index, at: own > 0 ? own : ms(app.updatedAt) }
    })
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((e) => e.app)
}
