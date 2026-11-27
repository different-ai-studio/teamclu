import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPgNotice, logPgNotice, withoutStatementContext } from "../../src/lib/provisioning/pg-notice.js";
import { connectForProvisioning, provisionAppPostgres } from "../../src/lib/provisioning/app-postgres.js";

const PASSWORD = "s3cret-Pa55word";

// What postgres.js hands `onnotice` when an app role's password is set on a
// server with password_encryption = md5 (belayo and self-host app RDS, 11/27).
const MD5_WARNING = {
  severity_local: "WARNING",
  severity: "WARNING",
  code: "01P01",
  message: "setting an MD5-encrypted password",
  detail: "MD5 password support is deprecated and will be removed in a future release of PostgreSQL.",
  where: `SQL statement "alter role app_x with login password '${PASSWORD}'"\nPL/pgSQL function inline_code_block line 3 at SQL statement`,
  file: "crypt.c",
  line: "210",
  routine: "encrypt_password",
};

test("a warning is logged by severity, code and message, never the statement that raised it", () => {
  const line = formatPgNotice(MD5_WARNING);
  assert.equal(line, "[app-db] postgres WARNING 01P01: setting an MD5-encrypted password");
  assert.ok(!line!.includes(PASSWORD));
});

test("NOTICE-level chatter is not logged", () => {
  assert.equal(
    formatPgNotice({ severity: "NOTICE", code: "42P06", message: 'schema "app_x" already exists, skipping' }),
    null,
  );
});

test("logPgNotice writes nothing that carries the password", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  t.mock.method(console, "log", (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  logPgNotice(MD5_WARNING);
  assert.equal(lines.length, 1);
  assert.ok(!lines.join("\n").includes(PASSWORD));
});

test("the provisioning connection routes notices through logPgNotice, not postgres.js's console.log", async () => {
  // postgres.js connects lazily: building the client opens no socket.
  const sql = connectForProvisioning("postgres://u:p@127.0.0.1:1/postgres");
  try {
    assert.equal((sql as any).options.onnotice, logPgNotice);
  } finally {
    await sql.end({ timeout: 0 });
  }
});

test("withoutStatementContext drops `where` and keeps the rest of the error", () => {
  const err = Object.assign(new Error("permission denied to alter role"), { code: "42501", where: MD5_WARNING.where });
  const out = withoutStatementContext(err);
  assert.equal(out, err);
  assert.equal("where" in out, false);
  assert.equal(out.code, "42501");
  assert.equal(out.message, "permission denied to alter role");
});

test("a failing role statement during provisioning rethrows without the password-bearing `where`", async () => {
  const fakeSql: any = Object.assign(async () => [{ exists: 1 }], {
    unsafe: async (statement: string) => {
      if (statement.includes("password")) {
        throw Object.assign(new Error("permission denied to alter role"), {
          code: "42501",
          where: `SQL statement "alter role app_x with login password '${PASSWORD}'"`,
        });
      }
    },
    end: async () => {},
  });
  await assert.rejects(
    provisionAppPostgres(
      "postgres://admin:pw@db.example:5432/postgres",
      { orgId: "00000000-0000-0000-0000-000000000001", appId: "00000000-0000-0000-0000-000000000002", slug: "demo", password: PASSWORD },
      () => fakeSql,
    ),
    (err: any) => {
      assert.equal(err.code, "42501");
      assert.equal("where" in err, false);
      assert.ok(!JSON.stringify(err).includes(PASSWORD));
      return true;
    },
  );
});
