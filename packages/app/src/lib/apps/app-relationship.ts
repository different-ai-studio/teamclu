import type { AppRelationship, AppRow } from '@/lib/backend/types'

/**
 * How the viewer is related to an app, and the quick filter over it.
 *
 * The server decides (`GET /v1/apps` sends `relationship`), because only it can
 * see the viewer's access grants. What is here is the fallback for a server
 * that predates the field, and the counting and filtering both lists share.
 */

export type AppRelationshipFilter = 'all' | AppRelationship

export const APP_RELATIONSHIP_FILTERS: readonly AppRelationshipFilter[] = ['all', 'owner', 'invited', 'team']

/**
 * The server's answer, or the same rule worked out from the row.
 *
 * The fallback cannot see grants, so a team app the viewer was also invited to
 * reads as `team` there. A visible app that is neither mine nor a team app can
 * only have come through a grant, so it is `invited` — unless my actor id is not
 * known yet, when a personal app is far more likely to be my own.
 */
export function appRelationship(
  app: Pick<AppRow, 'relationship' | 'createdByActorId' | 'visibility'>,
  myActorId: string | null,
): AppRelationship {
  if (app.relationship) return app.relationship
  if (myActorId && app.createdByActorId === myActorId) return 'owner'
  if (app.visibility === 'team') return 'team'
  return myActorId ? 'invited' : 'owner'
}

/**
 * My own app that the whole team can see.
 *
 * The only case worth marking: a team app is team-visible by definition, and an
 * app I was invited to is personal-visible with a grant behind it — in neither
 * does the visibility tell the viewer anything they do not already know. On my
 * own app it does, and it is the one thing the relationship word cannot say.
 */
export function isSharedByMe(
  app: Pick<AppRow, 'relationship' | 'createdByActorId' | 'visibility'>,
  myActorId: string | null,
): boolean {
  return app.visibility === 'team' && appRelationship(app, myActorId) === 'owner'
}

export function countAppsByRelationship(
  apps: readonly AppRow[],
  myActorId: string | null,
): Record<AppRelationshipFilter, number> {
  const counts: Record<AppRelationshipFilter, number> = { all: apps.length, owner: 0, invited: 0, team: 0 }
  for (const app of apps) counts[appRelationship(app, myActorId)] += 1
  return counts
}

export function filterAppsByRelationship<T extends AppRow>(
  apps: T[],
  filter: AppRelationshipFilter,
  myActorId: string | null,
): T[] {
  if (filter === 'all') return apps
  return apps.filter((app) => appRelationship(app, myActorId) === filter)
}

/**
 * A row from a create/rename/deploy response, keeping the relationship the list
 * gave the row it replaces — those endpoints do not send one, and dropping it
 * would move the app to a different filter until the next list load.
 */
export function keepRelationship(prev: AppRow, next: AppRow): AppRow {
  if (next.relationship || !prev.relationship) return next
  return { ...next, relationship: prev.relationship, invitedByActorId: prev.invitedByActorId ?? null }
}

export const APP_RELATIONSHIP_LABELS: Record<AppRelationshipFilter, { key: string; fallback: string }> = {
  all: { key: 'apps.relationshipAll', fallback: '全部' },
  owner: { key: 'apps.relationshipOwner', fallback: '我的' },
  invited: { key: 'apps.relationshipInvited', fallback: '受邀' },
  team: { key: 'apps.relationshipTeam', fallback: '团队' },
}
