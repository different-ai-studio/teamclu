/**
 * pg-repo-apps — UUID-seed pglite tests asserting the APPS domain.
 *
 * Follows the same pattern as pg-repo-sessions.test.ts:
 * - makeTestDb() → fresh in-process pglite with migrations applied.
 * - Seed helpers insert teams + actors.
 * - Each test constructs its own repo instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import type { GiteaClient } from "../src/lib/provisioning/gitea.js";
import type { GotrueOAuthClient } from "../src/lib/provisioning/gotrue-oauth.js";
import { teams, actors, members, teamMembers, apps, appSecrets } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";

function fakeGitea(over: Partial<GiteaClient> = {}): GiteaClient {
  return {
    createAppRepo: async (appId: string) => ({
      cloneUrl: `https://gitea.example/teamclaw-apps/tc-app-${appId}.git`,
      sshUrl: `git@gitea.example:teamclaw-apps/tc-app-${appId}.git`,
    }),
    createDeployKey: async () => ({ id: 1 }),
    listDeployKeys: async () => [],
    deleteDeployKey: async () => {},
    archiveAndRenameAppRepo: async (appId: string) => ({
      sshUrl: `git@gitea.example:teamclaw-apps/deleted-tc-app-${appId}.git`,
    }),
    getRepoHead: async () => ({ sha: "abc123" }),
    ...over,
  };
}

function appsRepo(opts: { db: any; userId: string; callerActorId?: string; gitea?: GiteaClient; giteaUnavailableReason?: string; [key: string]: any }) {
  const { db, userId, gitea, ...rest } = opts;
  return createPgBusinessRepository({
    db,
    userId,
    gitea: gitea ?? fakeGitea(),
    ...rest,
  });
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

async function seedActor(db: any, teamId: string, opts: { kind?: string; userId?: string } = {}) {
  const [actor] = await db
    .insert(actors)
    .values({
      teamId,
      actorType: opts.kind ?? "member",
      displayName: "Test Actor",
      userId: opts.userId ?? `user-${Math.random()}`,
    })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

// ── createApp + getApp ────────────────────────────────────────────────────────

test("createApp inserts a workspace + app and returns canonical fields", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });

  const app = await repo.createApp({
    teamId: team.id, name: "My App", type: "fullstack_tanstack_postgres", visibility: "personal",
  });

  assert.deepEqual(Object.keys(app).sort(), [
    "authMode", "createdAt", "fcStatus", "fcEndpoint", "fcFunctionName", "fcRegion",
    "gitAuthKind", "gitCommitSha", "gitRemoteUrl", "id", "name", "oauthClientId",
    "provisionStatus", "publicUrl",
    "runtime", "slug", "teamId", "type", "updatedAt", "visibility", "workspaceId",
  ].sort());
  assert.equal(app.teamId, team.id);
  assert.equal(app.provisionStatus, "repo_created");
  assert.equal(app.runtime, "node", "runtime defaults to node");
  assert.equal(app.authMode, "none", "authMode defaults to none");
  assert.equal(app.gitCommitSha, null);
  assert.equal(app.oauthClientId, null);
  assert.ok(app.workspaceId, "app must be linked to a workspace");

  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.id, app.id);
});

test("createApp keeps the repo URL an imported app was created from", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });

  // The daemon reads this back to know whether to clone or write the starter
  // template, so it has to survive the round trip, not just the insert.
  const imported = await repo.createApp({
    teamId: team.id, name: "Imported", type: "static_web",
    gitRemoteUrl: "https://github.com/owner/repo.git",
  });
  assert.equal(imported.gitRemoteUrl, "https://github.com/owner/repo.git");
  assert.equal((await repo.getApp(imported.id)).gitRemoteUrl, "https://github.com/owner/repo.git");
  const listed = (await repo.listApps({ teamId: team.id })).find((a) => a.id === imported.id);
  assert.equal(listed.gitRemoteUrl, "https://github.com/owner/repo.git");

  const seeded = await repo.createApp({ teamId: team.id, name: "Seeded", type: "static_web" });
  assert.match(seeded.gitRemoteUrl ?? "", /tc-app-/);
  assert.equal(seeded.provisionStatus, "repo_created");
  assert.equal(imported.provisionStatus, "pending");
});

// ── listApps / updateApp / listAppSessions ────────────────────────────────────

test("listApps hides another member's personal app but shows team apps", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);

  const ownerRepo = appsRepo({ db, userId: owner.userId });
  const otherRepo = appsRepo({ db, userId: other.userId });

  await ownerRepo.createApp({ teamId: team.id, name: "Private", type: "fullstack_tanstack_postgres", visibility: "personal" });
  await ownerRepo.createApp({ teamId: team.id, name: "Shared", type: "fullstack_tanstack_postgres", visibility: "team" });

  const ownerList = await ownerRepo.listApps({ teamId: team.id });
  const otherList = await otherRepo.listApps({ teamId: team.id });

  assert.equal(ownerList.length, 2, "owner sees both");
  assert.deepEqual(otherList.map((a) => a.name).sort(), ["Shared"], "other sees only the team app");
});

test("updateApp renames and changes visibility", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });

  const app = await repo.createApp({ teamId: team.id, name: "Before", type: "fullstack_tanstack_postgres", visibility: "personal" });
  const updated = await repo.updateApp(app.id, { name: "After", visibility: "team" });

  assert.equal(updated.name, "After");
  assert.equal(updated.visibility, "team");
});

test("listAppSessions returns only sessions linked to the app", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "WithSessions", type: "fullstack_tanstack_postgres", visibility: "team" });

  // create a session linked to the app + one unlinked, then assert filtering
  const linked = await repo.createSession({ teamId: team.id, title: "Linked", mode: "collab", participantActorIds: [actor.id] });
  // link it to the app via a direct update (the session→app link is set elsewhere; here we verify the query filters by app_id)
  const { apps, sessions } = await import("../src/db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  await db.update(sessions).set({ appId: app.id }).where(eq(sessions.id, linked.id));
  await repo.createSession({ teamId: team.id, title: "Unlinked", mode: "collab", participantActorIds: [actor.id] });

  const rows = await repo.listAppSessions(app.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Linked");
});

// ── Gitea repo provisioning ───────────────────────────────────────────────────

test("createApp provisions a private Gitea repo and returns repo_created", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  let seenAppId: string | undefined;
  const repo = appsRepo({
    db,
    userId: actor.userId,
    gitea: fakeGitea({
      createAppRepo: async (appId) => {
        seenAppId = appId;
        return {
          cloneUrl: `https://gitea.example/teamclaw-apps/tc-app-${appId}.git`,
          sshUrl: `git@gitea.example:teamclaw-apps/tc-app-${appId}.git`,
        };
      },
    }),
  });

  const app = await repo.createApp({ teamId: team.id, name: "Z", type: "static_web" });
  assert.equal(app.provisionStatus, "repo_created");
  // The SSH URL, not clone_url: the deploy key is the only credential we issue
  // for this repo and it cannot authenticate an HTTPS push.
  assert.equal(app.gitRemoteUrl, `git@gitea.example:teamclaw-apps/tc-app-${app.id}.git`);
  assert.equal(app.gitAuthKind, "gitea_deploy_key");
  assert.equal(seenAppId, app.id);

  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.provisionStatus, "repo_created");

  const [row] = await db.select().from(apps).where(eq(apps.id, app.id));
  assert.equal(row.gitAuthKind, "gitea_deploy_key");
});

test("createApp without Gitea configured throws gitea_unavailable before insert", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({
    db,
    userId: actor.userId,
    giteaUnavailableReason: "GITEA_URL is empty",
  });
  await assert.rejects(
    () => repo.createApp({ teamId: team.id, name: "NoGitea", type: "static_web" }),
    (err: any) => err?.code === "gitea_unavailable" && err?.statusCode === 503,
  );
  const rows = await db.select().from(apps);
  assert.equal(rows.length, 0, "no orphan app row when Gitea is unavailable");
});

test("createApp marks the row error when Gitea provisioning fails", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({
    db,
    userId: actor.userId,
    gitea: fakeGitea({
      createAppRepo: async () => {
        throw new Error("gitea down");
      },
    }),
  });
  await assert.rejects(
    () => repo.createApp({ teamId: team.id, name: "Fail", type: "static_web" }),
    (err: any) => err?.code === "gitea_provision_failed" && err?.statusCode === 502,
  );
  const [row] = await db.select().from(apps);
  assert.equal(row.provisionStatus, "error");
  assert.match(row.provisionError, /gitea down/);
});

// ── authz hardening ───────────────────────────────────────────────────────────

test("updateApp by a non-creator returns null and does not mutate", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);
  const ownerRepo = appsRepo({ db, userId: owner.userId });
  const otherRepo = appsRepo({ db, userId: other.userId });
  const app = await ownerRepo.createApp({ teamId: team.id, name: "Owned", type: "fullstack_tanstack_postgres", visibility: "personal" });

  const res = await otherRepo.updateApp(app.id, { name: "Hacked" });
  assert.equal(res, null);
  const still = await ownerRepo.getApp(app.id);
  assert.equal(still.name, "Owned");
});

test("listAppSessions for a personal app returns [] to a non-creator", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);
  const ownerRepo = appsRepo({ db, userId: owner.userId });
  const otherRepo = appsRepo({ db, userId: other.userId });
  const app = await ownerRepo.createApp({ teamId: team.id, name: "Secret", type: "fullstack_tanstack_postgres", visibility: "personal" });

  const rows = await otherRepo.listAppSessions(app.id);
  assert.deepEqual(rows, []);
});

test("createSession with appId links the session, listAppSessions finds it", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "Linked", type: "fullstack_tanstack_postgres", visibility: "team" });

  await repo.createSession({ teamId: team.id, title: "S1", mode: "collab", appId: app.id, participantActorIds: [actor.id] });

  const rows = await repo.listAppSessions(app.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "S1");
});

test("updateApp advances provisionStatus through legal transitions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "P", type: "data_app" });
  assert.equal(app.provisionStatus, "repo_created");

  const seeding = await repo.updateApp(app.id, { provisionStatus: "seeding" });
  assert.equal(seeding.provisionStatus, "seeding");
  const ready = await repo.updateApp(app.id, { provisionStatus: "ready" });
  assert.equal(ready.provisionStatus, "ready");
});

test("updateApp rejects an illegal provisionStatus jump", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "P2", type: "data_app" });
  assert.equal(app.provisionStatus, "repo_created");
  // Clients may never put a row back into a provisioning state.
  await assert.rejects(() => repo.updateApp(app.id, { provisionStatus: "repo_created" }), (err: any) => err?.code === "invalid_status_transition" && err?.statusCode === 400);
});

test("updateApp ignores illegal provisionStatus but still applies name", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId }); // pending app
  const app = await repo.createApp({ teamId: team.id, name: "Old", type: "data_app" });
  const updated = await repo.updateApp(app.id, { name: "New", provisionStatus: "repo_created" });
  assert.equal(updated.name, "New");
  assert.equal(updated.provisionStatus, "repo_created"); // status unchanged
});

const SHA = "abc1234";

async function readyApp(repo: any, db: any, team: any, name = "Demo") {
  const app = await repo.createApp({ teamId: team.id, name, type: "fullstack_tanstack_postgres" });
  await db.update(apps).set({ provisionStatus: "ready" }).where(eq(apps.id, app.id));
  return app;
}

function deployDeps(over: Record<string, any> = {}) {
  return {
    startDeploy: async () => ({
      fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou",
      ossObjectName: "apps/x/code.zip", presignedPut: "https://oss/put?sig=x",
    }),
    finalizeDeploy: async ({ fcFunctionName, ossObjectName }: any) => {
      assert.equal(fcFunctionName, "tc-app-x");
      assert.match(ossObjectName, /code\.zip$/);
      return { fcEndpoint: "https://x.fcapp.run" };
    },
    ...over,
  };
}

test("deployApp moves a ready app to awaiting_build and records fc identity", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({
    db, userId: "u1", callerActorId: actor.id,
    ...deployDeps({
      startDeploy: async () => ({
        fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou",
        ossObjectName: "apps/x/code.zip", presignedPut: "https://oss/put?sig=x",
      }),
    }),
  });
  const app = await readyApp(repo, db, team);
  const out = await repo.deployApp(app.id, { gitCommitSha: SHA });
  assert.equal(out.fcStatus, "awaiting_build");
  assert.equal(out.fcFunctionName, "tc-app-x");
  assert.equal(out.ossObjectName, "apps/x/code.zip");
  assert.equal(out.presignedPut, "https://oss/put?sig=x");
  assert.equal(out.gitCommitSha, SHA);
  assert.match(out.deployToken, /^[0-9a-f-]{36}$/i);
});

test("finalizeDeploy moves a deploying app to live and records fcEndpoint", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  const started = await repo.deployApp(app.id, { gitCommitSha: SHA });
  const out = await repo.finalizeDeploy(app.id, { gitCommitSha: SHA, deployToken: started.deployToken });
  assert.equal(out.fcStatus, "live");
  assert.equal(out.fcEndpoint, "https://x.fcapp.run");
});

test("deployApp rejects an app that is not yet ready", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u2" });
  const repo = appsRepo({ db, userId: "u2", callerActorId: actor.id,
    startDeploy: async () => ({ fcFunctionName: "x", fcRegion: "r", ossObjectName: "k", presignedPut: "p" }) });
  const app = await repo.createApp({ teamId: team.id, name: "NotReady", type: "fullstack_tanstack_postgres" });
  await assert.rejects(() => repo.deployApp(app.id, { gitCommitSha: SHA }), /app_not_ready|ready/i);
});

test("finalizeDeploy hands the provisioner the app's slug (it provisions the schema)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  let seen: any = null;
  const repo = appsRepo({
    db, userId: "u1", callerActorId: actor.id,
    startDeploy: async () => ({
      fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou",
      ossObjectName: "apps/x/code.zip", presignedPut: "https://oss/put?sig=x",
    }),
    finalizeDeploy: async (a: any) => { seen = a; return { fcEndpoint: "https://x.fcapp.run" }; },
  });
  const app = await readyApp(repo, db, team, "Demo App");
  const started = await repo.deployApp(app.id, { gitCommitSha: SHA });
  await repo.finalizeDeploy(app.id, { gitCommitSha: SHA, deployToken: started.deployToken });
  assert.equal(seen.slug, "demo-app");
  assert.equal(seen.appId, app.id);
  assert.equal(seen.orgId, team.oid ?? null);
});

test("second deploy while awaiting_build returns 409", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  await repo.deployApp(app.id, { gitCommitSha: SHA });
  await assert.rejects(
    () => repo.deployApp(app.id, { gitCommitSha: SHA }),
    (err: any) => err?.code === "deploy_in_progress" && err?.statusCode === 409,
  );
});

test("finalize without matching deployToken returns 409", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  await repo.deployApp(app.id, { gitCommitSha: SHA });
  await assert.rejects(
    () => repo.finalizeDeploy(app.id, { gitCommitSha: SHA, deployToken: "wrong-token" }),
    (err: any) => err?.code === "deploy_token_mismatch" && err?.statusCode === 409,
  );
});

test("finalize with auth_mode=third returns 409", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  const started = await repo.deployApp(app.id, { gitCommitSha: SHA });
  await db.update(apps).set({ authMode: "third" }).where(eq(apps.id, app.id));
  await assert.rejects(
    () => repo.finalizeDeploy(app.id, { gitCommitSha: SHA, deployToken: started.deployToken }),
    (err: any) => err?.code === "unsupported_auth_mode" && err?.statusCode === 409,
  );
});

test("finalize with runtime=container returns 409", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  const started = await repo.deployApp(app.id, { gitCommitSha: SHA });
  await db.update(apps).set({ runtime: "container" }).where(eq(apps.id, app.id));
  await assert.rejects(
    () => repo.finalizeDeploy(app.id, { gitCommitSha: SHA, deployToken: started.deployToken }),
    (err: any) => err?.code === "unsupported_runtime" && err?.statusCode === 409,
  );
});

test("finalize writes gitCommitSha from body; oss key still apps/{id}/code.zip", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const finalSha = "deadbeef";
  let seenOss: string | undefined;
  const repo = appsRepo({
    db, userId: "u1", callerActorId: actor.id,
    ...deployDeps({
      finalizeDeploy: async ({ ossObjectName }: any) => {
        seenOss = ossObjectName;
        return { fcEndpoint: "https://x.fcapp.run" };
      },
    }),
  });
  const app = await readyApp(repo, db, team);
  const started = await repo.deployApp(app.id, { gitCommitSha: SHA });
  const out = await repo.finalizeDeploy(app.id, { gitCommitSha: finalSha, deployToken: started.deployToken });
  assert.equal(out.gitCommitSha, finalSha);
  assert.equal(seenOss, `apps/${app.id}/code.zip`);
});

test("stale awaiting_build >30m is reclaimable on new deploy", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  const staleAt = new Date(Date.now() - 31 * 60 * 1000);
  await db.update(apps).set({
    fcStatus: "awaiting_build",
    fcFunctionName: "tc-app-stale",
    fcRegion: "cn-hangzhou",
    deployToken: "old-token",
    deployStartedAt: staleAt,
    provisionError: null,
  }).where(eq(apps.id, app.id));
  const out = await repo.deployApp(app.id, { gitCommitSha: SHA });
  assert.equal(out.fcStatus, "awaiting_build");
  assert.notEqual(out.deployToken, "old-token");
  const [row] = await db.select().from(apps).where(eq(apps.id, app.id));
  assert.equal(row.provisionError, null, "new deploy clears prior stale error");
});

test("updateApp accepts the client's deploy_error report and stores the reason", async () => {
  // Regression: the desktop owns the daemon-build leg, so a build that never
  // finished left fc_status stuck at awaiting_build with nothing surfaced.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({
    db, userId: "u1", callerActorId: actor.id,
    startDeploy: async () => ({
      fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou",
      ossObjectName: "apps/x/code.zip", presignedPut: "https://oss/put?sig=x",
    }),
  });
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  await db.update(apps).set({ provisionStatus: "ready" }).where(eq(apps.id, app.id));
  const started = await repo.deployApp(app.id, { gitCommitSha: "abc1234" }); // → awaiting_build

  const out = await repo.updateApp(app.id, { fcStatus: "deploy_error", deployError: "amuxd unreachable" });
  assert.equal(out.fcStatus, "deploy_error");
  const [row] = await db.select().from(apps).where(eq(apps.id, app.id));
  assert.equal(row.provisionError, "amuxd unreachable");

  // ...and a retry is legal from there.
  const retried = await repo.updateApp(app.id, { fcStatus: "awaiting_build" });
  assert.equal(retried.fcStatus, "awaiting_build");
});

test("updateApp rejects an illegal fc_status transition", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id });
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  // never deployed (fc_status null → not_deployed) → cannot jump straight to live
  await assert.rejects(() => repo.updateApp(app.id, { fcStatus: "live" }), /invalid_deploy_transition|fc_status/i);
});

test("getAppGitCredential returns null for non-creator", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id, { userId: "owner" });
  const other = await seedActor(db, team.id, { userId: "other" });
  const ownerRepo = appsRepo({ db, userId: owner.userId, gitea: fakeGitea() });
  const app = await ownerRepo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  const otherRepo = appsRepo({ db, userId: other.userId, gitea: fakeGitea() });
  assert.equal(await otherRepo.getAppGitCredential(app.id), null);
});

test("getAppGitCredential mints a deploy key for the creator", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  let seenKey: string | undefined;
  const gitea = fakeGitea({
    createDeployKey: async (_appId, _title, key) => {
      seenKey = key;
      return { id: 42 };
    },
  });
  const repo = appsRepo({ db, userId: actor.userId, gitea });
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  const cred = await repo.getAppGitCredential(app.id);
  assert.ok(cred);
  assert.equal(cred!.authKind, "deploy_key");
  assert.equal(cred!.remoteUrl, app.gitRemoteUrl);
  assert.equal(cred!.deployKeyId, 42);
  // OpenSSH format — OpenSSH cannot load an ed25519 key from a PKCS#8 block.
  assert.match(cred!.privateKeyPem, /BEGIN OPENSSH PRIVATE KEY/);
  assert.ok(seenKey?.startsWith("ssh-ed25519 "));
  assert.ok(new Date(cred!.expiresAt).getTime() > Date.now());
});

test("an imported app has no Gitea credential and no Gitea head", async () => {
  // It was created from someone else's remote: there is no tc-app-<id> repo to
  // mint a key on or read a HEAD from, and asking Gitea anyway 404s.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const gitea = fakeGitea({
    createDeployKey: async () => { throw new Error("must not be called"); },
    getRepoHead: async () => { throw new Error("must not be called"); },
  });
  const repo = appsRepo({ db, userId: actor.userId, gitea });
  const app = await repo.createApp({
    teamId: team.id,
    name: "Imported",
    type: "static_web",
    gitRemoteUrl: "https://github.com/owner/repo.git",
  });
  assert.equal(app.gitAuthKind, null);
  assert.equal(await repo.getAppGitCredential(app.id), null);
  assert.equal(await repo.getAppGitHead(app.id), null);
});

test("an imported app deploys with no commit sha at all", async () => {
  // Its build is of the local workdir, so there is no forge commit to pin the
  // deploy to. Requiring one made these apps undeployable.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await repo.createApp({
    teamId: team.id,
    name: "Imported",
    type: "fullstack_tanstack_postgres",
    gitRemoteUrl: "https://github.com/owner/repo.git",
  });
  await db.update(apps).set({ provisionStatus: "ready" }).where(eq(apps.id, app.id));

  const started = await repo.deployApp(app.id, {});
  assert.equal(started.fcStatus, "awaiting_build");
  assert.equal(started.gitCommitSha, null);
  const out = await repo.finalizeDeploy(app.id, { deployToken: started.deployToken });
  assert.equal(out.fcStatus, "live");
  assert.equal(out.gitCommitSha, null);
});

test("a deploy abandoned in `deploying` can be reclaimed once it is stale", async () => {
  // finalizeDeploy sets `deploying` before calling FC. A process killed there
  // used to block every future deploy with 409 deploy_in_progress, forever.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = appsRepo({ db, userId: "u1", callerActorId: actor.id, ...deployDeps() });
  const app = await readyApp(repo, db, team);
  await repo.deployApp(app.id, { gitCommitSha: SHA });

  await db.update(apps).set({
    fcStatus: "deploying",
    deployStartedAt: new Date(Date.now() - 31 * 60 * 1000),
  }).where(eq(apps.id, app.id));

  const retried = await repo.deployApp(app.id, { gitCommitSha: SHA });
  assert.equal(retried.fcStatus, "awaiting_build");
});

test("getAppGitHead returns default branch sha when app is visible", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id, { userId: "owner" });
  const other = await seedActor(db, team.id, { userId: "other" });
  const gitea = fakeGitea({ getRepoHead: async () => ({ sha: "deadbeef" }) });
  const ownerRepo = appsRepo({ db, userId: owner.userId, gitea });
  const app = await ownerRepo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres", visibility: "team" });
  const otherRepo = appsRepo({ db, userId: other.userId, gitea });
  assert.deepEqual(await ownerRepo.getAppGitHead(app.id), { sha: "deadbeef" });
  assert.deepEqual(await otherRepo.getAppGitHead(app.id), { sha: "deadbeef" });
});

function fakeGotrue(over: Partial<GotrueOAuthClient> = {}): GotrueOAuthClient {
  return {
    createOAuthClient: async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      clientId: "oauth-client-id",
      clientSecret: "oauth-client-secret",
    }),
    updateOAuthClient: async () => {},
    disableOAuthClient: async () => {},
    ...over,
  };
}

test("updateApp authMode=platform registers GoTrue client and seals secret", async () => {
  process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.APPS_PUBLIC_DOMAIN = "apps.example";
  process.env.BACKEND_KIND = "supabase";
  const calls: string[] = [];
  const gotrue = fakeGotrue({
    createOAuthClient: async (input) => {
      calls.push(input.redirectUris[0]!);
      return {
        id: "11111111-1111-4111-8111-111111111111",
        clientId: "oauth-client-id",
        clientSecret: "oauth-client-secret",
      };
    },
  });
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId, gotrue });
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "data_app" });
  const updated = await repo.updateApp(app.id, { authMode: "platform" });
  assert.equal(updated.authMode, "platform");
  assert.equal(updated.oauthClientId, "oauth-client-id");
  assert.match(calls[0], /\/auth\/callback$/);
  const [secretRow] = await db.select().from(appSecrets).where(eq(appSecrets.appId, app.id));
  assert.ok(secretRow?.ciphertext);
});

test("updateApp authMode=platform rejected when BACKEND_KIND=postgres", async () => {
  process.env.APPS_PUBLIC_DOMAIN = "apps.example";
  process.env.BACKEND_KIND = "postgres";
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId, gotrue: fakeGotrue() });
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "data_app" });
  await assert.rejects(
    () => repo.updateApp(app.id, { authMode: "platform" }),
    (err: any) => err?.code === "platform_auth_unavailable" && err?.statusCode === 409,
  );
});

test("updateApp authMode none disables GoTrue client and drops sealed secret", async () => {
  process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.APPS_PUBLIC_DOMAIN = "apps.example";
  process.env.BACKEND_KIND = "supabase";
  let disabled: string | undefined;
  const gotrue = fakeGotrue({
    disableOAuthClient: async (id) => { disabled = id; },
  });
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId, gotrue });
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "data_app" });
  await repo.updateApp(app.id, { authMode: "platform" });
  const updated = await repo.updateApp(app.id, { authMode: "none" });
  assert.equal(updated.authMode, "none");
  assert.equal(disabled, "oauth-client-id");
  // The ids go with the registration they name. GoTrue's "disable" is a hard
  // DELETE and the sealed secret is gone too, so keeping them "for audit" only
  // made platform auth un-re-enableable: the next switch back took the update
  // branch and 404'd on a client id that no longer exists.
  assert.equal(updated.oauthClientId, null);
  const rows = await db.select().from(appSecrets).where(eq(appSecrets.appId, app.id));
  assert.equal(rows.length, 0);

  // …and platform auth can be turned back on, minting a fresh client.
  const reenabled = await repo.updateApp(app.id, { authMode: "platform" });
  assert.equal(reenabled.authMode, "platform");
  assert.equal(reenabled.oauthClientId, "oauth-client-id");
  const resealed = await db.select().from(appSecrets).where(eq(appSecrets.appId, app.id));
  assert.equal(resealed.length, 1, "a fresh client secret is sealed again");
});

// ── getAppMembership ─────────────────────────────────────────────────────────

test("getAppMembership returns member true for team member", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "Member App", type: "static_web" });
  assert.deepEqual(await repo.getAppMembership(app.id), { member: true });
});

test("getAppMembership returns member false for authenticated outsider", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const outsiderTeam = await seedTeam(db);
  const outsider = await seedActor(db, outsiderTeam.id);
  const ownerRepo = appsRepo({ db, userId: owner.userId });
  const app = await ownerRepo.createApp({
    teamId: team.id,
    name: "Private App",
    type: "static_web",
    visibility: "personal",
  });
  const outsiderRepo = appsRepo({ db, userId: outsider.userId });
  assert.deepEqual(await outsiderRepo.getAppMembership(app.id), { member: false });
});

test("getAppMembership returns null for missing app", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = appsRepo({ db, userId: actor.userId });
  assert.equal(await repo.getAppMembership("00000000-0000-0000-0000-000000000000"), null);
});
