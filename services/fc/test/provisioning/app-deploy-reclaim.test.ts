import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  reclaimStaleDeploy,
  supabaseReclaimStore,
  type ReclaimStore,
} from "../../src/lib/provisioning/app-deploy-reclaim.js";
import { STALE_DEPLOY_MS } from "../../src/lib/provisioning/app-deploy.js";

const app = "00000000-0000-0000-0000-000000000001";
const HOUR = 60 * 60 * 1000;

/** The real lifecycle migrations, so their triggers run on every write below. */
async function db() {
  const pg = new PGlite();
  await pg.exec(`create schema amux; create role service_role; create role authenticated; create role anon;
    create table amux.apps (id uuid primary key, fc_status text, fc_endpoint text, deploy_token text, deploy_started_at timestamptz,
      updated_at timestamptz, slug text, fc_function_name text, auth_mode text, oauth_client_id text,
      provision_error text, deploy_use_app_code_domain boolean);
    insert into amux.apps(id,fc_status,deploy_token,slug) values ('${app}','live','tok','sample');`);
  for (const f of ["20261005000000_app_undeploy_lifecycle.sql", "20261018000000_app_deploy_failure_cleanup.sql"]) {
    await pg.exec(await readFile(new URL(`../../../../services/supabase/migrations/${f}`, import.meta.url), "utf8"));
  }
  return pg;
}

/** The same conditional writes as supabaseReclaimStore, in SQL. */
function pgStore(pg: PGlite): ReclaimStore {
  return {
    async pendingOperation(appId) {
      const r = await pg.query<any>(`select id, kind, in_flight, updated_at from amux.app_lifecycle_operations where app_id=$1 and status<>'succeeded'`, [appId]);
      const o = r.rows[0];
      return o ? { id: o.id, kind: o.kind, inFlight: o.in_flight, updatedAt: new Date(o.updated_at).toISOString() } : null;
    },
    async releaseOperation(op, error) {
      const r = await pg.query(`update amux.app_lifecycle_operations set status='succeeded', in_flight=false, error=$2, updated_at=now()
        where id=$1 and status<>'succeeded' and in_flight=$3 and updated_at=$4::timestamptz`, [op.id, error, op.inFlight, op.updatedAt]);
      return (r.affectedRows ?? 0) > 0;
    },
    async abandonApp(appId, expect, error) {
      const r = await pg.query(`update amux.apps set fc_status='deploy_error', provision_error=$2, deploy_use_app_code_domain=null, updated_at=now()
        where id=$1 and fc_status=$3 and deploy_token is not distinct from $4`, [appId, error, expect.fcStatus, expect.deployToken]);
      return (r.affectedRows ?? 0) > 0;
    },
  };
}

/** Put the app where finalize leaves it: deploying, lock in flight since `flightAgo`. */
async function stuckFinalize(pg: PGlite, startedAgo: number, flightAgo: number) {
  await pg.query(`select amux.begin_app_lifecycle($1,'deploy','tok')`, [app]);
  await pg.query(`update amux.apps set fc_status='deploying', deploy_started_at=$2 where id=$1`, [app, new Date(Date.now() - startedAgo)]);
  await pg.query(`update amux.app_lifecycle_operations set in_flight=true, updated_at=$2 where app_id=$1`, [app, new Date(Date.now() - flightAgo)]);
}

async function state(pg: PGlite) {
  const a = (await pg.query<any>(`select fc_status, deploy_token, deploy_started_at, provision_error from amux.apps`)).rows[0];
  const ops = (await pg.query<any>(`select status, in_flight, error from amux.app_lifecycle_operations`)).rows;
  return { a, ops };
}

const row = async (pg: PGlite) => {
  const a = (await pg.query<any>(`select fc_status, deploy_started_at, deploy_token from amux.apps`)).rows[0];
  return { fcStatus: a.fc_status, deployStartedAt: a.deploy_started_at, deployToken: a.deploy_token };
};

test("a finalize stuck in deploying for hours is reclaimed: lock released, attempt deploy_error, redeploy and undeploy possible", async () => {
  const pg = await db();
  try {
    await stuckFinalize(pg, 4 * HOUR, 4 * HOUR);
    // Before: exactly the Belayo dead end.
    await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'undeploy',null)`, [app]), /lifecycle_conflict/);

    assert.equal(await reclaimStaleDeploy(pgStore(pg), app, await row(pg)), "reclaimed");
    const { a, ops } = await state(pg);
    assert.equal(a.fc_status, "deploy_error");
    assert.equal(a.deploy_token, null, "the abandoned attempt's token is gone, so its own late writes miss");
    assert.equal(a.deploy_started_at, null);
    assert.match(a.provision_error, /stopped responding while finalizing/);
    assert.deepEqual(ops.map((o: any) => [o.status, o.in_flight]), [["succeeded", false]]);
    assert.match(ops[0].error, /^reclaimed:/);

    // A fresh preflight token can be written and a new deploy can take the lock.
    await pg.query(`update amux.apps set deploy_token='fresh' where id=$1`, [app]);
    assert.ok((await pg.query<any>(`select amux.begin_app_lifecycle($1,'deploy','fresh') as op`, [app])).rows[0].op.id);
  } finally { await pg.close(); }
});

test("undeploy works once the stale deploy is reclaimed", async () => {
  const pg = await db();
  try {
    await stuckFinalize(pg, 4 * HOUR, 4 * HOUR);
    assert.equal(await reclaimStaleDeploy(pgStore(pg), app, await row(pg)), "reclaimed");
    const op = (await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null) as op`, [app])).rows[0].op;
    assert.equal(op.kind, "undeploy");
  } finally { await pg.close(); }
});

