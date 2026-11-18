import { pinyin } from 'pinyin-pro'

/**
 * Team-registry skill ids.
 *
 * The slug is the install directory under `~/.agents/skills/<slug>`, the URL
 * segment, and the `name` written into SKILL.md. It stays ASCII on purpose:
 *
 * - Postgres, the OpenAPI contract, and the Cloud API only accept
 *   `^[a-z0-9][a-z0-9-]{1,63}$`.
 * - macOS stores many filenames as NFD and its default volume is
 *   case-insensitive. Windows stores the code points it is given (usually NFC)
 *   and rejects device names such as `CON` and `NUL`. Linux is case-sensitive.
 *   An ASCII lowercase id is the same directory on all three.
 * - A Chinese title is a display name, not a path. Personal folders may keep
 *   it; the shared copy does not use it as the folder name.
 *
 * Generation is a pure function of the NFC title, so Windows and macOS produce
 * the same default when the author leaves the field alone.
 */

export const TEAM_SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
export const TEAM_SKILL_SLUG_MAX = 64
export const TEAM_SKILL_DISPLAY_NAME_MAX = 120

/** Matches the Cloud API validation error so a toast can be localized. */
export const TEAM_SKILL_SLUG_INVALID_MESSAGE =
  'slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit'

/** Matches the Cloud API reserved-name error. */
export const TEAM_SKILL_SLUG_RESERVED_MESSAGE =
  'slug is reserved on Windows and cannot be a skill folder name'

/**
 * Device names Windows rejects as a file or directory, with or without an
 * extension. Skill slugs have no extension, so the bare name is enough.
 * Keep this list in sync with `services/fc/src/lib/team-skill-slug.ts`.
 */
const WINDOWS_RESERVED_SLUGS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

export type TeamSkillSlugIssue = 'empty' | 'invalid' | 'reserved' | 'taken'

export function isTeamSkillSlug(slug: string): boolean {
  return TEAM_SKILL_SLUG_RE.test(slug)
}

export function isWindowsReservedSlug(slug: string): boolean {
  return WINDOWS_RESERVED_SLUGS.has(slug)
}

/** A slug the registry will store and every desktop OS can create as a folder. */
export function isPublishableTeamSkillSlug(slug: string): boolean {
  return isTeamSkillSlug(slug) && !isWindowsReservedSlug(slug)
}

export function normalizeTeamSkillSlug(raw: string): {
  slug: string
  issue: Exclude<TeamSkillSlugIssue, 'taken'> | null
} {
  const slug = raw.trim().toLowerCase()
  if (!slug) return { slug: '', issue: 'empty' }
  if (!isTeamSkillSlug(slug)) return { slug, issue: 'invalid' }
  if (isWindowsReservedSlug(slug)) return { slug, issue: 'reserved' }
  return { slug, issue: null }
}

export function teamSkillSlugIssue(
  raw: string,
  taken?: ReadonlySet<string>,
): TeamSkillSlugIssue | null {
  const normalized = normalizeTeamSkillSlug(raw)
  if (normalized.issue) return normalized.issue
  if (taken?.has(normalized.slug)) return 'taken'
  return null
}

/**
 * Recognize the English validation strings the API still returns, so the share
 * toast can be shown in the dialog's language.
 */
export function skillSlugIssueFromServerMessage(message: string): 'invalid' | 'reserved' | null {
  if (message.includes(TEAM_SKILL_SLUG_RESERVED_MESSAGE)) return 'reserved'
  if (message.includes('slug must be 2-64')) return 'invalid'
  return null
}

export class SkillSlugInvalidError extends Error {
  readonly reason: Exclude<TeamSkillSlugIssue, 'taken'>

  constructor(readonly slug: string, reason: Exclude<TeamSkillSlugIssue, 'taken'>) {
    super(reason === 'reserved' ? TEAM_SKILL_SLUG_RESERVED_MESSAGE : TEAM_SKILL_SLUG_INVALID_MESSAGE)
    this.name = 'SkillSlugInvalidError'
    this.reason = reason
  }
}

