import {
  GITEA_AUTH_KIND,
  giteaOrgName,
  giteaTeamName,
  giteaUserName,
  isTeamCluOrgOwner,
  repoOwnerFromRemote,
  type GiteaClient,
  type GiteaCollaboratorPermission,
} from "./gitea.js";
import { appLevelAtLeast, storedAppPermissionLevel, type AppPermissionLevel } from "../app-permission.js";

/**
 * Projects an app's TeamClu access onto its Gitea repo
 * (docs/specs/2026-11-16-app-platform-identity-design.md §7).
 *
 * There is no mapping table: every Gitea name is computed from a TeamClu id
 * (`giteaUserName` & co), so a sync is "read what TeamClu says, make Gitea say
 * the same". It is idempotent and safe to run any number of times — the
 * request paths call it after every change, and the reconcile timer calls it
 * for every app to repair whatever a failed call left behind.
 *
 * Only repos under a TeamClu org (`o<uuid>`) are managed. Apps created before
 * per-org repos still live under `GITEA_OWNER`, are reached with deploy keys,
 * and are left untouched until the one-shot migration moves them.
 */

/** The service-role client, typed loosely like the rest of the repository code. */
type AdminClient = any;

export interface GiteaSyncDeps {
  /** Bound to the default owner; the sync rebinds it to the app's org. */
  gitea: GiteaClient;
  admin: AdminClient;
  log?: (message: string) => void;
  /** Set by the passes that sync many apps in a row; see `GiteaSyncPass`. */
  pass?: GiteaSyncPass;
}

/**
 * What one pass over many apps has already made true in Gitea.
 *
 * A team's apps share their org, their people and their Gitea team, so without
 * this a team of 40 with 30 apps asks Gitea about the same 40 accounts 30
 * times — sequentially, on the request that added one teammate.
 */
export interface GiteaSyncPass {
  orgs: Set<string>;
  users: Set<string>;
  /** Gitea team id → member count, once its membership has been synced. */
  teams: Map<number, number>;
}

export function newGiteaSyncPass(): GiteaSyncPass {
  return { orgs: new Set(), users: new Set(), teams: new Map() };
}

export type GiteaSyncResult =
  | { status: "synced"; owner: string; collaborators: number; teamMembers: number | null }
  | { status: "skipped"; reason: "not_found" | "not_gitea" | "legacy_owner" };

interface ActorRow {
  id: string;
  team_id: string;
  actor_type: string;
  user_id: string | null;
  display_name: string | null;
}

const APP_SYNC_COLUMNS = "id, team_id, org_id, visibility, created_by_actor_id, git_remote_url, git_auth_kind";

/** What an actor is called in Gitea. An agent says so, so a push is never mistaken for a person's. */
function giteaFullName(actor: ActorRow): string {
  const name = (actor.display_name ?? "").trim() || actor.id;
  return actor.actor_type === "agent" ? `${name} · agent` : name;
}

function higher(a: AppPermissionLevel | undefined, b: AppPermissionLevel): AppPermissionLevel {
  return a && appLevelAtLeast(a, b) ? a : b;
}

/** Actors that can hold a Gitea identity: people and agents with an account. */
function hasGiteaIdentity(actor: ActorRow | undefined): actor is ActorRow & { user_id: string } {
  return !!actor && !!actor.user_id && (actor.actor_type === "member" || actor.actor_type === "agent");
}

