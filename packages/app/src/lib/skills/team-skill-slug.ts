/**
 * Team-registry skill ids.
 *
 * The id is the install directory under `~/.agents/skills/<slug>`, the URL
 * segment, and the `name` written into SKILL.md. A Chinese title such as
 * 整车成本智能表格 is the id itself. Pinyin is not generated.
 *
 * The same string has to be one directory on Windows, macOS, and Linux:
 *
 * - NFC, so macOS (which may surface NFD) and Windows (which keeps the code
 *   points it was given) still name one folder. Comparison uses this form.
 * - ASCII letters are lowercased, because macOS and Windows volumes are
 *   case-insensitive and Linux is not. Chinese has no case and is unchanged.
 * - No path separators, controls, Windows-forbidden characters
 *   (`< > : " / \ | ? *`), trailing dots or spaces, or device names
 *   (`CON`, `NUL`, `COM1`, …).
 * - 2–64 Unicode code points, and at most 255 UTF-8 bytes (the macOS
 *   filename-component limit). Postgres `char_length` counts the same code
 *   points.
 *
 * Existing ASCII ids, including ones that were generated as pinyin, stay
 * valid. This module does not rename them.
 */

export const TEAM_SKILL_SLUG_MAX = 64
export const TEAM_SKILL_SLUG_MAX_BYTES = 255
export const TEAM_SKILL_DISPLAY_NAME_MAX = 120

/** Matches the Cloud API validation error so a toast can be localized. */
export const TEAM_SKILL_SLUG_INVALID_MESSAGE =
  'slug must be 2-64 letters or digits, any language, NFC, with hyphens only in the middle'

/** Matches the Cloud API reserved-name error. */
export const TEAM_SKILL_SLUG_RESERVED_MESSAGE =
  'slug is reserved on Windows and cannot be a skill folder name'

/**
 * Device names Windows rejects as a file or directory, with or without an
 * extension. Keep this list in sync with `services/fc/src/lib/team-skill-slug.ts`
 * and `crates/teamclu-skillpack/src/slug.rs`.
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

export function canonicalTeamSkillSlug(raw: string): string {
  return asciiLower(raw.normalize('NFC').trim())
}

export function isWindowsReservedSlug(slug: string): boolean {
  const stem = slug.split('.')[0] ?? slug
  return WINDOWS_RESERVED_SLUGS.has(stem)
}

/** A slug the registry will store and every desktop OS can create as a folder. */
export function isPublishableTeamSkillSlug(slug: string): boolean {
  return teamSkillSlugIssue(slug) === null
}

export function normalizeTeamSkillSlug(raw: string): {
  slug: string
  issue: Exclude<TeamSkillSlugIssue, 'taken'> | null
} {
  const slug = canonicalTeamSkillSlug(raw)
  if (!slug) return { slug: '', issue: 'empty' }
  if (!slugShapeOk(slug)) return { slug, issue: 'invalid' }
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
 * The same id is one skill: the personal folder and the team install would
 * otherwise be two copies. A publishable source id that the author
 * deliberately changed is a second skill and stays.
 */
export function shouldRetirePersonalOnShare(filename: string, publishedSlug: string): boolean {
  const source = canonicalTeamSkillSlug(filename)
  const sourceIsPublishable = isPublishableTeamSkillSlug(source) && source === filename.normalize('NFC')
  return !(sourceIsPublishable && source !== publishedSlug)
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
 * 整车成本智能表格 stays 整车成本智能表格. An ASCII title with spaces is still
 * hyphenated (`My Skill` → `my-skill`) because that id was already legal.
 * Nothing is turned into pinyin.
 */
export function teamSkillSlugFromName(name: string): string {
  const direct = normalizeTeamSkillSlug(name)
  if (!direct.issue) return direct.slug

  const lowered = canonicalTeamSkillSlug(name)
  if (!lowered) return ''
  if (containsNonAscii(lowered)) return lowered

  const ascii = hyphenateAscii(stripCombiningMarks(lowered))
  const hyphenated = normalizeTeamSkillSlug(ascii)
  if (!hyphenated.issue) return hyphenated.slug
  if (hyphenated.issue === 'reserved') return avoidReserved(hyphenated.slug)
  return lowered
}

/** First free slug. A collision becomes `整车成本智能表格-2`. */
export function allocateTeamSkillSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base = teamSkillSlugFromName(name)
  if (!base || !isPublishableTeamSkillSlug(base)) return base
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`
    const room = TEAM_SKILL_SLUG_MAX - codePointLength(suffix)
    const head = codePointSlice(base, room).replace(/-+$/g, '')
    const candidate = `${head}${suffix}`
    if (isPublishableTeamSkillSlug(candidate) && !taken.has(candidate)) return candidate
  }
  return base
}

/** Percent-encode a slug for one URL path segment. ASCII ids stay readable. */
export function encodeTeamSkillSlugForPath(slug: string): string {
  return encodeURIComponent(slug)
}

function slugShapeOk(slug: string): boolean {
  if (slug !== slug.normalize('NFC')) return false
  const points = [...slug]
  if (points.length < 2 || points.length > TEAM_SKILL_SLUG_MAX) return false
  if (utf8Bytes(slug) > TEAM_SKILL_SLUG_MAX_BYTES) return false
  return points.every((char, index) => allowedChar(char.codePointAt(0) ?? 0, index, points.length - 1))
}

function allowedChar(cp: number, index: number, last: number): boolean {
  if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false
  if (cp === 0xa0 || cp === 0x3000 || cp === 0xfeff) return false
  if (cp >= 0x200b && cp <= 0x200d) return false
  if (cp === 0x2028 || cp === 0x2029) return false
  if (cp >= 0x202a && cp <= 0x202e) return false
  if (cp >= 0x2066 && cp <= 0x2069) return false
  if (cp < 128) {
    const digit = cp >= 48 && cp <= 57
    const lower = cp >= 97 && cp <= 122
    const hyphen = cp === 45
    if (hyphen && (index === 0 || index === last)) return false
    return digit || lower || hyphen
  }
  return true
}

function avoidReserved(slug: string): string {
  if (!slug || !isWindowsReservedSlug(slug)) return slug
  const prefixed = `skill-${slug}`
  return isPublishableTeamSkillSlug(prefixed) ? prefixed : slug
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
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

function stripControlChars(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) continue
    out += char
  }
  return out
}

function codePointLength(value: string): number {
  return [...value].length
}

function codePointSlice(value: string, count: number): string {
  return [...value].slice(0, Math.max(0, count)).join('')
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}
