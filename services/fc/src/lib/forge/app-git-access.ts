import { readTeamAppAccess } from "../teamclu-apps/team-app-access.js";
import { pagedRows } from "../supabase-repo/shared.js";
import {
  appLevelAtLeast,
  higherAppLevel,
  storedAppPermissionLevel,
  type AppPermissionLevel,
} from "../app-permission.js";

/**
 * The level an inherited agent gets on the repo (mirrored to Gitea). Gitea's `admin` collaborator
 * adds nothing an agent needs — merging a PR is `write` — and is the level
 * that could change the repo's settings, so an agent that inherits `admin`
 * from the app's creator is mirrored as `write`. The Cloud API still treats it
 * as admin for deploys (see agent inheritance in supabase-repo).
 */
export function inheritedRepoLevel(level: AppPermissionLevel): AppPermissionLevel {
  return level === "admin" ? "write" : level;
}

/**
 * What an account holds on an app, for `GET /v1/git/access` — the credential
 * helper asking why Gitea refused it.
 *
 * Lives with the repository code, not in the route: it reads `amux` tables,
 * and it must give the answer the rest of the app rules give. It takes the
 * service-role client because its caller authenticates with a git token, which
 * PostgREST cannot be handed, so RLS has nobody to evaluate for; the team
 * check below is the boundary instead.
 */
export interface AppGitAccess {
  appId: string;
  appName: string;
  /** null: in the app's team, but holds nothing on the app. */
  permission: AppPermissionLevel | null;
  actorName: string | null;
  actorType: string;
}

/**
 * The level Gitea ends up enforcing for an account in the app's org: the
 * creator is admin, a grant counts at its level, an agent's inherited level
 * counts as the sync mirrors it (admin → write, `inheritedRepoLevel`), and a
 * org-visible app is readable by the whole org (the Gitea read team the sync
 * maintains).
 */
export function appGitLevel(input: {
  isCreator: boolean;
  grant: unknown;
  inherited?: unknown;
  visibility: string | null | undefined;
}): AppPermissionLevel | null {
  if (input.isCreator) return "admin";
  const inheritedLevel = storedAppPermissionLevel(input.inherited);
  const granted = higherAppLevel(
    storedAppPermissionLevel(input.grant),
    inheritedLevel ? inheritedRepoLevel(inheritedLevel) : null,
  );
  if (input.visibility === "team" && (!granted || !appLevelAtLeast(granted, "read"))) return "read";
  return granted;
}

/**
 * null when there is no such app, or the account is not in its org — the two
 * are not told apart. Read from the platform model (P3.1d): org, creator,
 * grants and inheritance through readTeamAppAccess.
 */
export async function readAppGitAccess(admin: any, appId: string, userId: string): Promise<AppGitAccess | null> {
  const access = await readTeamAppAccess(admin, appId);
  if (!access) return null;
  const { data: teamActor, error: actorErr } = await admin
    .from("actors")
    .select("id, actor_type, display_name")
    .eq("team_id", access.teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (actorErr) throw actorErr;
  let actor = teamActor;
  if (!actor && access.teamVisible && access.orgId) {
    const orgTeams = await pagedRows((from, to) => admin.from("teams")
      .select("id").eq("oid", access.orgId).order("id").range(from, to));
    const teamIds = new Set((orgTeams as { id: string }[]).map((team) => team.id));
    const orgActors = await pagedRows((from, to) => admin.from("actors")
      .select("id, team_id, actor_type, display_name")
      .eq("user_id", userId).order("id").range(from, to));
    actor = orgActors.find((candidate) => teamIds.has(candidate.team_id)) ?? null;
  }
  if (!actor) return null;

  const isCreator = access.createdByActorId === actor.id;
  const grant = isCreator ? null : access.grants.find((g) => g.actorId === actor.id)?.level ?? null;
  const inherited = !isCreator && actor.actor_type === "agent"
    ? access.inherited.find((r) => r.agentId === actor.id)?.level ?? null
    : null;
  return {
    appId: access.appId,
    appName: access.name,
    permission: appGitLevel({ isCreator, grant, inherited, visibility: access.teamVisible ? "team" : "personal" }),
    actorName: actor.display_name ?? null,
    actorType: actor.actor_type,
  };
}
