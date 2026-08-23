/**
 * pg-repo-agents — UUID-seed pglite tests for the AGENTS domain.
 *
 * Tests the 9 contract methods plus supporting helpers.
 * Follows the same pattern as pg-repo-actors.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import {
  teams,
  actors,
  members,
  teamMembers,
  agents,
  agentMemberAccess,
} from "../src/db/schema/index.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

async function seedMemberActor(
  db: any,
  teamId: string,
  opts: { displayName?: string; userId?: string } = {},
) {
  const [actor] = await db
    .insert(actors)
    .values({
      teamId,
      actorType: "member",
      displayName: opts.displayName ?? "Test Actor",
      userId: opts.userId ?? `user-${Math.random()}`,
    })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedAgentActor(
  db: any,
  teamId: string,
  ownerMemberId: string,
  visibility = "team",
  status = "active",
) {
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId, actorType: "agent", displayName: "TestBot" })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "claude",
    status,
    visibility,
    ownerMemberId,
  });
  return agentActor;
}

// ── listConnectedAgents ───────────────────────────────────────────────────────

test("listConnectedAgents returns items with kind=agent", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db });

  const result = await repo.listConnectedAgents(team.id);
  assert.ok(result && typeof result === "object", "must return an object");
  assert.ok(Array.isArray(result.items), "items must be an array");
  assert.ok(result.items.length >= 1, "must include at least one agent");
  assert.ok(
    result.items.every((item: any) => item.kind === "agent"),
    "all items must have kind=agent",
  );
});

test("listConnectedAgents hides retired agents", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const live = await seedAgentActor(db, team.id, member.id, "team");
  await seedAgentActor(db, team.id, member.id, "team", "archived");
  await seedAgentActor(db, team.id, member.id, "personal", "disabled");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const result = await repo.listConnectedAgents(team.id);
  assert.deepEqual(
    result.items.map((a: any) => a.id),
    [live.id],
    "only the active agent is connected",
  );
});

test("listConnectedAgents only returns agents from the specified team", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  const memberA = await seedMemberActor(db, teamA.id);
  const memberB = await seedMemberActor(db, teamB.id);
  await seedAgentActor(db, teamA.id, memberA.id, "team");
  await seedAgentActor(db, teamB.id, memberB.id, "team");
  const repo = createPgBusinessRepository({ db });

  const resultA = await repo.listConnectedAgents(teamA.id);
  assert.ok(
    resultA.items.every((a: any) => a.teamId === teamA.id),
    "all agents must belong to teamA",
  );
});

// ── listAgentDefaults ───────────────────────────────────────────────────────

test("listAgentDefaults returns defaultAgentType and defaultWorkspaceId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId: team.id, actorType: "agent", displayName: "Daemon" })
    .returning();
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "claude",
    status: "active",
    visibility: "team",
    ownerMemberId: member.id,
    agentTypes: ["claude", "opencode"],
    defaultAgentType: "opencode",
    defaultWorkspaceId: workspaceId,
  });
  const repo = createPgBusinessRepository({ db });

  const rows = await repo.listAgentDefaults([agentActor.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, agentActor.id);
  assert.equal(rows[0].defaultAgentType, "opencode");
  // The amuxd daemon reads defaultWorkspaceId from this endpoint to pick the
  // working directory for gateway (WeCom) runtimes.
  assert.equal(rows[0].defaultWorkspaceId, workspaceId);
});

// ── checkAgentPermission ──────────────────────────────────────────────────────

test("checkAgentPermission returns allowed=false + role=null when no access row", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  const result = await repo.checkAgentPermission(agentActor.id, member.id);
  assert.ok(result && typeof result === "object", "must return an object");
  assert.equal(result.allowed, false);
  assert.equal(result.role, null);
});

test("checkAgentPermission returns allowed=true + role string when access exists", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  // Insert an access row
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: member.id,
    permissionLevel: "admin",
  });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.checkAgentPermission(agentActor.id, member.id);
  assert.equal(result.allowed, true);
  assert.equal(result.role, "admin");
});

// ── grantAgentAccess ──────────────────────────────────────────────────────────

test("grantAgentAccess returns {actorId, role} on success", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  const result = await repo.grantAgentAccess(agentActor.id, { actorId: member.id, role: "viewer" });
  assert.ok(result && typeof result === "object");
  assert.equal(result.actorId, member.id);
  assert.equal(result.role, "viewer");
});

test("grantAgentAccess is idempotent (upsert updates role)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  await repo.grantAgentAccess(agentActor.id, { actorId: member.id, role: "viewer" });
  const updated = await repo.grantAgentAccess(agentActor.id, { actorId: member.id, role: "admin" });
  assert.equal(updated.role, "admin");
});

// ── revokeAgentAccess ─────────────────────────────────────────────────────────

test("revokeAgentAccess does not throw (even when row missing)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  // No access row exists — should not throw
  await assert.doesNotReject(
    () => repo.revokeAgentAccess(agentActor.id, member.id),
  );
});

test("revokeAgentAccess removes an existing access row", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: member.id,
    permissionLevel: "admin",
  });
  const repo = createPgBusinessRepository({ db });

  await repo.revokeAgentAccess(agentActor.id, member.id);

  const check = await repo.checkAgentPermission(agentActor.id, member.id);
  assert.equal(check.allowed, false);
});

// ── removeAgentAccessById ─────────────────────────────────────────────────────

test("removeAgentAccessById deletes the grant by its access id", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const [row] = await db
    .insert(agentMemberAccess)
    .values({ agentId: agentActor.id, memberId: member.id, permissionLevel: "admin" })
    .returning();
  const repo = createPgBusinessRepository({ db });

  await repo.removeAgentAccessById(row.id);

  const check = await repo.checkAgentPermission(agentActor.id, member.id);
  assert.equal(check.allowed, false);
});

test("removeAgentAccessById is a no-op for a missing access id", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  await assert.doesNotReject(
    () => repo.removeAgentAccessById("00000000-0000-0000-0000-000000000000"),
  );
});

// ── listAgentAccess ───────────────────────────────────────────────────────────

test("listAgentAccess items have keys {actorId, agentActorId, role}", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: member.id,
    permissionLevel: "viewer",
  });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.listAgentAccess(agentActor.id);
  assert.ok(result && typeof result === "object");
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length >= 1);

  const item = result.items[0];
  assert.ok("actorId" in item, "item must have actorId");
  assert.ok("agentActorId" in item, "item must have agentActorId");
  assert.ok("role" in item, "item must have role");
  assert.equal(item.actorId, member.id);
  assert.equal(item.agentActorId, agentActor.id);
  assert.equal(item.role, "viewer");
});

test("listAgentAccess returns empty items when no access rows", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  const result = await repo.listAgentAccess(agentActor.id);
  assert.ok(Array.isArray(result.items));
  assert.equal(result.items.length, 0);
});

// ── listAgentAdminMembers ─────────────────────────────────────────────────────

test("listAgentAdminMembers returns array of actor id strings", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: member.id,
    permissionLevel: "admin",
  });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.listAgentAdminMembers(agentActor.id);
  assert.ok(result && typeof result === "object");
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.every((id: any) => typeof id === "string"), "items must be strings");
  assert.ok(result.items.includes(member.id));
});

test("listAgentAdminMembers excludes non-admin access rows", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const memberAdmin = await seedMemberActor(db, team.id);
  const memberViewer = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, memberAdmin.id);
  await db.insert(agentMemberAccess).values([
    { agentId: agentActor.id, memberId: memberAdmin.id, permissionLevel: "admin" },
    { agentId: agentActor.id, memberId: memberViewer.id, permissionLevel: "viewer" },
  ]);
  const repo = createPgBusinessRepository({ db });

  const result = await repo.listAgentAdminMembers(agentActor.id);
  assert.ok(result.items.includes(memberAdmin.id));
  assert.ok(!result.items.includes(memberViewer.id));
});

// ── updateOwnedAgentProfile ───────────────────────────────────────────────────

test("updateOwnedAgentProfile does not throw for owner", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, { userId: "user-owner" });
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db, userId: "user-owner" });

  await assert.doesNotReject(
    () => repo.updateOwnedAgentProfile(agentActor.id, { displayName: "NewName" }),
  );
});

// ── updateAgentDefaults ───────────────────────────────────────────────────────

test("updateAgentDefaults does not throw", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, { userId: "user-def" });
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db, userId: "user-def" });

  await assert.doesNotReject(
    () => repo.updateAgentDefaults(agentActor.id, { defaultAgentType: "chat" }),
  );
});

// ── authz fail-closed: shareAgentToTeam / makeAgentPersonal / updateOwnedAgentProfile / updateAgentDefaults ──

test("shareAgentToTeam: no ctx.userId → 401", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id, "personal");
  const repo = createPgBusinessRepository({ db }); // no userId

  await assert.rejects(
    () => repo.shareAgentToTeam(agentActor.id),
    (err: any) => err.statusCode === 401,
    "should reject with 401",
  );
});

test("shareAgentToTeam: non-owner → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "owner-user" });
  const nonOwner = await seedMemberActor(db, team.id, { userId: "nonowner-user" });
  const agentActor = await seedAgentActor(db, team.id, owner.id, "personal");
  const repo = createPgBusinessRepository({ db, userId: "nonowner-user" });

  await assert.rejects(
    () => repo.shareAgentToTeam(agentActor.id),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

test("shareAgentToTeam: owner succeeds", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "owner-share" });
  const agentActor = await seedAgentActor(db, team.id, owner.id, "personal");
  const repo = createPgBusinessRepository({ db, userId: "owner-share" });

  await assert.doesNotReject(() => repo.shareAgentToTeam(agentActor.id));
});

test("makeAgentPersonal: no ctx.userId → 401", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db });

  await assert.rejects(
    () => repo.makeAgentPersonal(agentActor.id),
    (err: any) => err.statusCode === 401,
  );
});

test("makeAgentPersonal: non-owner → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "mp-owner" });
  const nonOwner = await seedMemberActor(db, team.id, { userId: "mp-nonowner" });
  const agentActor = await seedAgentActor(db, team.id, owner.id, "team");
  const repo = createPgBusinessRepository({ db, userId: "mp-nonowner" });

  await assert.rejects(
    () => repo.makeAgentPersonal(agentActor.id),
    (err: any) => err.statusCode === 403,
  );
});

test("makeAgentPersonal: owner succeeds", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "mp-owner-ok" });
  const agentActor = await seedAgentActor(db, team.id, owner.id, "team");
  const repo = createPgBusinessRepository({ db, userId: "mp-owner-ok" });

  await assert.doesNotReject(() => repo.makeAgentPersonal(agentActor.id));
});

test("updateOwnedAgentProfile: no ctx.userId → 401", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  await assert.rejects(
    () => repo.updateOwnedAgentProfile(agentActor.id, { displayName: "Hacked" }),
    (err: any) => err.statusCode === 401,
  );
});

test("updateOwnedAgentProfile: non-owner → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "prof-owner" });
  const nonOwner = await seedMemberActor(db, team.id, { userId: "prof-nonowner" });
  const agentActor = await seedAgentActor(db, team.id, owner.id);
  const repo = createPgBusinessRepository({ db, userId: "prof-nonowner" });

  await assert.rejects(
    () => repo.updateOwnedAgentProfile(agentActor.id, { displayName: "Hijack" }),
    (err: any) => err.statusCode === 403,
  );
});

test("updateAgentDefaults: no ctx.userId → 401", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db });

  await assert.rejects(
    () => repo.updateAgentDefaults(agentActor.id, { defaultAgentType: "chat" }),
    (err: any) => err.statusCode === 401,
  );
});

test("updateAgentDefaults: non-owner → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "def-owner" });
  const nonOwner = await seedMemberActor(db, team.id, { userId: "def-nonowner" });
  const agentActor = await seedAgentActor(db, team.id, owner.id);
  const repo = createPgBusinessRepository({ db, userId: "def-nonowner" });

  await assert.rejects(
    () => repo.updateAgentDefaults(agentActor.id, { defaultAgentType: "chat" }),
    (err: any) => err.statusCode === 403,
  );
});

test("listConnectedAgents marks owner and shows owner's personal agent", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const ownerUser = crypto.randomUUID();
  const owner = await seedMemberActor(db, team.id, { userId: ownerUser });
  // Change member role to owner
  const { teamMembers: tmTable } = await import("../src/db/schema/index.js");
  const { eq: eqImport } = await import("drizzle-orm");
  await db.update(tmTable).set({ role: "owner" }).where(eqImport(tmTable.memberId, owner.id));

  const agentActor = await seedAgentActor(db, team.id, owner.id, "personal");

  const repo = createPgBusinessRepository({ db, userId: ownerUser });
  const result = await repo.listConnectedAgents(team.id);
  const found = result.items.find((a: any) => a.id === agentActor.id);
  assert.ok(found, "owner can see their own personal agent");
  assert.equal(found.isOwner, true, "isOwner is true for the owner");
});

test("listConnectedAgents exposes a personal Agent to an explicit admin", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id);
  const admin = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, owner.id, "personal");
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: admin.id,
    permissionLevel: "admin",
  });

  const repo = createPgBusinessRepository({ db, callerActorId: admin.id });
  const result = await repo.listConnectedAgents(team.id);
  const found = result.items.find((item: any) => item.id === agentActor.id);
  assert.ok(found, "an explicit admin can select the personal Agent");
  assert.equal(found.permissionLevel, "admin");
  assert.equal(found.isOwner, false);
});

test("authorizeAgentManagement admits an explicit admin and rejects a plain member", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id);
  const admin = await seedMemberActor(db, team.id);
  const bystander = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, owner.id, "personal");
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: admin.id,
    permissionLevel: "admin",
  });

  const asAdmin = createPgBusinessRepository({ db, callerActorId: admin.id });
  assert.deepEqual(await asAdmin.authorizeAgentManagement(agentActor.id, team.id), {
    teamId: team.id,
    requesterActorId: admin.id,
  });

  const asOwner = createPgBusinessRepository({ db, callerActorId: owner.id });
  assert.deepEqual(await asOwner.authorizeAgentManagement(agentActor.id, team.id), {
    teamId: team.id,
    requesterActorId: owner.id,
  });

  const asBystander = createPgBusinessRepository({ db, callerActorId: bystander.id });
  await assert.rejects(
    asBystander.authorizeAgentManagement(agentActor.id, team.id),
    /owner or admin access required/,
  );
});

test("authorizeAgentManagement is scoped to the team the caller named", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const other = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id);
  const agentActor = await seedAgentActor(db, team.id, owner.id, "personal");

  const repo = createPgBusinessRepository({ db, callerActorId: owner.id });
  await assert.rejects(
    repo.authorizeAgentManagement(agentActor.id, other.id),
    /agent not found/,
  );
  await assert.rejects(repo.authorizeAgentManagement(agentActor.id, ""), /teamId is required/);
});
