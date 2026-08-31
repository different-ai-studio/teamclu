/**
 * pg-repo-teams-rpc — UUID-seed pglite tests for createTeam / createTeamInvite / removeTeamActor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, teamInvites } from "../src/db/schema/index.js";
import { agents } from "../src/db/schema/agents.js";
import { workspaces } from "../src/db/schema/workspaces.js";
import { eq } from "drizzle-orm";

// ── createTeam ────────────────────────────────────────────────────────────────

test("createTeam: creates team + owner actor + member + team_member + workspace + config", async () => {
  const { db } = await makeTestDb();
  const userId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId });

  const team = await repo.createTeam({ name: "Acme Corp" });

  assert.ok(team.id, "team.id must be present");
  assert.equal(team.name, "Acme Corp");
  assert.ok(team.slug, "team.slug must be present");

  // Verify teams row
  const [teamRow] = await db.select().from(teams).where(eq(teams.id, team.id));
  assert.ok(teamRow, "teams row must exist");

  // Verify actor row (member type, linked to userId)
  const actorRows = await db.select().from(actors).where(eq(actors.teamId, team.id));
  assert.equal(actorRows.length, 1, "exactly one actor must be created");
  assert.equal(actorRows[0].actorType, "member");
  assert.equal(actorRows[0].userId, userId);

  const actorId = actorRows[0].id;

  // Verify members row
  const [memberRow] = await db.select().from(members).where(eq(members.id, actorId));
  assert.ok(memberRow, "members row must exist");
  assert.equal(memberRow.status, "active");

  // Verify team_members row with owner role
  const tmRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, team.id));
  assert.equal(tmRows.length, 1, "exactly one team_members row must exist");
  assert.equal(tmRows[0].role, "owner");
  assert.equal(tmRows[0].memberId, actorId);

  // Verify default workspace
  const wsRows = await db.select().from(workspaces).where(eq(workspaces.teamId, team.id));
  assert.equal(wsRows.length, 1, "exactly one workspace must be created");
  assert.equal(wsRows[0].name, "General");
});

test("createTeam: owner display name uses caller-provided name verbatim", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db, userId: `user-${Math.random()}` });

  const team = await repo.createTeam({ name: "Acme Corp", displayName: "Jin Liang" });

  const [actor] = await db.select().from(actors).where(eq(actors.teamId, team.id));
  assert.equal(actor.displayName, "Jin Liang");
});

test("createTeam: owner display name falls back to a generated handle, never 'You' or the team name", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db, userId: `user-${Math.random()}` });

  const team = await repo.createTeam({ name: "Acme Corp" });

  const [actor] = await db.select().from(actors).where(eq(actors.teamId, team.id));
  assert.notEqual(actor.displayName, "You", "must not regress to the legacy 'You' default");
  assert.notEqual(actor.displayName, "Acme Corp", "must not reuse the team name as the person's name");
  assert.match(actor.displayName ?? "", /^\S+ \S+$/, "should be an 'Adjective Animal' handle");
});

test("createTeam: first-team-only — rejects if userId already has an actor", async () => {
  const { db } = await makeTestDb();
  const userId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId });

  await repo.createTeam({ name: "First Team" });

  await assert.rejects(
    () => repo.createTeam({ name: "Second Team" }),
    (err: any) => err?.code === "conflict" || /conflict|already/i.test(err?.message),
  );
});

test("createTeam: requires userId", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db }); // no userId

  await assert.rejects(
    () => repo.createTeam({ name: "No User" }),
    /userId is required|bad_request/i,
  );
});

test("createTeam: slug dedup generates unique slug on conflict", async () => {
  const { db } = await makeTestDb();

  // Manually insert a team with slug "acme"
  await db.insert(teams).values({ name: "Existing", slug: "acme" });

  const userId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId });

  // createTeam with same name/slug should succeed with a different slug
  const team = await repo.createTeam({ name: "Acme" });
  assert.ok(team.slug !== "acme", "slug must differ from the existing one");
});

// ── createTeamInvite ──────────────────────────────────────────────────────────

test("createTeamInvite: returns { token, inviteId, expiresAt } and inserts row", async () => {
  const { db } = await makeTestDb();

  // Create a team with a real userId so invite can reference an actor
  const userId = `user-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId });
  const team = await ownerRepo.createTeam({ name: "Invite Team" });

  const result = await ownerRepo.createTeamInvite(team.id, {
    actorType: "member",
    displayName: "New Member",
    role: "member",
    expiresAt: null,
  });

  assert.ok(result.token, "token must be present");
  assert.ok(result.inviteId, "inviteId must be present");
  // expiresAt: null input → defaults to 7-day TTL → should be a non-null ISO string
  assert.ok(result.expiresAt, "expiresAt should be set (defaulted TTL)");

  // Verify row in team_invites
  const [inviteRow] = await db.select().from(teamInvites).where(eq(teamInvites.id, result.inviteId));
  assert.ok(inviteRow, "team_invites row must exist");
  assert.equal(inviteRow.token, result.token);
  assert.equal(inviteRow.teamId, team.id);
  assert.equal(inviteRow.kind, "member");
  assert.equal(inviteRow.displayName, "New Member");
});

test("createTeamInvite: explicit expiresAt null returns null expiresAt when null string", async () => {
  const { db } = await makeTestDb();
  const userId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId });
  const team = await repo.createTeam({ name: "Invite Team 2" });

  // Pass a far-future explicit expiresAt
  const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const result = await repo.createTeamInvite(team.id, {
    actorType: "user",
    displayName: "VIP",
    role: "owner",
    expiresAt: farFuture,
  });

  assert.ok(result.token);
  assert.ok(result.inviteId);
  assert.ok(result.expiresAt);
  assert.equal(new Date(result.expiresAt).toISOString(), farFuture);
});

// ── removeTeamActor ───────────────────────────────────────────────────────────

test("removeTeamActor: deletes actor + members + team_members rows", async () => {
  const { db } = await makeTestDb();

  // Setup: team + actor to remove
  const userId = `user-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId });
  const team = await ownerRepo.createTeam({ name: "Remove Test Team" });

  // Seed a second actor to remove
  const [actorToRemove] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "To Remove",
    userId: `user-${Math.random()}`,
  }).returning();
  await db.insert(members).values({ id: actorToRemove.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: actorToRemove.id, role: "member" });

  // Verify the actor exists
  const [before] = await db.select().from(actors).where(eq(actors.id, actorToRemove.id));
  assert.ok(before, "actor must exist before removal");

  // Remove
  await ownerRepo.removeTeamActor(team.id, actorToRemove.id);

  // Verify actor is gone
  const [after] = await db.select().from(actors).where(eq(actors.id, actorToRemove.id));
  assert.equal(after, undefined, "actor must be deleted");

  // Verify members row gone
  const [memberAfter] = await db.select().from(members).where(eq(members.id, actorToRemove.id));
  assert.equal(memberAfter, undefined, "members row must be deleted");

  // Verify team_members row gone
  const tmAfter = await db.select().from(teamMembers).where(eq(teamMembers.memberId, actorToRemove.id));
  assert.equal(tmAfter.length, 0, "team_members rows must be deleted");
});

test("removeTeamActor: throws not_found when actor does not exist", async () => {
  const { db } = await makeTestDb();
  const userId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId });
  const team = await repo.createTeam({ name: "Ghost Team" });

  await assert.rejects(
    () => repo.removeTeamActor(team.id, "00000000-0000-0000-0000-000000000099"),
    (e: any) => e?.message?.includes("actor not found"),
  );
});

test("removeTeamActor: personal agent owner can delete; other member cannot", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const memberUserId = `user-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const memberRepo = createPgBusinessRepository({ db, userId: memberUserId });
  const team = await ownerRepo.createTeam({ name: "Personal Agent Delete Team" });

  const [memberActor] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "Agent Owner Member",
    userId: memberUserId,
  }).returning();
  await db.insert(members).values({ id: memberActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: memberActor.id, role: "member" });

  const [personalAgent] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "agent",
    displayName: "Personal Agent",
  }).returning();
  await db.insert(agents).values({
    id: personalAgent.id,
    agentKind: "daemon",
    status: "active",
    visibility: "personal",
    ownerMemberId: memberActor.id,
  });

  await assert.rejects(
    () => ownerRepo.removeTeamActor(team.id, personalAgent.id),
    (e: any) => /requires agent owner for personal agents/i.test(String(e?.message ?? e)),
  );

  await memberRepo.removeTeamActor(team.id, personalAgent.id);

  const after = await db.select().from(actors).where(eq(actors.id, personalAgent.id));
  assert.equal(after.length, 0, "personal agent must be deleted by owner member");
});

test("removeTeamActor: team agent requires admin; member cannot delete", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const memberUserId = `user-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const memberRepo = createPgBusinessRepository({ db, userId: memberUserId });
  const team = await ownerRepo.createTeam({ name: "Team Agent Delete Team" });

  const [memberActor] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "Regular Member",
    userId: memberUserId,
  }).returning();
  await db.insert(members).values({ id: memberActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: memberActor.id, role: "member" });

  const [teamAgent] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "agent",
    displayName: "Shared Team Agent",
  }).returning();
  await db.insert(agents).values({
    id: teamAgent.id,
    agentKind: "daemon",
    status: "active",
    visibility: "team",
    ownerMemberId: memberActor.id,
  });

  await assert.rejects(
    () => memberRepo.removeTeamActor(team.id, teamAgent.id),
    (e: any) => /requires owner or admin for team agents/i.test(String(e?.message ?? e)),
  );

  await ownerRepo.removeTeamActor(team.id, teamAgent.id);

  const after = await db.select().from(actors).where(eq(actors.id, teamAgent.id));
  assert.equal(after.length, 0, "team agent must be deleted by team owner");
});

test("removeTeamActor: team admin (not owner) can delete team agent", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const adminUserId = `user-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const adminRepo = createPgBusinessRepository({ db, userId: adminUserId });
  const team = await ownerRepo.createTeam({ name: "Team Agent Admin Delete Team" });

  const [adminActor] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "Team Admin",
    userId: adminUserId,
  }).returning();
  await db.insert(members).values({ id: adminActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: adminActor.id, role: "admin" });

  const [memberActor] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "Agent Owner Member",
    userId: `user-${Math.random()}`,
  }).returning();
  await db.insert(members).values({ id: memberActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: memberActor.id, role: "member" });

  const [teamAgent] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "agent",
    displayName: "Team Scoped Agent",
  }).returning();
  await db.insert(agents).values({
    id: teamAgent.id,
    agentKind: "daemon",
    status: "active",
    visibility: "team",
    ownerMemberId: memberActor.id,
  });

  await adminRepo.removeTeamActor(team.id, teamAgent.id);

  const after = await db.select().from(actors).where(eq(actors.id, teamAgent.id));
  assert.equal(after.length, 0, "team admin must be able to delete team agent");
});

test("removeTeamActor: deleting a member also removes agents they own", async () => {
  const { db } = await makeTestDb();
  const userId = `user-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId });
  const team = await ownerRepo.createTeam({ name: "Owned Agents Team" });

  const ownerActor = await db.query.actors.findFirst({
    where: eq(actors.teamId, team.id),
  });
  assert.ok(ownerActor, "owner actor must exist");

  const [memberToRemove] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "Agent Owner",
    userId: `user-${Math.random()}`,
  }).returning();
  await db.insert(members).values({ id: memberToRemove.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: memberToRemove.id, role: "member" });

  const [ownedAgent] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "agent",
    displayName: "Owned Agent",
  }).returning();
  await db.insert(agents).values({
    id: ownedAgent.id,
    agentKind: "daemon",
    status: "active",
    visibility: "team",
    ownerMemberId: memberToRemove.id,
  });

  await ownerRepo.removeTeamActor(team.id, memberToRemove.id);

  const memberAfter = await db.select().from(actors).where(eq(actors.id, memberToRemove.id));
  assert.equal(memberAfter.length, 0, "member actor must be deleted");

  const ownedAfter = await db.select().from(actors).where(eq(actors.id, ownedAgent.id));
  assert.equal(ownedAfter.length, 0, "owned agent actor must be deleted");
});

test("removeTeamActor: still succeeds when the injected key-deletion function throws", async () => {
  const { db } = await makeTestDb();
  const userId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({
    db,
    userId,
    deleteMemberKey: async () => { throw new Error("litellm down"); },
  });
  const team = await repo.createTeam({ name: "Key Delete Throws Team" });

  const [actorToRemove] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "To Remove",
    userId: `user-${Math.random()}`,
  }).returning();
  await db.insert(members).values({ id: actorToRemove.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: actorToRemove.id, role: "member" });

  // Should not throw, even though the injected deleteMemberKey rejects.
  await repo.removeTeamActor(team.id, actorToRemove.id);

  const after = await db.select().from(actors).where(eq(actors.id, actorToRemove.id));
  assert.equal(after.length, 0, "actor must still be deleted");
});