test("a finalize that began recently is left alone even when the deploy started long ago", async () => {
  const pg = await db();
  try {
    // A 40-minute build, then finalize took over 2 minutes ago.
    await stuckFinalize(pg, 42 * 60_000, 2 * 60_000);
    assert.equal(await reclaimStaleDeploy(pgStore(pg), app, await row(pg)), "blocked");
    const { a, ops } = await state(pg);
    assert.equal(a.fc_status, "deploying");
    assert.deepEqual(ops.map((o: any) => [o.status, o.in_flight]), [["pending", true]]);
  } finally { await pg.close(); }
});

test("a young deploy is not stale at all", async () => {
  const pg = await db();
  try {
    await stuckFinalize(pg, 5 * 60_000, 5 * 60_000);
    assert.equal(await reclaimStaleDeploy(pgStore(pg), app, await row(pg)), "not_stale");
    assert.equal(await reclaimStaleDeploy(pgStore(pg), app, { fcStatus: "live", deployStartedAt: null, deployToken: null }), "not_stale");
  } finally { await pg.close(); }
});

test("a stale build that never reached finalize is reclaimed as before", async () => {
  const pg = await db();
  try {
    await pg.query(`select amux.begin_app_lifecycle($1,'deploy','tok')`, [app]);
    await pg.query(`update amux.apps set fc_status='awaiting_build', deploy_started_at=$2 where id=$1`, [app, new Date(Date.now() - HOUR)]);
    assert.equal(await reclaimStaleDeploy(pgStore(pg), app, await row(pg)), "reclaimed");
    const { a, ops } = await state(pg);
    assert.equal(a.fc_status, "deploy_error");
    assert.equal(a.provision_error, "previous build timed out");
    assert.equal(ops[0].status, "succeeded");
  } finally { await pg.close(); }
});

test("another lifecycle kind is never cleared, and a lock that moved since it was read is not released", async () => {
  // An undeploy owning the app.
  const kinds: ReclaimStore = {
    pendingOperation: async () => ({ id: "op", kind: "undeploy", inFlight: true, updatedAt: new Date(0).toISOString() }),
    releaseOperation: async () => { throw new Error("must not release"); },
    abandonApp: async () => { throw new Error("must not touch the app"); },
  };
  const stale = { fcStatus: "deploying", deployStartedAt: new Date(Date.now() - HOUR), deployToken: "tok" };
  assert.equal(await reclaimStaleDeploy(kinds, app, stale), "blocked");

  // Finalize finished between the read and the write.
  let abandoned = false;
  const raced: ReclaimStore = {
    pendingOperation: async () => ({ id: "op", kind: "deploy", inFlight: true, updatedAt: new Date(Date.now() - HOUR).toISOString() }),
    releaseOperation: async () => false,
    abandonApp: async () => { abandoned = true; return true; },
  };
  assert.equal(await reclaimStaleDeploy(raced, app, stale), "blocked");
  assert.equal(abandoned, false, "the app is not flipped when its lock could not be released");
  assert.ok(STALE_DEPLOY_MS < HOUR);
});

test("supabaseReclaimStore writes only rows that are still as they were read", async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain = (result: unknown) => {
    const q: any = new Proxy({}, {
      get: (_t, prop: string) => prop === "maybeSingle"
        ? async () => { calls.push(["maybeSingle"]); return { data: result, error: null }; }
        : (...args: unknown[]) => { calls.push([prop, ...args]); return q; },
    });
    return q;
  };
  const client = { from: (t: string) => { calls.push(["from", t]); return chain({ id: "x" }); } };
  const store = supabaseReclaimStore(client);
  const op = { id: "op1", kind: "deploy", inFlight: true, updatedAt: "2026-11-25T02:10:01.785066+00:00" };
  assert.equal(await store.releaseOperation(op, "reclaimed: x"), true);
  assert.deepEqual(calls.filter(c => ["eq", "neq"].includes(c[0])),
    [["eq", "id", "op1"], ["neq", "status", "succeeded"], ["eq", "in_flight", true], ["eq", "updated_at", op.updatedAt]]);
  calls.length = 0;
  await store.abandonApp(app, { fcStatus: "deploying", deployToken: null }, "m");
  assert.deepEqual(calls.filter(c => ["eq", "is"].includes(c[0])),
    [["eq", "id", app], ["eq", "fc_status", "deploying"], ["is", "deploy_token", null]]);
});
