import type { AppRelationship, AppRow } from '@/lib/backend/types'

/**
 * How the viewer is related to an app, and the sidebar's quick filter.
 *
 * The server decides (`GET /v1/apps` sends `relationship`), because only it can
 * see the viewer's access grants. What is here is the fallback for a server
 * that predates the field.
 */

/**
 * The sidebar's split: what is on this machine, then mine and invited wherever
 * they are. A team app nobody invited me to shows only once it is here — the
 * library is where the rest of the team's apps are found.
 */
export type AppSidebarFilter = 'local' | 'owner' | 'invited'

export const APP_SIDEBAR_FILTERS: readonly AppSidebarFilter[] = ['local', 'owner', 'invited']

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

/**
 * A row from a create/rename/deploy response, keeping the relationship the list
 * gave the row it replaces — those endpoints do not send one, and dropping it
 * would move the app to a different filter until the next list load.
 */
export function keepRelationship(prev: AppRow, next: AppRow): AppRow {
  if (next.relationship || !prev.relationship) return next
  return { ...next, relationship: prev.relationship, invitedByActorId: prev.invitedByActorId ?? null }
}

export const APP_SIDEBAR_FILTER_LABELS: Record<AppSidebarFilter, { key: string; fallback: string }> = {
  local: { key: 'apps.filterLocal', fallback: '本机' },
  owner: { key: 'apps.relationshipOwner', fallback: '我的' },
  invited: { key: 'apps.relationshipInvited', fallback: '受邀' },
}
