/**
 * TeamClu's answers to the app platform's tenant questions (AppTenantHooks).
 *
 * In TeamClu an app is created inside a team, by one of its actors, with a
 * 1:1 workspace for its sessions; lists are per team; responses carry the
 * team, the creating actor and the caller's relationship to the app. Until P3
 * those live on the app row (team_id, created_by_actor_id, workspace_id,
 * visibility) and P2.1's triggers project them into app_links and grants.
 * P2.4b of docs/specs/2026-11-25-app-platform-p2-de-team.md.
 */
import { ApiError } from "../http-utils.js";
import type { AppTenantHooksFactory } from "../app-platform/tenant.js";
import { appRelationshipFor } from "../supabase-repo/shared.js";

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

    // Lists are per team: `GET /v1/apps?teamId=`.
    scopeList(query: any, scope) {
      return query.eq("team_id", scope.teamId);
    },

    // `relationship` / `invitedByActorId`: the caller's relationship to each
    // app, from their actor in its team.
    async decorate(rows) {
      const byTeam = new Map<string, string[]>();
      for (const r of rows) {
        const ids = byTeam.get(r.team_id) ?? [];
        ids.push(r.id);
        byTeam.set(r.team_id, ids);
      }
      const viewers = new Map<string, any>();
      for (const [teamId, ids] of byTeam) viewers.set(teamId, await repo.resolveAppViewer(teamId, ids));
      return rows.map((r) => {
        const viewer = viewers.get(r.team_id);
        return appRelationshipFor(r as { id: string }, viewer.actorId, viewer.grants);
      });
    },

    // `visibility: team` is the team's org seeing the app (an org grant,
    // projected by P2.1's trigger from this column).
    updateColumns(patch) {
      return patch.visibility === "team" || patch.visibility === "personal" ? { visibility: patch.visibility } : {};
    },

    // Desktop introspect decodes `teamId` as required.
    authInfoFields(app) {
      return { teamId: app.teamId };
    },

    // The app's workspace is archived, pointing at wherever the code now
    // lives, and so are its sessions.
    async appDeleting(appId, { admin, archivedRepoUrl, remoteUrl }) {
      const { data: link, error: linkErr } = await admin
        .from("apps")
        .select("workspace_id")
        .eq("id", appId)
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
