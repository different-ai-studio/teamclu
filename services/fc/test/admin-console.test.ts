import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { aiGateway } from "../src/lib/ai-gateway.js";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { ADMIN_LIST_CAP, clampPage, safeSearch } from "../src/lib/platform-operators.js";

/**
 * The operator console's org / team / credit endpoints.
 *
 * The reads go through the service role (an operator is not a member of what
 * they are looking at), and the money numbers still come from the gateway — so
 * the tests pin both: which table was asked for with which filters, and that
 * FC never reads the ledger itself.
 */

const OPERATOR = "0b5b7c1e-3d0a-4c65-9d2f-6a1e0f7c2b11";
const OUTSIDER = "7f3e2a10-9c4b-4e8d-a1f6-2b7d5c0e9a33";
const ORG = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

function withOperators(t: any, ids: string) {
  const prev = process.env.PLATFORM_OPERATOR_USER_IDS;
  process.env.PLATFORM_OPERATOR_USER_IDS = ids;
  t.after(() => {
    if (prev === undefined) delete process.env.PLATFORM_OPERATOR_USER_IDS;
    else process.env.PLATFORM_OPERATOR_USER_IDS = prev;
  });
}

type Query = { schema: string; table: string; select?: string; filters: string[]; range?: [number, number] };

/**
 * Enough of supabase-js's builder to record what was asked and answer with
 * canned rows, keyed by `<schema>.<table>`.
 */
function fakeServiceRoleClient(rows: Record<string, any[]>, seen: Query[]) {
  const client: any = {
    schema(schema: string) {
      return {
        from(table: string) {
          const q: Query = { schema, table, filters: [] };
          seen.push(q);
          const data = () => rows[`${schema}.${table}`] ?? [];
          const builder: any = {
            select(sel: string) { q.select = sel; return builder },
            eq(col: string, val: unknown) { q.filters.push(`eq:${col}=${val}`); return builder },
            in(col: string, vals: unknown[]) { q.filters.push(`in:${col}=${vals.join("|")}`); return builder },
            or(expr: string) { q.filters.push(`or:${expr}`); return builder },
            order() { return builder },
            update(patch: Record<string, unknown>) { q.filters.push(`update:${JSON.stringify(patch)}`); return builder },
            range(from: number, to: number) { q.range = [from, to]; return Promise.resolve({ data: data(), error: null, count: data().length }) },
            maybeSingle() { return Promise.resolve({ data: data()[0] ?? null, error: null }) },
            then(resolve: any) { return Promise.resolve({ data: data(), error: null, count: data().length }).then(resolve) },
          };
          return builder;
        },
      };
    },
  };
  return client;
}

function repoFor(userId: string, rows: Record<string, any[]> = {}) {
  const seen: Query[] = [];
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    trustedExternalJwtSecret: "",
    createServiceRoleClient: () => fakeServiceRoleClient(rows, seen),
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
      from: () => { throw new Error("the caller's own client must not be used for operator reads") },
      rpc: () => { throw new Error("not reached") },
    }),
  } as any) as any;
  return { repo, seen };
}

const ORG_ROW = { id: ORG, name: "Acme", code: "acme", status: "active", created_at: "2026-09-01T00:00:00Z" };
const TEAM_ROW = { id: TEAM, slug: "acme-core", name: "Core", created_at: "2026-09-02T00:00:00Z", oid: ORG };

// ── helpers ─────────────────────────────────────────────────────────────────

test("a page size is clamped, and a search term cannot smuggle a filter", () => {
  assert.equal(clampPage(undefined, 25), 25);
  assert.equal(clampPage("50", 25), 50);
  assert.equal(clampPage(0, 25), 25);
  assert.equal(clampPage(9999, 25), 200);
  // PostgREST parses `or=(...)` as a comma-separated list: a comma in the term
  // would silently become a different filter rather than an error.
  assert.equal(safeSearch("acme,status.eq.deleted"), "acmestatus.eq.deleted");
  assert.equal(safeSearch(" a%b_c "), "abc");
  assert.equal(safeSearch("x".repeat(200)).length, 80);
});

// ── orgs ────────────────────────────────────────────────────────────────────

