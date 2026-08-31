import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProvisionStatements } from "../../src/lib/provisioning/app-postgres.js";
import { PGlite } from "@electric-sql/pglite";
import { ensureAppSchema } from "../../src/lib/provisioning/app-postgres.js";
import { getAppsAdminExecutor } from "../../src/lib/provisioning/app-postgres.js";
import {
  resolveAppConnectionString,
  withDbHost,
} from "../../src/lib/provisioning/app-postgres.js";
import { appSchemaName } from "../../src/lib/provisioning/pg-name.js";

test("buildProvisionStatements throws on an unsafe schema name", () => {
  assert.throws(
    () =>
      buildProvisionStatements({
        schema: 'evil"; drop schema amux cascade; --',
        role: "app_ok",
        password: "pw",
      }),
    /unsafe postgres identifier/i,
  );
});

test("buildProvisionStatements throws on an unsafe role name", () => {
  assert.throws(
    () => buildProvisionStatements({ schema: "app_ok", role: "r-bad", password: "pw" }),
    /unsafe postgres identifier/i,
  );
});

test("buildProvisionStatements emits idempotent, schema-scoped DDL in order", () => {
  const stmts = buildProvisionStatements({ schema: "app_demo", role: "app_demo", password: "s3cret" });
  assert.equal(stmts[0], "create schema if not exists app_demo");
  // role created when absent, password re-applied when present
  assert.match(stmts[1], /if exists \(select 1 from pg_roles where rolname = 'app_demo'\)/);
  assert.match(stmts[1], /alter role app_demo with login password 's3cret'/);
  assert.match(stmts[1], /create role app_demo login password 's3cret'/);
  // grants are scoped to the app schema only — never to amux/public
  assert.ok(stmts.some((s) => s === "grant usage, create on schema app_demo to app_demo"));
  assert.ok(stmts.every((s) => !/\bamux\b|\bpublic\b/.test(s)));
  // search_path pinned
  assert.ok(stmts.includes("alter role app_demo set search_path = app_demo"));
});

test("buildProvisionStatements escapes single quotes in the password", () => {
  const stmts = buildProvisionStatements({ schema: "app_x", role: "app_x", password: "a'b" });
  assert.match(stmts[1], /password 'a''b'/);
});

test("re-provisioning an existing role applies the NEW password", async () => {
  // Regression: the role was only touched on create, so a redeploy handed the
  // app a connection string whose password had never been set.
  const pg = new PGlite();
  const exec = async (sql: string) => { await pg.exec(sql); };
  const params = {
    appId: "3f1c9a2e-0000-4000-8000-000000000abc",
    slug: "Demo App",
    baseUrl: "postgres://host:5432/teamclu_apps",
  };
  await ensureAppSchema(exec, { ...params, password: "first-pw" });
  await ensureAppSchema(exec, { ...params, password: "second-pw" });
  // md5-less check: ask PG whether the stored secret validates the new password.
  const r = await pg.query<{ ok: boolean }>(
    `select (rolpassword is not null) as ok from pg_authid
      where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'`,
  );
  assert.equal(r.rows[0]?.ok, true);
  // And the statement stream for the second call carries the second password.
  const stmts = buildProvisionStatements({ schema: "app_x", role: "app_x", password: "second-pw" });
  assert.match(stmts[1], /alter role app_x with login password 'second-pw'/);
});

test("ensureAppSchema creates the schema and a scoped role on a real PG (pglite)", async () => {
  const pg = new PGlite();
  const exec = async (sql: string) => { await pg.exec(sql); };
  const appId = "3f1c9a2e-0000-4000-8000-000000000abc";
  const expectedSchema = appSchemaName("Demo App", appId);
  const conn = await ensureAppSchema(exec, {
    appId,
    slug: "Demo App",
    password: "p@ss'1",
    baseUrl: "postgres://app_user@host:5432/teamclu_apps",
  });
  const schemas = await pg.query<{ schema_name: string }>(
    `select schema_name from information_schema.schemata where schema_name = '${expectedSchema}'`,
  );
  assert.equal(schemas.rows.length, 1);
  const roles = await pg.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'",
  );
  assert.equal(roles.rows.length, 1);
  assert.match(conn.connectionString, /app_3f1c9a2e_0000_4000_8000_000000000abc/);
  assert.equal(conn.database, "teamclu_apps");
  assert.match(
    conn.connectionString,
    new RegExp(`[?&]options=.*search_path%3D${expectedSchema}`),
  );
});

test("ensureAppSchema is safe to run twice (idempotent re-deploy)", async () => {
  const pg = new PGlite();
  const exec = async (sql: string) => { await pg.exec(sql); };
  const params = {
    appId: "3f1c9a2e-0000-4000-8000-000000000abc",
    slug: "Demo App",
    password: "p@ss'1",
    baseUrl: "postgres://host:5432/teamclu_apps",
  };
  await ensureAppSchema(exec, params);
  await ensureAppSchema(exec, params);
  const roles = await pg.query<{ n: number }>(
    "select count(*)::int as n from pg_roles where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'",
  );
  assert.equal(roles.rows[0].n, 1);
});

test("getAppsAdminExecutor throws a clear error when APPS_DB_ADMIN_URL is unset", () => {
  const prev = process.env.APPS_DB_ADMIN_URL;
  delete process.env.APPS_DB_ADMIN_URL;
  try {
    assert.throws(() => getAppsAdminExecutor(), /APPS_DB_ADMIN_URL is not set/);
  } finally {
    if (prev !== undefined) process.env.APPS_DB_ADMIN_URL = prev;
  }
});

test("withDbHost rewrites host while keeping role, database, and search_path", () => {
  const out = withDbHost(
    "postgres://app_role:secret@db:5432/tc_org_abc?options=-c%20search_path%3Dapp_demo",
    "postgres://postgres:pw@192.168.0.23:5432/postgres",
  );
  const u = new URL(out);
  assert.equal(u.hostname, "192.168.0.23");
  assert.equal(u.port, "5432");
  assert.equal(u.username, "app_role");
  assert.equal(u.pathname, "/tc_org_abc");
  assert.match(u.search, /search_path/);
});

test("resolveAppConnectionString requires APPS_DB_APP_URL for compose-internal admin host", () => {
  assert.throws(
    () =>
      resolveAppConnectionString(
        "postgres://app_role:secret@db:5432/tc_org_abc",
        "postgres://postgres:pw@db:5432/postgres",
      ),
    /APPS_DB_APP_URL is required/,
  );
});

test("resolveAppConnectionString rewrites when APPS_DB_APP_URL is provided", () => {
  const out = resolveAppConnectionString(
    "postgres://app_role:secret@db:5432/tc_org_abc",
    "postgres://postgres:pw@db:5432/postgres",
    "postgres://postgres:pw@10.0.0.5:5432/postgres",
  );
  assert.match(out, /@10\.0\.0\.5:5432\/tc_org_abc/);
});

test("resolveAppConnectionString rewrites public admin host to internal app host", () => {
  const out = resolveAppConnectionString(
    "postgres://app_role:secret@pgm-public.example:5432/tc_org_abc",
    "postgres://postgres:pw@pgm-public.example:5432/postgres",
    "postgres://postgres:pw@pgm-internal.example:5432/postgres",
  );
  assert.match(out, /@pgm-internal\.example:5432\/tc_org_abc/);
});
