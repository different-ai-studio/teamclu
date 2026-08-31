/**
 * Credits enforcement against a real Postgres carrying the real migrations.
 *
 * These are not unit tests with a fake: the property under test is what
 * concurrent transactions do to one balance row, which no mock reproduces.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connect, type Sql } from "../src/db.js";
import {
  backfillSignupGrants, pruneUsage, reconcile, release, reserve, settle, sweepExpired, topUp,
} from "../src/credits.js";

const DB = process.env.DATABASE_URL;
const ADMIN_DB = process.env.ADMIN_DATABASE_URL ?? DB;

let sql: Sql;
let admin: Sql;
let teamId: string;
let memberId: string;
let agentId: string;

const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "aaaaaaaa-0000-4000-8000-000000000002";

before(async () => {
  if (!DB) return;
  sql = connect(DB);
  admin = connect(ADMIN_DB!);
  await admin`insert into auth.users (id) values (${USER_A}::uuid), (${USER_B}::uuid)
              on conflict (id) do nothing`;
  [{ id: teamId }] = await admin<{ id: string }[]>`
    insert into amux.teams (slug, name) values (${`credits-${Date.now()}`}, 'credits test')
    returning id`;
  [{ id: memberId }] = await admin<{ id: string }[]>`
    insert into amux.actors (team_id, actor_type, display_name, user_id)
    values (${teamId}::uuid, 'member', 'Member', ${USER_A}) returning id`;
  [{ id: agentId }] = await admin<{ id: string }[]>`
    insert into amux.actors (team_id, actor_type, display_name, user_id)
    values (${teamId}::uuid, 'agent', 'Agent', ${USER_B}) returning id`;
});

after(async () => {
  if (!DB) return;
  await admin`delete from amux.teams where id = ${teamId}::uuid`;
  await admin`delete from auth.users where id in (${USER_A}::uuid, ${USER_B}::uuid)`;
  await sql.end();
  await admin.end();
});

/** Reset the wallet between tests so each starts from a known balance. */
async function setBalance(credits: number) {
  await admin`
    insert into amux.team_credit_balance (team_id, balance_credits)
    values (${teamId}::uuid, ${credits})
    on conflict (team_id) do update set balance_credits = ${credits}`;
}

