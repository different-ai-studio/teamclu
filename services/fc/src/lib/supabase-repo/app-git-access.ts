import { appLevelAtLeast, storedAppPermissionLevel, type AppPermissionLevel } from "../app-permission.js";

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
 * The level Gitea ends up enforcing for an actor of the app's team: the
 * creator is admin, a grant counts at its level, and a team-visible app is
 * readable by the whole team (the Gitea team the sync maintains).
 */
export function appGitLevel(input: {
  isCreator: boolean;
  grant: unknown;
  visibility: string | null | undefined;
}): AppPermissionLevel | null {
  if (input.isCreator) return "admin";
  const granted = storedAppPermissionLevel(input.grant);
  if (input.visibility === "team" && (!granted || !appLevelAtLeast(granted, "read"))) return "read";
  return granted;
}

/** null when there is no such app, or the account is not in its team — the two are not told apart. */
export async function readAppGitAccess(admin: any, appId: string, userId: string): Promise<AppGitAccess | null> {
  const { data: app, error: appErr } = await admin
    .from("apps")
    .select("id, name, team_id, visibility, created_by_actor_id")
    .eq("id", appId)
    .maybeSingle();
  if (appErr) throw appErr;
  if (!app) return null;
  const { data: actor, error: actorErr } = await admin
    .from("actors")
    .select("id, actor_type, display_name")
    .eq("team_id", app.team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (actorErr) throw actorErr;
  if (!actor) return null;

  const isCreator = app.created_by_actor_id === actor.id;
  let grant: unknown = null;
  if (!isCreator) {
    const { data, error } = await admin
      .from("app_member_access")
      .select("permission_level")
      .eq("app_id", app.id)
      .eq("member_id", actor.id)
      .maybeSingle();
    if (error) throw error;
    grant = data?.permission_level;
  }
  return {
    appId: app.id,
    appName: app.name,
    permission: appGitLevel({ isCreator, grant, visibility: app.visibility }),
    actorName: actor.display_name ?? null,
    actorType: actor.actor_type,
  };
}
