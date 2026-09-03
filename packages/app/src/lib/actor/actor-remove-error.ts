import type { TFunction } from 'i18next'

/** Map raw Cloud API / Postgres errors to user-facing remove-from-team messages. */
export function formatActorRemoveError(raw: string, t: TFunction): string {
  if (/cannot remove the last owner/i.test(raw)) {
    return t(
      'actors.removeFailed.lastOwner',
      'Cannot remove the last team owner. Promote another member first.',
    )
  }
  if (/cannot remove your own actor/i.test(raw)) {
    return t('actors.removeFailed.self', 'You cannot remove yourself from the team.')
  }
  if (/requires agent owner for personal agents/i.test(raw)) {
    return t(
      'actors.removeFailed.personalAgentOwner',
      'Only the owner can remove a personal agent.',
    )
  }
  if (/requires owner or admin for team agents/i.test(raw)) {
    return t(
      'actors.removeFailed.teamAgentAdmin',
      'Only team owners and admins can remove team agents.',
    )
  }
  if (/requires owner or admin|remove_team_actor requires owner or admin/i.test(raw)) {
    return t(
      'actors.removeFailed.forbidden',
      'Only team owners and admins can remove members.',
    )
  }
  if (/agent_delete_blocked_by_idea_activities/i.test(raw)) {
    return t(
      'actors.removeFailed.blockedByIdeas',
      'This agent still has related idea activity. Resolve those references first.',
    )
  }
  if (/agent_delete_blocked_by_apps/i.test(raw)) {
    return t(
      'actors.removeFailed.blockedByApps',
      'This agent still has related apps. Resolve those references first.',
    )
  }
  if (/agent_delete_blocked_by_files/i.test(raw)) {
    return t(
      'actors.removeFailed.blockedByFiles',
      'This agent still has related files. Resolve those references first.',
    )
  }
  if (/actor_delete_blocked_by_references/i.test(raw)) {
    return t(
      'actors.removeFailed.blockedByReferences',
      'This actor is still referenced elsewhere. Resolve those references first.',
    )
  }
  if (/agents_owner_member_id_fkey|owner_member_id/i.test(raw)) {
    return t(
      'actors.removeFailed.ownsAgents',
      'This member still owns one or more agents. Remove or reassign those agents first.',
    )
  }
  if (/actor not found/i.test(raw)) {
    return t('actors.removeFailed.notFound', 'This actor is no longer in the team.')
  }
  return t('actors.removeFailed.generic', 'Remove failed: {{msg}}', { msg: raw })
}