test("orgs are listed with team and member counts, and only for an operator", async (t) => {
  withOperators(t, OPERATOR);
  const rows = {
    "public.orgs": [ORG_ROW],
    "amux.teams": [{ id: TEAM, oid: ORG }, { id: "t2", oid: ORG }],
    "amux.actors": [
      { team_id: TEAM, user_id: "u1", actor_type: "member" },
      { team_id: "t2", user_id: "u1", actor_type: "member" },
      { team_id: "t2", user_id: "u2", actor_type: "member" },
    ],
  };

  const denied = repoFor(OUTSIDER, rows);
  await assert.rejects(denied.repo.listAdminOrgs(), (e: any) => e.statusCode === 403);
  assert.deepEqual(denied.seen, [], "nothing is read for a caller who may not look");

  const { repo, seen } = repoFor(OPERATOR, rows);
  const out = await repo.listAdminOrgs({ query: "acme", limit: 10 });
  assert.deepEqual(out.items, [
    { id: ORG, name: "Acme", code: "acme", status: "active", createdAt: "2026-09-01T00:00:00Z", teamCount: 2, memberCount: 2 },
  ]);
  assert.equal(out.total, 1);
  // One person in two teams of the org counts once.
  assert.ok(seen.some((q) => q.table === "orgs" && q.filters.some((f) => f.startsWith("or:"))));
  assert.ok(seen.some((q) => q.table === "actors" && q.filters.includes("eq:actor_type=member")));
});

test("an org rename records the operator where the audit trigger cannot", async (t) => {
  withOperators(t, OPERATOR);
  const { repo, seen } = repoFor(OPERATOR, { "public.orgs": [{ ...ORG_ROW, name: "Acme Inc" }] });
  t.mock.method(console, "log", () => {});

  const out = await repo.updateAdminOrg(ORG, { name: "Acme Inc" });
  assert.equal(out.name, "Acme Inc");
  const update = seen.find((q) => q.filters.some((f) => f.startsWith("update:")));
  const patch = JSON.parse(update!.filters.find((f) => f.startsWith("update:"))!.slice("update:".length));
  assert.equal(patch.name, "Acme Inc");
  // The table's trigger overwrites updated_by with auth.uid(), which is null
  // under the service role, so identity has to ride in the note.
  assert.match(patch.updated_note, new RegExp(OPERATOR));
  assert.equal("updated_by" in patch, false);
});

test("an org patch refuses what it should not write", async (t) => {
  withOperators(t, OPERATOR);
  const { repo } = repoFor(OPERATOR, { "public.orgs": [ORG_ROW] });
  await assert.rejects(repo.updateAdminOrg(ORG, {}), (e: any) => e.statusCode === 400);
  await assert.rejects(repo.updateAdminOrg(ORG, { name: "  " }), (e: any) => e.statusCode === 400);
  await assert.rejects(repo.updateAdminOrg(ORG, { name: "x".repeat(101) }), (e: any) => e.statusCode === 400);
  // saas-mono owns this column's vocabulary on Belayo; the console writes two
  // values or nothing.
  await assert.rejects(repo.updateAdminOrg(ORG, { status: "deleted" }), (e: any) => e.statusCode === 400);
  await assert.rejects(repo.updateAdminOrg("not-a-uuid", { name: "x" }), (e: any) => e.statusCode === 400);
});

// ── teams ───────────────────────────────────────────────────────────────────

test("teams carry the balance from the gateway and can be ranked by it", async (t) => {
  withOperators(t, OPERATOR);
  const creditTeams = t.mock.method(aiGateway, "creditTeams", async () => ({
    items: [
      { teamId: TEAM, balanceCredits: 500, periodCredits: 40 },
      { teamId: "t2", balanceCredits: 10, periodCredits: 900 },
    ],
    truncated: false,
  }));
  const rows = {
    "amux.teams": [TEAM_ROW, { ...TEAM_ROW, id: "t2", slug: "b", name: "Beta" }],
    "public.orgs": [{ id: ORG, name: "Acme" }],
    "amux.actors": [{ team_id: TEAM }, { team_id: TEAM }],
  };

  const { repo } = repoFor(OPERATOR, rows);
  const byBalance = await repo.listAdminTeams({ sort: "balance" });
  assert.deepEqual(byBalance.items.map((r: any) => [r.slug, r.balanceCredits]), [["b", 10], ["acme-core", 500]]);
  assert.equal(byBalance.items[1].memberCount, 2);
  assert.equal(byBalance.items[1].orgName, "Acme");
  assert.equal(byBalance.truncated, false);
  assert.equal(creditTeams.mock.calls[0].arguments[0], ADMIN_LIST_CAP);

  const byUsage = await repo.listAdminTeams({ sort: "usage" });
  assert.deepEqual(byUsage.items.map((r: any) => r.slug), ["b", "acme-core"]);
});

test("a team list survives a gateway that is down, minus the money", async (t) => {
  // The gateway holds the balances; the org and team inventory does not depend
  // on it, and an operator looking at teams should not get an empty screen
  // because the gateway is restarting.
  withOperators(t, OPERATOR);
  t.mock.method(aiGateway, "creditTeams", async () => { throw new Error("gateway down") });
  const { repo } = repoFor(OPERATOR, {
    "amux.teams": [TEAM_ROW],
    "public.orgs": [{ id: ORG, name: "Acme" }],
    "amux.actors": [],
  });

  const out = await repo.listAdminTeams({});
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].balanceCredits, 0);
});

