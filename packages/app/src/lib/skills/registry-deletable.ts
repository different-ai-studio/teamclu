export function teamSkillDeletableSlug(
  canManageTeam: boolean,
  origin: string | undefined,
  slug: string,
): string | undefined {
  if (!canManageTeam || origin !== 'registry') return undefined
  return slug
}
