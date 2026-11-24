import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../http-utils.js";
import { provisionAppPostgres, withDatabaseName } from "./app-postgres.js";

/**
 * Deploy-time database migrations for a data app.
 *
 * An app's own database is reachable from exactly two places: the deployed
 * function (whose DATABASE_URL carries a password minted per deploy and never
 * stored) and this service (APPS_DB_ADMIN_URL). No agent, daemon or person
 * can open it, so a migration script checked into the app repo is something
 * nobody could run. The daemon reads the repo's `migrations/*.sql` at the
 * revision it built and sends them with finalize; this runs them before the
 * function is pointed at the new code.
 *
 * Three rules hold here, and each guards against a way this could hurt
 * someone's production:
 *
 *  1. **The app's privileges, never the admin's.** The SQL is the app's own
 *     text. Running it on the admin connection under `SET ROLE` would not do:
 *     a session whose login is the admin can `RESET ROLE` back to it. Instead
 *     a throwaway login role is minted that holds nothing but membership of
 *     the app's role (NOINHERIT), and the SQL runs on a connection logged in
 *     as that. `RESET ROLE` there falls to a role that can do less than the
 *     app, not more.
 *  2. **A failed migration leaves the live version serving.** Everything runs
 *     before the app role's password is rotated and before the function is
 *     touched, and each file is one transaction. Rotating first would cut the
 *     old function off the database whether or not the migration then
 *     succeeded.
 *  3. **No SQL text or result rows in a log.** Errors carry the file name and
 *     the server's SQLSTATE and message, which is what the deployer needs to
 *     fix the file; they go to the caller and `apps.provision_error`, not to
 *     the console.
 *
 * The SQL runs while the previous version is still live and keeps running
 * until the new function takes over, so a migration has to be additive
 * (expand first, contract in a later deploy). That is documented for agents;
 * it cannot be enforced here.
 */

export interface AppMigration {
  /** File name under `migrations/`, e.g. `0001_create_scan_tasks.sql`. */
  name: string;
  sql: string;
}

