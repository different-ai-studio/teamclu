import { buildLinkSessionCompositeKey } from './key'

export const LINK_SESSION_MAP_KEY = 'teamclu.extension.linkSessionMap'

export type LinkSessionEntry = {
  sessionId: string
  teamId: string
  linkText: string
  createdAt: number
  lastOpenedAt: number
}

export type LinkSessionMap = {
  version: 1
  entries: Record<string, LinkSessionEntry>
}

type ChromeStorageLocal = {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
}

function readChromeStorage(): ChromeStorageLocal | undefined {
  return (globalThis as { chrome?: { storage?: { local?: ChromeStorageLocal } } }).chrome?.storage
    ?.local
}

export const EMPTY_LINK_SESSION_MAP: LinkSessionMap = { version: 1, entries: {} }

function emptyLinkSessionMap(): LinkSessionMap {
  return { version: 1, entries: {} }
}

export function parseLinkSessionMap(raw: unknown): LinkSessionMap {
  if (!raw || typeof raw !== 'object') return emptyLinkSessionMap()
  const entriesRaw = (raw as { entries?: unknown }).entries
  if (!entriesRaw || typeof entriesRaw !== 'object') return emptyLinkSessionMap()

  const entries: Record<string, LinkSessionEntry> = {}
  for (const [key, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Partial<LinkSessionEntry>
    if (
      typeof row.sessionId !== 'string' ||
      typeof row.teamId !== 'string' ||
      typeof row.linkText !== 'string' ||
      typeof row.createdAt !== 'number' ||
      typeof row.lastOpenedAt !== 'number'
    ) {
      continue
    }
    entries[key] = {
      sessionId: row.sessionId,
      teamId: row.teamId,
      linkText: row.linkText,
      createdAt: row.createdAt,
      lastOpenedAt: row.lastOpenedAt,
    }
  }

  return { version: 1, entries }
}

export async function readLinkSessionMap(): Promise<LinkSessionMap> {
  const storage = readChromeStorage()
  if (!storage) return emptyLinkSessionMap()

  try {
    const bag = await storage.get(LINK_SESSION_MAP_KEY)
    return parseLinkSessionMap(bag[LINK_SESSION_MAP_KEY])
  } catch {
    return emptyLinkSessionMap()
  }
}

async function writeLinkSessionMap(map: LinkSessionMap): Promise<void> {
  const storage = readChromeStorage()
  if (!storage) return
  await storage.set({ [LINK_SESSION_MAP_KEY]: map })
}

export async function lookupLinkSessionEntry(
  teamId: string,
  linkKey: string,
): Promise<LinkSessionEntry | null> {
  const composite = buildLinkSessionCompositeKey(teamId, linkKey)
  const map = await readLinkSessionMap()
  return map.entries[composite] ?? null
}

export type UpsertLinkSessionEntryInput = {
  teamId: string
  linkKey: string
  sessionId: string
  linkText: string
  createdAt?: number
  lastOpenedAt?: number
}

export async function upsertLinkSessionEntry(input: UpsertLinkSessionEntryInput): Promise<void> {
  const composite = buildLinkSessionCompositeKey(input.teamId, input.linkKey)
  const map = await readLinkSessionMap()
  const now = Date.now()
  const existing = map.entries[composite]

  map.entries[composite] = {
    sessionId: input.sessionId,
    teamId: input.teamId,
    linkText: input.linkText,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    lastOpenedAt: input.lastOpenedAt ?? now,
  }

  await writeLinkSessionMap(map)
}

export async function clearLinkSessionMap(): Promise<void> {
  await writeLinkSessionMap(emptyLinkSessionMap())
}

export async function clearLinkSessionMapForTeam(teamId: string): Promise<void> {
  const map = await readLinkSessionMap()
  const trimmedTeam = teamId.trim()
  if (!trimmedTeam) return

  const nextEntries: Record<string, LinkSessionEntry> = {}
  for (const [key, entry] of Object.entries(map.entries)) {
    if (entry.teamId === trimmedTeam) continue
    nextEntries[key] = entry
  }

  await writeLinkSessionMap({ version: 1, entries: nextEntries })
}

/** Drop every mapping that points at a deleted/archived session. */
export async function removeLinkSessionEntriesForSession(sessionId: string): Promise<void> {
  const trimmed = sessionId.trim()
  if (!trimmed) return

  const map = await readLinkSessionMap()
  let changed = false
  const nextEntries: Record<string, LinkSessionEntry> = {}
  for (const [key, entry] of Object.entries(map.entries)) {
    if (entry.sessionId === trimmed) {
      changed = true
      continue
    }
    nextEntries[key] = entry
  }

  if (changed) {
    await writeLinkSessionMap({ version: 1, entries: nextEntries })
  }
}
