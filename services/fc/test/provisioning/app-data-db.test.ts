import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { ensureAppSchema } from "../../src/lib/provisioning/app-postgres.js";
import { appRoleName, appSchemaName } from "../../src/lib/provisioning/pg-name.js";
import {
  runAppQuery,
  listTables,
  readRows,
  updateRow,
  deleteRow,
  parsePageLimit,
  describeDbError,
  MAX_PAGE_SIZE,
  type AppDataSql,
  type ConnectOrgDb,
} from "../../src/lib/provisioning/app-data-db.js";

const ADMIN_URL = "postgres://admin:pw@db.internal:5432/postgres";
const ORG_ID = "0a1b2c3d-0000-4000-8000-00000000face";
const APP_ID = "3f1c9a2e-0000-4000-8000-000000000abc";
const SLUG = "demo-app";
const TARGET = { orgId: ORG_ID, appId: APP_ID, slug: SLUG };
const SCHEMA = appSchemaName(SLUG, APP_ID);
const ROLE = appRoleName(APP_ID);

/** postgres.js-shaped adapter over PGlite's single in-process connection. */
function pgliteConnect(pg: PGlite): ConnectOrgDb {
  const sql: AppDataSql = {
    async begin(options, fn) {
      await pg.exec(`begin ${options}`);
      try {
        const out = await fn({
          async unsafe(query: string, params?: any[]) {
            const r = await pg.query(query, params ?? []);
            return (r.rows ?? []) as any[];
          },
        });
        await pg.exec("commit");
        return out;
      } catch (e) {
        await pg.exec("rollback");
        throw e;
      }
    },
  };
  return () => sql;
}

async function seedApp(): Promise<PGlite> {
  const pg = new PGlite();
  await ensureAppSchema(async (s) => { await pg.exec(s); }, {
    appId: APP_ID,
    slug: SLUG,
    password: "pw",
    baseUrl: ADMIN_URL,
  });
  return pg;
}

async function seedItems(pg: PGlite, count: number): Promise<void> {
  await pg.exec(`
    create table ${SCHEMA}.items (
      id int primary key,
      title text not null,
      note text,
      updated_at timestamptz not null default '2020-01-01T00:00:00Z'
    );
    grant all on all tables in schema ${SCHEMA} to ${ROLE};
  `);
  if (count > 0) {
    const values = Array.from({ length: count }, (_, i) => `(${i + 1}, 'item ${i + 1}', null)`).join(",");
    await pg.exec(`insert into ${SCHEMA}.items (id, title, note) values ${values}`);
  }
}

const opts = (pg: PGlite) => ({ adminUrl: ADMIN_URL, connect: pgliteConnect(pg) });

// --- Task 1: the transaction envelope --------------------------------------

test("runAppQuery wraps the work in BEGIN + SET LOCAL, in that order", async () => {
  // Asserted against a recording connector rather than a real database because
  // the ORDER is the contract: a `set local` issued before `begin` silently
  // becomes session-wide, which is the exact leak this guards.
  const issued: string[] = [];
  let beganWith = "";
  const connect: ConnectOrgDb = () => ({
    async begin(options, fn) {
      beganWith = options;
      return fn({
        async unsafe(query: string) {
          issued.push(query);
          return [];
        },
      });
    },
  });
  await runAppQuery(TARGET, { readOnly: true, adminUrl: ADMIN_URL, connect }, async () => null);

  assert.equal(beganWith, "read only");
  assert.deepEqual(issued, [`set local role ${ROLE}`, "set local statement_timeout = 5000"]);
  // `set role` without LOCAL survives the transaction on a pooled connection.
  assert.ok(issued.every((q) => !/^set (?!local)/.test(q)));
});

test("runAppQuery targets the org's own database, not the admin URL's", async () => {
  let url = "";
  const connect: ConnectOrgDb = (u) => {
    url = u;
    return { async begin(_o, fn) { return fn({ async unsafe() { return []; } }); } };
  };
  await runAppQuery(TARGET, { readOnly: true, adminUrl: ADMIN_URL, connect }, async () => null);
  assert.equal(new URL(url).pathname, "/tc_org_0a1b2c3d00004000800000000000face");
});

