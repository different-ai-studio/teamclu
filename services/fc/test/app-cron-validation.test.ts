import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";

/**
 * `normalizeAppCronInput` is the only place a job's user-supplied fields are
 * checked, and it runs before any client call — so it can be exercised with a
 * repository whose client is never touched.
 */
function repo() {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "pk",
    accessToken: "t",
    createClient: () => ({}) as any,
  }) as any;
}

const ok = (over: Record<string, unknown> = {}) => ({
  name: "daily report",
  schedule: "0 9 * * *",
  ...over,
});

const rejects = (input: Record<string, unknown>, match: RegExp) =>
  assert.throws(
    () => repo().normalizeAppCronInput(input),
    (e: any) => e.statusCode === 400 && match.test(e.message),
    `accepted ${JSON.stringify(input)}`,
  );

test("a minimal job gets the defaults and a computed next run", () => {
  const out = repo().normalizeAppCronInput(ok());
  assert.equal(out.name, "daily report");
  assert.equal(out.schedule_expr, "0 9 * * *");
  assert.equal(out.timezone, "UTC");
  assert.equal(out.method, "GET");
  assert.equal(out.path, "/");
  assert.deepEqual(out.headers, {});
  assert.equal(out.body, null);
  assert.equal(out.timeout_ms, 30000);
  assert.equal(out.enabled, true);
  assert.ok(out.next_run_at, "an enabled job must know when it fires next");
  assert.ok(new Date(out.next_run_at).getTime() > Date.now());
});

test("a disabled job has no next run at all", () => {
  // Not "a next run we ignore": leaving one behind is how a job that was off
  // for a month fires the moment it is switched back on.
  const out = repo().normalizeAppCronInput(ok({ enabled: false }));
  assert.equal(out.enabled, false);
  assert.equal(out.next_run_at, null);
});

test("re-enabling recomputes the next run from now, not from the old one", () => {
  const existing = {
    name: "n",
    schedule_expr: "0 9 * * *",
    timezone: "UTC",
    method: "GET",
    path: "/",
    headers: {},
    body: null,
    timeout_ms: 30000,
    enabled: false,
  };
  const out = repo().normalizeAppCronInput({ enabled: true }, existing);
  assert.ok(new Date(out.next_run_at).getTime() > Date.now());
});

test("a patch keeps every field it does not mention", () => {
  const existing = {
    name: "old name",
    schedule_expr: "*/5 * * * *",
    timezone: "Asia/Shanghai",
    method: "POST",
    path: "/api/tick",
    headers: { "x-a": "1" },
    body: "{}",
    timeout_ms: 12000,
    enabled: true,
  };
  const out = repo().normalizeAppCronInput({ name: "new name" }, existing);
  assert.equal(out.name, "new name");
  assert.equal(out.schedule_expr, "*/5 * * * *");
  assert.equal(out.timezone, "Asia/Shanghai");
  assert.equal(out.method, "POST");
  assert.equal(out.path, "/api/tick");
  assert.deepEqual(out.headers, { "x-a": "1" });
  assert.equal(out.body, "{}");
  assert.equal(out.timeout_ms, 12000);
});

test("the method is an allowlist, upper-cased", () => {
  assert.equal(repo().normalizeAppCronInput(ok({ method: "post" })).method, "POST");
  rejects(ok({ method: "TRACE" }), /not supported/);
});

test("a path must be a path on this app, not a URL", () => {
  // Absolute URLs are how a scheduled task would become an outbound request
  // machine pointed at somebody else's server.
  rejects(ok({ path: "https://evil.example.com/" }), /must start with/);
  rejects(ok({ path: "api/x" }), /must start with/);
  rejects(ok({ path: `/${"x".repeat(600)}` }), /too long/);
  assert.equal(repo().normalizeAppCronInput(ok({ path: "/api/x" })).path, "/api/x");
});

test("headers must be a flat map of strings, and not too many", () => {
  rejects(ok({ headers: [] }), /must be an object/);
  rejects(ok({ headers: { "x-a": 1 } }), /must be a string/);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-${i}`, "v"]));
  rejects(ok({ headers: many }), /at most 20/);
});

test("a body has a ceiling and must be text", () => {
  rejects(ok({ body: { a: 1 } }), /must be a string/);
  rejects(ok({ body: "x".repeat(64 * 1024 + 1) }), /64 KiB/);
});

test("the timeout has a floor as well as a ceiling", () => {
  // Under a second is a busy loop against the app; over a minute outlives the
  // heartbeat that started the tick.
  rejects(ok({ timeoutMs: 500 }), /between 1000 and 60000/);
  rejects(ok({ timeoutMs: 120000 }), /between 1000 and 60000/);
  rejects(ok({ timeoutMs: 1500.5 }), /between 1000 and 60000/);
});

test("a bad schedule or zone is refused at save time, not at fire time", () => {
  rejects(ok({ schedule: "every day" }), /cron/);
  rejects(ok({ schedule: "0 9 * *" }), /5 fields/);
  rejects(ok({ timezone: "Mars/Olympus" }), /unknown timezone/);
});

test("a name is required and bounded", () => {
  rejects(ok({ name: "   " }), /1-120/);
  rejects(ok({ name: "x".repeat(121) }), /1-120/);
});

test("an expression that never comes is stored with no next run rather than refused", () => {
  // Feb 30 parses fine — it just never happens. Refusing it at save time would
  // mean explaining "this date does not exist" through a 400 on five numbers;
  // storing it null lets the panel show "never" next to the job itself.
  const out = repo().normalizeAppCronInput(ok({ schedule: "0 0 30 2 *" }));
  assert.equal(out.next_run_at, null);
});
