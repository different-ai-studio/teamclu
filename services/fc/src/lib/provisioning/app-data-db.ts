import postgres from "postgres";
import { appRoleName, appSchemaName, orgDatabaseName } from "./pg-name.js";
import { withDatabaseName } from "./app-postgres.js";
import { ApiError } from "../http-utils.js";

/**
 * Read/write one app's own Postgres data on behalf of the control panel.
 *
 * The control panel has no password for the app's login role: it is
 * regenerated on every deploy and only ever written into the FC function's
 * environment (app-postgres.ts:29-31). So we connect as the admin that
 * provisioned the database and drop to the app's role for the duration of one
 * transaction.
 *
 * Three rules hold everywhere in this file, and each one corresponds to a way
 * this could take down someone's production data:
 *
 *  1. `SET LOCAL ROLE`, never `SET ROLE`, and always after `BEGIN`. The
 *     connection is pooled and long-lived; a plain `SET ROLE` stays on the
 *     connection and is inherited by whoever borrows it next — quite possibly
 *     another app in another team.
 *  2. No identifier is ever taken from the request. Table and column names are
 *     read out of `information_schema` *for this schema* and the statement is
 *     built from those looked-up strings; the request only ever selects among
 *     them. Values are bound parameters without exception.
 *  3. Neither SQL text nor result rows may reach a log. This is the user's
 *     business data. {@link describeDbError} is the only thing that may be
 *     logged, and it carries a SQLSTATE and nothing else.
 */

const SAFE_IDENT = /^[a-z0-9_]+$/;

/** Every statement runs under this. Long enough for a 100-row page, short
 *  enough that a bad filter on a big table cannot pin a connection. */
export const APP_QUERY_TIMEOUT_MS = 5000;

/** Hard server-side cap. The request may ask for less, never for more. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

function assertSafe(ident: string): void {
  if (!SAFE_IDENT.test(ident)) {
    throw new Error(`unsafe postgres identifier: ${JSON.stringify(ident)}`);
  }
}

/** Quote an identifier that came out of the catalog (may be mixed-case). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// --- Connection ------------------------------------------------------------

/** The slice of a postgres.js transaction this module uses. */
export interface AppDataTx {
  unsafe<T = any>(query: string, params?: any[]): Promise<T[]>;
}

/** The slice of a postgres.js connection this module uses. */
export interface AppDataSql {
  begin<T>(options: string, fn: (tx: AppDataTx) => Promise<T>): Promise<T>;
}

export type ConnectOrgDb = (url: string) => AppDataSql;

/**
 * One pool per org database.
 *
 * Deliberately keyed by URL rather than reusing `getAppsAdminExecutor`'s single
 * pool: that one points at whatever `APPS_DB_ADMIN_URL` names (typically
 * `…/postgres`), and every org's data lives in a different database. Postgres
 * connections cannot switch database, so a shared pool would silently query the
 * wrong one.
 */
const orgPools = new Map<string, AppDataSql>();

function defaultConnect(url: string): AppDataSql {
  const existing = orgPools.get(url);
  if (existing) return existing;
  const sql = postgres(url, {
    max: Number(process.env.APPS_DATA_POOL_MAX ?? "2"),
    idle_timeout: Number(process.env.PG_IDLE_TIMEOUT ?? "20"),
    connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT ?? "10"),
    prepare: false,
  }) as unknown as AppDataSql;
  orgPools.set(url, sql);
  return sql;
}

/** Test seam: drop cached pools so a test can hand in its own connector. */
export function resetOrgPools(): void {
  orgPools.clear();
}

export interface AppDataTarget {
  /** `public.orgs.id` — the database. Read from `apps.org_id` (see §3.1). */
  orgId: string;
  appId: string;
  /** `apps.slug`. Immutable after create (updateApp never writes it), which is
   *  what makes the schema name derivable rather than something to go probe. */
  slug: string;
}

export interface RunAppQueryOptions {
  readOnly: boolean;
  /** Superuser / owner URL, e.g. `APPS_DB_ADMIN_URL`. */
  adminUrl: string;
  connect?: ConnectOrgDb;
  statementTimeoutMs?: number;
}

/**
 * Run `fn` inside one transaction, as the app's own role.
 *
 * `fn` receives the qualified schema name; every statement it builds must
 * qualify with it. `SET LOCAL ROLE` does NOT apply the role's stored
 * `search_path` (per-role settings are applied at login, not at role switch),
 * so an unqualified table name here would resolve against the *admin's*
 * search_path.
 */