test("runAppQuery hands the caller the qualified schema", async () => {
  const connect: ConnectOrgDb = () => ({
    async begin(_o, fn) { return fn({ async unsafe() { return []; } }); },
  });
  const schema = await runAppQuery(
    TARGET,
    { readOnly: true, adminUrl: ADMIN_URL, connect },
    async (_tx, s) => s,
  );
  // SET LOCAL ROLE does not apply the role's stored search_path, so every
  // statement must qualify; handing the schema out is how that stays possible.
  assert.equal(schema, SCHEMA);
});

test("the app role does not leak onto the connection after the transaction", async () => {
  const pg = await seedApp();
  await seedItems(pg, 1);
  await runAppQuery(TARGET, { readOnly: true, ...opts(pg) }, async (tx, schema) => {
    const who = await tx.unsafe<{ u: string }>("select current_user as u");
    assert.equal(who[0].u, ROLE, "inside the transaction we are the app");
    await tx.unsafe(`select 1 from ${schema}.items limit 1`);
    return null;
  });
  const after = await pg.query<{ u: string }>("select current_user as u");
  assert.notEqual(after.rows[0].u, ROLE, "SET LOCAL must not survive COMMIT");
});

test("readOnly rejects a write", async () => {
  const pg = await seedApp();
  await seedItems(pg, 1);
  await assert.rejects(
    () =>
      runAppQuery(TARGET, { readOnly: true, ...opts(pg) }, async (tx, schema) =>
        tx.unsafe(`insert into ${schema}.items (id, title) values (99, 'nope')`),
      ),
    /read-only transaction/i,
  );
});

test("a missing app role surfaces as 409, not a raw driver error", async () => {
  // SQLSTATE, not the message: `lc_messages` is a server setting, so matching
  // on "role ... does not exist" would break on a differently-configured box
  // and break silently — the error would fall through as a 500.
  const connect: ConnectOrgDb = () => ({
    async begin(_o, fn) {
      return fn({
        async unsafe(query: string) {
          if (query.startsWith("set local role")) {
            throw Object.assign(new Error('role "app_x" does not exist'), { code: "42704" });
          }
          return [];
        },
      });
    },
  });
  await assert.rejects(
    () => listTables(TARGET, { adminUrl: ADMIN_URL, connect }),
    (e: any) => e?.statusCode === 409 && e?.code === "app_database_not_provisioned",
  );
});

test("browsing an app that was never provisioned fails closed", async () => {
  // Not "no tables": an empty answer here is indistinguishable from the normal
  // just-deployed state, and that ambiguity is exactly what §3.1 is about.
  const pg = new PGlite(); // no role, no schema
  await assert.rejects(() => listTables(TARGET, opts(pg)));
});

test("describeDbError carries a SQLSTATE and nothing else", () => {
  const described = describeDbError({
    code: "42P01",
    message: 'relation "secrets" does not exist',
    query: "select * from secrets",
    parameters: ["hunter2"],
  });
  assert.deepEqual(described, { sqlstate: "42P01" });
});

// --- Task 2: introspection --------------------------------------------------

test("listTables reports columns, primary key and editability", async () => {
  const pg = await seedApp();
  await seedItems(pg, 0);
  await pg.exec(`
    create table ${SCHEMA}.audit_log (at timestamptz not null, what text);
    create view ${SCHEMA}.items_v as select * from ${SCHEMA}.items;
    grant all on all tables in schema ${SCHEMA} to ${ROLE};
  `);

  const tables = await listTables(TARGET, opts(pg));
  assert.deepEqual(tables.map((t) => t.name), ["audit_log", "items"], "views are not base tables");

  const items = tables.find((t) => t.name === "items")!;
  assert.deepEqual(items.primaryKey, ["id"]);
  assert.equal(items.editable, true);
  assert.deepEqual(items.columns.map((c) => c.name), ["id", "title", "note", "updated_at"]);
  assert.equal(items.columns.find((c) => c.name === "title")!.nullable, false);
  assert.equal(items.columns.find((c) => c.name === "note")!.nullable, true);

  const audit = tables.find((t) => t.name === "audit_log")!;
  assert.deepEqual(audit.primaryKey, []);
  assert.equal(audit.editable, false, "no primary key means no safe single row");
});

test("listTables returns an empty list for a schema with no tables yet", async () => {
  // The normal state right after the first deploy: the provisioner creates the
  // schema, the app creates its tables on first request. Not an error.
  const pg = await seedApp();
  assert.deepEqual(await listTables(TARGET, opts(pg)), []);
});

// --- Task 3: reading rows ---------------------------------------------------

