/** Registry / OpenAPI cap on `summary`. Matches `char_length(summary) <= 200`. */
export const TEAM_SKILL_SUMMARY_MAX = 200

/**
 * Fit a SKILL.md `description` (or any draft blurb) into the registry summary
 * field. Prefers a whitespace break so a clipped English sentence is still
 * readable; Chinese has no spaces and is hard-clipped.
 */
export function clipTeamSkillSummary(
  value: string,
  max = TEAM_SKILL_SUMMARY_MAX,
): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  const slice = trimmed.slice(0, max)
  const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'))
  if (breakAt >= Math.floor(max * 0.6)) return slice.slice(0, breakAt).trimEnd()
  return slice
}

/**
 * Prefill the publish/share form from disk frontmatter + the registry row.
 *
 * Agent Skills put a long "Use when…" matching blob in `description`. The
 * registry's `summary` is 200 characters, so dumping the blob into the
 * 简介 field makes every submit fail. If that blob is too long and
 * `when_to_use` is empty, the full text belongs in 什么时候用 instead.
 */
export function hydrateTeamSkillPublishFields(input: {
  draftSummary?: string | null
  draftWhenToUse?: string | null
  registrySummary?: string | null
  registryWhenToUse?: string | null
}): { summary: string; whenToUse: string; summaryWasClipped: boolean } {
  const draftSummary = (input.draftSummary ?? '').trim()
  const registrySummary = (input.registrySummary ?? '').trim()
  const draftWhenToUse = (input.draftWhenToUse ?? '').trim()
  const registryWhenToUse = (input.registryWhenToUse ?? '').trim()

  const whenToUse = draftWhenToUse || registryWhenToUse
  const rawSummary = draftSummary || registrySummary

  if (rawSummary.length <= TEAM_SKILL_SUMMARY_MAX) {
    return { summary: rawSummary, whenToUse, summaryWasClipped: false }
  }

  const registryFits =
    registrySummary.length > 0 && registrySummary.length <= TEAM_SKILL_SUMMARY_MAX
  return {
    summary: registryFits ? registrySummary : clipTeamSkillSummary(rawSummary),
    whenToUse: whenToUse || rawSummary,
    summaryWasClipped: !registryFits,
  }
}