export async function runAppQuery<T>(
  target: AppDataTarget,
  opts: RunAppQueryOptions,
  fn: (tx: AppDataTx, schema: string) => Promise<T>,
): Promise<T> {
  const schema = appSchemaName(target.slug, target.appId);
  const role = appRoleName(target.appId);
  assertSafe(schema);
  assertSafe(role);

  const database = orgDatabaseName(target.orgId);
  const url = withDatabaseName(opts.adminUrl, database);
  const sql = (opts.connect ?? defaultConnect)(url);
  const timeout = Math.trunc(opts.statementTimeoutMs ?? APP_QUERY_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("statementTimeoutMs must be positive");

  return sql.begin(opts.readOnly ? "read only" : "read write", async (tx) => {
    try {
      // Both identifiers are assertSafe'd above; SET ROLE takes no parameter.
      await tx.unsafe(`set local role ${role}`);
    } catch (e: any) {
      // 42704 undefined_object — the role is missing from THIS database. Either
      // the app was never provisioned, or `apps.org_id` points somewhere its
      // schema was never created (the one ambiguity §3.1 leaves open for rows
      // that predate the column).
      if (e?.code === "42704") {
        throw new ApiError(
          409,
          "app_database_not_provisioned",
          "this app has no database in the org it is recorded against",
        );
      }
      throw e;
    }
    await tx.unsafe(`set local statement_timeout = ${timeout}`);
    return fn(tx, schema);
  });
}

/**
 * The only representation of a database error that may be logged.
 *
 * Postgres error objects carry `query`, `parameters` and often a fragment of
 * the offending value in `detail` — all of which are the user's data.
 */
export function describeDbError(e: any): { sqlstate: string | null } {
  const code = typeof e?.code === "string" ? e.code : null;
  return { sqlstate: code };
}

// --- Introspection ---------------------------------------------------------

export interface AppDataColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface AppDataTableInfo {
  name: string;
  columns: AppDataColumn[];
  /** Ordered primary-key columns; empty when the table has none. */
  primaryKey: string[];
  /**
   * False when there is no primary key. Without one there is no safe "this
   * row": `update … where title = 'x'` can match many. Such tables stay
   * browsable and the UI greys the row actions out (design §5.3).
   */
  editable: boolean;
}

/**
 * Every base table in the app's schema, with columns and primary key.
 *
 * `information_schema` filters by the *current* privileges, so running this
 * after `SET LOCAL ROLE` means the app's role decides what is visible — a
 * second line of defence behind the schema qualifier.
 */
export async function listTables(
  target: AppDataTarget,
  opts: Omit<RunAppQueryOptions, "readOnly">,
): Promise<AppDataTableInfo[]> {
  return runAppQuery(target, { ...opts, readOnly: true }, async (tx, schema) => {
    return introspect(tx, schema);
  });
}

async function introspect(tx: AppDataTx, schema: string): Promise<AppDataTableInfo[]> {
  const tables = await tx.unsafe<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = $1 and table_type = 'BASE TABLE'
      order by table_name`,
    [schema],
  );
  if (tables.length === 0) return [];

  const columns = await tx.unsafe<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = $1
      order by table_name, ordinal_position`,
    [schema],
  );

  const pks = await tx.unsafe<{ table_name: string; column_name: string }>(
    `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
      where tc.constraint_type = 'PRIMARY KEY'
        and tc.table_schema = $1
      order by tc.table_name, kcu.ordinal_position`,
    [schema],
  );

  const byTable = new Map<string, AppDataTableInfo>();
  for (const t of tables) {
    byTable.set(t.table_name, { name: t.table_name, columns: [], primaryKey: [], editable: false });
  }
  for (const c of columns) {
    byTable.get(c.table_name)?.columns.push({
      name: c.column_name,
      dataType: c.data_type,
      nullable: c.is_nullable === "YES",
    });
  }
  for (const p of pks) byTable.get(p.table_name)?.primaryKey.push(p.column_name);
  for (const t of byTable.values()) t.editable = t.primaryKey.length > 0;
  return [...byTable.values()];
}

/**
 * Resolve a requested table name to the catalog entry, or reject.
 *
 * The returned object's strings — not the caller's — are what may be
 * interpolated into a statement.
 */
async function requireTable(tx: AppDataTx, schema: string, table: unknown): Promise<AppDataTableInfo> {
  if (typeof table !== "string" || !table) {
    throw new ApiError(400, "validation_failed", "table is required");
  }
  const info = (await introspect(tx, schema)).find((t) => t.name === table);
  if (!info) throw new ApiError(404, "table_not_found", "no such table in this app");
  return info;
}

