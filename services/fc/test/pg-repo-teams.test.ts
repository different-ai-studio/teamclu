import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, teamWorkspaceConfig, actors, members, teamMembers, teamInvites, agents } from "../src/db/schema/index.js";

async function seedOwner(db: any) {
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Date.now()}-${Math.random()}` }).returning();
  const userId = crypto.randomUUID();
  const [actor] = await db.insert(actors).values({ teamId: t.id, actorType: "member", displayName: "Owner", userId }).returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: t.id, memberId: actor.id, role: "owner" });
  return { teamId: t.id, userId, actorId: actor.id };
}

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db.insert(teams).values({ name: "Acme", slug: "acme", ...over }).returning();
  return t;
}

test("listTeams returns mapped rows ordered by created_at", async () => {
  const { db } = await makeTestDb();
  await seedTeam(db, { name: "A", slug: "a" });
  await seedTeam(db, { name: "B", slug: "b" });
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const rows = await repo.listTeams({ limit: 50 });
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["createdAt","id","name","slug","visibility"]);
});

test("listAllMyTeams returns only teams the caller belongs to", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedOwner(db);
  await seedTeam(db, { name: "Other", slug: "other" });
  const repo = createPgBusinessRepository({ db, accessToken: "x", userId });
  const rows = await repo.listAllMyTeams();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, teamId);
  assert.equal(rows[0].orgId, null);
  assert.equal(rows[0].orgName, null);
});

test("listTeams with userId filters to caller membership", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedOwner(db);
  await seedTeam(db, { name: "Other", slug: "other" });
  const repo = createPgBusinessRepository({ db, accessToken: "x", userId });
  const rows = await repo.listTeams({ limit: 50 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, teamId);
});

test("getTeam returns one team or null", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const got = await repo.getTeam(t.id);
  assert.equal(got.id, t.id);
  assert.equal(got.name, "Acme");
  assert.equal(await repo.getTeam("00000000-0000-0000-0000-000000000000"), null);
});

test("renameTeam updates name", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const out = await repo.renameTeam(t.id, { name: "Renamed" });
  assert.equal(out.id, t.id);
  assert.equal(out.name, "Renamed");
});

test("get/putTeamWorkspaceConfig roundtrip; getWorkspaceConfig merges", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  assert.equal(await repo.getTeamWorkspaceConfig(t.id), null);
  await db.insert(teamWorkspaceConfig).values({ teamId: t.id, syncMode: "oss", litellmTeamId: "lt1" });
  const wc = await repo.getWorkspaceConfig(t.id);
  assert.equal(wc.syncMode, "oss");
  assert.equal(wc.litellmTeamId, "lt1");
  // Defaults for the new per-team LLM config block.
  assert.equal(wc.llm.enabled, false);
  assert.equal(wc.llm.baseUrl, null);
  assert.deepEqual(wc.llm.models, []);
});

test("setLlmConfig persists and getWorkspaceConfig round-trips stored llm config", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const saved = await repo.setLlmConfig(t.id, {
    enabled: true,
    baseUrl: "https://proxy.example.com/v1",
    models: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }],
  });
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.models, [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }]);

  const wc = await repo.getWorkspaceConfig(t.id);
  assert.equal(wc.llm.enabled, true);
  assert.equal(wc.llm.baseUrl, "https://proxy.example.com/v1");
  assert.deepEqual(wc.llm.models, [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }]);

  // Upsert update path: toggling off + replacing models.
  await repo.setLlmConfig(t.id, { enabled: false, baseUrl: null, models: [] });
  const wc2 = await repo.getWorkspaceConfig(t.id);
  assert.equal(wc2.llm.enabled, false);
  assert.equal(wc2.llm.baseUrl, null);
  assert.deepEqual(wc2.llm.models, []);
});

test("createTeam still succeeds when member-key provisioning throws", async () => {
  const { db } = await makeTestDb();
  const userId = crypto.randomUUID();
  const repo = createPgBusinessRepository({
    db,
    userId,
    provisionMemberKey: async () => { throw new Error("litellm down"); },
  });
  const team = await repo.createTeam({ name: "T", litellmTeamId: "lt-throws" });
  assert.ok(team.id);
});





test("createTeam requires userId context", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db, accessToken: "x" }); // no userId
  await assert.rejects(() => repo.createTeam({ name: "x" }), /userId is required|bad_request/i);
});

test("pg createTeamInvite persists kind and agentKind for agent invites", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedOwner(db);
  const repo = createPgBusinessRepository({ db, userId });
  const result = await repo.createTeamInvite(teamId, {
    kind: "agent", displayName: "Build Bot", agentKind: "claude", teamRole: null, targetActorId: null,
  });
  assert.ok(result.token, "token present");
  assert.ok(result.inviteId, "pg repo returns inviteId");
  const [row] = await db.select().from(teamInvites).where(eq(teamInvites.token, result.token));
  assert.equal(row.kind, "agent");
  assert.equal(row.agentKind, "claude");
});

test("pg createTeamInvite rejects re-invite by non-owner and allows owner", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId: ownerUser, actorId: ownerActor } = await seedOwner(db);
  const [agentActor] = await db.insert(actors).values({ teamId, actorType: "agent", displayName: "A1" }).returning();
  await db.insert(agents).values({ id: agentActor.id, agentKind: "claude", status: "active", visibility: "team", ownerMemberId: ownerActor });
  const otherUser = crypto.randomUUID();
  const [otherActor] = await db.insert(actors).values({ teamId, actorType: "member", displayName: "Other", userId: otherUser }).returning();
  await db.insert(members).values({ id: otherActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: otherActor.id, role: "member" });

  const otherRepo = createPgBusinessRepository({ db, userId: otherUser });
  await assert.rejects(
    () => otherRepo.createTeamInvite(teamId, { kind: "agent", displayName: "x", agentKind: "claude", targetActorId: agentActor.id }),
    /forbidden|owner/i,
  );
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUser });
  const ok = await ownerRepo.createTeamInvite(teamId, { kind: "agent", displayName: "x", agentKind: "claude", targetActorId: agentActor.id });
  assert.ok(ok.token);
});

// ── default-org invite guard (parity with supabase-repo.createTeamInvite) ────

test("pg createTeamInvite blocks member invites into a DEFAULT_ORG team but allows agent invites", async () => {
  const { db } = await makeTestDb();
  const prev = process.env.DEFAULT_ORG_ID;
  process.env.DEFAULT_ORG_ID = crypto.randomUUID();
  try {
    // Seed an owner whose team lives in the shared DEFAULT_ORG (oid = default org).
    const [t] = await db.insert(teams).values({ name: "Solo", slug: `solo-${Math.random()}`, oid: process.env.DEFAULT_ORG_ID }).returning();
    const userId = crypto.randomUUID();
    const [actor] = await db.insert(actors).values({ teamId: t.id, actorType: "member", displayName: "Owner", userId }).returning();
    await db.insert(members).values({ id: actor.id, status: "active" });
    await db.insert(teamMembers).values({ teamId: t.id, memberId: actor.id, role: "owner" });
    const repo = createPgBusinessRepository({ db, userId });

    // Member invite → upgrade_required (403).
    await assert.rejects(
      () => repo.createTeamInvite(t.id, { kind: "member", displayName: "Newbie" }),
      (err: any) => err?.statusCode === 403 && err?.code === "upgrade_required",
    );

    // Agent invite → still allowed (daemon amuxd init).
    const ok = await repo.createTeamInvite(t.id, { kind: "agent", displayName: "Bot", agentKind: "claude" });
    assert.ok(ok.token);
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

test("pg createTeamInvite allows member invites when team is not in the DEFAULT_ORG", async () => {
  const { db } = await makeTestDb();
  const prev = process.env.DEFAULT_ORG_ID;
  process.env.DEFAULT_ORG_ID = crypto.randomUUID();
  try {
    // Owner team carries no oid (Postgres backend default) → not a default-org team.
    const { teamId, userId } = await seedOwner(db);
    const repo = createPgBusinessRepository({ db, userId });
    const ok = await repo.createTeamInvite(teamId, { kind: "member", displayName: "Newbie" });
    assert.ok(ok.token);
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

// ── drift-parity: setLlmConfig / getWorkspaceConfig llm block ────────────────

test("setLlmConfig round-trips into getWorkspaceConfig llm block", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db, { name: "L", slug: `l-${Math.random()}` });
  const repo = createPgBusinessRepository({ db });

  const models = [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }];
  const out = await repo.setLlmConfig(t.id, { enabled: true, baseUrl: "https://gw.example/x", models });
  assert.deepEqual(out, { enabled: true, baseUrl: "https://gw.example/x", models });

  const cfg = await repo.getWorkspaceConfig(t.id);
  assert.ok(cfg.llm, "llm block present");
  assert.equal(cfg.llm.enabled, true);
  assert.equal(cfg.llm.baseUrl, "https://gw.example/x");
  assert.deepEqual(cfg.llm.models, models);
  // aiGatewayEndpoint not set → null
  assert.equal(cfg.llm.aiGatewayEndpoint, null);
});

test("getWorkspaceConfig llm block defaults for fresh team", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db, { name: "F", slug: `f-${Math.random()}` });
  const repo = createPgBusinessRepository({ db });
  const cfg = await repo.getWorkspaceConfig(t.id);
  assert.deepEqual(cfg.llm, {
    enabled: false,
    baseUrl: null,
    models: [],
    aiGatewayEndpoint: null,
  });
});

// ── drift-parity: listAllMyTeams ────────────────────────────────────────────

test("listAllMyTeams lists all teams the caller has an actor in", async () => {
  const { db } = await makeTestDb();
  const { teamId: t1, userId } = await seedOwner(db);
  // second team, same user is an actor
  const [t2] = await db.insert(teams).values({ name: "T2", slug: `t2-${Math.random()}` }).returning();
  await db.insert(actors).values({ teamId: t2.id, actorType: "member", displayName: "Me", userId });
  // a third team the user is NOT part of
  await db.insert(teams).values({ name: "T3", slug: `t3-${Math.random()}` }).returning();

  const repo = createPgBusinessRepository({ db, userId });
  const rows = await repo.listAllMyTeams();
  const ids = rows.map((r: any) => r.id).sort();
  assert.deepEqual(ids, [t1, t2.id].sort());
  // Shape parity with supabase-repo.listAllMyTeams — the client maps both
  // backends through one type, so a key that exists on only one is a bug.
  // This list had fallen behind twice over: `visibility`/`isMember` were added
  // without it, and then createdAt/memberCount/ownerName for picker
  // disambiguation.
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "createdAt", "id", "isMember", "memberCount", "name",
    "orgId", "orgName", "ownerName", "slug", "visibility",
  ]);
  assert.equal(rows[0].orgId, null);
  assert.equal(rows[0].orgName, null);
});

test("listAllMyTeams requires userId context", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  await assert.rejects(() => repo.listAllMyTeams(), /missing_auth|authenticated/i);
});

// ── drift-parity: team workspace config ─────────────────────────────────────




