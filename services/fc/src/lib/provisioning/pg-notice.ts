/**
 * `onnotice` for every postgres.js client that provisions or serves app
 * databases.
 *
 * Left unset, postgres.js prints each notice object whole with console.log —
 * `where` included, which quotes the statement that raised it. Setting an app
 * role's password on a server with `password_encryption = md5` raises
 * WARNING 01P01, whose `where` is the `alter role … password '…'` statement:
 * every data_app deploy wrote that app's database password to the Cloud API's
 * log. So only severity, code and message are logged (none of them quotes the
 * statement), and only for warnings — NOTICE-level chatter such as
 * "schema … already exists, skipping" is dropped.
 */
export type PgNotice = {
  severity?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

const QUIET = new Set(["DEBUG", "LOG", "INFO", "NOTICE"]);

export function formatPgNotice(notice: PgNotice): string | null {
  const severity = String(notice.severity ?? "NOTICE").toUpperCase();
  if (QUIET.has(severity)) return null;
  return `[app-db] postgres ${severity} ${notice.code ?? "?"}: ${notice.message ?? ""}`;
}

export function logPgNotice(notice: PgNotice): void {
  const line = formatPgNotice(notice);
  if (line) console.warn(line);
}

/**
 * The same leak through an error: a PostgresError raised inside the role's
 * `do $$ … $$` block carries a `where` that quotes the statement, password
 * and all, and whoever logs the error prints it. Drop it before rethrowing.
 */
export function withoutStatementContext<T>(err: T): T {
  if (err && typeof err === "object" && "where" in err) {
    delete (err as { where?: unknown }).where;
  }
  return err;
}
