import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../supabase/migrations/20261019000000_apps_public_code.sql", import.meta.url);

describe("app code migration", () => {
  test("backfill preserves existing deployments and assigns independent codes", async () => {
    const db = new PGlite();
    try {
      await db.exec(`create schema amux;
        create table amux.apps (
          id uuid primary key default gen_random_uuid(), name text, slug text,
          fc_endpoint text, fc_function_name text, fc_status text
        );
        insert into amux.apps(name, slug, fc_endpoint, fc_function_name, fc_status) values
          ('门店大盘', 'shop', 'https://existing-one.fcapp.run', 'existing-one', 'live'),
          ('门店大盘', 'shop-two', 'https://existing-two.fcapp.run', 'existing-two', 'error');`);
      const deploymentsBefore = await db.query("select id, fc_endpoint, fc_function_name, fc_status from amux.apps order by id");
      await db.exec(await readFile(migration, "utf8"));
      const deploymentsAfter = await db.query("select id, fc_endpoint, fc_function_name, fc_status from amux.apps order by id");
      assert.deepEqual(deploymentsAfter.rows, deploymentsBefore.rows);
      const legacy = await db.query<{ id: string; app_code: string; uses_app_code_domain: boolean; deploy_use_app_code_domain: boolean | null }>(
        "select id, app_code, uses_app_code_domain, deploy_use_app_code_domain from amux.apps order by id",
      );
      assert.equal(new Set(legacy.rows.map((row) => row.app_code)).size, 2);
      for (const legacyRow of legacy.rows) {
        assert.match(legacyRow.app_code, /^[0-9a-hjkmnp-tv-z]{12}$/);
        assert.equal(legacyRow.uses_app_code_domain, false);
        assert.equal(legacyRow.deploy_use_app_code_domain, null);
      }
      const fresh = await db.query<{ app_code: string; uses_app_code_domain: boolean; deploy_use_app_code_domain: boolean | null }>(
        "insert into amux.apps(name, slug) values ('New', 'new') returning app_code, uses_app_code_domain, deploy_use_app_code_domain",
      );
      const newRow = fresh.rows[0];
      assert.equal(newRow.uses_app_code_domain, true);
      assert.match(newRow.app_code, /^[0-9a-hjkmnp-tv-z]{12}$/);
      assert.equal(newRow.deploy_use_app_code_domain, null);
      await db.exec("insert into amux.apps(name) select 'new' from generate_series(1, 1000)");
      const counts = await db.query("select count(*)::int as total, count(distinct app_code)::int as unique_codes from amux.apps");
      assert.deepEqual(counts.rows, [{ total: 1003, unique_codes: 1003 }]);
      const codesBefore = await db.query("select id, app_code from amux.apps order by id");
      await db.exec("update amux.apps set name = 'Renamed', slug = 'renamed'");
      assert.deepEqual((await db.query("select id, app_code from amux.apps order by id")).rows, codesBefore.rows);
      await assert.rejects(() => db.exec("update amux.apps set app_code = '000000000000'"), /immutable/i);
      await assert.rejects(() => db.exec("insert into amux.apps(app_code) values (null)"), /not-null constraint/i);
      for (const code of ['bad', '00000000000i', '00000000000l', '00000000000o', '00000000000u', '00000000000A', '00000000000_']) {
        await assert.rejects(() => db.query("insert into amux.apps(app_code) values ($1)", [code]), /check constraint/i);
      }
      await assert.rejects(() => db.exec("insert into amux.apps(app_code) select app_code from amux.apps limit 1"), /unique constraint/i);
    } finally {
      await db.close();
    }
  });

  test("backfill retries a generated code collision", async () => {
    const db = new PGlite();
    try {
      await db.exec(`create schema amux;
        create table amux.apps (id uuid primary key);
        insert into amux.apps values
          ('00000000-0000-4000-8000-000000000001'),
          ('00000000-0000-4000-8000-000000000002');
        create sequence public.code_attempt;
        create or replace function pg_catalog.gen_random_uuid() returns uuid
        language sql volatile as $$
          select case when nextval('public.code_attempt') <= 2
            then '00000000-0000-4000-8000-000000000001'::uuid
            else '00000000-0000-4000-8000-000000000002'::uuid end
        $$;`);
      await db.exec(await readFile(migration, "utf8"));
      assert.deepEqual((await db.query("select app_code from amux.apps order by app_code")).rows,
        [{ app_code: "000000000001" }, { app_code: "000000000002" }]);
      assert.equal((await db.query<{ last_value: number }>("select last_value::int from public.code_attempt")).rows[0].last_value, 3);
    } finally {
      await db.close();
    }
  });

  test("the generator preserves all 60 random tail bits outside UUID version and variant bits", async () => {
    const db = new PGlite();
    try {
      await db.exec("create schema amux; create table amux.apps (id uuid primary key)");
      await db.exec(await readFile(migration, "utf8"));
      await db.exec(`create sequence public.random_tail_fixture;
        create or replace function pg_catalog.gen_random_uuid() returns uuid
        language sql volatile as $$
          select (array[
            '12345678-1234-4234-8000-000000000000'::uuid,
            '12345678-1234-4234-8800-000000000000'::uuid,
            '12345678-1234-4234-8fff-ffffffffffff'::uuid
          ])[nextval('public.random_tail_fixture')::int]
        $$`);
      for (const expected of ["000000000000", "g00000000000", "zzzzzzzzzzzz"]) {
        assert.equal((await db.query<{ code: string }>("select amux.generate_app_code() as code")).rows[0].code, expected);
      }
    } finally {
      await db.close();
    }
  });

});