/**
 * Whether sharing should move the personal folder aside.
 *
 * A publishable source id that the author deliberately changed is a second
 * skill: keep both. Every other source — a Chinese folder, a reserved device
 * name, a name with spaces — cannot be the team install path, so leaving it
 * in place would keep a private copy that team updates never reach.
 */
export function shouldRetirePersonalOnShare(filename: string, publishedSlug: string): boolean {
  const sourceIsPublishable = isPublishableTeamSkillSlug(filename)
  return !(sourceIsPublishable && filename !== publishedSlug)
}

/** Display name stored beside the slug. Chinese is kept; control chars are not. */
export function teamSkillDisplayName(name: string | null | undefined, fallback: string): string {
  const cleaned = stripControlChars(name ?? '')
    .normalize('NFC')
    .trim()
    .slice(0, TEAM_SKILL_DISPLAY_NAME_MAX)
    .trim()
  return cleaned || fallback
}

/**
 * Default registry id for a personal skill title.
 *
 * Already-valid ids pass through (`deploy-check`). Latin titles are
 * hyphenated (`My Skill` → `my-skill`). Chinese and other non-ASCII titles
 * become pinyin (`整车成本智能表格` → `zheng-che-cheng-ben-zhi-neng-biao-ge`),
 * and anything pinyin cannot express becomes `skill-` plus a stable hash of
 * the NFC title.
 */
export function teamSkillSlugFromName(name: string): string {
  const key = name.normalize('NFC').trim().toLowerCase()
  if (!key) return ''
  if (isPublishableTeamSkillSlug(key)) return key

  const folded = stripCombiningMarks(key)
  const ascii = hyphenateAscii(folded)
  const hasNonAscii = containsNonAscii(folded)
  if (!hasNonAscii && ascii.length >= 2) {
    return avoidReserved(ascii)
  }

  const fromReading = fitReading(slugFromPinyin(key), key)
  if (fromReading) return avoidReserved(fromReading)

  return avoidReserved(fitSlug(`skill-${fnv1a64(key).slice(0, 8)}`) ?? '')
}

/** First free slug. `deploy-check` stays put; a collision becomes `deploy-check-2`. */
export function allocateTeamSkillSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base = teamSkillSlugFromName(name)
  if (!base) return ''
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`
    const room = TEAM_SKILL_SLUG_MAX - suffix.length
    const head = base.slice(0, room).replace(/-+$/g, '')
    const candidate = `${head}${suffix}`
    if (isPublishableTeamSkillSlug(candidate) && !taken.has(candidate)) return candidate
  }
  return base
}

function stripControlChars(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) continue
    out += char
  }
  return out
}

function containsNonAscii(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) return true
  }
  return false
}

function stripCombiningMarks(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
}

function hyphenateAscii(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function slugFromPinyin(name: string): string {
  let raw: string | readonly string[]
  try {
    raw = pinyin(name, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  } catch {
    return ''
  }
  const parts = Array.isArray(raw) ? raw : [raw]
  return parts
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter((part) => part.length > 0)
    .join('-')
}

/** Keep a pinyin id inside 64 characters without collapsing two long titles. */
function fitReading(reading: string, key: string): string | null {
  if (reading.length <= TEAM_SKILL_SLUG_MAX) return fitSlug(reading)
  const suffix = `-${fnv1a64(key).slice(0, 8)}`
  const head = reading.slice(0, TEAM_SKILL_SLUG_MAX - suffix.length).replace(/-+$/g, '')
  return fitSlug(`${head}${suffix}`)
}

function fitSlug(slug: string): string | null {
  let fitted = slug.replace(/^-+|-+$/g, '')
  if (fitted.length > TEAM_SKILL_SLUG_MAX) {
    fitted = fitted.slice(0, TEAM_SKILL_SLUG_MAX).replace(/-+$/g, '')
  }
  return isTeamSkillSlug(fitted) ? fitted : null
}

function avoidReserved(slug: string): string {
  if (!slug) return ''
  if (!isWindowsReservedSlug(slug)) return slug
  return fitSlug(`skill-${slug}`) ?? `skill-${fnv1a64(slug).slice(0, 8)}`
}

/** Stable, synchronous, platform-independent digest. Not a security hash. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) ?? 0)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
