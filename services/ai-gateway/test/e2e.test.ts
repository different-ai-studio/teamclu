/**
 * End-to-end: the real Hono app, against a real Postgres carrying the real
 * migrations, talking to the real upstream.
 *
 * Only token verification is stubbed — that path needs GoTrue, and what it
 * would prove (does a signature check work) is not what these tests are for.
 * Everything downstream of "this token belongs to user X" is genuine: the
 * membership lookup, tier routing, upstream call, SSE relay and usage row.
 *
 * Skips cleanly when DATABASE_URL is absent so a checkout without a local
 * database still runs the rest of the suite.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCatalog } from "../src/catalog.js";
import { connect, type Sql } from "../src/db.js";
import { TokenCache } from "../src/auth.js";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

// The app connects with the gateway's own least-privilege role, so the suite
// exercises the real grant set — an over-tight grant fails here, not in prod.
const DB = process.env.DATABASE_URL;
// Fixtures need to write auth.users / amux.teams, which ai_gateway cannot.
const ADMIN_DB = process.env.ADMIN_DATABASE_URL ?? DB;
const KEY = process.env.DEEPSEEK_API_KEY;
const SERVICE_TOKEN = "svc-test-token";

const MEMBER_SUB = "11111111-1111-4111-8111-111111111111";
const OUTSIDER_SUB = "22222222-2222-4222-8222-222222222222";

let sql: Sql;      // gateway role — what the app itself uses
let admin: Sql;    // fixture role
let app: ReturnType<typeof createApp>;
let teamId: string;
let otherTeamId: string;

const CATALOG = readFileSync(
  new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url),
  "utf8",
);

before(async () => {
  if (!DB) return;
  sql = connect(DB);
  admin = connect(ADMIN_DB!);
  // amux.actors.user_id is FK'd to auth.users, so the fixture needs real users.
  await admin`insert into auth.users (id) values (${MEMBER_SUB}::uuid), (${OUTSIDER_SUB}::uuid)
            on conflict (id) do nothing`;
  const slug = `e2e-${Date.now()}`;
  [{ id: teamId }] = await admin<{ id: string }[]>`
    insert into amux.teams (slug, name) values (${slug}, 'e2e team') returning id`;
  [{ id: otherTeamId }] = await admin<{ id: string }[]>`
    insert into amux.teams (slug, name) values (${slug + "-b"}, 'other team') returning id`;
  await admin`insert into amux.actors (team_id, actor_type, display_name, user_id)
            values (${teamId}::uuid, 'member', 'E2E Member', ${MEMBER_SUB})`;

  const cfg = {
    port: 0, databaseUrl: DB, catalogPath: "", serviceToken: SERVICE_TOKEN,
    backendKind: "supabase", supabaseUrl: "", supabaseAnonKey: "",
    authBaseUrl: "", tokenCacheTtlMs: 60_000,
  } as Config;

  // Stubbed verifier: "token-<sub>" resolves to that subject, anything else is
  // rejected the way an expired JWT would be.
  const tokens = new TokenCache(60_000, async (t) => {
    if (!t.startsWith("token-")) throw new Error("invalid_token");
    return t.slice("token-".length);
  });

  app = createApp({
    cfg, sql, tokens,
    catalog: parseCatalog(CATALOG, { DEEPSEEK_API_KEY: KEY ?? "x", OPENAI_API_KEY: "unused" } as NodeJS.ProcessEnv),
    env: { DEEPSEEK_API_KEY: KEY ?? "", OPENAI_API_KEY: "" } as NodeJS.ProcessEnv,
  });
});

after(async () => {
  if (!DB) return;
  await admin`delete from amux.teams where id in (${teamId}::uuid, ${otherTeamId}::uuid)`;
  await admin`delete from auth.users where id in (${MEMBER_SUB}::uuid, ${OUTSIDER_SUB}::uuid)`;
  await sql.end();
  await admin.end();
});

const req = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://gw${path}`, init));
const asMember = (extra: Record<string, string> = {}) =>
  ({ Authorization: `Bearer token-${MEMBER_SUB}`, ...extra });

test("healthz needs no auth", { skip: !DB }, async () => {
  assert.equal((await req("/healthz")).status, 200);
});

test("no token is 401", { skip: !DB }, async () => {
  assert.equal((await req(`/v1/teams/${teamId}/models`)).status, 401);
});

test("a bad token is 401", { skip: !DB }, async () => {
  const r = await req(`/v1/teams/${teamId}/models`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(r.status, 401);
});

test("valid token for a team you are NOT in is 403", { skip: !DB }, async () => {
  // The regression test for the authorization hole: :teamId is caller-supplied,
  // and a token alone must never be enough to spend another team's credits.
  const r = await req(`/v1/teams/${otherTeamId}/models`, { headers: asMember() });
  assert.equal(r.status, 403);
  assert.equal((await r.json() as any).error.code, "not_a_team_member");
});

test("a member who exists in no team at all is 403", { skip: !DB }, async () => {
  const r = await req(`/v1/teams/${teamId}/models`, {
    headers: { Authorization: `Bearer token-${OUTSIDER_SUB}` },
  });
  assert.equal(r.status, 403);
});

test("models lists all tiers with exact pricing, and no upstream names", { skip: !DB }, async () => {
  const r = await req(`/v1/teams/${teamId}/models`, { headers: asMember() });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  const ids = body.data.map((m: any) => m.id);
  for (const tier of ["default", "pro", "max"]) assert.ok(ids.includes(tier), `missing ${tier}`);
  assert.ok(body.data.every((m: any) => m.pricing.inputPer1mCredits > 0));
  assert.ok(!JSON.stringify(body).includes("deepseek-v4-flash-vision"), "must not leak upstream catalogue");
});

test("an unknown model is 403, never a silent fallback to default", { skip: !DB }, async () => {
  const r = await req(`/v1/teams/${teamId}/chat/completions`, {
    method: "POST",
    headers: asMember({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: "gpt-9-turbo", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json() as any).error.code, "model_not_allowed");
});

test("internal routes reject an end-user token and accept the service token", { skip: !DB }, async () => {
  assert.equal((await req("/internal/models", { headers: asMember() })).status, 401);
  const ok = await req("/internal/models", { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json() as any).data.length >= 3);
});

test("non-streaming completion round-trips and writes a usage row", { skip: !DB || !KEY }, async () => {
  const before = await sql`select count(*)::int as n from amux.ai_usage_logs where team_id = ${teamId}::uuid`;
  const r = await req(`/v1/teams/${teamId}/chat/completions`, {
    method: "POST",
    headers: asMember({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "只回复:好" }], max_tokens: 32 }),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.ok(Array.isArray(body.choices), "upstream returned a completion");

  // The write is fire-and-forget; give it a moment to land.
  for (let i = 0; i < 40; i++) {
    const now = await sql`select count(*)::int as n from amux.ai_usage_logs where team_id = ${teamId}::uuid`;
    if (now[0].n > before[0].n) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const [row] = await sql<any[]>`
    select * from amux.ai_usage_logs where team_id = ${teamId}::uuid
     order by created_at desc limit 1`;
  assert.ok(row, "a usage row was written");
  assert.equal(row.public_model_id, "default", "billed against the tier the client asked for");
  assert.equal(row.backend_model_id, "ds-v4-flash", "records the backend it actually landed on");
  assert.equal(row.usage_source, "upstream");
  assert.ok(Number(row.input_tokens) > 0, "input tokens recorded");
  assert.ok(Number(row.credits) > 0, "credits computed");
  assert.equal(row.stream, false);
});

test("streaming completion relays SSE and still records usage", { skip: !DB || !KEY }, async () => {
  const r = await req(`/v1/teams/${teamId}/chat/completions`, {
    method: "POST",
    headers: asMember({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "default", stream: true, max_tokens: 32,
      messages: [{ role: "user", content: "只回复:好" }],
    }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /event-stream/);

  const text = await r.text();
  assert.ok(text.includes("data:"), "SSE frames relayed");
  assert.ok(text.includes("[DONE]"), "terminator relayed");

  for (let i = 0; i < 40; i++) {
    const [row] = await sql<any[]>`
      select stream from amux.ai_usage_logs where team_id = ${teamId}::uuid
       order by created_at desc limit 1`;
    if (row?.stream === true) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const [row] = await sql<any[]>`
    select * from amux.ai_usage_logs where team_id = ${teamId}::uuid
     order by created_at desc limit 1`;
  assert.equal(row.stream, true, "streaming request logged");
  assert.equal(row.usage_source, "upstream",
    "DeepSeek returns usage unconditionally — falling back to estimated means the tee broke");
  assert.ok(Number(row.output_tokens) > 0, "output tokens recorded from the streamed usage frame");
});