beforeEach(async () => {
  if (!DB) return;
  await admin`delete from amux.credit_reservation where team_id = ${teamId}::uuid`;
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.ai_usage_logs where team_id = ${teamId}::uuid`;
  await admin`delete from amux.member_credit_quota where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_settings where team_id = ${teamId}::uuid`;
});

const member = { teamId: () => teamId, actorId: () => memberId, actorType: "member" };

test("a hold within the balance succeeds", { skip: !DB }, async () => {
  await setBalance(1000);
  const r = await reserve(sql, {
    teamId, actorId: memberId, actorType: "member", holdCredits: 400,
  });
  assert.ok(r.ok);
});

test("a hold beyond the balance is refused with insufficient_credits", { skip: !DB }, async () => {
  await setBalance(100);
  const r = await reserve(sql, {
    teamId, actorId: memberId, actorType: "member", holdCredits: 400,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "insufficient_credits");
});

test("concurrent holds cannot overspend the balance", { skip: !DB }, async () => {
  // THE reason reservations exist. Ten simultaneous requests against a balance
  // that fits three: without the row lock every one of them reads 1000 and
  // proceeds, and the team spends 3.3x what it has. Agent traffic is concurrent
  // by construction, so this is the ordinary case, not a stress test.
  await setBalance(1000);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 300 }),
    ),
  );
  const granted = results.filter((r) => r.ok).length;
  assert.equal(granted, 3, `expected exactly 3 holds to fit in 1000, got ${granted}`);

  const [{ held }] = await sql<{ held: string }[]>`
    select coalesce(sum(amount_credits),0)::text as held from amux.credit_reservation
     where team_id = ${teamId}::uuid and state = 'held'`;
  assert.ok(Number(held) <= 1000, "total held never exceeds the balance");
});

test("settlement debits the balance and writes a matching ledger row", { skip: !DB }, async () => {
  await setBalance(1000);
  const r = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 400 });
  assert.ok(r.ok);
  const [usage] = await sql<{ id: string }[]>`
    insert into amux.ai_usage_logs
      (team_id, actor_id, public_model_id, backend_model_id, provider_id, credits)
    values (${teamId}::uuid, ${memberId}::uuid, 'default', 'ds-v4-flash', 'deepseek', 250)
    returning id`;

  await settle(sql, {
    reservationId: r.ok ? r.reservationId : null,
    teamId, actorId: memberId, credits: 250, usageLogId: usage.id,
  });

  const [bal] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  assert.equal(Number(bal.balance_credits), 750, "charged the actual cost, not the hold");

  const [led] = await sql<{ amount_credits: string; kind: string }[]>`
    select amount_credits, kind from amux.credit_ledger where team_id = ${teamId}::uuid`;
  assert.equal(led.kind, "usage");
  assert.equal(Number(led.amount_credits), -250);

  const [res] = await sql<{ state: string }[]>`
    select state from amux.credit_reservation where team_id = ${teamId}::uuid`;
  assert.equal(res.state, "settled", "the hold is released, not left outstanding");
});

test("the balance always equals the sum of the ledger", { skip: !DB }, async () => {
  // The invariant the daily reconciliation job checks. Materialising the
  // balance is what makes `for update` possible; this is its cost.
  await setBalance(1000);
  await admin`insert into amux.credit_ledger (team_id, kind, amount_credits)
              values (${teamId}::uuid, 'grant', 1000)`;
  for (const amount of [120, 30, 7]) {
    const [u] = await sql<{ id: string }[]>`
      insert into amux.ai_usage_logs
        (team_id, actor_id, public_model_id, backend_model_id, provider_id, credits)
      values (${teamId}::uuid, ${memberId}::uuid, 'default', 'ds-v4-flash', 'deepseek', ${amount})
      returning id`;
    await settle(sql, { reservationId: null, teamId, actorId: memberId, credits: amount, usageLogId: u.id });
  }
  const [row] = await sql<{ balance: string; ledger: string }[]>`
    select b.balance_credits::text as balance,
           (select coalesce(sum(amount_credits),0) from amux.credit_ledger where team_id = ${teamId}::uuid)::text as ledger
      from amux.team_credit_balance b where b.team_id = ${teamId}::uuid`;
  assert.equal(row.balance, row.ledger);
});

test("a member over their period quota is refused while the team still has credit", { skip: !DB }, async () => {
  await setBalance(1_000_000);
  await admin`insert into amux.team_credit_settings (team_id, period) values (${teamId}::uuid, 'month')`;
  await admin`insert into amux.member_credit_quota (team_id, actor_id, limit_credits)
              values (${teamId}::uuid, ${memberId}::uuid, 500)`;
  await admin`insert into amux.ai_usage_logs
              (team_id, actor_id, public_model_id, backend_model_id, provider_id, credits)
              values (${teamId}::uuid, ${memberId}::uuid, 'default', 'ds-v4-flash', 'deepseek', 450)`;

  const r = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 100 });
  assert.equal(r.ok, false);
  // Distinct from insufficient_credits: this one is fixed by raising a limit,
  // not by topping up. Same message for both sends people to the wrong remedy.
  if (!r.ok) assert.equal(r.code, "quota_exceeded");
});

test("in-flight holds count toward the quota", { skip: !DB }, async () => {
  // Otherwise two concurrent requests each see "450 used of 500" and both pass.
  await setBalance(1_000_000);
  await admin`insert into amux.member_credit_quota (team_id, actor_id, limit_credits)
              values (${teamId}::uuid, ${memberId}::uuid, 500)`;
  const first = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 400 });
  assert.ok(first.ok);
  const second = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 400 });
  assert.equal(second.ok, false);
});

test("an agent with no quota row is unlimited", { skip: !DB }, async () => {
  // Cron and unattended agents run with nobody watching: stalling one on a
  // limit no one is awake to raise turns a spend cap into an outage.
  await setBalance(1_000_000);
  await admin`insert into amux.team_credit_settings (team_id, period, default_limit_credits)
              values (${teamId}::uuid, 'month', 100)`;
  const r = await reserve(sql, { teamId, actorId: agentId, actorType: "agent", holdCredits: 50_000 });
  assert.ok(r.ok, "an agent is not held to the member default");
});

test("an agent WITH an explicit quota row is held to it", { skip: !DB }, async () => {
  // Unlimited-by-default is a default, not a licence: an operator who sets one
  // deliberately must still be obeyed.
  await setBalance(1_000_000);
  await admin`insert into amux.member_credit_quota (team_id, actor_id, limit_credits)
              values (${teamId}::uuid, ${agentId}::uuid, 100)`;
  const r = await reserve(sql, { teamId, actorId: agentId, actorType: "agent", holdCredits: 500 });
  assert.equal(r.ok, false);
});

test("a member falls back to the team default limit", { skip: !DB }, async () => {
  await setBalance(1_000_000);
  await admin`insert into amux.team_credit_settings (team_id, period, default_limit_credits)
              values (${teamId}::uuid, 'month', 100)`;
  const r = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 500 });
  assert.equal(r.ok, false);
});

test("releasing a hold returns the credit to the pool", { skip: !DB }, async () => {
  await setBalance(1000);
  const first = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 900 });
  assert.ok(first.ok);
  const blocked = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 900 });
  assert.equal(blocked.ok, false);

  await release(sql, first.ok ? first.reservationId : null);
  const after = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 900 });
  assert.ok(after.ok, "a released hold frees the credit for the next request");
});

test("the sweeper expires holds whose request never came back", { skip: !DB }, async () => {
  // A crashed process or a client that vanished mid-stream would otherwise keep
  // that credit reserved forever.
  await setBalance(1000);
  await admin`
    insert into amux.credit_reservation (team_id, actor_id, amount_credits, expires_at)
    values (${teamId}::uuid, ${memberId}::uuid, 900, now() - interval '1 minute')`;
  const blocked = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 900 });
  assert.equal(blocked.ok, false, "the stale hold still blocks before the sweep");

  assert.equal(await sweepExpired(sql), 1);
  const after = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 900 });
  assert.ok(after.ok);
});

test("a team with no balance row at all is refused, not defaulted to unlimited", { skip: !DB }, async () => {
  // The fail-open this guards: a missing row reading as "no limit known" would
  // give every un-provisioned team free AI.
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  const r = await reserve(sql, { teamId, actorId: memberId, actorType: "member", holdCredits: 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "insufficient_credits");
});

// ── operator surface ────────────────────────────────────────────────────────

test("top-up credits the balance and records it in the ledger", { skip: !DB }, async () => {
  await setBalance(0);
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  const r = await topUp(sql, {
    teamId, amountCredits: 5000, kind: "top_up", idempotencyKey: "pay-1", note: "test",
  });
  assert.equal(r.applied, true);
  assert.equal(r.balanceCredits, 5000);
});

test("the same idempotency key never credits twice", { skip: !DB }, async () => {
  // A payment provider retrying delivery is normal, not exceptional. The unique
  // index does this, not a read-then-write, so two concurrent deliveries of the
  // same purchase cannot both pass the check.
  await setBalance(0);
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  const first = await topUp(sql, { teamId, amountCredits: 5000, kind: "top_up", idempotencyKey: "pay-dup" });
  const second = await topUp(sql, { teamId, amountCredits: 5000, kind: "top_up", idempotencyKey: "pay-dup" });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false, "the retry is a no-op, not a second credit");
  assert.equal(second.balanceCredits, 5000);
});

test("concurrent deliveries of the same purchase credit once", { skip: !DB }, async () => {
  await setBalance(0);
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      topUp(sql, { teamId, amountCredits: 1000, kind: "top_up", idempotencyKey: "pay-race" }),
    ),
  );
  const applied = results.filter(
    (r) => r.status === "fulfilled" && r.value.applied,
  ).length;
  assert.equal(applied, 1, "exactly one delivery credits");
  const [bal] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  assert.equal(Number(bal.balance_credits), 1000);
});

test("backfill grants every team that has never been credited", { skip: !DB }, async () => {
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  await backfillSignupGrants(sql, 777);

  // Asserts THIS team, not a global count: the backfill sweeps every team on
  // the deployment, and other suites create and delete their own concurrently.
  const [bal] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  assert.equal(Number(bal.balance_credits), 777, "the un-credited team was granted");
});

test("a team deleted mid-backfill is skipped, not fatal", { skip: !DB }, async () => {
  // The list is a snapshot. In production the sweep covers every team on the
  // deployment, so a deletion during the run is ordinary — and aborting would
  // leave a PARTIAL backfill right before enforcement is switched on, which is
  // the one outcome that must not happen quietly.
  const [{ id: doomed }] = await admin<{ id: string }[]>`
    insert into amux.teams (slug, name) values (${`doomed-${Date.now()}`}, 'doomed') returning id`;
  await admin`delete from amux.teams where id = ${doomed}::uuid`;

  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  // Does not throw, and our team is still granted.
  await backfillSignupGrants(sql, 555);
  const [bal] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  assert.equal(Number(bal.balance_credits), 555);
});

test("backfill is safe to re-run", { skip: !DB }, async () => {
  // It is the gate on enabling enforcement, so it will be run more than once:
  // ahead of time, again after new teams appear, again if it half-failed.
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  await backfillSignupGrants(sql, 777);
  const [before] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;

  const second = await backfillSignupGrants(sql, 777);
  const [after] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;

  assert.equal(after.balance_credits, before.balance_credits, "a second pass grants nothing");
  assert.ok(
    !second.scanned || second.granted < second.scanned || second.scanned === 0,
    "already-granted teams are not re-scanned into grants",
  );
});

test("backfill does not top up a team that already has credit", { skip: !DB }, async () => {
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  await topUp(sql, {
    teamId, amountCredits: 50, kind: "grant", idempotencyKey: `signup_grant:${teamId}`,
  });
  await backfillSignupGrants(sql, 777);
  const [bal] = await sql<{ balance_credits: string }[]>`
    select balance_credits from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  assert.equal(Number(bal.balance_credits), 50, "an existing signup grant is left alone");
});

