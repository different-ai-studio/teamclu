/**
 * TeamClu's side of apps: what the app platform does not know about.
 *
 * P2.4b of docs/specs/2026-11-25-app-platform-p2-de-team.md. The platform
 * (app-platform/service/apps.ts) answers who may do what by account and org;
 * everything here is shaped by teams and actors and stays TeamClu's:
 *
 *   - the access tab, keyed by actor ids (`memberId` in the API), with the
 *     agents that reach an app through their owner and the inbox hint;
 *   - an app's sessions and whether the caller is a member of its team;
 *   - git credentials, issued to the caller's actor in the app's team;
 *   - the team → org lookup.
 *
 * Spread into the business repository like the other modules, so `this` is
 * the whole repository and the platform's methods are reached through it.
 */
import { ApiError } from "../http-utils.js";
import {
  appLevelAtLeast,
  parseAppPermissionLevel,
  storedAppPermissionLevel,
} from "../app-permission.js";
import { appIso, chunkedIn } from "../supabase-repo/shared.js";
import { readTeamAppAccess } from "./team-app-access.js";
import { readForgeRepos } from "./forge-repos.js";
import { readUserGrantLevel, removeUserGrant, setUserGrant } from "../app-platform/grants.js";
import { appAccessRecipientUserId, publishAppAccessChanged, type AppAccessGrantee } from "../app-access-notify.js";
import type { TeamCluForge } from "./forge.js";

function mapAppAccessRow(r: any) {
  return {
    memberId: r.member_id,
    permissionLevel: storedAppPermissionLevel(r.permission_level) ?? r.permission_level,
    grantedByMemberId: r.granted_by_member_id ?? null,
    createdAt: appIso(r.created_at)!,
  };
}

export type TeamCluAppsHost = {
  supabase: any;
  serviceRoleClient: (why: string) => Promise<any>;
  getCurrentUser: () => Promise<any>;
  forge: TeamCluForge;
  publishSessionParticipantInbox?: (userId: string, payload: unknown) => Promise<void>;
};

