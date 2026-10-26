import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const oldMigration = new URL("../../supabase/migrations/20261019000000_apps_public_code.sql", import.meta.url);
const migration = new URL("../../supabase/migrations/20261025110255_apps_public_code_full_format.sql", import.meta.url);
const fullFormat = /^a-[0-9a-hjkmnp-tv-z]{12}$/;

async function legacyDatabase() {
  const db = new PGlite();
  await db.exec(`create schema amux;
    create table amux.apps (
      id uuid primary key default gen_random_uuid(), name text, slug text,
      fc_endpoint text, fc_function_name text, fc_status text, deploy_token text,
      deploy_started_at timestamptz, auth_mode text, auth_rules jsonb, org_id uuid
    );
    create table amux.app_lifecycle_operations (
      id uuid primary key default gen_random_uuid(), app_id uuid references amux.apps,
      status text not null default 'succeeded', in_flight boolean not null default false,
      snapshot jsonb not null default '{}'::jsonb
    );
    create table amux.app_permissions (app_id uuid references amux.apps, actor_id uuid, permission text);
    insert into amux.apps(id, name, slug, fc_endpoint, fc_function_name, fc_status, auth_mode, auth_rules, org_id) values
      ('00000000-0000-4000-8000-000000000001', '名称域名', 'shop', 'https://old-one.fcapp.run', 'fn-one', 'live', 'platform', '{"/private":"org"}', '00000000-0000-4000-8000-000000000003'),
      ('00000000-0000-4000-8000-000000000002', '代码域名', 'dashboard', 'https://old-two.fcapp.run', 'fn-two', 'live', 'public', '{}', null);
    insert into amux.app_permissions values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'owner');
    insert into amux.app_lifecycle_operations(app_id, snapshot) values
      ('00000000-0000-4000-8000-000000000002', '{"fc_function_name":"fn-two"}');
    alter table amux.apps enable row level security;
    create policy fixture_visibility on amux.apps for select using (auth_mode = 'public');`);
  await db.exec(await readFile(oldMigration, "utf8"));
  await db.exec(`alter table amux.apps disable trigger apps_app_code_immutable;
    update amux.apps set app_code = case slug when 'shop' then '000000000000' else 'zzzzzzzzzzzz' end,
      uses_app_code_domain = (slug = 'dashboard');
    alter table amux.apps enable trigger apps_app_code_immutable;`);
  return db;
}

async function snapshot(db: PGlite) {
  return (await db.query(`select jsonb_build_object(
    'apps', (select jsonb_agg(to_jsonb(a) - 'app_code' order by id) from amux.apps a),
    'permissions', (select jsonb_agg(p) from amux.app_permissions p),
    'lifecycle', (select jsonb_agg(o) from amux.app_lifecycle_operations o),
    'policies', (select jsonb_agg(p) from pg_policies p where schemaname = 'amux'),
    'rls', (select relrowsecurity from pg_class where oid = 'amux.apps'::regclass)
  ) as saved`)).rows;
}

async function assertLegacyProtection(db: PGlite) {
  assert.deepEqual((await db.query("select app_code from amux.apps order by slug")).rows,
    [{ app_code: "zzzzzzzzzzzz" }, { app_code: "000000000000" }]);
  assert.match((await db.query<{ code: string }>("select amux.generate_app_code() as code")).rows[0].code,
    /^[0-9a-hjkmnp-tv-z]{12}$/);
  await assert.rejects(db.exec("update amux.apps set app_code = '111111111111'"), /immutable/);
}

