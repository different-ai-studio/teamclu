import type { TFunction } from 'i18next'

/** Map Cloud API / Postgres errors from set_team_member_role to user-facing text. */
export function formatSetTeamMemberRoleError(raw: string, t: TFunction): string {
  if (/cannot change your own role/i.test(raw)) {
    return t('actors.roleFailed.self', 'You cannot change your own role.')
  }
  if (/cannot change the owner role/i.test(raw)) {
    return t('actors.roleFailed.owner', 'The team owner role cannot be changed this way.')
  }
  if (/requires owner or admin|set_team_member_role requires owner or admin/i.test(raw)) {
    return t(
      'actors.roleFailed.forbidden',
      'Only team owners and admins can change member roles.',
    )
  }
  if (/actor not found/i.test(raw)) {
    return t('actors.roleFailed.notFound', 'This member is no longer in the team.')
  }
  if (/target must be a member/i.test(raw)) {
    return t('actors.roleFailed.notMember', 'Only team members can be made admin.')
  }
  return t('actors.roleFailed.generic', 'Could not update role: {{msg}}', { msg: raw })
}
