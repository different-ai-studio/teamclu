import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import {
  LEDGER_TABLE,
  MAX_MIGRATION_BYTES,
  applyMigrations,
  migrationChecksum,
  parseAppMigrations,
  planMigrations,
  runAppMigrations,
  type MigrationSession,
} from "../../src/lib/provisioning/app-migrations.js";
import { appRoleName, appSchemaName, orgDatabaseName } from "../../src/lib/provisioning/pg-name.js";

const m = (name: string, sql: string) => ({ name, sql });

test("parseAppMigrations: absent is none, and files come back in run order", () => {
  assert.deepEqual(parseAppMigrations(undefined), []);
  assert.deepEqual(parseAppMigrations(null), []);
  const out = parseAppMigrations([m("0002_b.sql", "select 2"), m("0001_a.sql", "select 1"), m("0010_c.sql", "select 3")]);
  assert.deepEqual(out.map(x => x.name), ["0001_a.sql", "0002_b.sql", "0010_c.sql"]);
});

test("parseAppMigrations refuses names that could not be a migrations/ file", () => {
  for (const name of ["a.sql", "0001.sql", "0001_x.txt", "../0001_x.sql", "0001_x/y.sql", "0001_ x.sql", "", 1]) {
    assert.throws(() => parseAppMigrations([{ name, sql: "select 1" }]), /must look like 0001_description\.sql/, String(name));
  }
});

test("parseAppMigrations refuses duplicates, missing text, oversize files and non-arrays", () => {
  assert.throws(() => parseAppMigrations([m("0001_a.sql", "x"), m("0001_a.sql", "y")]), /listed twice/);
  assert.throws(() => parseAppMigrations([{ name: "0001_a.sql" }]), /no sql text/);
  assert.throws(() => parseAppMigrations([m("0001_a.sql", "x".repeat(MAX_MIGRATION_BYTES + 1))]), /larger than/);
  assert.throws(() => parseAppMigrations({ name: "0001_a.sql" }), /must be an array/);
});

test("planMigrations: applied files are skipped, new ones are pending", () => {
  const files = [m("0001_a.sql", "create table a()"), m("0002_b.sql", "create table b()")];
  const applied = new Map([["0001_a.sql", migrationChecksum("create table a()")]]);
  assert.deepEqual(planMigrations(files, applied).map(x => x.name), ["0002_b.sql"]);
  assert.deepEqual(planMigrations(files, new Map()).map(x => x.name), ["0001_a.sql", "0002_b.sql"]);
});

test("planMigrations: an applied file whose text changed stops the deploy", () => {
  const applied = new Map([["0001_a.sql", migrationChecksum("create table a()")]]);
  assert.throws(
    () => planMigrations([m("0001_a.sql", "create table a(id int)")], applied),
    (e: any) => e.code === "migration_modified" && e.statusCode === 409 && /new file/.test(e.message),
  );
});

test("planMigrations: a new file numbered before the latest applied one stops the deploy", () => {
  const applied = new Map([["0005_e.sql", migrationChecksum("select 1")]]);
  assert.throws(
    () => planMigrations([m("0003_c.sql", "select 3"), m("0005_e.sql", "select 1")], applied),
    (e: any) => e.code === "migration_out_of_order" && /0003_c\.sql/.test(e.message),
  );
});

test("planMigrations: an applied file removed from the repo is not an error", () => {
  const applied = new Map([["0001_a.sql", "whatever"]]);
  assert.deepEqual(planMigrations([m("0002_b.sql", "select 1")], applied).map(x => x.name), ["0002_b.sql"]);
});

// --- applyMigrations on PGlite: the transaction semantics. PGlite has one
// superuser connection, so the privilege boundary is tested against a real
// server below; here the role is a plain one the session can SET ROLE to.

async function pgliteWorld() {
  const pg = new PGlite();
  await pg.exec(`
    create schema app_s;
    create role app_r nologin;
    grant usage, create on schema app_s to app_r;
  `);
  const session: MigrationSession = {
    transaction: fn => pg.transaction(async tx => fn({
      query: async (text, params) => (await tx.query(text, params)).rows as never,
      script: async text => { await tx.exec(text); },
    })),
  };
  return { pg, session, target: { role: "app_r", schema: "app_s" } };
}

test("applyMigrations runs pending files once, as the app's role, and records them", async () => {
  const { pg, session, target } = await pgliteWorld();
  const files = [
    m("0001_tasks.sql", "create table scan_tasks (id serial primary key, name text);\ninsert into scan_tasks (name) values ('a');"),
    m("0002_index.sql", "create index scan_tasks_name on scan_tasks (name);"),
  ];
  const first = await applyMigrations(session, target, files, "abc123");
  assert.deepEqual(first.applied, ["0001_tasks.sql", "0002_index.sql"]);

  const owner = await pg.query<{ tableowner: string }>(`select tableowner from pg_tables where schemaname = 'app_s' and tablename = 'scan_tasks'`);
  assert.equal(owner.rows[0]?.tableowner, "app_r", "objects belong to the app, not the platform");
  const ledger = await pg.query<{ name: string; checksum: string; git_commit_sha: string }>(`select name, checksum, git_commit_sha from app_s.${LEDGER_TABLE} order by name`);
  assert.deepEqual(ledger.rows.map(r => [r.name, r.git_commit_sha]), [["0001_tasks.sql", "abc123"], ["0002_index.sql", "abc123"]]);
  assert.equal(ledger.rows[0].checksum, migrationChecksum(files[0].sql));

  const again = await applyMigrations(session, target, files, "def456");
  assert.deepEqual(again.applied, [], "a redeploy runs nothing twice");
  const rows = await pg.query<{ n: number }>(`select count(*)::int as n from app_s.scan_tasks`);
  assert.equal(rows.rows[0].n, 1);
});