/** Resolve requested column names against the catalog. Never trusts the input. */
function requireColumns(info: AppDataTableInfo, names: readonly string[]): string[] {
  return names.map((n) => {
    const col = info.columns.find((c) => c.name === n);
    if (!col) throw new ApiError(400, "unknown_column", `no such column: ${JSON.stringify(n)}`);
    return col.name;
  });
}

/**
 * Columns of `table` whose type has a default btree ordering operator.
 *
 * Asked of Postgres rather than kept as a deny-list in code: the set depends on
 * the extensions installed in that particular database, so a hard-coded list is
 * wrong for exactly the databases we do not control. Only the keyless read path
 * needs this, so it stays out of {@link introspect}.
 */
async function orderableColumns(tx: AppDataTx, schema: string, table: string): Promise<Set<string>> {
  const rows = await tx.unsafe<{ attname: string }>(
    `select a.attname
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
        and c.relname = $2
        and a.attnum > 0
        and not a.attisdropped
        and exists (
          select 1 from pg_opclass o
           where o.opcintype = a.atttypid and o.opcdefault and o.opcmethod = 403
        )`,
    [schema, table],
  );
  return new Set(rows.map((r) => r.attname));
}

// --- Cursor ----------------------------------------------------------------

/**
 * Keyset cursor: the primary-key values of the last row on the page, or a plain
 * offset for tables with no primary key.
 *
 * Opaque to the client on purpose — the shape depends on the table's key and we
 * do not want clients constructing one.
 */
type Cursor = { k: unknown[] } | { o: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new ApiError(400, "validation_failed", "after must be a string");
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "validation_failed", "after is not a valid cursor");
  }
  if (parsed && Array.isArray(parsed.k)) return { k: parsed.k };
  if (parsed && Number.isInteger(parsed.o) && parsed.o >= 0) return { o: parsed.o };
  throw new ApiError(400, "validation_failed", "after is not a valid cursor");
}

// --- Read ------------------------------------------------------------------

export type FilterOp = "eq" | "contains" | "isNull" | "notNull";

export interface ReadRowsInput {
  table: string;
  after?: string | null;
  /** Direction along the primary key. Sorting by an arbitrary column is not
   *  offered: it would make the keyset cursor unsound and the only way back is
   *  OFFSET, which is what §4.2 rules out. */
  direction?: "asc" | "desc";
  filter?: { column: string; op: FilterOp; value?: unknown } | null;
  limit?: number;
}

export interface ReadRowsResult {
  table: string;
  columns: AppDataColumn[];
  primaryKey: string[];
  editable: boolean;
  rows: Record<string, unknown>[];
  /** Opaque; pass back as `after`. Null when this was the last page. */
  nextCursor: string | null;
}

export function parsePageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PAGE_SIZE;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), MAX_PAGE_SIZE);
}