test("readRows pages by keyset and caps the page at 100", async () => {
  const pg = await seedApp();
  await seedItems(pg, 101);

  const first = await readRows(TARGET, opts(pg), { table: "items", limit: 1000 });
  assert.equal(first.rows.length, MAX_PAGE_SIZE, "a client asking for 1000 still gets 100");
  assert.equal(first.rows[0].id, 1);
  assert.ok(first.nextCursor, "101 rows means there is a next page");

  const second = await readRows(TARGET, opts(pg), { table: "items", after: first.nextCursor });
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].id, 101);
  assert.equal(second.nextCursor, null, "last page carries no cursor");
});

test("readRows does not emit OFFSET for a keyed table", async () => {
  // §4.2: this is someone's production database; OFFSET 10000 reads 10000 rows.
  const seen: string[] = [];
  const connect: ConnectOrgDb = () => ({
    async begin(_o, fn) {
      return fn({
        async unsafe(query: string) {
          seen.push(query);
          if (query.includes("information_schema.tables")) return [{ table_name: "items" }] as any;
          if (query.includes("information_schema.columns")) {
            return [{ table_name: "items", column_name: "id", data_type: "integer", is_nullable: "NO" }] as any;
          }
          if (query.includes("table_constraints")) {
            return [{ table_name: "items", column_name: "id" }] as any;
          }
          return [];
        },
      });
    },
  });
  await readRows(TARGET, { adminUrl: ADMIN_URL, connect }, {
    table: "items",
    after: Buffer.from(JSON.stringify({ k: [500] }), "utf8").toString("base64url"),
  });
  const select = seen.find((q) => q.startsWith("select * from"))!;
  assert.match(select, /\("id"\) > \(\$1\)/);
  assert.ok(!/offset/i.test(select), `keyset paging must not fall back to OFFSET: ${select}`);
});

test("readRows sorts descending and pages backwards from the cursor", async () => {
  const pg = await seedApp();
  await seedItems(pg, 5);
  const first = await readRows(TARGET, opts(pg), { table: "items", direction: "desc", limit: 2 });
  assert.deepEqual(first.rows.map((r) => r.id), [5, 4]);
  const second = await readRows(TARGET, opts(pg), {
    table: "items", direction: "desc", limit: 2, after: first.nextCursor,
  });
  assert.deepEqual(second.rows.map((r) => r.id), [3, 2]);
});

test("readRows filters on one column with a bound value", async () => {
  const pg = await seedApp();
  await seedItems(pg, 5);
  await pg.exec(`update ${SCHEMA}.items set note = 'keep' where id in (2, 4)`);

  const eq = await readRows(TARGET, opts(pg), {
    table: "items", filter: { column: "note", op: "eq", value: "keep" },
  });
  assert.deepEqual(eq.rows.map((r) => r.id), [2, 4]);

  const nulls = await readRows(TARGET, opts(pg), {
    table: "items", filter: { column: "note", op: "isNull" },
  });
  assert.deepEqual(nulls.rows.map((r) => r.id), [1, 3, 5]);

  const contains = await readRows(TARGET, opts(pg), {
    table: "items", filter: { column: "title", op: "contains", value: "ITEM 3" },
  });
  assert.deepEqual(contains.rows.map((r) => r.id), [3]);
});

test("readRows refuses a table or column that is not in this schema", async () => {
  const pg = await seedApp();
  await seedItems(pg, 1);
  await assert.rejects(
    () => readRows(TARGET, opts(pg), { table: "pg_shadow" }),
    (e: any) => e?.statusCode === 404 && e?.code === "table_not_found",
  );
  await assert.rejects(
    () => readRows(TARGET, opts(pg), { table: "items", filter: { column: "1=1; drop table items; --", op: "isNull" } }),
    (e: any) => e?.statusCode === 400 && e?.code === "unknown_column",
  );
});

test("readRows falls back to OFFSET only when the table has no key", async () => {
  const pg = await seedApp();
  await pg.exec(`
    create table ${SCHEMA}.audit_log (at int not null, what text);
    grant all on all tables in schema ${SCHEMA} to ${ROLE};
    insert into ${SCHEMA}.audit_log select g, 'e' || g from generate_series(1, 5) g;
  `);
  const first = await readRows(TARGET, opts(pg), { table: "audit_log", limit: 2 });
  assert.equal(first.editable, false);
  assert.deepEqual(first.rows.map((r) => r.at), [1, 2]);
  const second = await readRows(TARGET, opts(pg), { table: "audit_log", limit: 2, after: first.nextCursor });
  assert.deepEqual(second.rows.map((r) => r.at), [3, 4]);
});