/** `0001_create_tasks.sql`, `20261124_add_index.sql`. Ordered by name. */
const MIGRATION_NAME = /^[0-9]{1,16}_[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.sql$/;
export const MAX_MIGRATIONS = 500;
export const MAX_MIGRATION_BYTES = 512 * 1024;
export const MAX_MIGRATIONS_TOTAL_BYTES = 4 * 1024 * 1024;

/** The ledger, in the app's own schema so it moves with the app's data. */
export const LEDGER_TABLE = "_teamclu_migrations";

/** Per statement, generous for an index build on a mid-sized table. */
const STATEMENT_TIMEOUT = "120s";
/** A migration waiting on a lock the live app holds should fail, not hang the deploy. */
const LOCK_TIMEOUT = "15s";
/** First key of the advisory lock; the second is the schema's hash. */
const ADVISORY_NAMESPACE = 0x7c11;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
export const migrationChecksum = (sql: string) => createHash("sha256").update(sql, "utf8").digest("hex");

/**
 * Validate the `migrations` a finalize body carries. Absent means none.
 * Returned sorted by name, which is the order they run in.
 */
export function parseAppMigrations(raw: unknown): AppMigration[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, "validation_failed", "migrations must be an array of { name, sql }");
  if (raw.length > MAX_MIGRATIONS) {
    throw new ApiError(400, "validation_failed", `at most ${MAX_MIGRATIONS} migration files`);
  }
  const seen = new Set<string>();
  let total = 0;
  const out: AppMigration[] = [];
  for (const item of raw) {
    const name = (item as { name?: unknown })?.name;
    const sql = (item as { sql?: unknown })?.sql;
    if (typeof name !== "string" || !MIGRATION_NAME.test(name)) {
      throw new ApiError(400, "validation_failed",
        `migration name ${JSON.stringify(name)} must look like 0001_description.sql (digits, underscore, then letters, digits, _ . -)`);
    }
    if (typeof sql !== "string") throw new ApiError(400, "validation_failed", `migration ${name} has no sql text`);
    if (seen.has(name)) throw new ApiError(400, "validation_failed", `migration ${name} is listed twice`);
    seen.add(name);
    const size = bytes(sql);
    if (size > MAX_MIGRATION_BYTES) {
      throw new ApiError(400, "validation_failed", `migration ${name} is larger than ${MAX_MIGRATION_BYTES} bytes`);
    }
    total += size;
    out.push({ name, sql });
  }
  if (total > MAX_MIGRATIONS_TOTAL_BYTES) {
    throw new ApiError(400, "validation_failed", `migrations total more than ${MAX_MIGRATIONS_TOTAL_BYTES} bytes`);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What to apply, given what the ledger says ran before. Pure, so it is tested alone. */
export function planMigrations(
  migrations: AppMigration[],
  applied: ReadonlyMap<string, string>,
): AppMigration[] {
  const pending: AppMigration[] = [];
  let latestApplied = "";
  for (const name of applied.keys()) if (name > latestApplied) latestApplied = name;
  for (const m of migrations) {
    const recorded = applied.get(m.name);
    if (recorded === undefined) {
      pending.push(m);
      continue;
    }
    if (recorded !== migrationChecksum(m.sql)) {
      throw new ApiError(409, "migration_modified",
        `migration ${m.name} was already applied and its content has changed since. An applied migration must not be edited: put the change in a new file with a later number.`);
    }
  }
  const early = pending.find(m => m.name < latestApplied);
  if (early) {
    throw new ApiError(409, "migration_out_of_order",
      `migration ${early.name} sorts before ${latestApplied}, which is already applied. Rename it so it comes after ${latestApplied}.`);
  }
  return pending;
}

/** One transaction on the migration connection. */
export interface MigrationTx {
  /** A platform statement, with bound parameters. */
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** The app's own SQL: simple protocol, so a file may hold many statements. */
  script(text: string): Promise<void>;
}

export interface MigrationSession {
  transaction<T>(fn: (tx: MigrationTx) => Promise<T>): Promise<T>;
}

export interface MigrationTarget {
  /** The app's login role; the SQL runs as this. */
  role: string;
  /** The app's schema; the ledger and unqualified names land here. */
  schema: string;
}

const SAFE_IDENT = /^[a-z0-9_]+$/;
function assertSafe(ident: string): void {
  if (!SAFE_IDENT.test(ident)) throw new Error(`unsafe postgres identifier: ${JSON.stringify(ident)}`);
}

/** Every transaction opens the same way: the app's role, its schema, bounded waits, one deploy at a time. */
async function enter(tx: MigrationTx, target: MigrationTarget): Promise<void> {
  await tx.query(`set local role ${target.role}`);
  await tx.query(`set local search_path = ${target.schema}`);
  await tx.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
  await tx.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
  await tx.query(`select pg_advisory_xact_lock(${ADVISORY_NAMESPACE}, hashtext($1))`, [target.schema]);
}

async function readLedger(tx: MigrationTx): Promise<Map<string, string>> {
  await tx.query(
    `create table if not exists ${LEDGER_TABLE} (
       name text primary key,
       checksum text not null,
       git_commit_sha text,
       applied_at timestamptz not null default now()
     )`,
  );
  const rows = await tx.query<{ name: string; checksum: string }>(`select name, checksum from ${LEDGER_TABLE}`);
  return new Map(rows.map(r => [r.name, r.checksum]));
}

/** Postgres's own words for why a file failed — SQLSTATE and message, no detail rows. */
export function describeMigrationError(name: string, e: unknown): ApiError {
  const err = e as { code?: unknown; message?: unknown };
  const code = typeof err?.code === "string" && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
  const message = typeof err?.message === "string" ? err.message.slice(0, 500) : "unknown error";
  return new ApiError(422, "migration_failed",
    `migration ${name} failed${code ? ` (SQLSTATE ${code})` : ""}: ${message}. Nothing from this file was applied and the live version keeps running.`);
}

export interface AppliedMigrations {
  applied: string[];
}

/**
 * Apply what the ledger has not seen, each file in its own transaction.
 *
 * Planning re-reads the ledger under the advisory lock, and every apply checks
 * again before it runs, so a second deploy racing this one cannot run a file
 * twice; the deploy lifecycle lock already makes that race unlikely.
 */
export async function applyMigrations(
  session: MigrationSession,
  target: MigrationTarget,
  migrations: AppMigration[],
  gitCommitSha: string | null,
): Promise<AppliedMigrations> {
  assertSafe(target.role);
  assertSafe(target.schema);
  if (migrations.length === 0) return { applied: [] };
  const pending = await session.transaction(async tx => {
    await enter(tx, target);
    return planMigrations(migrations, await readLedger(tx));
  });
  const applied: string[] = [];
  for (const m of pending) {
    const checksum = migrationChecksum(m.sql);
    const ran = await session.transaction(async tx => {
      await enter(tx, target);
      const ledger = await readLedger(tx);
      if (ledger.has(m.name)) {
        planMigrations([m], ledger);
        return false;
      }
      try {
        await tx.script(m.sql);
      } catch (e) {
        throw describeMigrationError(m.name, e);
      }
      // Back to the app's role and schema whatever the file did with them: a
      // file that reset its role can no longer write the ledger, and fails.
      await tx.query(`set local role ${target.role}`);
      await tx.query(`set local search_path = ${target.schema}`);
      await tx.query(
        `insert into ${LEDGER_TABLE} (name, checksum, git_commit_sha) values ($1, $2, $3)`,
        [m.name, checksum, gitCommitSha],
      );
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return { applied };
}

export interface RunAppMigrationsParams {
  orgId: string;
  appId: string;
  slug: string;
  migrations: AppMigration[];
  gitCommitSha?: string | null;
}

type Connect = (url: string) => ReturnType<typeof postgres>;
const defaultConnect: Connect = url =>
  postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });

export interface RunAppMigrationsDeps {
  connect?: Connect;
  provision?: typeof provisionAppPostgres;
}

/** The temporary login role's name: recognisable, unique, safe. */
export function migratorRoleName(): string {
  return `tc_mig_${randomBytes(8).toString("hex")}`;
}

function sessionOn(sql: ReturnType<typeof postgres>): MigrationSession {
  return {
    transaction: fn => sql.begin(async tx => fn({
      query: async (text, params) => (await tx.unsafe(text, (params ?? []) as never[])) as never,
      script: async text => { await tx.unsafe(text).simple(); },
    })) as never,
  };
}

/**
 * Run a data app's migrations against its database, as described at the top
 * of this file. Ensures the org database, schema and role exist (creating the
 * role with a throwaway password on a first deploy, keeping the live one
 * otherwise), mints the migrator role, applies, and removes the migrator.
 */
export async function runAppMigrations(
  adminUrl: string,
  params: RunAppMigrationsParams,
  deps: RunAppMigrationsDeps = {},
): Promise<AppliedMigrations> {
  if (params.migrations.length === 0) return { applied: [] };
  const connect = deps.connect ?? defaultConnect;
  const provision = deps.provision ?? provisionAppPostgres;
  const conn = await provision(adminUrl, {
    orgId: params.orgId,
    appId: params.appId,
    slug: params.slug,
    password: randomBytes(18).toString("base64url"),
    preserveExistingPassword: true,
  }, connect);
  assertSafe(conn.role);
  assertSafe(conn.schema);
  const orgDbUrl = withDatabaseName(adminUrl, conn.database);
  const migrator = migratorRoleName();
  const password = randomBytes(24).toString("base64url");
  const validUntil = new Date(Date.now() + 30 * 60_000).toISOString();
  const admin = connect(orgDbUrl);
  try {
    await admin.unsafe(
      `create role ${migrator} login noinherit nosuperuser nocreatedb nocreaterole noreplication
         connection limit 2 password '${password}' valid until '${validUntil}'`,
    );
    await admin.unsafe(`grant ${conn.role} to ${migrator}`);
    const url = new URL(orgDbUrl);
    url.username = migrator;
    url.password = password;
    const sql = connect(url.toString());
    try {
      return await applyMigrations(sessionOn(sql), { role: conn.role, schema: conn.schema }, params.migrations, params.gitCommitSha ?? null);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  } finally {
    await dropMigrator(admin, migrator, conn.role);
    await admin.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Remove the migrator. Anything it came to own (a file that reset its role and
 * created something) goes to the app's role first. Best-effort: the role
 * cannot log in after `valid until` regardless, and it holds nothing of its
 * own, so a failed cleanup must not fail a deploy that has already migrated.
 */
async function dropMigrator(admin: ReturnType<typeof postgres>, migrator: string, appRole: string): Promise<void> {
  try {
    await admin.unsafe(`alter role ${migrator} nologin`);
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where usename = '${migrator}'`);
    await admin.unsafe(`reassign owned by ${migrator} to ${appRole}`);
    await admin.unsafe(`drop owned by ${migrator}`);
    await admin.unsafe(`drop role ${migrator}`);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    console.warn(`[apps] migrator role ${migrator} left behind (SQLSTATE ${typeof code === "string" ? code : "?"}); it can no longer log in`);
  }
}