test("a failing file is rolled back whole, earlier files stay, and the error names the file", async () => {
  const { pg, session, target } = await pgliteWorld();
  const files = [
    m("0001_ok.sql", "create table good (id int);"),
    m("0002_bad.sql", "create table half (id int);\nselect * from no_such_table;"),
    m("0003_never.sql", "create table never (id int);"),
  ];
  await assert.rejects(
    () => applyMigrations(session, target, files, null),
    (e: any) => e.code === "migration_failed" && e.statusCode === 422
      && /0002_bad\.sql/.test(e.message) && /SQLSTATE 42P01/.test(e.message) && /live version keeps running/.test(e.message),
  );
  const tables = await pg.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'app_s' order by 1`);
  assert.deepEqual(tables.rows.map(r => r.tablename), [LEDGER_TABLE, "good"]);
  const ledger = await pg.query<{ name: string }>(`select name from app_s.${LEDGER_TABLE}`);
  assert.deepEqual(ledger.rows.map(r => r.name), ["0001_ok.sql"]);

  // Fixed and redeployed: picks up where it stopped.
  files[1] = m("0002_bad.sql", "create table half (id int);");
  const retry = await applyMigrations(session, target, files, null);
  assert.deepEqual(retry.applied, ["0002_bad.sql", "0003_never.sql"]);
});

test("no migrations touches nothing", async () => {
  const session: MigrationSession = { transaction: async () => { throw new Error("must not open a transaction"); } };
  assert.deepEqual(await applyMigrations(session, { role: "app_r", schema: "app_s" }, [], null), { applied: [] });
});

test("unsafe role or schema names are refused before any SQL", async () => {
  const session: MigrationSession = { transaction: async () => { throw new Error("must not open a transaction"); } };
  await assert.rejects(() => applyMigrations(session, { role: "app_r; drop", schema: "app_s" }, [m("0001_a.sql", "select 1")], null), /unsafe/);
});

// --- runAppMigrations against a real Postgres server: the privilege boundary
// and the live password. Opt-in, because it needs a superuser URL:
//   APP_MIGRATIONS_PG_URL=postgres://postgres:pw@127.0.0.1:55432/postgres
const PG_URL = process.env.APP_MIGRATIONS_PG_URL;
const TASKS_SQL = "create table scan_tasks (id serial primary key, name text not null);\ncreate index scan_tasks_name on scan_tasks (name);\ninsert into scan_tasks (name) values ('seed');";

test("runAppMigrations on a real server: app privileges only, live password kept, migrator removed", { skip: !PG_URL && "set APP_MIGRATIONS_PG_URL to run" }, async () => {
  const orgId = "11111111-2222-4333-8444-" + Math.floor(Math.random() * 1e12).toString(16).padStart(12, "0");
  const appId = "3f1c9a2e-0000-4000-8000-" + Math.floor(Math.random() * 1e12).toString(16).padStart(12, "0");
  const slug = "fund-mgmt";
  const role = appRoleName(appId);
  const schema = appSchemaName(slug, appId);
  const database = orgDatabaseName(orgId);
  const admin = postgres(PG_URL!, { max: 1, onnotice: () => {} });
  const orgUrl = new URL(PG_URL!);
  orgUrl.pathname = `/${database}`;
  const orgAdmin = () => postgres(orgUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    // A live app: role with the password the running function holds.
    const { provisionAppPostgres } = await import("../../src/lib/provisioning/app-postgres.js");
    await provisionAppPostgres(PG_URL!, { orgId, appId, slug, password: "live-pw" });

    await runAppMigrations(PG_URL!, {
      orgId, appId, slug, gitCommitSha: "abc",
      migrations: [m("0001_tasks.sql", TASKS_SQL)],
    });

    // The live function's password still works, and it sees the new table.
    const liveUrl = new URL(orgUrl.toString());
    liveUrl.username = role;
    liveUrl.password = "live-pw";
    const live = postgres(liveUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      await live.unsafe(`insert into ${schema}.scan_tasks (name) values ('x')`);
    } finally {
      await live.end();
    }
    const oa = orgAdmin();
    try {
      const [{ tableowner }] = await oa`select tableowner from pg_tables where schemaname = ${schema} and tablename = 'scan_tasks'`;
      assert.equal(tableowner, role);
    } finally {
      await oa.end();
    }

    // A file that tries to climb out of the app's role gets nowhere: RESET
    // ROLE lands on the migrator, which holds even less.
    await assert.rejects(
      () => runAppMigrations(PG_URL!, { orgId, appId, slug, migrations: [
        m("0001_tasks.sql", TASKS_SQL),
        m("0002_escape.sql", "reset role; create role pwned superuser;"),
      ] }),
      (e: any) => e.code === "migration_failed" && /0002_escape\.sql/.test(e.message),
    );
    await assert.rejects(
      () => runAppMigrations(PG_URL!, { orgId, appId, slug, migrations: [
        m("0001_tasks.sql", TASKS_SQL),
        m("0002_escape.sql", "reset role; select rolpassword from pg_authid;"),
      ] }),
      (e: any) => e.code === "migration_failed" && /SQLSTATE 42501/.test(e.message),
    );
    const pwned = await admin`select 1 from pg_roles where rolname = 'pwned'`;
    assert.equal(pwned.length, 0);
    const leftovers = await admin`select rolname from pg_roles where rolname like 'tc_mig_%'`;
    assert.deepEqual([...leftovers], [], "every migrator role is dropped");
  } finally {
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()`).catch(() => {});
    await admin.unsafe(`drop database if exists ${database}`).catch(() => {});
    await admin.unsafe(`drop role if exists ${role}`).catch(() => {});
    await admin.end();
  }
});
