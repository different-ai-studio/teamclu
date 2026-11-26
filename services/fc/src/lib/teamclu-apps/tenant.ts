/**
 * TeamClu's answers to the app platform's tenant questions (AppTenantHooks).
 *
 * In TeamClu an app is created inside a team, by one of its actors, with a
 * 1:1 workspace for its sessions; lists are per team; responses carry the
 * team, the creating actor and the caller's relationship to the app.
 *
 * Reads come from app_links (team, workspace, creating actor) and app_grants
 * (org grant = `visibility: team`; the caller's user grants = `invited`), P3.1
 * of docs/specs/2026-11-26-app-platform-p3-retire-legacy.md. Writes still go
 * to the legacy columns on the app row until P3.2; P2.1's triggers project
 * them into those tables.
 */
import { ApiError } from "../http-utils.js";
import type { AppTenantHooksFactory } from "../app-platform/tenant.js";
import { chunkedIn } from "../supabase-repo/shared.js";

export type AppRelationship = "owner" | "invited" | "team";

/**
 * How the caller came to see an app, collapsed to one answer.
 *
 * Owner first, then invited, then team: a grant on a team app is what gives
 * the caller rights beyond reading it, so it is the fact worth showing. A row
 * that is neither the caller's nor a team app can only be visible through a
 * grant, so it is `invited` even when the grants could not be read — just
 * without the name of whoever granted it.
 */
export function appRelationshipFor(
  app: { id: string; createdByActorId: string | null; visibility: string },
  callerActorId: string | null,
  grants: Map<string, string | null> | null,
): { relationship: AppRelationship; invitedByActorId: string | null } {
  if (callerActorId && app.createdByActorId === callerActorId) {
    return { relationship: "owner", invitedByActorId: null };
  }
  if (grants?.has(app.id)) {
    return { relationship: "invited", invitedByActorId: grants.get(app.id) ?? null };
  }
  if (app.visibility === "team") return { relationship: "team", invitedByActorId: null };
  return { relationship: "invited", invitedByActorId: null };
}

/** TeamClu's fields of an app (`AppTenantHooks.fields`). */
export type TeamCluAppFields = {
  teamId: string | null;
  visibility: "team" | "personal";
  workspaceId: string | null;
  createdByActorId: string | null;
};

export type TeamCluAppTenantDeps = {
  supabase: any;
  getCurrentUser: () => Promise<any>;
  /** Archive the sessions of a workspace (supabase-repo.ts). */
  archiveSessionsForWorkspace: (admin: any, workspaceId: string) => Promise<unknown>;
};