async function readActors(admin: AdminClient, ids: string[]): Promise<Map<string, ActorRow>> {
  const out = new Map<string, ActorRow>();
  if (ids.length === 0) return out;
  const { data, error } = await admin
    .from("actors")
    .select("id, team_id, actor_type, user_id, display_name")
    .in("id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as ActorRow[]) out.set(row.id, row);
  return out;
}

async function readTeamActors(admin: AdminClient, teamId: string): Promise<ActorRow[]> {
  const { data, error } = await admin
    .from("actors")
    .select("id, team_id, actor_type, user_id, display_name")
    .eq("team_id", teamId);
  if (error) throw error;
  return ((data ?? []) as ActorRow[]).filter(hasGiteaIdentity);
}

/** Bring one app's repo in line with TeamClu. */
export async function syncAppToGitea(deps: GiteaSyncDeps, appId: string): Promise<GiteaSyncResult> {
  const { admin } = deps;
  const { data: app, error } = await admin.from("apps").select(APP_SYNC_COLUMNS).eq("id", appId).maybeSingle();
  if (error) throw error;
  if (!app) return { status: "skipped", reason: "not_found" };
  if (app.git_auth_kind !== GITEA_AUTH_KIND) return { status: "skipped", reason: "not_gitea" };
  const owner = repoOwnerFromRemote(app.git_remote_url);
  if (!owner || !isTeamCluOrgOwner(owner)) return { status: "skipped", reason: "legacy_owner" };

  const gitea = deps.gitea.withOwner(owner);
  const pass = deps.pass;
  if (!pass?.orgs.has(owner)) {
    await gitea.ensureOrg(owner);
    pass?.orgs.add(owner);
  }
  const ensureUser = async (username: string, actor: ActorRow) => {
    if (pass?.users.has(username)) return;
    await gitea.ensureUser(username, giteaFullName(actor));
    pass?.users.add(username);
  };

  // ── Collaborators: the creator (admin) and every grant ─────────────────
  const { data: grants, error: grantErr } = await admin
    .from("app_member_access")
    .select("member_id, permission_level")
    .eq("app_id", appId);
  if (grantErr) throw grantErr;
  const actorIds = [
    ...new Set([app.created_by_actor_id, ...((grants ?? []) as any[]).map((g) => g.member_id)].filter(Boolean)),
  ] as string[];
  const actors = await readActors(admin, actorIds);

  const desired = new Map<string, { level: GiteaCollaboratorPermission; actor: ActorRow }>();
  const want = (actorId: string, level: AppPermissionLevel) => {
    const actor = actors.get(actorId);
    // A grant to an agent that never got an account names nobody Gitea can
    // know; it starts working the moment the daemon claims one.
    if (!hasGiteaIdentity(actor) || actor.team_id !== app.team_id) return;
    const username = giteaUserName(actor.user_id);
    desired.set(username, { level: higher(desired.get(username)?.level, level), actor });
  };
  if (app.created_by_actor_id) want(app.created_by_actor_id, "admin");
  for (const g of (grants ?? []) as any[]) {
    const level = storedAppPermissionLevel(g.permission_level);
    if (level) want(g.member_id, level);
  }

  for (const [username, { actor }] of desired) await ensureUser(username, actor);
  const current = new Map<string, GiteaCollaboratorPermission>(
    (await gitea.listCollaborators(appId)).map((c) => [c.username, c.permission] as const),
  );
  for (const [username, { level }] of desired) {
    if (current.get(username) !== level) await gitea.setCollaborator(appId, username, level);
  }
  for (const username of current.keys()) {
    if (!desired.has(username)) await gitea.removeCollaborator(appId, username);
  }

  // ── Team visibility: teammates read through the team ──────────────────
  const teamName = giteaTeamName(app.team_id);
  let teamMembers: number | null = null;
  if (app.visibility === "team") {
    const teamId = await gitea.ensureReadTeam(owner, teamName);
    const done = pass?.teams.get(teamId);
    teamMembers = done ?? (await syncGiteaTeamMembers(deps, gitea, teamId, app.team_id, ensureUser));
    pass?.teams.set(teamId, teamMembers);
    await gitea.setTeamRepo(teamId, appId, true);
  } else {
    const teamId = await gitea.findTeamId(owner, teamName);
    if (teamId !== null) await gitea.setTeamRepo(teamId, appId, false);
  }

  return { status: "synced", owner, collaborators: desired.size, teamMembers };
}

/** Make a Gitea team's members exactly the TeamClu team's people and connected agents. */
async function syncGiteaTeamMembers(
  deps: GiteaSyncDeps,
  gitea: GiteaClient,
  giteaTeamId: number,
  teamId: string,
  ensureUser: (username: string, actor: ActorRow) => Promise<void>,
): Promise<number> {
  const members = await readTeamActors(deps.admin, teamId);
  const desired = new Map(members.map((a) => [giteaUserName(a.user_id!), a]));
  for (const [username, actor] of desired) await ensureUser(username, actor);
  const current = new Set(await gitea.listTeamMembers(giteaTeamId));
  for (const username of desired.keys()) if (!current.has(username)) await gitea.addTeamMember(giteaTeamId, username);
  for (const username of current) if (!desired.has(username)) await gitea.removeTeamMember(giteaTeamId, username);
  return desired.size;
}

/**
 * Re-sync every managed app of a team: after someone joins or leaves it, both
 * the team's read access and any grants that cascaded away must catch up.
 */
export async function syncTeamAppsToGitea(deps: GiteaSyncDeps, teamId: string): Promise<void> {
  const { data, error } = await deps.admin
    .from("apps")
    .select("id")
    .eq("team_id", teamId)
    .eq("git_auth_kind", GITEA_AUTH_KIND);
  if (error) throw error;
  const pass = { ...deps, pass: deps.pass ?? newGiteaSyncPass() };
  for (const row of (data ?? []) as { id: string }[]) {
    try {
      await syncAppToGitea(pass, row.id);
    } catch (e) {
      deps.log?.(`[gitea-sync] team ${teamId} app ${row.id} failed: ${String((e as Error)?.message ?? e)}`);
    }
  }
}

/**
 * The repair pass: sync every app whose repo is under a TeamClu org. One
 * failing app never stops the rest.
 */
export async function reconcileGiteaApps(
  deps: GiteaSyncDeps,
  opts: { deadline?: number } = {},
): Promise<{ synced: number; failed: number; skipped: number; truncated: boolean }> {
  const { data, error } = await deps.admin
    .from("apps")
    .select("id, git_remote_url")
    .eq("git_auth_kind", GITEA_AUTH_KIND);
  if (error) throw error;
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  // Oldest-synced-first would be fairer, but nothing records when an app was
  // last synced; a deadline that cuts the pass short just resumes next time
  // from a shuffled order, so no app is starved for long.
  const rows = [...((data ?? []) as { id: string; git_remote_url: string | null }[])].sort(() => Math.random() - 0.5);
  const pass = { ...deps, pass: deps.pass ?? newGiteaSyncPass() };
  for (const row of rows) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      return { synced, failed, skipped, truncated: true };
    }
    if (!isTeamCluOrgOwner(repoOwnerFromRemote(row.git_remote_url))) {
      skipped += 1;
      continue;
    }
    try {
      const result = await syncAppToGitea(pass, row.id);
      if (result.status === "synced") synced += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      deps.log?.(`[gitea-sync] reconcile app ${row.id} failed: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return { synced, failed, skipped, truncated: false };
}

/** The org a new app's repo goes under when per-org repos are on. */
export function giteaOwnerForNewApp(orgId: string): string {
  return giteaOrgName(orgId);
}
