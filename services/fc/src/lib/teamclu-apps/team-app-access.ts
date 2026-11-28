/**
 * One app's access as TeamClu sees it — by actor, inside the app's team —
 * read from the platform model (P3.1c of
 * docs/specs/2026-11-26-app-platform-p3-retire-legacy.md):
 *
 *   app_links      the app's team, workspace and creating actor
 *   app_grants     user grants (an account, named here as its actor in the
 *                  team) and the org grant that is `visibility: team`
 *   app_delegations  an agent acting at its owner's level
 *
 * It replaces reads of apps.team_id / created_by_actor_id / visibility,
 * app_member_access and amux.app_inherited_agents, which P3.4 drops. The
 * inheritance rule is the one app_inherited_agents had (20261120120000): an
 * agent of the app's team whose owner — the creator or a grantee, a member of
 * that team — reaches the app, at the owner's level. app_delegations holds
 * active agents only (P2.1), as that function required.
 *
 * Read with the service role: callers gate first (the access tab, the forge's
 * sync, the git credential path).
 */
import { higherAppLevel, storedAppPermissionLevel, type AppPermissionLevel } from "../app-permission.js";
import { chunkedIn, pagedRows } from "../supabase-repo/shared.js";

export type TeamAppActor = {
  id: string;
  team_id: string;
  actor_type: string;
  user_id: string | null;
  display_name: string | null;
};

export type TeamAppGrant = {
  actorId: string;
  userId: string;
  level: AppPermissionLevel;
  grantedByActorId: string | null;
  createdAt: string | null;
};

export type TeamAppInherited = { agentId: string; ownerActorId: string; level: AppPermissionLevel };

export type TeamAppAccess = {
  appId: string;
  name: string | null;
  orgId: string | null;
  teamId: string;
  workspaceId: string | null;
  createdByActorId: string | null;
  teamVisible: boolean;
  /** User grants whose account has an actor in the app's team, oldest first. */
  grants: TeamAppGrant[];
  /** Agents reaching the app through their owner; an agent with its own grant is still listed. */
  inherited: TeamAppInherited[];
  /** Every actor named above, by id. */
  actors: Map<string, TeamAppActor>;
};

const ACTOR_COLUMNS = "id, team_id, actor_type, user_id, display_name";

/** null when the app does not exist or has no TeamClu link. */
export async function readTeamAppAccess(admin: any, appId: string): Promise<TeamAppAccess | null> {
  const [{ data: app, error: appErr }, { data: link, error: linkErr }] = await Promise.all([
    admin.from("apps").select("id, name, org_id, created_by_user_id").eq("id", appId).maybeSingle(),
    admin.from("app_links").select("team_id, workspace_id, created_by_actor_id").eq("app_id", appId).maybeSingle(),
  ]);
  if (appErr) throw appErr;
  if (linkErr) throw linkErr;
  if (!app || !link?.team_id) return null;
  const teamId: string = link.team_id;

  const { data: grantRows, error: grantErr } = await admin
    .from("app_grants")
    .select("principal_user_id, principal_org_id, level, granted_by_user_id, created_at")
    .eq("app_id", appId)
    .order("created_at", { ascending: true });
  if (grantErr) throw grantErr;
  const rows = (grantRows ?? []) as any[];
  const teamVisible = rows.some((g) => g.principal_org_id && (app.org_id == null || g.principal_org_id === app.org_id));
  const userGrants = rows.filter((g) => g.principal_user_id);

  // Whose level an agent may act at here: the creator's account and every grantee's.
  const principalLevel = new Map<string, AppPermissionLevel>();
  if (app.created_by_user_id) principalLevel.set(app.created_by_user_id, "admin");
  for (const g of userGrants) {
    const level = storedAppPermissionLevel(g.level);
    if (level) principalLevel.set(g.principal_user_id, higherAppLevel(principalLevel.get(g.principal_user_id) ?? null, level)!);
  }
  const delegations = principalLevel.size === 0 ? [] : await chunkedIn([...principalLevel.keys()], async (chunk) => {
    const { data, error } = await admin
      .from("app_delegations")
      .select("delegate_user_id, principal_user_id")
      .in("principal_user_id", chunk);
    if (error) throw error;
    return data ?? [];
  });

  // Accounts → their actor in this team.
  const users = [
    ...new Set([
      ...userGrants.flatMap((g) => [g.principal_user_id, g.granted_by_user_id]),
      ...principalLevel.keys(),
      ...delegations.map((d: any) => d.delegate_user_id),
    ].filter(Boolean)),
  ] as string[];
  const teamActors = users.length === 0 ? [] : await chunkedIn(users, async (chunk) => {
    const { data, error } = await admin.from("actors").select(ACTOR_COLUMNS).eq("team_id", teamId).in("user_id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const actors = new Map<string, TeamAppActor>();
  const actorOfUser = new Map<string, TeamAppActor>();
  for (const a of teamActors as TeamAppActor[]) {
    actors.set(a.id, a);
    if (a.user_id) actorOfUser.set(a.user_id, a);
  }
  if (link.created_by_actor_id && !actors.has(link.created_by_actor_id)) {
    const { data: creator, error } = await admin.from("actors").select(ACTOR_COLUMNS).eq("id", link.created_by_actor_id).maybeSingle();
    if (error) throw error;
    if (creator) actors.set(creator.id, creator);
  }

  const grants: TeamAppGrant[] = [];
  for (const g of userGrants) {
    const actor = actorOfUser.get(g.principal_user_id);
    const level = storedAppPermissionLevel(g.level);
    if (!actor || !level) continue;
    grants.push({
      actorId: actor.id,
      userId: g.principal_user_id,
      level,
      grantedByActorId: g.granted_by_user_id ? actorOfUser.get(g.granted_by_user_id)?.id ?? null : null,
      createdAt: g.created_at ?? null,
    });
  }

  const inherited: TeamAppInherited[] = [];
  const seen = new Set<string>();
  for (const d of delegations as any[]) {
    const agent = actorOfUser.get(d.delegate_user_id);
    const owner = actorOfUser.get(d.principal_user_id);
    const level = principalLevel.get(d.principal_user_id);
    if (!agent || agent.actor_type !== "agent" || !owner || owner.actor_type !== "member" || !level) continue;
    if (seen.has(agent.id)) {
      const prev = inherited.find((r) => r.agentId === agent.id)!;
      const top = higherAppLevel(prev.level, level)!;
      if (top !== prev.level) Object.assign(prev, { level: top, ownerActorId: owner.id });
      continue;
    }
    seen.add(agent.id);
    inherited.push({ agentId: agent.id, ownerActorId: owner.id, level });
  }

  return {
    appId,
    name: app.name ?? null,
    orgId: app.org_id ?? null,
    teamId,
    workspaceId: link.workspace_id ?? null,
    createdByActorId: link.created_by_actor_id ?? null,
    teamVisible,
    grants,
    inherited,
    actors,
  };
}

/** The ids of a team's apps (app_links), for passes that walk a team. */
export async function readTeamAppIds(admin: any, teamId: string): Promise<string[]> {
  const rows = await pagedRows((from, to) => admin.from("app_links")
    .select("app_id").eq("team_id", teamId).order("app_id").range(from, to));
  return rows.map((r) => r.app_id);
}
