import { ApiError } from "./http-utils.js";

/**
 * Registry slug rules for team skills.
 *
 * The id is also the install folder on every desktop. It stays
 * `[a-z0-9-]`, 2–64 chars, and it must not be a Windows device name
 * (`CON`, `NUL`, `COM1`, …). Chinese titles belong in `display_name`.
 *
 * Keep `WINDOWS_RESERVED_SLUGS` in sync with
 * `packages/app/src/lib/skills/team-skill-slug.ts`.
 */

export const TEAM_SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const TEAM_SKILL_DISPLAY_NAME_MAX = 120;

export const TEAM_SKILL_SLUG_INVALID_MESSAGE =
  "slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit";

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

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function assertTeamSkillSlug(slug: string): void {
  if (!TEAM_SKILL_SLUG_RE.test(slug)) {
    throw new ApiError(400, "validation_failed", TEAM_SKILL_SLUG_INVALID_MESSAGE);
  }
  if (WINDOWS_RESERVED_SLUGS.has(slug)) {
    throw new ApiError(400, "validation_failed", TEAM_SKILL_SLUG_RESERVED_MESSAGE);
  }
}

/**
 * Human title stored next to the slug. Empty falls back to the slug so older
 * clients that omit the field keep the previous "the slug is the name"
 * behaviour. A present value may be Chinese; control characters and a length
 * past 120 are rejected rather than silently clipped.
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
