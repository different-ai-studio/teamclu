/**
 * pg-repo-actors — UUID-seed pglite tests for the ACTORS/DIRECTORY domain.
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
import { teams, actors, members, teamMembers, agents } from "../src/db/schema/index.js";
import { actorClientVersions } from "../src/db/schema/telemetry.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

async function seedMemberActor(db: any, teamId: string, opts: { displayName?: string; userId?: string } = {}) {
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
    .values({ teamId, actorType: "agent", displayName: "Bot" })
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

// ── getActor ──────────────────────────────────────────────────────────────────

test("getActor returns displayName for existing actor", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedMemberActor(db, team.id, { displayName: "Alice" });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.getActor(actor.id);
  assert.ok(result, "actor should be found");
  assert.equal(result.displayName, "Alice");
});

test("getActor returns null for missing actor", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });

  const result = await repo.getActor("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});

// ── upsertExternalActor ───────────────────────────────────────────────────────

test("upsertExternalActor creates a new external actor and returns actorId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const repo = createPgBusinessRepository({ db });

  const result = await repo.upsertExternalActor({
    teamId: team.id,
    source: "wecom",
    sourceId: "wc-001",
    displayName: "External User",
  });
  assert.ok(result.actorId, "actorId must be present");
  assert.equal(typeof result.actorId, "string");
});

test("upsertExternalActor is idempotent (returns same actorId on second call)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const repo = createPgBusinessRepository({ db });

  const first = await repo.upsertExternalActor({
    teamId: team.id,
    source: "wecom",
    sourceId: "wc-002",
    displayName: "Ext User",
  });
  const second = await repo.upsertExternalActor({
    teamId: team.id,
    source: "wecom",
    sourceId: "wc-002",
    displayName: "Ext User Updated",
  });
  assert.equal(first.actorId, second.actorId, "actorId must be stable across upserts");
});

// ── listTeamActors ────────────────────────────────────────────────────────────

test("listTeamActors returns agentOwnerMemberId for agents", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "personal");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const page = await repo.listTeamActors(team.id, { kind: "agent", limit: 200 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].agentOwnerMemberId, member.id);
  assert.equal(page.items[0].visibility, "personal");
});

test("listTeamActors returns directory fields needed for actor management UI", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const page = await repo.listTeamActors(team.id, { kind: null, limit: 200 });
  assert.ok(Array.isArray(page.items), "items must be an array");
  assert.ok(page.items.length >= 2, "must have member + agent");

  const memberRow = page.items.find((a: any) => a.kind === "member");
  const agentRow = page.items.find((a: any) => a.kind === "agent");
  assert.ok(memberRow?.teamRole, "member row should expose teamRole");
  assert.equal(agentRow?.visibility, "team");
  assert.equal(agentRow?.agentOwnerMemberId, member.id);
});

test("listTeamActors kind filter returns only matching actors", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db });

  const memberPage = await repo.listTeamActors(team.id, { kind: "member", limit: 200 });
  assert.ok(memberPage.items.every((a: any) => a.kind === "member"), "only member actors expected");

  const agentPage = await repo.listTeamActors(team.id, { kind: "agent", limit: 200 });
  assert.ok(agentPage.items.length >= 1, "should have at least one agent");
  assert.ok(agentPage.items.every((a: any) => a.kind === "agent"), "only agent actors expected");
});

test("listTeamActors agent-visibility: personal agent excluded without callerActorId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "personal");
  // No callerActorId → personal agents excluded
  const repo = createPgBusinessRepository({ db });

  const page = await repo.listTeamActors(team.id, { kind: "agent", limit: 200 });
  assert.equal(page.items.length, 0, "personal agent should not appear without caller context");
});

test("listTeamActors agent-visibility: personal agent visible to its owner", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "personal");
  // Pass callerActorId = owner's actor id
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const page = await repo.listTeamActors(team.id, { kind: "agent", limit: 200 });
  assert.equal(page.items.length, 1, "owner should see their personal agent");
});

test("listTeamActors hides retired agents but keeps members", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const live = await seedAgentActor(db, team.id, member.id, "team");
  await seedAgentActor(db, team.id, member.id, "team", "archived");
  await seedAgentActor(db, team.id, member.id, "team", "disabled");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const agentPage = await repo.listTeamActors(team.id, { kind: "agent", limit: 200 });
  assert.deepEqual(
    agentPage.items.map((a: any) => a.id),
    [live.id],
    "only the active agent belongs in the list",
  );

  const all = await repo.listTeamActors(team.id, { kind: null, limit: 200 });
  assert.ok(
    all.items.some((a: any) => a.id === member.id),
    "members carry a null agent_status and must survive the filter",
  );
});

test("listTeamActors hides a retired agent from its own owner", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  await seedAgentActor(db, team.id, member.id, "personal", "archived");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const page = await repo.listTeamActors(team.id, { kind: "agent", limit: 200 });
  assert.equal(page.items.length, 0, "ownership does not exempt a retired agent");
});

test("listActorDirectoryByIds still resolves a retired agent", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const retired = await seedAgentActor(db, team.id, member.id, "team", "archived");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const rows = await repo.listActorDirectoryByIds([retired.id], team.id);
  assert.equal(rows.length, 1, "messages authored by a retired agent must keep their author name");
  assert.equal(rows[0].id, retired.id);
});

// ── getTeamDirectory ──────────────────────────────────────────────────────────

test("getTeamDirectory returns actors and members with canonical keys", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  await seedMemberActor(db, team.id, { displayName: "Dir Member" });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.getTeamDirectory(team.id);
  assert.ok(Array.isArray(result.actors), "actors must be an array");
  assert.ok(Array.isArray(result.members), "members must be an array");
  assert.ok(result.actors.length >= 1, "must have at least one actor");
  assert.ok(result.members.length >= 1, "must have at least one member");

  const actorKeys = ["id", "teamId", "kind", "displayName", "avatarUrl", "metadata"].sort();
  assert.deepEqual(Object.keys(result.actors[0]).sort(), actorKeys);

  const memberKeys = ["actorId", "teamId", "role", "joinedAt"].sort();
  assert.deepEqual(Object.keys(result.members[0]).sort(), memberKeys);
});

test("getTeamDirectory hides retired agents", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, { displayName: "Dir Member" });
  const live = await seedAgentActor(db, team.id, member.id, "team");
  const retired = await seedAgentActor(db, team.id, member.id, "team", "archived");
  const repo = createPgBusinessRepository({ db, callerActorId: member.id });

  const result = await repo.getTeamDirectory(team.id);
  const ids = result.actors.map((a: any) => a.id);
  assert.ok(ids.includes(member.id), "member stays");
  assert.ok(ids.includes(live.id), "active agent stays");
  assert.ok(!ids.includes(retired.id), "archived agent is gone");
});

// ── updateCurrentActorProfile ─────────────────────────────────────────────────

test("updateCurrentActorProfile updates displayName and returns directory shape", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedMemberActor(db, team.id, { displayName: "Old Name" });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.updateCurrentActorProfile(actor.id, { displayName: "New Name" });
  assert.equal(result.displayName, "New Name", "displayName must be updated");
  assert.equal(result.id, actor.id, "id must match");
  assert.equal(result.teamId, team.id, "teamId must match");
  assert.equal(result.kind, "member", "kind must be member");

  // Persisted: verify via getActor
  const fetched = await repo.getActor(actor.id);
  assert.ok(fetched, "actor must exist");
  assert.equal(fetched.displayName, "New Name", "persisted displayName must match");
});

test("updateCurrentActorProfile updates avatarUrl", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedMemberActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const result = await repo.updateCurrentActorProfile(actor.id, { avatarUrl: "https://example.com/avatar.png" });
  assert.equal(result.avatarUrl, "https://example.com/avatar.png");
});

test("updateCurrentActorProfile throws 404 for unknown actorId", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });

  await assert.rejects(
    () => repo.updateCurrentActorProfile("00000000-0000-0000-0000-000000000000", { displayName: "X" }),
    (err: any) => { assert.equal(err.statusCode, 404); return true; },
  );
});

test("getTeamDirectory only returns actors in the specified team", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  await seedMemberActor(db, teamA.id);
  await seedMemberActor(db, teamB.id);
  const repo = createPgBusinessRepository({ db });

  const resultA = await repo.getTeamDirectory(teamA.id);
  const resultB = await repo.getTeamDirectory(teamB.id);
  assert.ok(resultA.actors.every((a: any) => a.teamId === teamA.id), "all actors must belong to teamA");
  assert.ok(resultB.actors.every((a: any) => a.teamId === teamB.id), "all actors must belong to teamB");
});

test("getActor includes clientVersions array", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedMemberActor(db, team.id, { displayName: "Vee" });
  await db.insert(actorClientVersions).values({
    actorId: actor.id,
    teamId: team.id,
    clientType: "ios",
    deviceId: "iphone-1",
    version: "1.1.5",
    build: "14",
    lastReportedAt: new Date(),
  });

  const repo = createPgBusinessRepository({ db });
  const result = await repo.getActor(actor.id);
  assert.ok(Array.isArray(result.clientVersions), "clientVersions must be an array");
  assert.equal(result.clientVersions.length, 1);
  assert.equal(result.clientVersions[0].clientType, "ios");
  assert.equal(result.clientVersions[0].version, "1.1.5");
  assert.equal(result.clientVersions[0].build, "14");
});

test("getActor returns empty clientVersions when none reported", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedMemberActor(db, team.id, { displayName: "Empty" });
  const repo = createPgBusinessRepository({ db });
  const result = await repo.getActor(actor.id);
  assert.deepEqual(result.clientVersions, []);
});

// ── getCurrentTeamMember ──────────────────────────────────────────────────────

test("getCurrentTeamMember returns the member row for a team member", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedMemberActor(db, team.id, { displayName: "Mona", userId: "user-mona" });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.getCurrentTeamMember(team.id, "user-mona");
  assert.ok(result, "member should be found");
  assert.equal(result.id, actor.id);
  assert.equal(result.displayName, "Mona");
  assert.equal(result.role, "member");
  assert.ok(result.joinedAt, "joinedAt should be populated");
});

test("getCurrentTeamMember returns null for a non-member user", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  await seedMemberActor(db, team.id, { userId: "user-in" });
  const repo = createPgBusinessRepository({ db });

  const result = await repo.getCurrentTeamMember(team.id, "user-not-in-team");
  assert.equal(result, null);
});

// ── listActorDirectoryByIds ───────────────────────────────────────────────────

test("listActorDirectoryByIds returns directory-actor shape for given ids", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const a1 = await seedMemberActor(db, team.id, { displayName: "One" });
  const a2 = await seedMemberActor(db, team.id, { displayName: "Two" });
  const repo = createPgBusinessRepository({ db });

  const items = await repo.listActorDirectoryByIds([a1.id, a2.id], team.id);
  assert.equal(items.length, 2);
  const byId = new Map<string, any>(items.map((i: any) => [i.id, i]));
  assert.equal(byId.get(a1.id).displayName, "One");
  assert.equal(byId.get(a1.id).kind, "member");
  assert.equal(byId.get(a1.id).teamId, team.id);
  // Full directory shape keys present (email/phone null in pg view).
  assert.ok("email" in byId.get(a1.id));
  assert.ok("visibility" in byId.get(a1.id));
});

test("listActorDirectoryByIds returns [] for empty input", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const repo = createPgBusinessRepository({ db });
  assert.deepEqual(await repo.listActorDirectoryByIds([], team.id), []);
});

test("listActorDirectoryByIds scopes to the given team", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  const a = await seedMemberActor(db, teamA.id);
  const b = await seedMemberActor(db, teamB.id);
  const repo = createPgBusinessRepository({ db });

  const items = await repo.listActorDirectoryByIds([a.id, b.id], teamA.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, a.id);
});

test("listActorDirectoryByIds returns explicitly requested personal agents", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "owner-u" });
  const other = await seedMemberActor(db, team.id, { userId: "other-u" });
  const personalAgent = await seedAgentActor(db, team.id, owner.id, "private");
  // by-ids is a direct id lookup (supabase-repo parity): if the caller already
  // knows an actor id — e.g. from session participants — return its directory row.
  const repo = createPgBusinessRepository({ db, userId: "other-u" });

  const items = await repo.listActorDirectoryByIds([other.id, personalAgent.id], team.id);
  const ids = items.map((i: any) => i.id);
  assert.ok(ids.includes(other.id));
  assert.ok(ids.includes(personalAgent.id), "explicit id lookup must return the row");
  const personal = items.find((i: any) => i.id === personalAgent.id);
  assert.equal(personal?.displayName, "Bot");
});

test("listActorDirectoryByIds returns a personal agent without callerActorId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "owner-u" });
  const personalAgent = await seedAgentActor(db, team.id, owner.id, "private");
  const repo = createPgBusinessRepository({ db });

  const items = await repo.listActorDirectoryByIds([personalAgent.id], team.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, personalAgent.id);
  assert.equal(items[0].displayName, "Bot");
});

test("listActorDirectoryByIds returns a personal agent looking up itself", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, { userId: "owner-u" });
  const personalAgent = await seedAgentActor(db, team.id, owner.id, "private");
  const repo = createPgBusinessRepository({ db, callerActorId: personalAgent.id });

  const items = await repo.listActorDirectoryByIds([personalAgent.id], team.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, personalAgent.id);
  assert.equal(items[0].displayName, "Bot");
});