test("a keyless table holding json still lists its rows", async () => {
  // `json` has no default ordering operator. Ordering by every column — which
  // is what makes successive OFFSETs line up — used to include it and fail the
  // whole query, so such a table showed nothing at all.
  const pg = await seedApp();
  await pg.exec(`
    create table ${SCHEMA}.events (payload json, at int);
    grant all on all tables in schema ${SCHEMA} to ${ROLE};
    insert into ${SCHEMA}.events values ('{"a":1}', 1), ('{"a":2}', 2);
  `);
  const rows = await readRows(TARGET, opts(pg), { table: "events" });
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.editable, false);
});

test("an eq filter compares natively so an index stays usable", async () => {
  // A `::text` cast on the column would make every row compute a string and
  // would rule the index out — on a production table that is a sequential scan
  // the 5s timeout then kills.
  const seen: string[] = [];
  const connect: ConnectOrgDb = () => ({
    async begin(_o, fn) {
      return fn({
        async unsafe(query: string) {
          seen.push(query);
          if (query.includes("information_schema.tables")) return [{ table_name: "items" }] as any;
          if (query.includes("information_schema.columns")) {
            return [{ table_name: "items", column_name: "id", data_type: "integer", is_nullable: "NO" }] as any;
          }
          if (query.includes("table_constraints")) return [{ table_name: "items", column_name: "id" }] as any;
          return [];
        },
      });
    },
  });
  await readRows(TARGET, { adminUrl: ADMIN_URL, connect }, {
    table: "items",
    filter: { column: "id", op: "eq", value: "7" },
  });
  const select = seen.find((q) => q.startsWith("select * from"))!;
  assert.match(select, /where "id" = \$1/);
});

test("parsePageLimit clamps to the server's cap", () => {
  assert.equal(parsePageLimit(undefined), 50);
  assert.equal(parsePageLimit("10"), 10);
  assert.equal(parsePageLimit(1000), MAX_PAGE_SIZE);
  assert.equal(parsePageLimit(-1), 50);
  assert.equal(parsePageLimit("nonsense"), 50);
});

// --- Task 4: single-row writes ---------------------------------------------

test("updateRow returns the row as the database actually stored it", async () => {
  const pg = await seedApp();
  await seedItems(pg, 3);
  await pg.exec(`
    create function ${SCHEMA}.touch() returns trigger language plpgsql as $$
      begin new.updated_at := '2030-06-01T00:00:00Z'; return new; end $$;
    create trigger items_touch before update on ${SCHEMA}.items
      for each row execute function ${SCHEMA}.touch();
  `);

  const row = await updateRow(TARGET, opts(pg), {
    table: "items", key: [2], patch: { title: "renamed" },
  });
  assert.equal(row.title, "renamed");
  // The trigger overwrote what the user sent; echoing the submitted value back
  // would be telling them something untrue about their own database.
  assert.equal(new Date(row.updated_at as string).toISOString(), "2030-06-01T00:00:00.000Z");
});

test("updateRow rolls back when the row is gone", async () => {
  const pg = await seedApp();
  await seedItems(pg, 2);
  await assert.rejects(
    () => updateRow(TARGET, opts(pg), { table: "items", key: [999], patch: { title: "x" } }),
    (e: any) => e?.statusCode === 404 && e?.code === "row_not_found",
  );
  const still = await pg.query<{ n: number }>(`select count(*)::int as n from ${SCHEMA}.items`);
  assert.equal(still.rows[0].n, 2);
});

test("updateRow refuses a table with no primary key", async () => {
  const pg = await seedApp();
  await pg.exec(`
    create table ${SCHEMA}.audit_log (at int not null, what text);
    grant all on all tables in schema ${SCHEMA} to ${ROLE};
    insert into ${SCHEMA}.audit_log values (1, 'a'), (2, 'a');
  `);
  await assert.rejects(
    () => updateRow(TARGET, opts(pg), { table: "audit_log", key: [1], patch: { what: "b" } }),
    (e: any) => e?.statusCode === 409 && e?.code === "table_not_editable",
  );
  const untouched = await pg.query<{ n: number }>(
    `select count(*)::int as n from ${SCHEMA}.audit_log where what = 'a'`,
  );
  assert.equal(untouched.rows[0].n, 2);
});

