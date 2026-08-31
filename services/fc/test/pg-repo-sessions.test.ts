/**
 * pg-repo-sessions — UUID-seed pglite tests asserting the SESSIONS + PARTICIPANTS domain.
 *
 * Follows the same pattern as pg-repo-ideas.test.ts:
 * - makeTestDb() → fresh in-process pglite with migrations applied.
 * - Seed helpers insert teams + actors.
 * - Each test constructs its own repo instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import {
  teams,
  actors,
  members,
  teamMembers,
  sessions,
  sessionParticipants,
  agents,
} from "../src/db/schema/index.js";

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

async function seedPersonalAgent(
  db: any,
  teamId: string,
  ownerMemberId: string,
  displayName = "MDC",
) {
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId, actorType: "agent", displayName })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "pi",
    status: "active",
    visibility: "personal",
    ownerMemberId,
  });
  return agentActor;
}

// ── listSessions ──────────────────────────────────────────────────────────────

test("listSessions returns canonical contract keys for actor-visible sessions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  // Identity flows through ctx.userId; teamId is a required narrowing filter,
  // and actorId is still never supplied by the route.
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.createSession({ teamId: team.id, title: "Alpha", mode: "solo", participantActorIds: [actor.id] });
  await repo.createSession({ teamId: team.id, title: "Beta", mode: "solo", participantActorIds: [actor.id] });

  const rows = await repo.listSessions({ teamId: team.id, limit: 50, cursor: null });
  assert.ok(Array.isArray(rows), "listSessions should return an array");
  assert.ok(rows.length >= 2, "should see 2 sessions");

  const contractKeys = [
    "id", "teamId", "title", "mode", "ideaId",
    "lastMessageAt", "lastMessagePreview", "hasUnread",
    "source", "cronJobId",
    // Display-row fields, previously only on GET /v1/teams/:teamId/sessions.
    "summary", "primaryAgentId", "createdByActorId", "participantCount",
    "createdAt", "updatedAt",
  ].sort();
  assert.deepEqual(Object.keys(rows[0]).sort(), contractKeys);
  assert.equal(rows[0].participantCount, 1, "the seeded participant must be counted");
});

test("listSessions narrows by teamId and ideaId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const withIdea = await repo.createSession({
    teamId: team.id, title: "HasIdea", mode: "solo", participantActorIds: [actor.id],
  });
  await repo.createSession({
    teamId: team.id, title: "NoIdea", mode: "solo", participantActorIds: [actor.id],
  });
  // Give exactly one session an idea to filter on.
  const ideaId = randomUUID();
  await db.execute(sql`UPDATE sessions SET idea_id = ${ideaId} WHERE id = ${withIdea.id}`);

  const teamScoped = await repo.listSessions({ teamId: team.id, limit: 50, cursor: null });
  assert.equal(teamScoped.length, 2, "both sessions belong to the team");

  const ideaScoped = await repo.listSessions({ teamId: team.id, ideaId, limit: 50, cursor: null });
  assert.deepEqual(ideaScoped.map((r: any) => r.title), ["HasIdea"]);

  const otherTeam = await repo.listSessions({ teamId: randomUUID(), limit: 50, cursor: null });
  assert.deepEqual(otherTeam, [], "a foreign teamId must not leak rows");
});

test("listSessions filters session kind before pagination", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const regular = await repo.createSession({
    teamId: team.id, title: "Regular", mode: "solo", participantActorIds: [actor.id],
  });
  const cron = await repo.createSession({
    teamId: team.id, title: "Cron", mode: "solo", participantActorIds: [actor.id],
  });
  await db.execute(sql`UPDATE sessions SET source = 'user' WHERE id = ${regular.id}`);
  await db.execute(sql`UPDATE sessions SET source = 'cron' WHERE id = ${cron.id}`);

  const regularRows = await repo.listSessions({
    teamId: team.id, kind: "regular", limit: 1, cursor: null,
  });
  const cronRows = await repo.listSessions({
    teamId: team.id, kind: "cron", limit: 1, cursor: null,
  });

  assert.deepEqual(regularRows.map((row: any) => row.title), ["Regular"]);
  assert.deepEqual(cronRows.map((row: any) => row.title), ["Cron"]);
});

test("listSessions ordering: lastMessageAt desc nulls last, then createdAt desc, then id desc", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  // Create two sessions; neither has lastMessageAt set (null)
  await repo.createSession({ teamId: team.id, title: "First", mode: "solo", participantActorIds: [actor.id] });
  await new Promise((r) => setTimeout(r, 5)); // tiny delay to ensure createdAt ordering
  await repo.createSession({ teamId: team.id, title: "Second", mode: "solo", participantActorIds: [actor.id] });

  const rows = await repo.listSessions({ teamId: team.id, limit: 50, cursor: null });
  assert.ok(rows.length >= 2);

  // Verify ordering: null lastMessageAt rows sorted by createdAt desc
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const prevLast = prev.lastMessageAt ?? "";
    const currLast = curr.lastMessageAt ?? "";
    if (prevLast !== currLast) {
      assert.ok(currLast.localeCompare(prevLast) <= 0, "lastMessageAt must be desc");
    } else {
      // same lastMessageAt, check createdAt desc
      const prevCreated = prev.createdAt ?? "";
      const currCreated = curr.createdAt ?? "";
      if (prevCreated !== currCreated) {
        assert.ok(currCreated.localeCompare(prevCreated) <= 0, "createdAt must be desc");
      } else {
        assert.ok(curr.id.localeCompare(prev.id) <= 0, "id must be desc");
      }
    }
  }
});

test("listSessions cursor continues through rows with the same lastMessageAt", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const oldest = await repo.createSession({ teamId: team.id, title: "Oldest", mode: "solo", participantActorIds: [actor.id] });
  const middle = await repo.createSession({ teamId: team.id, title: "Middle", mode: "solo", participantActorIds: [actor.id] });
  const newest = await repo.createSession({ teamId: team.id, title: "Newest", mode: "solo", participantActorIds: [actor.id] });
  const sharedLastMessageAt = new Date("2026-05-27T10:00:00.000Z");

  await db
    .update(sessions)
    .set({ lastMessageAt: sharedLastMessageAt, createdAt: new Date("2026-05-27T09:57:00.000Z") })
    .where(eq(sessions.id, oldest.id));
  await db
    .update(sessions)
    .set({ lastMessageAt: sharedLastMessageAt, createdAt: new Date("2026-05-27T09:58:00.000Z") })
    .where(eq(sessions.id, middle.id));
  await db
    .update(sessions)
    .set({ lastMessageAt: sharedLastMessageAt, createdAt: new Date("2026-05-27T09:59:00.000Z") })
    .where(eq(sessions.id, newest.id));

  const firstPage = await repo.listSessions({ teamId: team.id, limit: 1, cursor: null });
  assert.deepEqual(firstPage.map((row: any) => row.title), ["Newest"]);

  const secondPage = await repo.listSessions({
    teamId: team.id,
    limit: 2,
    cursor: {
      lastMessageAt: firstPage[0].lastMessageAt,
      createdAt: firstPage[0].createdAt,
      id: firstPage[0].id,
    },
  });

  assert.deepEqual(secondPage.map((row: any) => row.title), ["Middle", "Oldest"]);
});

test("listSessions team-scopes: a user only sees sessions where their actor participates", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  // Two DIFFERENT users, one actor each in separate teams.
  const actorA = await seedActor(db, teamA.id);
  const actorB = await seedActor(db, teamB.id);
  // Write path is a trusted caller — no identity needed.
  const writer = createPgBusinessRepository({ db });
  await writer.createSession({ teamId: teamA.id, title: "A-Session", mode: "solo", participantActorIds: [actorA.id] });
  await writer.createSession({ teamId: teamB.id, title: "B-Session", mode: "solo", participantActorIds: [actorB.id] });

  // Each user's list is resolved purely from their own ctx.userId.
  const repoA = createPgBusinessRepository({ db, userId: actorA.userId });
  const repoB = createPgBusinessRepository({ db, userId: actorB.userId });
  const rowsA = await repoA.listSessions({ teamId: teamA.id, limit: 50, cursor: null });
  const rowsB = await repoB.listSessions({ teamId: teamB.id, limit: 50, cursor: null });

  assert.ok(rowsA.every((r: any) => r.teamId === teamA.id), "userA should only see teamA sessions");
  assert.ok(rowsB.every((r: any) => r.teamId === teamB.id), "userB should only see teamB sessions");
  assert.ok(!rowsA.find((r: any) => r.title === "B-Session"), "userA must not see teamB session");
});

// ── getSession ────────────────────────────────────────────────────────────────

test("getSession returns session with participants array", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const created = await repo.createSession({
    teamId: team.id, title: "WithParticipants", mode: "solo",
    participantActorIds: [actor.id],
  });

  const found = await repo.getSession(created.id);
  assert.ok(found, "session should be found");
  assert.equal(found.id, created.id);
  assert.ok(Array.isArray(found.participants), "participants should be an array");
  assert.ok(found.participants.length >= 1, "should have at least 1 participant");
});

test("getSession returns null for missing session", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  const result = await repo.getSession("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});

// ── createSession ─────────────────────────────────────────────────────────────

test("createSession returns session with participants", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({
    teamId: team.id, title: "New Session", mode: "collab",
    participantActorIds: [actor.id],
  });

  assert.ok(s);
  assert.equal(s.title, "New Session");
  assert.equal(s.teamId, team.id);
  assert.ok(Array.isArray(s.participants));
  assert.ok(typeof s.id === "string");
  assert.ok(typeof s.createdAt === "string");
});

test("createSession resolves createdByActorId from ctx.userId when omitted", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const userId = "user-create-session-test";
  const actor = await seedActor(db, team.id, { userId });
  const repo = createPgBusinessRepository({ db, userId });

  const s = await repo.createSession({
    teamId: team.id,
    title: "Resolved creator",
    mode: "collab",
    participantActorIds: [actor.id],
  });

  assert.equal(s.createdByActorId, actor.id);
  assert.ok(s.participants.some((p: any) => p.actorId === actor.id));
});

test("createSession ignores client-supplied createdByActorId (server authoritative)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const userId = "user-authoritative-creator";
  const actor = await seedActor(db, team.id, { userId });
  const repo = createPgBusinessRepository({ db, userId });

  // Client sends a DIFFERENT actor id (e.g. stale current-team value from a
  // multi-team user). It must be ignored and the row must carry the
  // server-resolved team actor so it satisfies the sessions INSERT RLS.
  const s = await repo.createSession({
    teamId: team.id,
    title: "Spoofed creator",
    mode: "collab",
    createdByActorId: "00000000-0000-0000-0000-000000000000",
    participantActorIds: [actor.id],
  });

  assert.equal(s.createdByActorId, actor.id);
});

test("createSession with explicit id respects the client-generated id", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const explicitId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const s = await repo.createSession({
    id: explicitId,
    teamId: team.id, title: "Explicit ID", mode: "solo",
    participantActorIds: [actor.id],
  });
  assert.equal(s.id, explicitId);
});

// ── patchSession ──────────────────────────────────────────────────────────────

test("patchSession mutates title", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "Original", mode: "solo", participantActorIds: [actor.id] });
  const patched = await repo.patchSession(s.id, { title: "Updated" });
  assert.ok(patched);
  assert.equal(patched.title, "Updated");
  assert.equal(patched.id, s.id);
});

// ── markSessionViewed ─────────────────────────────────────────────────────────

test("markSessionViewed upserts a read marker (resolved from ctx.userId)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  // Actor is resolved server-side from the authenticated user.
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const s = await repo.createSession({ teamId: team.id, title: "ViewMe", mode: "solo", participantActorIds: [actor.id] });
  await repo.markSessionViewed(s.id);
  // Calling again should be idempotent
  await repo.markSessionViewed(s.id);
});

test("markSessionViewed fails closed with no identity and no trusted actor", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db }); // no userId

  const s = await repo.createSession({ teamId: team.id, title: "NoId", mode: "solo", participantActorIds: [actor.id] });
  await assert.rejects(() => repo.markSessionViewed(s.id), /missing_auth|cannot resolve actor/i);
});

test("markSessionViewed throws 403 when authenticated user is not a member of the session's team", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  const actorA = await seedActor(db, teamA.id);
  const outsider = await seedActor(db, teamB.id); // user with no actor in teamA

  const writer = createPgBusinessRepository({ db });
  const s = await writer.createSession({ teamId: teamA.id, title: "TeamA", mode: "solo", participantActorIds: [actorA.id] });

  const repo = createPgBusinessRepository({ db, userId: outsider.userId });
  await assert.rejects(() => repo.markSessionViewed(s.id), /forbidden|not a member/i);
});

// ── hasUnread ────────────────────────────────────────────────────────────────

test("hasUnread is false after markSessionViewed", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const s = await repo.createSession({ teamId: team.id, title: "UnreadTest", mode: "solo", participantActorIds: [actor.id] });
  await repo.markSessionViewed(s.id);

  const rows = await repo.listSessions({ teamId: team.id, limit: 50, cursor: null });
  const found = rows.find((r: any) => r.id === s.id);
  assert.ok(found);
  assert.equal(found.hasUnread, false);
});

// ── markSessionUnread ──────────────────────────────────────────────────────────

test("markSessionUnread deletes the caller's read marker", async () => {
  const { db, pg } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const s = await repo.createSession({ teamId: team.id, title: "UnreadAgain", mode: "solo", participantActorIds: [actor.id] });
  await repo.markSessionViewed(s.id);
  const before = await pg.query("SELECT count(*)::int AS n FROM session_read_markers WHERE session_id = $1", [s.id]);
  assert.equal((before.rows[0] as { n: number }).n, 1);

  await repo.markSessionUnread(s.id);
  const after = await pg.query("SELECT count(*)::int AS n FROM session_read_markers WHERE session_id = $1", [s.id]);
  assert.equal((after.rows[0] as { n: number }).n, 0);
});

test("markSessionUnread fails closed with no identity and no trusted actor", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db }); // no userId

  const s = await repo.createSession({ teamId: team.id, title: "NoIdUnread", mode: "solo", participantActorIds: [actor.id] });
  await assert.rejects(() => repo.markSessionUnread(s.id), /missing_auth|cannot resolve actor/i);
});

// ── getSessionByAcp ───────────────────────────────────────────────────────────

test("getSessionByAcp returns null when absent", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  const out = await repo.getSessionByAcp("acp-does-not-exist");
  assert.equal(out, null);
});

// ── ensureGatewaySession ──────────────────────────────────────────────────────

test("ensureGatewaySession is idempotent: first call created=true, second created=false", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const first = await repo.ensureGatewaySession({
    teamId: team.id,
    binding: `wecom:room#${Math.random()}`,
    title: "Stand-up",
    primaryAgentActorId: actor.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  });
  assert.ok(first.sessionId, "sessionId should be present");
  assert.ok(first.gatewaySessionId, "gatewaySessionId should be present");
  assert.equal(first.created, true, "first call should be created=true");

  const second = await repo.ensureGatewaySession({
    teamId: team.id,
    binding: first.gatewaySessionId, // re-use the binding stored in the session
    title: "Stand-up",
    primaryAgentActorId: actor.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  });
  assert.equal(second.created, false, "second call should not create new session");
  assert.equal(second.sessionId, first.sessionId, "sessionId should be identical");
});

test("ensureGatewaySession adds participants that appeared after the session was created", async () => {
  // A gateway session is keyed by (teamId, binding) and outlives the daemon
  // that opened it: re-onboarding mints a new agent actor, and admin owners
  // can be granted access later. Writing participants only on create left
  // those chats working end to end but absent from every session list, which
  // filters on participation alone.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const oldAgent = await seedActor(db, team.id, { kind: "agent" });
  const newAgent = await seedActor(db, team.id, { kind: "agent" });
  const owner = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const binding = `wecom:room#${Math.random()}`;
  const first = await repo.ensureGatewaySession({
    teamId: team.id,
    binding,
    title: "WeCom DM",
    primaryAgentActorId: oldAgent.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  });

  // Same chat, after a re-onboard: different agent, and an owner now exists.
  const second = await repo.ensureGatewaySession({
    teamId: team.id,
    binding,
    title: "WeCom DM",
    primaryAgentActorId: newAgent.id,
    ownerMemberActorIds: [owner.id],
    participantActorIds: [],
  });
  assert.equal(second.created, false);
  assert.equal(second.sessionId, first.sessionId);

  const rows = await db
    .select()
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, first.sessionId));
  const actorIds = rows.map((r: any) => r.actorId).sort();
  assert.deepEqual(
    actorIds,
    [oldAgent.id, newAgent.id, owner.id].sort(),
    "the live agent and the new owner must be joined to the existing session",
  );
});

test("ensureGatewaySession different bindings in same team create different sessions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const binding1 = `wecom:room#1-${Math.random()}`;
  const binding2 = `wecom:room#2-${Math.random()}`;

  const r1 = await repo.ensureGatewaySession({ teamId: team.id, binding: binding1, title: "Room1", primaryAgentActorId: actor.id, ownerMemberActorIds: [], participantActorIds: [] });
  const r2 = await repo.ensureGatewaySession({ teamId: team.id, binding: binding2, title: "Room2", primaryAgentActorId: actor.id, ownerMemberActorIds: [], participantActorIds: [] });

  assert.notEqual(r1.sessionId, r2.sessionId);
  assert.equal(r1.created, true);
  assert.equal(r2.created, true);
});

// ── listGatewaySessions / attachGatewaySession ────────────────────────────────

test("a chat's whole lineage stays listable across detach, and attach switches back", async () => {
  // `/new` detaches the binding, which is what makes the next message open a
  // fresh session. Before `gateway_key` that was a one-way door: the detached
  // row had no trace of which chat it came from, so nothing could name it.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { kind: "agent" });
  const repo = createPgBusinessRepository({ db });
  const binding = `wecom:room#${Math.random()}`;

  const first = await repo.ensureGatewaySession({
    teamId: team.id,
    binding,
    title: "WeCom DM: LiangLiang",
    primaryAgentActorId: actor.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  });
  const firstAcp = `acp-${Math.random()}`;
  await db.update(sessions).set({ acpSessionId: firstAcp }).where(eq(sessions.id, first.sessionId));

  // /new
  const detached = await repo.detachGatewaySession(firstAcp);
  assert.equal(detached.detached, true);

  // Next message opens a second session under the same binding.
  const second = await repo.ensureGatewaySession({
    teamId: team.id,
    binding,
    title: "WeCom DM: LiangLiang",
    primaryAgentActorId: actor.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  });
  assert.equal(second.created, true, "detaching must free the binding");
  assert.notEqual(second.sessionId, first.sessionId);

  const listed = await repo.listGatewaySessions({ teamId: team.id, gatewayKey: binding });
  assert.equal(listed.items.length, 2, "both generations must be listed");
  const current = listed.items.filter((i: any) => i.isCurrent);
  assert.equal(current.length, 1, "exactly one session is current");
  assert.equal(current[0].sessionId, second.sessionId);
  assert.ok(
    listed.items.some((i: any) => i.sessionId === first.sessionId && !i.isCurrent),
    "the detached session must be listed, not current",
  );

  // /sessions <n> back to the first one.
  const attached = await repo.attachGatewaySession({ binding, sessionId: first.sessionId });
  assert.equal(attached.attached, true);
  assert.equal(attached.acpSessionId, firstAcp, "the target's ACP id is what resumes");

  const afterSwitch = await repo.listGatewaySessions({ teamId: team.id, gatewayKey: binding });
  const nowCurrent = afterSwitch.items.filter((i: any) => i.isCurrent);
  assert.equal(nowCurrent.length, 1, "the binding is unique: only one holder");
  assert.equal(nowCurrent[0].sessionId, first.sessionId);

  // The session that gave up the binding keeps its history and stays listed.
  const [displaced] = await db.select().from(sessions).where(eq(sessions.id, second.sessionId));
  assert.equal(displaced.binding, null);
  assert.equal(displaced.gatewayKey, binding);
});

test("attachGatewaySession refuses a session belonging to another chat", async () => {
  // The guard is what stops one chat from hijacking another's conversation:
  // the daemon calls this as its agent actor for whatever number a user typed.
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { kind: "agent" });
  const repo = createPgBusinessRepository({ db });

  const mine = `wecom:room#mine-${Math.random()}`;
  const theirs = `wecom:room#theirs-${Math.random()}`;
  const args = {
    teamId: team.id,
    title: "chat",
    primaryAgentActorId: actor.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  };
  await repo.ensureGatewaySession({ ...args, binding: mine });
  const other = await repo.ensureGatewaySession({ ...args, binding: theirs });

  const out = await repo.attachGatewaySession({ binding: mine, sessionId: other.sessionId });
  assert.equal(out.attached, false);
  assert.equal(out.sessionId, null);

  // And the other chat kept its own binding.
  const [row] = await db.select().from(sessions).where(eq(sessions.id, other.sessionId));
  assert.equal(row.binding, theirs);
});

test("listGatewaySessions only returns the requested chat's sessions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { kind: "agent" });
  const repo = createPgBusinessRepository({ db });

  const a = `wecom:room#a-${Math.random()}`;
  const b = `wecom:room#b-${Math.random()}`;
  const args = {
    teamId: team.id,
    title: "chat",
    primaryAgentActorId: actor.id,
    ownerMemberActorIds: [],
    participantActorIds: [],
  };
  const inA = await repo.ensureGatewaySession({ ...args, binding: a });
  await repo.ensureGatewaySession({ ...args, binding: b });

  const listed = await repo.listGatewaySessions({ teamId: team.id, gatewayKey: a });
  assert.deepEqual(
    listed.items.map((i: any) => i.sessionId),
    [inA.sessionId],
  );
});

// ── createCronSession ─────────────────────────────────────────────────────────

test("createCronSession returns sessionId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const out = await repo.createCronSession({
    teamId: team.id,
    primaryAgentActorId: actor.id,
    title: "Daily summary",
  });
  assert.ok(out.sessionId, "sessionId should be present");
});

// ── listSessionsForTeamSince ──────────────────────────────────────────────────

test("listSessionsForTeamSince returns sessions updated after timestamp", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const before = new Date(Date.now() - 10000).toISOString();
  await repo.createSession({ teamId: team.id, title: "SinceTest", mode: "solo", participantActorIds: [actor.id] });

  const rows = await repo.listSessionsForTeamSince(team.id, before);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  // Sync rows are snake_case (consumed directly by the client's lib/sync/*).
  const r = rows[0];
  assert.ok("team_id" in r && "created_at" in r && "primary_agent_id" in r, "must be snake_case");
  assert.ok(!("teamId" in r), "must not leak camelCase keys");
});

// ── listSessionDisplayRows ────────────────────────────────────────────────────

test("listSessionDisplayRows returns id+title pairs", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "DisplayRow", mode: "solo", participantActorIds: [actor.id] });
  const rows = await repo.listSessionDisplayRows(team.id, [s.id]);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok(rows[0].id);
  assert.ok(rows[0].title);
});

test("listSessionDisplayRows returns empty array for empty input", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  const rows = await repo.listSessionDisplayRows("team-1", []);
  assert.deepEqual(rows, []);
});

// ── listSessionIdsForActor ────────────────────────────────────────────────────

test("listSessionIdsForActor returns session ids", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "ForActor", mode: "solo", participantActorIds: [actor.id] });
  const ids = await repo.listSessionIdsForActor(actor.id);
  assert.ok(Array.isArray(ids));
  assert.ok(ids.includes(s.id));
});

// ── listSessionParticipants ───────────────────────────────────────────────────

test("listSessionParticipants returns items array", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "Participants", mode: "solo", participantActorIds: [actor.id] });
  const out = await repo.listSessionParticipants(s.id);
  assert.ok(out);
  assert.ok(Array.isArray(out.items));
  assert.ok(out.items.length >= 1);
  const p = out.items[0];
  assert.ok(p.actorId, "actorId should be present");
  assert.ok("role" in p, "role key should be present");
});

// ── upsertSessionParticipant ──────────────────────────────────────────────────

test("upsertSessionParticipant returns participant with actorId and role", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const actor2 = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "Upsert", mode: "solo", participantActorIds: [actor.id] });
  const p = await repo.upsertSessionParticipant(s.id, { actorId: actor2.id, role: "guest" });
  assert.equal(p.actorId, actor2.id);
  assert.equal(p.role, "guest");

  // Upsert again (update role)
  const p2 = await repo.upsertSessionParticipant(s.id, { actorId: actor2.id, role: "owner" });
  assert.equal(p2.actorId, actor2.id);
  assert.equal(p2.role, "owner");
});

// ── removeSessionParticipant ──────────────────────────────────────────────────

test("removeSessionParticipant removes participant (no throw)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const actor2 = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "Remove", mode: "solo", participantActorIds: [actor.id, actor2.id] });
  await repo.removeSessionParticipant(s.id, actor2.id);

  const out = await repo.listSessionParticipants(s.id);
  assert.ok(!out.items.find((p: any) => p.actorId === actor2.id), "participant should be removed");
});

// ── listSessionParticipantsForSync ────────────────────────────────────────────

test("listSessionParticipantsForSync returns participant rows", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const s = await repo.createSession({ teamId: team.id, title: "Sync", mode: "solo", participantActorIds: [actor.id] });
  const rows = await repo.listSessionParticipantsForSync(s.id, null);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  const r = rows[0];
  assert.ok("session_id" in r && "actor_id" in r && "joined_at" in r, "must be snake_case");
  assert.ok(!("sessionId" in r), "must not leak camelCase keys");
});

// ── listSessionRoster ─────────────────────────────────────────────────────────

test("listSessionRoster returns personal agent display name for caller agent", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id, { userId: "member-u" });
  const personalAgent = await seedPersonalAgent(db, team.id, member.id, "MDC");
  const repo = createPgBusinessRepository({ db, callerActorId: personalAgent.id });

  const s = await repo.createSession({
    teamId: team.id,
    title: "Roster",
    mode: "collab",
    participantActorIds: [member.id, personalAgent.id],
  });
  const out = await repo.listSessionRoster(s.id);

  assert.equal(out.sessionId, s.id);
  assert.equal(out.callerActorId, personalAgent.id);
  assert.equal(out.title, "Roster");
  assert.ok(out.selfAgent, "personal agent caller should include selfAgent metadata");
  assert.equal(out.selfAgent.visibility, "personal");
  assert.equal(out.selfAgent.ownerMemberId, member.id);
  assert.equal(out.selfAgent.ownerDisplayName, "Test Actor");
  const self = out.items.find((item: any) => item.actorId === personalAgent.id);
  assert.ok(self, "personal agent should appear in roster");
  assert.equal(self.displayName, "MDC");
  assert.equal(self.kind, "agent");
  assert.equal(self.isSelf, true);

  const human = out.items.find((item: any) => item.actorId === member.id);
  assert.ok(human);
  assert.equal(human.displayName, "Test Actor");
  assert.equal(human.kind, "member");
  assert.equal(human.isSelf, false);
});

test("listSessionRoster rejects non-participants", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id);
  const outsider = await seedActor(db, team.id);
  const personalAgent = await seedPersonalAgent(db, team.id, member.id);
  const repo = createPgBusinessRepository({ db, callerActorId: outsider.id });

  const s = await repo.createSession({
    teamId: team.id,
    title: "Private roster",
    mode: "solo",
    participantActorIds: [member.id, personalAgent.id],
  });

  await assert.rejects(
    () => repo.listSessionRoster(s.id),
    (err: any) => err.code === "forbidden",
  );
});