export function teamCluAppTenant(deps: TeamCluAppTenantDeps): AppTenantHooksFactory {
  const { supabase, getCurrentUser, archiveSessionsForWorkspace } = deps;

  async function currentUserId(): Promise<string> {
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
    return userId;
  }

  return (repo) => ({
    /**
     * `input.teamId` is the team the app is created in; `input.visibility`
     * `team` makes it visible to the team's org; `input.grantActorIds` are
     * actors (in practice: agents) to grant `write` on the new app. Agents get
     * no access by default (spec decision 6); this is the create dialog's
     * "also grant these agents" list. A grant that fails is logged and
     * skipped — it must not undo a created app.
     */
    async prepareCreate(input) {
      // Resolve the caller's actor in this team — the RLS insert policy
      // (created_by_actor_id = amux.current_actor_id_for_team(team_id)) requires
      // it. A member or an agent: a daemon's agent creates apps for the agents
      // on its machine (`amuxd app create`), and that policy takes any actor.
      const userId = await currentUserId();
      const resolved = await repo.resolveCurrentActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      // `workspaces.created_by_member_id` references `amux.members`, which an
      // agent is not; its insert policy takes null.
      const createdByMemberId = resolved.actorType === "agent" ? null : createdByActorId;

      // The app's tenant, settled here rather than at the first finalize.
      //
      // `apps.org_id` is a live tenant pointer (migration 20260923200000): the
      // login page narrows its account picker by it and the proxy gateway
      // resolves admission against it, so an app that reaches either of them
      // without one is simply broken.
      //
      // `teams.oid` is nullable by design (a team is created before it has an
      // org), so this can legitimately fail. It is answered with a 409 naming
      // the cause, because the alternative is a NOT NULL violation surfacing
      // as a 500 at the moment someone is trying to create an app.
      const orgId = await repo.resolveTeamOrgId(input.teamId);
      if (!orgId) {
        throw new ApiError(409, "team_has_no_org", "该团队尚未关联组织，无法创建应用");
      }

      return {
        orgId,
        async writeColumns({ slug }) {
          // 1:1 workspace for the app. created_by_member_id = the resolved actor so
          // the workspace RLS insert policy is satisfied (same actor identity).
          const { data: ws, error: wsErr } = await supabase
            .from("workspaces")
            .insert({
              team_id: input.teamId,
              created_by_member_id: createdByMemberId,
              name: `app-${slug}-${Math.random().toString(36).slice(2, 8)}`,
            })
            .select("id")
            .single();
          if (wsErr) throw wsErr;
          return {
            team_id: input.teamId,
            created_by_actor_id: createdByActorId,
            visibility: input.visibility === "team" ? "team" : "personal",
            workspace_id: ws.id,
          };
        },
        async created(row) {
          for (const actorId of [...new Set((input.grantActorIds ?? []) as unknown[])]) {
            if (typeof actorId !== "string" || !actorId || actorId === createdByActorId) continue;
            try {
              await repo.setAppAccess(row.id, actorId, "write");
            } catch (e) {
              console.warn(`[apps] initial grant to ${actorId} on ${row.id} skipped: ${String((e as Error)?.message ?? e)}`);
            }
          }
        },
      };
    },

    // Lists are per team: `GET /v1/apps?teamId=`, through the app's link.
    // app_links is readable for the apps the caller sees (20261127100000).
    listEmbed() {
      return "app_links!inner(team_id)";
    },
    scopeList(query: any, scope) {
      return query.eq("app_links.team_id", scope.teamId);
    },

    // Team, workspace and creating actor from app_links; `visibility: team`
    // is an org grant on the app for its own org. Both readable with the
    // caller's token for the apps they see (20261127100000).
    async fields(rows) {
      const ids = [...new Set(rows.map((r) => r.id).filter(Boolean))] as string[];
      if (ids.length === 0) return rows.map(() => ({}));
      const admin = supabase;
      const [links, orgGrants] = await Promise.all([
        chunkedIn(ids, async (chunk) => {
          const { data, error } = await admin
            .from("app_links")
            .select("app_id, team_id, workspace_id, created_by_actor_id")
            .in("app_id", chunk);
          if (error) throw error;
          return data ?? [];
        }),
        chunkedIn(ids, async (chunk) => {
          const { data, error } = await admin
            .from("app_grants")
            .select("app_id, principal_org_id")
            .in("app_id", chunk)
            .not("principal_org_id", "is", null);
          if (error) throw error;
          return data ?? [];
        }),
      ]);
      const linkOf = new Map(links.map((l: any) => [l.app_id, l]));
      return rows.map((r): TeamCluAppFields => {
        const link: any = linkOf.get(r.id);
        const teamVisible = orgGrants.some(
          (g: any) => g.app_id === r.id && (r.org_id == null || g.principal_org_id === r.org_id),
        );
        return {
          teamId: link?.team_id ?? null,
          visibility: teamVisible ? "team" : "personal",
          workspaceId: link?.workspace_id ?? null,
          createdByActorId: link?.created_by_actor_id ?? null,
        };
      });
    },

    // `relationship` / `invitedByActorId`: the caller's relationship to each
    // app, from their actor in its team and their own grants (by account; the
    // grantor's account named as their actor in that team).
    async decorate(rows, fields) {
      const apps = rows.map((r, i) => ({ id: r.id as string, ...(fields[i] as TeamCluAppFields) }));
      const userId = await currentUserId();
      const teams = [...new Set(apps.map((a) => a.teamId).filter(Boolean))] as string[];
      const actorIn = new Map<string, string | null>();
      for (const teamId of teams) actorIn.set(teamId, (await repo.resolveCurrentActor(teamId, userId))?.id ?? null);

      let grants: Map<string, string | null> | null = null;
      try {
        const admin = supabase;
        const mine = await chunkedIn(apps.map((a) => a.id), async (chunk) => {
          const { data, error } = await admin
            .from("app_grants")
            .select("app_id, granted_by_user_id")
            .eq("principal_user_id", userId)
            .in("app_id", chunk);
          if (error) throw error;
          return data ?? [];
        });
        const grantors = [...new Set(mine.map((g: any) => g.granted_by_user_id).filter(Boolean))] as string[];
        const grantorActors = grantors.length === 0 ? [] : await chunkedIn(grantors, async (chunk) => {
          const { data, error } = await admin
            .from("actors")
            .select("id, team_id, user_id")
            .in("user_id", chunk);
          if (error) throw error;
          return data ?? [];
        });
        const teamOf = new Map(apps.map((a) => [a.id, a.teamId]));
        grants = new Map(mine.map((g: any) => [
          g.app_id,
          grantorActors.find((a: any) => a.user_id === g.granted_by_user_id && a.team_id === teamOf.get(g.app_id))?.id ?? null,
        ]));
      } catch (e) {
        console.warn(`[apps] app grants unavailable for the list: ${String(e)}`);
      }
      return apps.map((a) => appRelationshipFor(a, a.teamId ? actorIn.get(a.teamId) ?? null : null, grants));
    },

    // `visibility: team` is the team's org seeing the app (an org grant,
    // projected by P2.1's trigger from this column).
    updateColumns(patch) {
      return patch.visibility === "team" || patch.visibility === "personal" ? { visibility: patch.visibility } : {};
    },
    // That org grant is access: a delegate (an agent acting for its owner)
    // may not widen or narrow who sees the owner's app (P2 spec §6 Q1).
    accessColumns: ["visibility"],

    // Desktop introspect decodes `teamId` as required.
    authInfoFields(app) {
      return { teamId: app.teamId };
    },

    // The app's workspace is archived, pointing at wherever the code now
    // lives, and so are its sessions.
    async appDeleting(appId, { admin, archivedRepoUrl, remoteUrl }) {
      const { data: link, error: linkErr } = await admin
        .from("app_links")
        .select("workspace_id")
        .eq("app_id", appId)
        .maybeSingle();
      if (linkErr) throw linkErr;
      const workspaceId = link?.workspace_id;
      if (!workspaceId) return;
      const now = new Date().toISOString();
      const { error: wsErr } = await admin
        .from("workspaces")
        .update({
          archived: true,
          path: archivedRepoUrl ?? remoteUrl,
          updated_at: now,
        })
        .eq("id", workspaceId);
      if (wsErr) throw wsErr;
      await archiveSessionsForWorkspace(admin, workspaceId);
    },
  });
}
