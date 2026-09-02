// ─── ClawHub API Response Types ──────────────────────────────────────────────
// Mirror the Rust serde types returned by Tauri commands.

export interface ClawHubSearchResultEntry {
  score: number
  slug?: string
  displayName?: string
  summary?: string | null
  version?: string | null
  updatedAt?: number
}

export interface ClawHubSearchResults {
  results: ClawHubSearchResultEntry[]
}

interface ClawHubSkillVersionInfo {
  version: string
  createdAt?: number
  changelog: string
}

interface ClawHubSkillOwner {
  handle: string | null
  displayName?: string | null
  image?: string | null
}

interface ClawHubSkillModeration {
  isSuspicious: boolean
  isMalwareBlocked: boolean
}

interface ClawHubSkillInfo {
  slug: string
  displayName: string
  tags: unknown
  stats: unknown
  createdAt: number
  updatedAt: number
  summary?: string | null
}

export interface ClawHubSkillDetail {
  skill: ClawHubSkillInfo | null
  latestVersion: ClawHubSkillVersionInfo | null
  owner: ClawHubSkillOwner | null
  moderation: ClawHubSkillModeration | null
}

export interface ClawHubSkillListItem {
  slug: string
  displayName: string
  tags: unknown
  stats: unknown
  createdAt: number
  updatedAt: number
  summary?: string | null
  latestVersion?: ClawHubSkillVersionInfo
}

export interface ClawHubExploreResults {
  items: ClawHubSkillListItem[]
  nextCursor: string | null
}

// ─── Lockfile Types ──────────────────────────────────────────────────────────

interface ClawHubLockfileEntry {
  version: string | null
  installedAt: number
  /** Absent on pre-team-registry rows, which are all ClawHub. */
  source?: string | null
}

export interface ClawHubLockfile {
  version: number
  skills: Record<string, ClawHubLockfileEntry>
}

/** Lockfile `source` values that the ClawHub marketplace may treat as installed. */
export function isClawHubLockfileSource(source?: string | null): boolean {
  return source == null || source === '' || source === 'clawhub'
}

/** Slugs the ClawHub UI may show as Installed / Uninstall. Team rows stay out. */
export function clawhubInstalledSlugs(lock: ClawHubLockfile): string[] {
  return Object.entries(lock.skills)
    .filter(([, entry]) => isClawHubLockfileSource(entry.source))
    .map(([slug]) => slug)
}

// ─── Stats helper (stats field is untyped from API) ──────────────────────────

interface ClawHubStats {
  stars?: number
  downloads?: number
  installsCurrent?: number
  installsAllTime?: number
}

export function parseStats(stats: unknown): ClawHubStats {
  if (!stats || typeof stats !== "object") return {}
  const s = stats as Record<string, unknown>
  return {
    stars: typeof s.stars === "number" ? s.stars : undefined,
    downloads: typeof s.downloads === "number" ? s.downloads : undefined,
    installsCurrent: typeof s.installsCurrent === "number" ? s.installsCurrent : undefined,
    installsAllTime: typeof s.installsAllTime === "number" ? s.installsAllTime : undefined,
  }
}
