import postgres from "postgres";
import { appSchemaName, appRoleName, orgDatabaseName } from "./pg-name.js";

const SAFE_IDENT = /^[a-z0-9_]+$/;

function assertSafe(ident: string): void {
  if (!SAFE_IDENT.test(ident)) {
    throw new Error(`unsafe postgres identifier: ${JSON.stringify(ident)}`);
  }
}

export interface ProvisionParams {
  schema: string; // already-sanitized schema name (see pg-name.ts)
  role: string; // already-sanitized role name
  password: string; // generated secret for the scoped login role
}

// Returns the ordered, idempotent DDL statements that create the per-app schema
// + a login role scoped to ONLY that schema. CREATE SCHEMA/ROLE cannot be
// parameterized, so identifiers are interpolated AFTER assertSafe(); the
// password is the only value-position datum and is single-quote-escaped.
export function buildProvisionStatements({ schema, role, password }: ProvisionParams): string[] {
  assertSafe(schema);
  assertSafe(role);
  const pw = password.replace(/'/g, "''");
  return [
    `create schema if not exists ${schema}`,
    // The password is ALWAYS (re)set, not only on create. The caller generates a
    // fresh secret per deploy and writes it into the function env; leaving an
    // existing role's password alone made every redeploy hand the app a
    // DATABASE_URL whose password had never been applied, so a second deploy
    // could no longer connect.
    `do $$ begin
       if exists (select 1 from pg_roles where rolname = '${role}') then
         alter role ${role} with login password '${pw}';
       else
         create role ${role} login password '${pw}';
       end if;
     end $$`,
    `grant usage, create on schema ${schema} to ${role}`,
    `alter default privileges in schema ${schema} grant all on tables to ${role}`,
    `alter default privileges in schema ${schema} grant all on sequences to ${role}`,
    `grant all on all tables in schema ${schema} to ${role}`,
    `grant all on all sequences in schema ${schema} to ${role}`,
    `alter role ${role} set search_path = ${schema}`,
  ];
}

export type SqlExecutor = (sql: string) => Promise<void>;

export interface EnsureAppSchemaParams {
  appId: string;
  slug: string;
  password: string;
  // Base URL of the org database (or legacy shared apps DB), used to compose
  // the app's own connection string (role + password + pinned search_path).
  baseUrl: string;
}

export interface AppConnection {
  schema: string;
  role: string;
  database: string;
  connectionString: string;
}

export async function ensureAppSchema(
  exec: SqlExecutor,
  { appId, slug, password, baseUrl }: EnsureAppSchemaParams,
): Promise<AppConnection> {
  const schema = appSchemaName(slug, appId);
  const role = appRoleName(appId);
  for (const stmt of buildProvisionStatements({ schema, role, password })) {
    await exec(stmt);
  }
  const u = new URL(baseUrl);
  u.username = role;
  u.password = password;
  u.searchParams.set("options", `-c search_path=${schema}`);
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  return { schema, role, database, connectionString: u.toString() };
}

/** Rewrite a postgres URL so it targets `database` (pathname). */
export function withDatabaseName(adminUrl: string, database: string): string {
  assertSafe(database);
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Idempotent CREATE DATABASE for an org.
 *
 * Postgres has no `CREATE DATABASE IF NOT EXISTS` on the versions we run, so
 * we probe `pg_database` first. Must not run inside a multi-statement
 * transaction with other DDL.
 */
export async function ensureOrgDatabaseExists(
  adminUrl: string,
  orgId: string,
  connect: (url: string) => ReturnType<typeof postgres> = (url) =>
    postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 }),
): Promise<string> {
  const database = orgDatabaseName(orgId);
  assertSafe(database);
  const sql = connect(adminUrl);
  try {
    const rows = await sql<{ exists: number }[]>`
      select 1 as exists from pg_database where datname = ${database}
    `;
    if (rows.length === 0) {
      // Identifier already assertSafe'd — CREATE DATABASE cannot take a param.
      await sql.unsafe(`CREATE DATABASE ${database}`);
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  return database;
}

export interface ProvisionAppPostgresParams {
  orgId: string;
  appId: string;
  slug: string;
  password: string;
}

/**
 * Org DB + per-app schema in one shot.
 *
 * `adminUrl` is a superuser (or CREATEDB) connection — typically the self-host
 * compose Postgres (`…/postgres`), not a pre-created shared apps database.
 * Creates `tc_org_<orgIdHex>` if missing, then schema + role inside it.
 */
export async function provisionAppPostgres(
  adminUrl: string,
  params: ProvisionAppPostgresParams,
  connect: (url: string) => ReturnType<typeof postgres> = (url) =>
    postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 }),
): Promise<AppConnection> {
  const database = await ensureOrgDatabaseExists(adminUrl, params.orgId, connect);
  const orgDbUrl = withDatabaseName(adminUrl, database);
  const sql = connect(orgDbUrl);
  try {
    const exec: SqlExecutor = async (statement) => {
      await sql.unsafe(statement);
    };
    return await ensureAppSchema(exec, {
      appId: params.appId,
      slug: params.slug,
      password: params.password,
      baseUrl: orgDbUrl,
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

let _adminSql: ReturnType<typeof postgres> | null = null;

/**
 * Admin connection pointed at whatever APPS_DB_ADMIN_URL names.
 *
 * Prefer {@link provisionAppPostgres} for new deploys (per-org DB). This
 * helper remains for call sites that only need a raw executor against the
 * admin URL.
 */
export function getAppsAdminExecutor(): SqlExecutor {
  const url = process.env.APPS_DB_ADMIN_URL;
  if (!url) throw new Error("APPS_DB_ADMIN_URL is not set");
  if (!_adminSql) {
    _adminSql = postgres(url, {
      max: Number(process.env.PG_POOL_MAX ?? "1"),
      idle_timeout: Number(process.env.PG_IDLE_TIMEOUT ?? "20"),
      connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT ?? "10"),
      prepare: false,
    });
  }
  const sql = _adminSql;
  return async (statement: string) => {
    await sql.unsafe(statement);
  };
}

/** Read APPS_DB_ADMIN_URL; empty → undefined (data_app deploy will fail loudly). */
export function readAppsAdminUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.APPS_DB_ADMIN_URL?.trim();
  return url || undefined;
}