export function makeTeamCluAppsRepo(host: TeamCluAppsHost) {
  const { supabase, serviceRoleClient, getCurrentUser, forge, publishSessionParticipantInbox } = host;

  async function currentUserId(): Promise<string> {
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
    return userId;
  }

  /** The caller's actor (member or agent) in `teamId`, or null. */
  async function callerActorIn(repo: any, teamId: string): Promise<{ id: string; actorType?: string | null } | null> {
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
    return (await repo.resolveCurrentActor(teamId, userId)) ?? null;
  }

  /** Best-effort: a grant or revoke succeeds whether or not the hint lands. */
  function scheduleAppAccessChanged(teamId: string, appId: string, grantee: AppAccessGrantee | null | undefined) {
    if (!publishSessionParticipantInbox) return;
    const userId = appAccessRecipientUserId(grantee);
    if (!userId) return;
    void publishAppAccessChanged({
      teamId,
      appId,
      userId,
      publish: publishSessionParticipantInbox,
    }).catch((err: unknown) => {
      console.error("[app-access] notify failed (swallowed):", err);
    });
  }

  /** An app row with its repo attached from the forge's record (P3.3), with `client`'s rights. */
  async function withForgeRepo<T extends { id: string }>(client: any, app: T) {
    const repo = (await readForgeRepos(client, [app.id])).get(app.id);
    return { ...app, git_remote_url: repo?.remoteUrl ?? null, git_auth_kind: repo?.authKind ?? null };
  }

  /** An app's team (app_links), with `client`'s rights. */
  async function appTeamId(client: any, appId: string): Promise<string | null> {
    const { data, error } = await client.from("app_links").select("team_id").eq("app_id", appId).maybeSingle();
    if (error) throw error;
    return data?.team_id ?? null;
  }

  /** Whether an app carries an org grant (TeamClu's `visibility: team`), with `client`'s rights. */
  async function appTeamVisible(client: any, appId: string): Promise<boolean> {
    const { data, error } = await client
      .from("app_grants")
      .select("app_id")
      .eq("app_id", appId)
      .not("principal_org_id", "is", null)
      .limit(1);
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  /** The app row the agent path authorises against, and its team, read past RLS. */
  async function readAppForAgentGitCredential(appId: string) {
    const admin = await serviceRoleClient("read app for agent git credential");
    const { data, error } = await admin
      .from("apps")
      .select("id")
      .eq("id", appId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const teamId = await appTeamId(admin, appId);
    return teamId ? { app: await withForgeRepo(admin, data), teamId } : null;
  }

  /**
   * The caller's `agent` actor in `teamId`, or null when the caller is not an
   * agent there. `actors_team_user_idx` allows one actor per (team, user), so
   * this is the daemon's own actor and never a human's.
   */
  async function resolveCurrentAgentActor(teamId: string): Promise<string | null> {
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
    const { data, error } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", teamId)
      .eq("user_id", userId)
      .eq("actor_type", "agent")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const id = data?.id;
    return typeof id === "string" && id.trim() ? id : null;
  }

  return {
    async listAppSessions(appId: string) {
      // RLS on sessions governs visibility; a caller who cannot see the app's
      // sessions gets an empty list.
      const { data, error } = await supabase
        .from("sessions")
        .select("id, team_id, title, mode, last_message_at, created_at, updated_at")
        .eq("app_id", appId);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        teamId: r.team_id,
        title: r.title ?? "",
        mode: r.mode ?? "collab",
        lastMessageAt: appIso(r.last_message_at),
        createdAt: appIso(r.created_at)!,
        updatedAt: appIso(r.updated_at)!,
      }));
    },

    async getAppMembership(appId: string) {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Bypass apps RLS: membership is team-scoped, not visibility-scoped. A
      // logged-in user checking access to a deployed app may not pass
      // apps_select_if_visible yet still need a truthful member/non-member answer.
      const admin = await serviceRoleClient("read app team for membership check");
      const teamId = await appTeamId(admin, appId);
      if (!teamId) return null;
      const resolved = await this.resolveCurrentMemberActor(teamId, userId);
      return { member: Boolean(resolved?.id) };
    },

    /**
     * `public.orgs.id` for a team (`amux.teams.oid`). Null when the team has
     * no org — data_app finalize then fails with a clear error rather than
     * inventing a shared database.
     */
    async resolveTeamOrgId(teamId: string): Promise<string | null> {
      const { data, error } = await supabase
        .from("teams")
        .select("oid")
        .eq("id", teamId)
        .maybeSingle();
      if (error) throw error;
      const oid = data?.oid;
      return typeof oid === "string" && oid.trim() ? oid.trim() : null;
    },

    /**
     * Creator or `admin` grant on this app — required to list/set/remove access.
     * Returns null when the app is not visible or the caller lacks manage rights
     * (routes surface 404 to avoid leaking app existence).
     */
    async resolveAppAccessManager(appId: string): Promise<{
      callerActorId: string | null;
      teamId: string;
    } | null> {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;
      const teamId = await appTeamId(supabase, appId);
      if (!teamId) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission || permission.level !== "admin") return null;
      this.assertNotInheritedFor(permission, "manage_access");
      // The grantor the legacy grant row records: the caller's actor in the
      // app's team (an admin by grant or the creator always has one).
      return {
        callerActorId: (await callerActorIn(this, teamId))?.id ?? null,
        teamId,
      };
    },

    async listAppAccess(appId: string) {
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      // RLS only exposes all rows to the creator; admin grantees see self only.
      // After the manage gate, read the whole picture with service role — from
      // the platform model, by actor in the app's team (team-app-access.ts).
      const admin = await serviceRoleClient("list app member access");
      const access = await readTeamAppAccess(admin, appId);
      if (!access) return [];

      // The agents that reach the app through their owner. Listed after the
      // grants, read-only: the way to take one away is to take its owner's
      // access away.
      const granted = new Set(access.grants.map((g) => g.actorId));
      const inherited = access.inherited.filter((r) => !granted.has(r.agentId));

      // Who each grantee is: the access tab shows agents apart from people and
      // shows the NAME from here — the caller's own directory hides agents it
      // may not talk to, which left those rows as bare ids. Every grantee here
      // has an account (a grant is to an account), so every one is connected.
      const describe = (actorId: string) => {
        const actor = access.actors.get(actorId);
        return {
          actorType: actor?.actor_type ?? null,
          connected: actor ? actor.actor_type !== "agent" || !!actor.user_id : null,
          displayName: actor?.display_name ?? null,
        };
      };
      return [
        ...access.grants.map((g) => ({
          memberId: g.actorId,
          permissionLevel: g.level,
          grantedByMemberId: g.grantedByActorId,
          createdAt: appIso(g.createdAt)!,
          ...describe(g.actorId),
          inherited: false,
          inheritedFrom: null,
        })),
        ...inherited.map((r) => ({
          memberId: r.agentId,
          permissionLevel: r.level,
          grantedByMemberId: null,
          createdAt: null,
          ...describe(r.agentId),
          inherited: true,
          inheritedFrom: { actorId: r.ownerActorId, displayName: access.actors.get(r.ownerActorId)?.display_name ?? null },
        })),
      ];
    },

    async setAppAccess(appId: string, memberId: string, permissionLevel: string) {
      const level = parseAppPermissionLevel(permissionLevel);
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      // RLS manage policy is creator-only; admin grantees write via service role.
      const admin = await serviceRoleClient("manage app member access");
      // The grantee is any actor in the app's team — a member or an agent. The
      // database trigger enforces the team boundary; checking here first turns
      // its 23514 into a sentence the access tab can show, and catches an agent
      // that has no account yet (a device agent before its daemon claimed it),
      // which could hold the row but never act on it.
      const { data: grantee, error: granteeErr } = await admin
        .from("actors")
        .select("id, team_id, actor_type, user_id")
        .eq("id", memberId)
        .maybeSingle();
      if (granteeErr) throw granteeErr;
      if (!grantee || grantee.team_id !== manager.teamId
          || (grantee.actor_type !== "member" && grantee.actor_type !== "agent")) {
        throw new ApiError(422, "grantee_not_in_team", "the grantee must be a member or agent of the app's team");
      }
      if (grantee.actor_type === "agent" && !grantee.user_id) {
        throw new ApiError(422, "agent_not_connected", "this agent has no account yet; connect its daemon first");
      }
      // The level before this write, from the platform's grant (by account).
      const priorLevel = storedAppPermissionLevel(await readUserGrantLevel(admin, appId, grantee.user_id));
      const now = new Date().toISOString();
      const { data, error } = await admin
        .from("app_member_access")
        .upsert(
          {
            app_id: appId,
            member_id: memberId,
            permission_level: level,
            granted_by_member_id: manager.callerActorId,
            updated_at: now,
          },
          { onConflict: "app_id,member_id" },
        )
        .select("member_id, permission_level, granted_by_member_id, created_at")
        .single();
      if (error) throw error;
      // …and the platform's own grant, by account (P3.2). P2.1's trigger has
      // usually projected the legacy row already; this settles it either way,
      // and is the only write once P3.4 drops app_member_access.
      await setUserGrant(admin, { appId, userId: grantee.user_id, level, grantedByUserId: await currentUserId() });
      if (level === "read" && priorLevel && appLevelAtLeast(priorLevel, "write")) {
        await forge.memberWriteRevoked(appId, memberId);
      }
      await forge.appAccessChanged(appId);
      scheduleAppAccessChanged(manager.teamId, appId, grantee);
      return mapAppAccessRow(data);
    },

    async removeAppAccess(appId: string, memberId: string) {
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      const admin = await serviceRoleClient("manage app member access");
      // Who to tell, read before the row goes. A failed lookup only costs the
      // hint; the revoke itself must not depend on it.
      const { data: grantee, error: granteeErr } = await admin
        .from("actors")
        .select("actor_type, user_id")
        .eq("id", memberId)
        .maybeSingle();
      if (granteeErr) console.warn(`[app-access] grantee lookup for ${memberId} failed: ${granteeErr.message}`);
      const { error } = await admin
        .from("app_member_access")
        .delete()
        .eq("app_id", appId)
        .eq("member_id", memberId);
      if (error) throw error;
      // The platform's grant goes with it (P3.2; see setAppAccess). Without the
      // account there is no grant to remove — none was ever projected.
      if (grantee?.user_id) await removeUserGrant(admin, appId, grantee.user_id);
      await forge.memberWriteRevoked(appId, memberId);
      await forge.appAccessChanged(appId);
      scheduleAppAccessChanged(manager.teamId, appId, granteeErr ? null : grantee);
      return true;
    },

    /**
     * Who, if anyone, the caller is for this app's git credentials — and the
     * app row to act on. One rule, shared by mint and revoke, so the two can
     * never drift apart.
     */
    async resolveAppGitCredentialActor(
      appId: string,
    ): Promise<{ actorId: string; app: Record<string, any>; readOnly: boolean } | null> {
      const { data: found, error: selErr } = await supabase
        .from("apps")
        .select("id")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      const visible = found ? await withForgeRepo(supabase, found) : null;
      // Team and visibility as TeamClu reads them: the app's link, and whether
      // it carries an org grant (`visibility: team`), both with the caller's token.
      const fields = visible
        ? { teamId: await appTeamId(supabase, appId), visibility: (await appTeamVisible(supabase, appId)) ? "team" : "personal" }
        : null;

      if (visible && fields?.teamId) {
        const permission = await this.resolveAppCallerPermissionForApp(visible);
        // The platform answers the level; who the credential is for is the
        // caller's actor in the app's team (TeamClu's identity for Gitea).
        const actor = permission ? await callerActorIn(this, fields.teamId!) : null;
        // A member the app knows about is answered on the member rules alone,
        // never by falling through to the agent path below. `read` may download
        // the code but not push to it, so its key cannot push.
        //
        // An agent's `read` grant does not narrow its key. The agent path below
        // still gives every agent of the team a writable one (phase 1 leaves it
        // alone — the daemon's own seed/clone/deploy run on it), so narrowing
        // here would hand a granted agent less than an ungranted one.
        // A caller with a level but no actor in the app's team (an agent
        // reaching its owner's app in another team) has no one to issue the
        // credential to here; it falls through to the paths below.
        if (permission && actor?.id) {
          return {
            actorId: actor.id,
            app: visible,
            readOnly: permission.level === "read" && actor.actorType !== "agent",
          };
        }
        // A teammate with no grant on a team-visible app. The app list shows it
        // to them with a download button, and refusing the repo made that
        // button a dead end — while their own daemon, on the agent path below,
        // could already push to it. Same terms as `read`.
        if (fields.visibility === "team") {
          const { data: userData, error: userErr } = await getCurrentUser();
          if (userErr) throw userErr;
          const userId = userData?.user?.id;
          const member = userId
            ? await this.resolveCurrentMemberActor(fields.teamId!, userId)
            : null;
          if (member?.id) return { actorId: member.id, app: visible, readOnly: true };
        }
      }

      // Agent-actor path. The daemon holds its own cloud account, so it never
      // resolves to a member actor and the member rules above always decline
      // it — yet the daemon is the only thing on the machine that can hand
      // `git push` a credential (the agent's own push has none, and the key is
      // deliberately not persisted anywhere). Authorisation is therefore
      // team-scoped: any agent actor in the app's team may mint a key for a
      // Gitea-managed app in that team.
      //
      // Coarser than the per-app member rules on purpose, and accepted when
      // this path was chosen. An agent can hold a per-app grant now, and that
      // grant is what Gitea enforces on its own HTTPS pushes; this deploy-key
      // path keeps the team-wide rule until the daemon's git moves to HTTPS and
      // the keys are retired (phase-1 plan, "旧 deploy key 路径"). The blast
      // radius is one repo per key, and the key's title names the agent actor.
      //
      // The row is re-read with the service role because `apps.visibility`
      // defaults to `personal`, which `apps_select_if_visible` hides from every
      // actor but the creator — including the daemon of the very machine the
      // app is checked out on.
      const target = visible && fields?.teamId
        ? { app: visible, teamId: fields.teamId as string }
        : await readAppForAgentGitCredential(appId);
      if (!target) return null;
      const agentActorId = await resolveCurrentAgentActor(target.teamId);
      if (!agentActorId) return null;
      return { actorId: agentActorId, app: target.app, readOnly: false };
    },

    // The credential's fields are the forge's (a key pair, or a token).
    async getAppGitCredential(appId: string): Promise<Record<string, any> | null> {
      const resolved = await this.resolveAppGitCredentialActor(appId);
      if (!resolved) return null;
      return forge.issueCredential(resolved.app as { id: string }, resolved.actorId, {
        readOnly: resolved.readOnly,
      });
    },

    /**
     * Hand a JIT key back the moment its holder is done with it
     * (`amuxd git-ssh` calls this as soon as ssh exits).
     *
     * Authorised exactly like minting, and the key must carry the caller's own
     * actor in its title — otherwise revoking would be a way to kill a push
     * another machine is in the middle of.
     */
    async revokeAppGitCredential(appId: string, credentialId: number) {
      const resolved = await this.resolveAppGitCredentialActor(appId);
      if (!resolved) return null;
      const { actorId } = resolved;
      const revoked = await forge.revokeCredential(resolved.app as { id: string }, actorId, credentialId);
      // `revoked: false` is not an error the caller can act on — the key is
      // unusable either way, which is the whole point of asking.
      return { revoked };
    },
  };
}