export async function readRows(
  target: AppDataTarget,
  opts: Omit<RunAppQueryOptions, "readOnly">,
  input: ReadRowsInput,
): Promise<ReadRowsResult> {
  const limit = parsePageLimit(input.limit);
  const cursor = decodeCursor(input.after);
  const desc = input.direction === "desc";

  return runAppQuery(target, { ...opts, readOnly: true }, async (tx, schema) => {
    const info = await requireTable(tx, schema, input.table);
    const qualified = `${quoteIdent(schema)}.${quoteIdent(info.name)}`;
    const params: unknown[] = [];
    const where: string[] = [];

    if (input.filter) {
      const [col] = requireColumns(info, [input.filter.column]);
      const q = quoteIdent(col);
      switch (input.filter.op) {
        case "eq":
          // No `::text` cast: casting every row's value defeats any index on the
          // column, and on a production table that turns a point lookup into a
          // sequential scan that the 5s timeout then kills. The bound value is
          // sent untyped and Postgres coerces it to the column's type; a value
          // that will not coerce comes back as 22P02, which the caller maps to
          // a 400 rather than a 502.
          params.push(input.filter.value);
          where.push(`${q} = $${params.length}`);
          break;
        case "contains":
          params.push(`%${String(input.filter.value ?? "")}%`);
          where.push(`${q}::text ilike $${params.length}`);
          break;
        case "isNull":
          where.push(`${q} is null`);
          break;
        case "notNull":
          where.push(`${q} is not null`);
          break;
        default:
          throw new ApiError(400, "validation_failed", "unsupported filter operator");
      }
    }

    let orderBy: string;
    if (info.primaryKey.length > 0) {
      const pk = info.primaryKey.map(quoteIdent);
      orderBy = pk.map((c) => `${c} ${desc ? "desc" : "asc"}`).join(", ");
      if (cursor && "k" in cursor) {
        if (cursor.k.length !== pk.length) {
          throw new ApiError(400, "validation_failed", "cursor does not match this table's key");
        }
        // Row comparison, so a composite key pages correctly in one predicate.
        const placeholders = cursor.k.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        where.push(`(${pk.join(", ")}) ${desc ? "<" : ">"} (${placeholders.join(", ")})`);
      }
    } else {
      // No key, so no stable "after this row". OFFSET is the only option; it is
      // read-only and the page cap keeps it from getting deep enough to matter.
      //
      // Ordering by every column is what makes successive OFFSETs line up, but
      // it cannot include a column whose type has no ordering operator — a
      // `json` column would fail the whole query with "could not identify an
      // ordering operator", so the browser would show nothing at all for a
      // keyless table that happens to hold JSON.
      if (cursor && !("o" in cursor)) {
        // A keyset cursor for a table with no key. Silently restarting at page
        // one would look to the reader like the data changed underneath them.
        throw new ApiError(400, "validation_failed", "cursor does not match this table's key");
      }
      const orderable = await orderableColumns(tx, schema, info.name);
      const cols = info.columns
        .filter((c) => orderable.has(c.name))
        .map((c) => `${quoteIdent(c.name)} ${desc ? "desc" : "asc"}`);
      orderBy = cols.length ? cols.join(", ") : "1";
    }

    const offset = !info.primaryKey.length && cursor && "o" in cursor ? cursor.o : 0;
    // Ask for one more than the page: its presence is what tells us there is a
    // next page, without a count(*) that would scan the whole table (§4.2).
    const sql =
      `select * from ${qualified}` +
      (where.length ? ` where ${where.join(" and ")}` : "") +
      ` order by ${orderBy} limit ${limit + 1}` +
      (offset ? ` offset ${offset}` : "");

    const fetched = await tx.unsafe<Record<string, unknown>>(sql, params);
    const rows = fetched.slice(0, limit);
    const hasMore = fetched.length > limit;

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      nextCursor = info.primaryKey.length
        ? encodeCursor({ k: info.primaryKey.map((c) => rows[rows.length - 1][c]) })
        : encodeCursor({ o: offset + rows.length });
    }

    return {
      table: info.name,
      columns: info.columns,
      primaryKey: info.primaryKey,
      editable: info.editable,
      rows,
      nextCursor,
    };
  });
}

// --- Write -----------------------------------------------------------------

/**
 * A row's primary-key values, in the order `primaryKey` lists them.
 *
 * An ordered array rather than a column→value map so it survives a URL path
 * segment (see {@link encodeRowKey}) and so a composite key cannot arrive
 * half-specified with the missing half silently defaulting.
 */
export type RowKey = readonly unknown[];

/** Opaque, URL-safe form of a row key — what `:rowKey` carries in the path. */
export function encodeRowKey(values: RowKey): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

export function decodeRowKey(raw: unknown): RowKey {
  if (typeof raw !== "string" || !raw) {
    throw new ApiError(400, "validation_failed", "row key is required");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "validation_failed", "row key is not a valid key");
  }
  if (!Array.isArray(parsed)) {
    throw new ApiError(400, "validation_failed", "row key is not a valid key");
  }
  return parsed;
}

function buildKeyPredicate(
  info: AppDataTableInfo,
  key: RowKey,
  params: unknown[],
): string {
  if (info.primaryKey.length === 0) {
    throw new ApiError(
      409,
      "table_not_editable",
      "this table has no primary key, so a single row cannot be addressed",
    );
  }
  if (!Array.isArray(key) || key.length !== info.primaryKey.length) {
    throw new ApiError(
      400,
      "validation_failed",
      `row key must have ${info.primaryKey.length} value(s): ${info.primaryKey.join(", ")}`,
    );
  }
  // Only the key columns take part, and only in the order the catalog gives —
  // never a column the caller merely happened to send.
  return info.primaryKey
    .map((c, i) => {
      params.push(key[i]);
      return `${quoteIdent(c)} = $${params.length}`;
    })
    .join(" and ");
}

export interface UpdateRowInput {
  table: string;
  key: RowKey;
  patch: Record<string, unknown>;
}

/**
 * Update exactly one row, then read it back.
 *
 * The read-back is not paranoia: `updated_at` triggers and column defaults
 * rewrite what the user typed, and showing the submitted value instead of the
 * stored one is telling them something untrue about their own database (§5.4).
 */