describe("complete app code migration chain", () => {
  test("prefixes only the stored identity, preserving URLs, UUID references, deployment and permissions", async () => {
    const db = await legacyDatabase();
    try {
      const before = await snapshot(db);
      const urlsBefore = (await db.query(`select case when uses_app_code_domain then 'https://a-' || app_code
        else 'https://' || slug end || '.apps.example.test' as url from amux.apps order by id`)).rows;
      await db.exec(await readFile(migration, "utf8"));
      assert.deepEqual((await db.query("select app_code from amux.apps order by id")).rows,
        [{ app_code: "a-000000000000" }, { app_code: "a-zzzzzzzzzzzz" }]);
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual((await db.query(`select case when uses_app_code_domain then 'https://' || app_code
        else 'https://' || slug end || '.apps.example.test' as url from amux.apps order by id`)).rows, urlsBefore);
      await db.exec(await readFile(migration, "utf8"));
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual((await db.query("select app_code from amux.apps order by id")).rows,
        [{ app_code: "a-000000000000" }, { app_code: "a-zzzzzzzzzzzz" }]);
    } finally { await db.close(); }
  });

  test("new defaults, format, immutability and uniqueness remain enforced", async () => {
    const db = await legacyDatabase();
    try {
      await db.exec(await readFile(migration, "utf8"));
      const row = (await db.query<{ id: string; app_code: string; uses_app_code_domain: boolean; deploy_use_app_code_domain: boolean | null }>(
        "insert into amux.apps(name) values ('New') returning id, app_code, uses_app_code_domain, deploy_use_app_code_domain")).rows[0];
      assert.match(row.app_code, fullFormat);
      assert.equal(row.uses_app_code_domain, true);
      assert.equal(row.deploy_use_app_code_domain, null);
      await db.query("update amux.apps set name = 'Renamed', slug = 'renamed' where id = $1", [row.id]);
      assert.equal((await db.query<{ app_code: string }>("select app_code from amux.apps where id = $1", [row.id])).rows[0].app_code, row.app_code);
      await assert.rejects(db.exec("update amux.apps set app_code = 'a-111111111111'"), /immutable/);
      await assert.rejects(db.exec("insert into amux.apps(app_code) select app_code from amux.apps limit 1"), /apps_app_code_key/);
      await assert.rejects(db.exec("insert into amux.apps(app_code) values (null)"), /not-null constraint/);
      for (const invalid of ["000000000000", "a-a-000000000000", "a-00000000000i", "a-00000000000l", "a-00000000000o", "a-00000000000u", "A-000000000000"]) {
        await assert.rejects(db.query("insert into amux.apps(app_code) values ($1)", [invalid]), /apps_app_code_format/);
      }
    } finally { await db.close(); }
  });

  test("the complete generator preserves all 60 random tail bits", async () => {
    const db = await legacyDatabase();
    try {
      await db.exec(await readFile(migration, "utf8"));
      await db.exec(`create sequence public.random_tail_fixture;
        create or replace function pg_catalog.gen_random_uuid() returns uuid language sql volatile as $$
          select (array['12345678-1234-4234-8000-000000000000'::uuid,
            '12345678-1234-4234-8800-000000000000'::uuid,
            '12345678-1234-4234-8fff-ffffffffffff'::uuid])[nextval('public.random_tail_fixture')::int]
        $$`);
      for (const expected of ["a-000000000000", "a-g00000000000", "a-zzzzzzzzzzzz"]) {
        assert.equal((await db.query<{ code: string }>("select amux.generate_app_code() as code")).rows[0].code, expected);
      }
    } finally { await db.close(); }
  });

  test("refuses every potentially active operation, including stale or orphaned tokens, with no changes", async () => {
    const db = await legacyDatabase();
    try {
      const blockers = [
        "update amux.apps set deploy_token = 'orphaned-expired-token', deploy_started_at = '2000-01-01' where slug = 'shop'",
        ...["awaiting_build", "building", "deploying", "uninstalling"].map((status) => `update amux.apps set fc_status = '${status}' where slug = 'shop'`),
        "update amux.app_lifecycle_operations set status = 'pending'",
        "update amux.app_lifecycle_operations set status = 'running'",
        "update amux.app_lifecycle_operations set status = 'failed', in_flight = true",
        "update amux.app_lifecycle_operations set status = 'succeeded', in_flight = true",
      ];
      for (const blocker of blockers) {
        await db.exec(blocker);
        const before = await snapshot(db);
        await assert.rejects(db.exec(await readFile(migration, "utf8")), /app code migration requires idle lifecycle/i, blocker);
        await db.exec("rollback");
        assert.deepEqual(await snapshot(db), before, blocker);
        await assertLegacyProtection(db);
        await db.exec(`update amux.apps set deploy_token = null, deploy_started_at = null, fc_status = 'live';
          update amux.app_lifecycle_operations set status = 'succeeded', in_flight = false;`);
      }
    } finally { await db.close(); }
  });

  test("rolls back DDL and data when another trigger rejects the conversion", async () => {
    const db = await legacyDatabase();
    try {
      await db.exec(`create function amux.reject_conversion() returns trigger language plpgsql as $$
        begin
          if new.app_code like 'a-%' then raise exception 'conversion rejected by fixture'; end if;
          return new;
        end $$;
        create trigger fixture_conversion_guard before update of app_code on amux.apps
          for each row execute function amux.reject_conversion();`);
      const before = await snapshot(db);
      await assert.rejects(db.exec(await readFile(migration, "utf8")), /conversion rejected by fixture/);
      await db.exec("rollback");
      assert.deepEqual(await snapshot(db), before);
      await assertLegacyProtection(db);
      await assert.rejects(db.exec("insert into amux.apps(app_code) values ('a-111111111111')"), /apps_app_code_format/);
      await db.exec("insert into amux.apps(name) values ('Default after rollback')");
      assert.match((await db.query<{ app_code: string }>("select app_code from amux.apps where name = 'Default after rollback'")).rows[0].app_code,
        /^[0-9a-hjkmnp-tv-z]{12}$/);
    } finally { await db.close(); }
  });

  test("rejects malformed or normalization-colliding input before changing any code", async () => {
    const db = await legacyDatabase();
    try {
      await db.exec("alter table amux.apps drop constraint apps_app_code_format; alter table amux.apps disable trigger apps_app_code_immutable");
      for (const bad of ["bad", "a-000000000000"]) {
        await db.query("update amux.apps set app_code = $1 where slug = 'dashboard'", [bad]);
        await db.exec("alter table amux.apps enable trigger apps_app_code_immutable");
        const before = (await db.query("select * from amux.apps order by id")).rows;
        await assert.rejects(db.exec(await readFile(migration, "utf8")), /app code migration (invalid format|normalized collision)/i);
        await db.exec("rollback");
        assert.deepEqual((await db.query("select * from amux.apps order by id")).rows, before);
        await assert.rejects(db.exec("update amux.apps set app_code = '111111111111'"), /immutable/);
        await db.exec("alter table amux.apps disable trigger apps_app_code_immutable");
      }
    } finally { await db.close(); }
  });
});