test("one team's money comes from the gateway, never from FC's own tables", async (t) => {
  withOperators(t, OPERATOR);
  t.mock.method(aiGateway, "creditsSummary", async () => ({ balanceCredits: 1234 }));
  t.mock.method(aiGateway, "usage", async () => ({ range: "month", summary: { credits: 99 } }));
  t.mock.method(aiGateway, "ledger", async () => ({ items: [{ id: "l1", kind: "grant", amountCredits: 500 }] }));
  t.mock.method(aiGateway, "quotas", async () => ({
    period: "month",
    defaultLimitCredits: 1000,
    lowBalanceCredits: 50,
    members: [{ actorId: ACTOR, limitCredits: 200 }],
  }));

  const { repo, seen } = repoFor(OPERATOR, {
    "amux.teams": [TEAM_ROW],
    "amux.actors": [{ id: ACTOR, display_name: "Ada", actor_type: "member" }],
    "public.orgs": [{ name: "Acme" }],
  });
  const out = await repo.getAdminTeamCredits(TEAM);

  assert.equal(out.balanceCredits, 1234);
  assert.equal(out.usage.summary.credits, 99);
  assert.equal(out.ledger[0].kind, "grant");
  assert.equal(out.team.orgName, "Acme");
  // The quota rows are joined to actor names here, which the gateway cannot do.
  assert.deepEqual(out.quotas.members, [
    { actorId: ACTOR, displayName: "Ada", actorType: "member", limitCredits: 200 },
  ]);
  assert.ok(!seen.some((q) => q.table.includes("credit")), "FC must not read the ledger tables");
});

test("quotas are validated before the gateway is asked", async (t) => {
  withOperators(t, OPERATOR);
  const setQuotas = t.mock.method(aiGateway, "setQuotas", async () => ({ ok: true }));
  const { repo } = repoFor(OPERATOR, {});

  for (const bad of [
    { period: "day" },
    { defaultLimitCredits: -1 },
    { lowBalanceCredits: 1.5 },
    { members: [{ actorId: "nope", limitCredits: 1 }] },
    { members: [{ actorId: ACTOR, limitCredits: -5 }] },
  ]) {
    await assert.rejects(repo.setAdminTeamQuotas(TEAM, bad), (e: any) => {
      assert.equal(e.statusCode, 400, JSON.stringify(bad));
      return true;
    });
  }
  assert.equal(setQuotas.mock.callCount(), 0);

  t.mock.method(console, "log", () => {});
  await repo.setAdminTeamQuotas(TEAM, { period: "week", defaultLimitCredits: 10, lowBalanceCredits: null, members: [] });
  assert.deepEqual(setQuotas.mock.calls[0].arguments[1], {
    period: "week",
    defaultLimitCredits: 10,
    lowBalanceCredits: null,
    members: [],
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

test("the operator console routes reach their repository methods", async () => {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return {};
  };
  const repo = {
    listAdminOrgs: record("listAdminOrgs"),
    updateAdminOrg: record("updateAdminOrg"),
    listAdminTeams: record("listAdminTeams"),
    getAdminTeamCredits: record("getAdminTeamCredits"),
    setAdminTeamQuotas: record("setAdminTeamQuotas"),
  };
  const deps = { createRepository: () => repo, createAuthRepository: () => repo } as any;
  const headers = { Authorization: "Bearer caller-token" };
  const req = (httpMethod: string, path: string, body?: unknown, queryStringParameters?: Record<string, string>) =>
    handleBusinessApiRequest(
      { httpMethod, path, headers, body: body === undefined ? undefined : JSON.stringify(body), queryStringParameters } as any,
      deps,
    );

  assert.equal((await req("GET", "/v1/admin/orgs", undefined, { query: "acme", limit: "10", offset: "20" })).statusCode, 200);
  assert.equal((await req("PATCH", `/v1/admin/orgs/${ORG}`, { name: "Acme" })).statusCode, 200);
  assert.equal((await req("GET", "/v1/admin/teams", undefined, { sort: "balance", orgId: ORG })).statusCode, 200);
  assert.equal((await req("GET", `/v1/admin/teams/${TEAM}/credits`)).statusCode, 200);
  assert.equal((await req("PUT", `/v1/admin/teams/${TEAM}/quotas`, { period: "month" })).statusCode, 200);

  assert.deepEqual(calls, [
    ["listAdminOrgs", { query: "acme", limit: "10", offset: "20" }],
    ["updateAdminOrg", ORG, { name: "Acme" }],
    ["listAdminTeams", { query: undefined, orgId: ORG, sort: "balance", limit: undefined, offset: undefined }],
    ["getAdminTeamCredits", TEAM],
    ["setAdminTeamQuotas", TEAM, { period: "month" }],
  ]);
});