export async function updateRow(
  target: AppDataTarget,
  opts: Omit<RunAppQueryOptions, "readOnly">,
  input: UpdateRowInput,
): Promise<Record<string, unknown>> {
  return runAppQuery(target, { ...opts, readOnly: false }, async (tx, schema) => {
    const info = await requireTable(tx, schema, input.table);
    const qualified = `${quoteIdent(schema)}.${quoteIdent(info.name)}`;

    const patchNames = Object.keys(input.patch ?? {});
    if (patchNames.length === 0) {
      throw new ApiError(400, "validation_failed", "patch must set at least one column");
    }
    const cols = requireColumns(info, patchNames);
    const pkEdit = cols.filter((c) => info.primaryKey.includes(c));
    if (pkEdit.length) {
      // The row is addressed by its key, and the read-back uses the same key —
      // change it and we would read back nothing and report the row as gone.
      throw new ApiError(
        400,
        "primary_key_immutable",
        `primary key column(s) cannot be edited here: ${pkEdit.join(", ")}`,
      );
    }

    const params: unknown[] = [];
    const assignments = cols
      .map((c) => {
        params.push(input.patch[c]);
        return `${quoteIdent(c)} = $${params.length}`;
      })
      .join(", ");
    const predicate = buildKeyPredicate(info, input.key, params);
    const keyCols = info.primaryKey.map(quoteIdent).join(", ");

    const updated = await tx.unsafe<Record<string, unknown>>(
      `update ${qualified} set ${assignments} where ${predicate} returning ${keyCols}`,
      params,
    );
    assertExactlyOne(updated.length, "update");

    // Separate read-back rather than `returning *`: AFTER triggers run before
    // the statement's effects are visible to RETURNING, so RETURNING can still
    // be stale where a plain SELECT in the same transaction is not.
    const readParams: unknown[] = [];
    const readPredicate = buildKeyPredicate(info, input.key, readParams);
    const rows = await tx.unsafe<Record<string, unknown>>(
      `select * from ${qualified} where ${readPredicate} limit 1`,
      readParams,
    );
    if (rows.length !== 1) {
      throw new ApiError(502, "row_read_back_failed", "the updated row could not be read back");
    }
    return rows[0];
  });
}

export interface DeleteRowInput {
  table: string;
  key: RowKey;
}

export async function deleteRow(
  target: AppDataTarget,
  opts: Omit<RunAppQueryOptions, "readOnly">,
  input: DeleteRowInput,
): Promise<void> {
  return runAppQuery(target, { ...opts, readOnly: false }, async (tx, schema) => {
    const info = await requireTable(tx, schema, input.table);
    const qualified = `${quoteIdent(schema)}.${quoteIdent(info.name)}`;
    const params: unknown[] = [];
    const predicate = buildKeyPredicate(info, input.key, params);
    const keyCols = info.primaryKey.map(quoteIdent).join(", ");
    const deleted = await tx.unsafe<Record<string, unknown>>(
      `delete from ${qualified} where ${predicate} returning ${keyCols}`,
      params,
    );
    assertExactlyOne(deleted.length, "delete");
  });
}

/**
 * Anything other than one row aborts the transaction.
 *
 * Zero means somebody else already changed or removed it; more than one means
 * the key predicate is not the key we think it is. Both are cases where
 * committing would be a guess about the user's production data.
 */
function assertExactlyOne(count: number, op: "update" | "delete"): void {
  if (count === 1) return;
  if (count === 0) {
    throw new ApiError(404, "row_not_found", `the row to ${op} no longer exists`);
  }
  throw new ApiError(
    409,
    "not_single_row",
    `${op} matched ${count} rows; refusing to touch more than one`,
  );
}


// --- Bound facade ----------------------------------------------------------

/**
 * The four operations with the admin URL already bound.
 *
 * The repository takes this rather than the URL so tests can substitute the
 * whole surface without standing up a database, and so nothing above this file
 * has to know that an admin connection is involved at all.
 */
export interface AppDataOps {
  listTables(target: AppDataTarget): Promise<AppDataTableInfo[]>;
  readRows(target: AppDataTarget, input: ReadRowsInput): Promise<ReadRowsResult>;
  updateRow(target: AppDataTarget, input: UpdateRowInput): Promise<Record<string, unknown>>;
  deleteRow(target: AppDataTarget, input: DeleteRowInput): Promise<void>;
}

export function makeAppDataOps(adminUrl: string, connect?: ConnectOrgDb): AppDataOps {
  const opts = { adminUrl, connect };
  return {
    listTables: (target) => listTables(target, opts),
    readRows: (target, input) => readRows(target, opts, input),
    updateRow: (target, input) => updateRow(target, opts, input),
    deleteRow: (target, input) => deleteRow(target, opts, input),
  };
}