test("reconcile is silent when balance and ledger agree", { skip: !DB }, async () => {
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  await topUp(sql, { teamId, amountCredits: 1000, kind: "grant", idempotencyKey: "recon-ok" });
  const findings = (await reconcile(sql)).filter((f) => f.teamId === teamId);
  assert.deepEqual(findings, []);
});

test("reconcile reports drift between the balance and the ledger", { skip: !DB }, async () => {
  // The safety net that replaces the non-negative CHECK the schema omits: a
  // settlement bug shows up here rather than silently.
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await topUp(sql, { teamId, amountCredits: 1000, kind: "grant", idempotencyKey: "recon-drift" });
  await admin`update amux.team_credit_balance set balance_credits = 999
              where team_id = ${teamId}::uuid`;

  const [finding] = (await reconcile(sql)).filter((f) => f.teamId === teamId);
  assert.ok(finding, "drift is reported");
  assert.equal(finding.reason, "drift");
  assert.equal(finding.balanceCredits, 999);
  assert.equal(finding.ledgerCredits, 1000);
});

test("reconcile reports a negative balance", { skip: !DB }, async () => {
  // Only a refund against already-spent credits should produce one, and the
  // schema allows it on purpose (§4.9.5) — so it has to be visible.
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  await topUp(sql, { teamId, amountCredits: 100, kind: "grant", idempotencyKey: "recon-neg-1" });
  await topUp(sql, { teamId, amountCredits: -300, kind: "refund", idempotencyKey: "recon-neg-2" });

  const [finding] = (await reconcile(sql)).filter((f) => f.teamId === teamId);
  assert.ok(finding, "a negative balance is reported");
  assert.equal(finding.reason, "negative");
  assert.equal(finding.balanceCredits, -200);
});