test("updateRow rejects a column that is not in the table", async () => {
  const pg = await seedApp();
  await seedItems(pg, 1);
  await assert.rejects(
    () => updateRow(TARGET, opts(pg), {
      table: "items", key: [1], patch: { "title\" = 'pwned', note": "x" },
    }),
    (e: any) => e?.statusCode === 400 && e?.code === "unknown_column",
  );
  const row = await pg.query<{ title: string }>(`select title from ${SCHEMA}.items where id = 1`);
  assert.equal(row.rows[0].title, "item 1");
});

test("updateRow refuses to edit a primary key column", async () => {
  const pg = await seedApp();
  await seedItems(pg, 1);
  await assert.rejects(
    () => updateRow(TARGET, opts(pg), { table: "items", key: [1], patch: { id: 7 } }),
    (e: any) => e?.statusCode === 400 && e?.code === "primary_key_immutable",
  );
});

test("updateRow requires the whole key", async () => {
  const pg = await seedApp();
  await seedItems(pg, 1);
  await assert.rejects(
    () => updateRow(TARGET, opts(pg), { table: "items", key: [], patch: { title: "x" } }),
    (e: any) => e?.statusCode === 400 && /row key must have 1 value/.test(e?.message ?? ""),
  );
});

test("deleteRow removes exactly one row", async () => {
  const pg = await seedApp();
  await seedItems(pg, 3);
  await deleteRow(TARGET, opts(pg), { table: "items", key: [2] });
  const left = await pg.query<{ id: number }>(`select id from ${SCHEMA}.items order by id`);
  assert.deepEqual(left.rows.map((r) => r.id), [1, 3]);

  await assert.rejects(
    () => deleteRow(TARGET, opts(pg), { table: "items", key: [2] }),
    (e: any) => e?.statusCode === 404 && e?.code === "row_not_found",
  );
});

// --- Task 8 §9.7: cross-app isolation ---------------------------------------

const OTHER_APP_ID = "9e8d7c6b-0000-4000-8000-0000000005ad";
const OTHER_SLUG = "other-app";
const OTHER_TARGET = { orgId: ORG_ID, appId: OTHER_APP_ID, slug: OTHER_SLUG };
const OTHER_SCHEMA = appSchemaName(OTHER_SLUG, OTHER_APP_ID);
const OTHER_ROLE = appRoleName(OTHER_APP_ID);

async function seedTwoApps(): Promise<PGlite> {
  const pg = await seedApp();
  await seedItems(pg, 2);
  await ensureAppSchema(async (s) => { await pg.exec(s); }, {
    appId: OTHER_APP_ID,
    slug: OTHER_SLUG,
    password: "pw",
    baseUrl: ADMIN_URL,
  });
  await pg.exec(`
    create table ${OTHER_SCHEMA}.secrets (id int primary key, value text);
    insert into ${OTHER_SCHEMA}.secrets values (1, 'not yours');
    grant all on all tables in schema ${OTHER_SCHEMA} to ${OTHER_ROLE};
  `);
  return pg;
}

test("two apps sharing one org database cannot see each other's tables", async () => {
  const pg = await seedTwoApps();
  assert.deepEqual((await listTables(TARGET, opts(pg))).map((t) => t.name), ["items"]);
  assert.deepEqual((await listTables(OTHER_TARGET, opts(pg))).map((t) => t.name), ["secrets"]);
});

test("naming another app's table is a 404, not that app's data", async () => {
  const pg = await seedTwoApps();
  await assert.rejects(
    () => readRows(TARGET, opts(pg), { table: "secrets" }),
    (e: any) => e?.statusCode === 404 && e?.code === "table_not_found",
  );
});

test("the app role cannot reach the neighbouring schema even if a name slipped through", async () => {
  // Belt and braces: the schema filter above is the first line, `SET LOCAL ROLE`
  // is the second. This asserts the second one actually holds, so a bug in the
  // first cannot become a data leak on its own.
  const pg = await seedTwoApps();
  await assert.rejects(
    () =>
      runAppQuery(TARGET, { readOnly: true, ...opts(pg) }, async (tx) =>
        tx.unsafe(`select * from ${OTHER_SCHEMA}.secrets`),
      ),
    /permission denied/i,
  );
});
