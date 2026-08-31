/**
 * Credits enforcement against a real Postgres carrying the real migrations.
 *
 * These are not unit tests with a fake: the property under test is what
 * concurrent transactions do to one balance row, which no mock reproduces.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connect, type Sql } from "../src/db.js";
import { release, reserve, settle, sweepExpired } from "../src/credits.js";

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
