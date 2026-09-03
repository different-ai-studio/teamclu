import { getBackend } from '@/lib/backend'
import type { SessionListCursor, SessionListEntry } from '@/lib/backend/types'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'

/** Archive any session untouched for longer than this. */
export const EXTENSION_STALE_SESSION_DAYS = 7

/** Archive empty sessions untouched for longer than this. */
export const EXTENSION_STALE_EMPTY_SESSION_DAYS = 3

/** Periodic sweep interval while the extension side panel stays open. */
export const EXTENSION_SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Minimum gap between sweeps — avoids duplicate work when the panel remounts. */
const EXTENSION_SESSION_CLEANUP_MIN_GAP_MS = 60 * 60 * 1000

const LAST_RUN_KEY_PREFIX = 'teamclu.extension.sessionCleanupLastRun'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * In-flight sweep, keyed by team. The sweep walks every page of the team's
 * sessions, which takes seconds on a large team — long enough for a team
 * switch. Keyed rather than global so the new team is actually scanned instead
 * of being handed the previous team's promise and told it is done.
 */
const sweepInFlightByTeam = new Map<string, Promise<{ archived: number; scanned: number }>>()

export function isEmptySession(entry: Pick<SessionListEntry, 'last_message_at'>): boolean {
  return entry.last_message_at == null
}

/**
 * Idle time for cleanup — aligns with the session list UI (last message), not
 * metadata-only bumps on `updated_at`.
 */
export function sessionLastActivityAt(
  entry: Pick<SessionListEntry, 'updated_at' | 'last_message_at' | 'created_at'>,
): Date | null {
  const raw = entry.last_message_at ?? entry.created_at ?? entry.updated_at
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function daysSince(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / MS_PER_DAY
}

export function shouldArchiveStaleExtensionSession(
  entry: Pick<SessionListEntry, 'updated_at' | 'last_message_at' | 'created_at'>,
  now = new Date(),
): boolean {
  const lastActivity = sessionLastActivityAt(entry)
  if (!lastActivity) return false

  const idleDays = daysSince(lastActivity, now)
  if (idleDays >= EXTENSION_STALE_SESSION_DAYS) return true
  if (isEmptySession(entry) && idleDays >= EXTENSION_STALE_EMPTY_SESSION_DAYS) return true
  return false
}

function cleanupRunOwner(
  userId?: string | null,
  teamId?: string | null,
): string | null {
  const user = userId?.trim()
  const team = teamId?.trim()
  if (!user) return null
  return team ? `${user}.${team}` : user
}

function lastRunStorageKey(owner?: string | null): string {
  const trimmed = owner?.trim()
  return trimmed ? `${LAST_RUN_KEY_PREFIX}.${trimmed}` : LAST_RUN_KEY_PREFIX
}

function readLastCleanupRunMs(userId?: string | null): number {
  try {
    if (typeof localStorage === 'undefined') return 0
    const raw = localStorage.getItem(lastRunStorageKey(userId))
    if (!raw) return 0
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

function writeLastCleanupRunMs(ms: number, userId?: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(lastRunStorageKey(userId), String(ms))
  } catch {
    // localStorage unavailable — non-fatal.
  }
}

function buildProtectedSessionIds(extra?: ReadonlySet<string>): Set<string> {
  const skip = new Set(extra ?? [])
  const activeId = useSessionSelectionStore.getState().activeSessionId
  if (activeId) skip.add(activeId)
  for (const id of useSessionListStore.getState().pinnedSessionIds) skip.add(id)
  return skip
}

function resolveNextCursor(
  page: { rows: SessionListEntry[]; nextCursor?: SessionListCursor | null },
): SessionListCursor | null {
  if (page.nextCursor !== undefined) return page.nextCursor
  if (page.rows.length === 0) return null
  const row = page.rows[page.rows.length - 1]
  return {
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    id: row.id,
  }
}

/**
 * Every session the current actor can see in `teamId`.
 *
 * Team-scoped rather than global because archiving is destructive and silent:
 * a cross-team sweep would retire sessions the user cannot even see from the
 * panel they are looking at.
 */
async function listAllCurrentActorSessions(
  teamId: string,
  shouldAbort?: () => boolean,
): Promise<SessionListEntry[]> {
  const rows: SessionListEntry[] = []
  let cursor: SessionListCursor | null = null

  while (true) {
    if (shouldAbort?.()) break
    const page = await getBackend().sessions.listCurrentActorSessions({
      limit: 50,
      cursor,
      teamId,
    })
    rows.push(...page.rows)
    const nextCursor = resolveNextCursor(page)
    if (!nextCursor) break
    cursor = nextCursor
  }

  return rows
}

type ExtensionSessionCleanupOptions = {
  now?: Date
  skipSessionIds?: ReadonlySet<string>
  force?: boolean
  userId?: string | null
  /** Team to sweep. The list endpoint is team-scoped; there is no global sweep. */
  teamId: string
  shouldAbort?: () => boolean
}

async function archiveStaleSessionQuiet(sessionId: string): Promise<boolean> {
  return useSessionListStore.getState().archiveSessionQuiet(sessionId)
}

async function runExtensionSessionCleanupInner(
  options: ExtensionSessionCleanupOptions,
): Promise<{ archived: number; scanned: number }> {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const shouldAbort = options.shouldAbort

  // Scoped per team as well as per user: the sweep now only covers one team,
  // so a team switch inside the min-gap window must not be read as "already
  // swept".
  const runKeyOwner = cleanupRunOwner(options.userId, options.teamId)

  if (!options.force) {
    const lastRun = readLastCleanupRunMs(runKeyOwner)
    if (nowMs - lastRun < EXTENSION_SESSION_CLEANUP_MIN_GAP_MS) {
      return { archived: 0, scanned: 0 }
    }
  }

  if (shouldAbort?.()) {
    return { archived: 0, scanned: 0 }
  }

  const initialSkip = buildProtectedSessionIds(options.skipSessionIds)
  const sessions = await listAllCurrentActorSessions(options.teamId, shouldAbort)
  if (shouldAbort?.()) {
    return { archived: 0, scanned: sessions.length }
  }

  const toArchive = sessions.filter(
    (entry) =>
      !initialSkip.has(entry.id) && shouldArchiveStaleExtensionSession(entry, now),
  )

  let archived = 0
  let failed = 0
  for (const entry of toArchive) {
    if (shouldAbort?.()) break
    if (buildProtectedSessionIds(options.skipSessionIds).has(entry.id)) continue

    const ok = await archiveStaleSessionQuiet(entry.id)
    if (ok) {
      archived += 1
    } else {
      failed += 1
    }
  }

  if (failed === 0 && !shouldAbort?.()) {
    writeLastCleanupRunMs(nowMs, runKeyOwner)
  }

  if (archived > 0) {
    console.info(
      `[extension-session-cleanup] archived ${archived} of ${sessions.length} sessions`,
    )
  }

  return { archived, scanned: sessions.length }
}

/**
 * Archive expired / invalid sessions for the Chrome extension embed.
 * Skips the active session and pinned sessions (re-checked before each archive).
 */
export async function runExtensionSessionCleanup(
  options: ExtensionSessionCleanupOptions,
): Promise<{ archived: number; scanned: number }> {
  const inFlight = sweepInFlightByTeam.get(options.teamId)
  if (inFlight) return inFlight

  const sweep = runExtensionSessionCleanupInner(options).finally(() => {
    if (sweepInFlightByTeam.get(options.teamId) === sweep) {
      sweepInFlightByTeam.delete(options.teamId)
    }
  })
  sweepInFlightByTeam.set(options.teamId, sweep)
  return sweep
}
