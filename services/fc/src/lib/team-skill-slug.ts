import { ApiError } from "./http-utils.js";

/**
 * Registry slug rules for team skills.
 *
 * The id is also the install folder and the SKILL.md `name` on every desktop.
 * Chinese is a legal id: 整车成本智能表格 is stored and installed as itself.
 * Keep the character rules in sync with
 * `packages/app/src/lib/skills/team-skill-slug.ts` and
 * `crates/teamclu-skillpack/src/slug.rs`.
 *
 * Existing ASCII rows stay valid. Reserved Windows names are rejected on
 * create only — a check constraint that newly forbids `con` would fail if a
 * row with that id already exists.
 */

export const TEAM_SKILL_SLUG_MAX = 64;
export const TEAM_SKILL_SLUG_MAX_BYTES = 255;
export const TEAM_SKILL_DISPLAY_NAME_MAX = 120;

export const TEAM_SKILL_SLUG_INVALID_MESSAGE =
  "slug must be 2-64 letters or digits, any language, NFC, with hyphens only in the middle";

export const TEAM_SKILL_SLUG_RESERVED_MESSAGE =
  "slug is reserved on Windows and cannot be a skill folder name";

const WINDOWS_RESERVED_SLUGS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** NFC, trimmed, ASCII letters lowercased. Chinese is unchanged. */
export function canonicalTeamSkillSlug(raw: unknown): string {
  return asciiLower(String(raw ?? "").normalize("NFC").trim());
}

export function assertTeamSkillSlug(slug: string): void {
  if (!slugShapeOk(slug)) {
    throw new ApiError(400, "validation_failed", TEAM_SKILL_SLUG_INVALID_MESSAGE);
  }
  if (isWindowsReservedSlug(slug)) {
    throw new ApiError(400, "validation_failed", TEAM_SKILL_SLUG_RESERVED_MESSAGE);
  }
}

function isWindowsReservedSlug(slug: string): boolean {
  const stem = slug.split(".")[0] ?? slug;
  return WINDOWS_RESERVED_SLUGS.has(stem);
}

function slugShapeOk(slug: string): boolean {
  if (!slug || slug !== slug.normalize("NFC")) return false;
  const points = [...slug];
  if (points.length < 2 || points.length > TEAM_SKILL_SLUG_MAX) return false;
  if (utf8Bytes(slug) > TEAM_SKILL_SLUG_MAX_BYTES) return false;
  return points.every((char, index) => allowedChar(char.codePointAt(0) ?? 0, index, points.length - 1));
}

function allowedChar(cp: number, index: number, last: number): boolean {
  if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
  if (cp === 0xa0 || cp === 0x3000 || cp === 0xfeff) return false;
  if (cp >= 0x200b && cp <= 0x200d) return false;
  if (cp === 0x2028 || cp === 0x2029) return false;
  if (cp >= 0x202a && cp <= 0x202e) return false;
  if (cp >= 0x2066 && cp <= 0x2069) return false;
  if (cp < 128) {
    const digit = cp >= 48 && cp <= 57;
    const lower = cp >= 97 && cp <= 122;
    const hyphen = cp === 45;
    if (hyphen && (index === 0 || index === last)) return false;
    return digit || lower || hyphen;
  }
  return true;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Human title stored next to the slug. Empty falls back to the slug so older
 * clients that omit the field keep the previous behaviour. A present value
 * may be Chinese; control characters and a length past 120 are rejected.
 */
export function teamSkillDisplayName(value: unknown, fallbackSlug: string): string {
  if (value === undefined || value === null) return fallbackSlug;
  const name = String(value).trim();
  if (!name) return fallbackSlug;
  if (name.length > TEAM_SKILL_DISPLAY_NAME_MAX || hasControlChar(name)) {
    throw new ApiError(
      400,
      "validation_failed",
      "displayName must be 1-120 characters without control characters",
    );
  }
  return name;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** One URL path segment. Safe to decode once on the server. */
export function decodeRouteSlug(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