test("a refund can drive the balance negative without erroring", { skip: !DB }, async () => {
  // The reason team_credit_balance has no `check (balance_credits >= 0)`:
  // that constraint would roll back a legitimate refund of already-spent
  // credits. This is the test that stops someone "tidying up" by adding it.
  await admin`delete from amux.credit_ledger where team_id = ${teamId}::uuid`;
  await admin`delete from amux.team_credit_balance where team_id = ${teamId}::uuid`;
  await topUp(sql, { teamId, amountCredits: 10, kind: "grant", idempotencyKey: "neg-a" });
  const r = await topUp(sql, { teamId, amountCredits: -1000, kind: "refund", idempotencyKey: "neg-b" });
  assert.equal(r.balanceCredits, -990);
});

test("retention deletes only rows past the window", { skip: !DB }, async () => {
  await admin`delete from amux.ai_usage_logs where team_id = ${teamId}::uuid`;
  await admin`
    insert into amux.ai_usage_logs
      (team_id, actor_id, public_model_id, backend_model_id, provider_id, credits, created_at)
    values
      (${teamId}::uuid, ${memberId}::uuid, 'default', 'ds-v4-flash', 'deepseek', 1, now() - interval '14 months'),
      (${teamId}::uuid, ${memberId}::uuid, 'default', 'ds-v4-flash', 'deepseek', 1, now() - interval '12 months'),
      (${teamId}::uuid, ${memberId}::uuid, 'default', 'ds-v4-flash', 'deepseek', 1, now())`;
  const deleted = await pruneUsage(sql, 13);
  assert.ok(deleted >= 1);
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from amux.ai_usage_logs where team_id = ${teamId}::uuid`;
  assert.equal(n, 2, "12-month-old and current rows survive a 13-month window");
});
