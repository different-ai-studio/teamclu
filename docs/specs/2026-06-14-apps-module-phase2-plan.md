# Apps 模块第二期实现计划 — M0 spike + M1 Postgres Provisioning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the two phase-2 unknowns (Aliyun FC custom-runtime feasibility, `@alicloud/fc20230330` API surface), then ship per-app Postgres provisioning (schema-per-app + scoped role in a shared `teamclu_apps` DB) as a fully tested FC module.

**Architecture:** Two spikes (M0) produce committed findings that unblock the later M2–M5 plan. M1 adds `services/fc/src/lib/provisioning/app-postgres.ts`: a pure SQL builder (`buildProvisionStatements`) plus an executor (`ensureAppSchema`) that runs against a **separate** admin connection (`APPS_DB_ADMIN_URL`, the new `teamclu_apps` database), independent of the drizzle control-plane pool. Everything is idempotent.

**Tech Stack:** Node 20 + TypeScript (ESM, `.js` import specifiers), `postgres` (porsager) driver, `node:test` + `node:assert/strict`, `@electric-sql/pglite` for in-process DB tests, `@alicloud/openapi-client` (+ to-be-added `@alicloud/fc20230330`).

**Spec:** `docs/specs/2026-06-14-apps-module-phase2-design.md`.

**Scope note:** This plan covers **M0 + M1 only**. M2 (FC-function client), M3 (template+daemon build), M4 (finalize/live), and M5 (desktop UI) depend on the M0 findings and get a **separate plan written after M0 completes** — writing their code before the spike resolves the FC SDK/runtime shapes would be guesswork.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `docs/specs/2026-06-14-apps-fc-runtime-spike.md` | M0 findings: how a TanStack/Node server runs on Aliyun FC custom runtime + HTTP trigger | T1 |
| `docs/specs/2026-06-14-apps-alicloud-fc-sdk-spike.md` | M0 findings: `@alicloud/fc20230330` create/update-from-OSS/trigger-URL call shapes | T2 |
| `services/fc/src/lib/provisioning/app-postgres.ts` | Pure SQL builder + `ensureAppSchema` executor (schema + scoped role) | T4–T8 |
| `services/fc/src/lib/provisioning/pg-name.ts` | Sanitize app slug/id → safe Postgres identifiers | T3 |
| `services/fc/test/provisioning/pg-name.test.ts` | Identifier-sanitization tests | T3 |
| `services/fc/test/provisioning/app-postgres.test.ts` | SQL-builder + pglite-execution + idempotency tests | T4–T8 |
| `deploy/belayo/cloud-api.env.keys` + `.github/workflows/belayo-cloud-api.yml` (modify) | Wire new `APPS_DB_ADMIN_URL` into the Cloud API deployment contract | T9 |

---

## M0 — Spikes (gate M2–M5)

> Spikes are investigation, not TDD. Each produces a committed findings doc with concrete, copy-pastable answers. No product code ships in M0.

### Task 1: Spike — TanStack/Node server on Aliyun FC custom runtime + HTTP trigger

**Files:**
- Create: `docs/specs/2026-06-14-apps-fc-runtime-spike.md`

- [ ] **Step 1: Confirm the runtime + trigger model**

Use context7 or the Aliyun FC 3.0 docs to answer, concretely, in the findings doc:
- Which runtime to use for a long-running Node HTTP server: `custom.debian10`/`custom.debian11` custom runtime vs `nodejs20` event runtime. (Custom runtime is expected — it lets the function expose an HTTP server on `$PORT` / `9000`.)
- The exact `bootstrap` contract for a custom runtime: file name, executable bit, what env var carries the port (`FC_SERVER_PORT` / `PORT` — record the real one), and the request lifecycle (warm container reuse, cold-start timeout).
- How an HTTP trigger maps a public URL to the function, and where the invocable URL is read from (trigger config vs custom-domain). Record whether the default trigger URL is suitable for v1 (`fc_endpoint`).

- [ ] **Step 2: Prove a minimal Node server boots under the model**

Write a 10-line throwaway `bootstrap` + `server.js` (a bare `http.createServer` returning `200 "ok"`) in a scratch dir (NOT committed to product paths). Document the zip layout that FC accepts (where `node_modules` goes, entry path). If an account/region is available, deploy it manually via the console or `s` CLI and curl the trigger URL; otherwise document the exact expected layout from docs and mark the live deploy as "to verify in M2 with the SDK". Record findings.

- [ ] **Step 3: Map TanStack Start's node output onto that contract**

In the findings doc, state which TanStack Start server preset produces a plain Node server entry (e.g. `node-server`), what the built output directory + entry file is, and how the `bootstrap` should invoke it (`exec node .output/server/index.mjs` or equivalent). Note any env the app needs (`PORT`, `DATABASE_URL`). This is the input to M3's template work.

- [ ] **Step 4: Commit findings**

```bash
git add docs/specs/2026-06-14-apps-fc-runtime-spike.md
git commit -m "docs(apps): M0 spike — TanStack/Node on Aliyun FC custom runtime"
```

### Task 2: Spike — `@alicloud/fc20230330` API surface

**Files:**
- Create: `docs/specs/2026-06-14-apps-alicloud-fc-sdk-spike.md`

- [ ] **Step 1: Add the SDK and record the client construction**

```bash
cd services/fc && pnpm add @alicloud/fc20230330
```

In the findings doc, record the exact import + client construction, reusing the existing `@alicloud/openapi-client` `Config` pattern already used in `services/fc/src/lib/oss.ts` (AK/SK from `ACCESS_KEY_ID`/`ACCESS_KEY_SECRET`, region/endpoint). Paste the concrete `new FC20230330(new Config({...}))` snippet.

- [ ] **Step 2: Record the four calls M2/M4 need**

Document, with exact method names, request classes, and the shape of the response object for each:
1. **CreateFunction** — custom runtime, handler, memory, timeout, `role` (= `ROLE_ARN`), and code-from-OSS (`InputCodeLocation`/`ossBucketName`/`ossObjectName` — record the real field names).
2. **UpdateFunctionCode** (or `UpdateFunction` with code) — update an existing function's code from an OSS object.
3. **GetFunction** — to implement check-then-create idempotency (what error/shape indicates "not found").
4. **CreateTrigger** (http) + reading the **invoke URL** (which response field / which Get call returns the public URL).

- [ ] **Step 3: Record env/permission prerequisites**

State the RAM permissions the AK/SK needs (`fc:CreateFunction`, `fc:UpdateFunctionCode`, `fc:CreateTrigger`, `fc:GetFunction`, plus `ram:PassRole` for `ROLE_ARN`), and whether the existing production AK/SK already has them or a follow-up grant is needed. Record the `REGION`/`ENDPOINT` env the SDK expects.

- [ ] **Step 4: Commit findings**

```bash
git add services/fc/package.json services/fc/pnpm-lock.yaml docs/specs/2026-06-14-apps-alicloud-fc-sdk-spike.md
git commit -m "docs(apps): M0 spike — @alicloud/fc20230330 API surface + add dep"
```

---

## M1 — Postgres Provisioning (schema-per-app + scoped role)

> All M1 code is TDD. The two public entry points are `buildProvisionStatements` (pure, returns ordered SQL) and `ensureAppSchema` (executes them on the admin connection). Splitting the SQL into a pure builder makes the security-critical statements unit-testable without a live DB.

### Task 3: Postgres identifier sanitization

**Files:**
- Create: `services/fc/src/lib/provisioning/pg-name.ts`
- Test: `services/fc/test/provisioning/pg-name.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/fc/test/provisioning/pg-name.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appSchemaName, appRoleName } from "../../src/lib/provisioning/pg-name.js";

test("appSchemaName lowercases, replaces non-alnum with _, and prefixes", () => {
  assert.equal(appSchemaName("My Cool App!"), "app_my_cool_app_");
});

test("appSchemaName collapses leading digits behind the prefix safely", () => {
  // prefix guarantees a valid leading char even if slug starts with a digit
  assert.equal(appSchemaName("123abc"), "app_123abc");
});

test("appRoleName derives from the appId uuid with underscores", () => {
  assert.equal(
    appRoleName("3f1c9a2e-0000-4000-8000-000000000abc"),
    "app_3f1c9a2e_0000_4000_8000_000000000abc",
  );
});

test("appSchemaName truncates to <= 63 bytes (Postgres identifier limit)", () => {
  const long = "x".repeat(200);
  const out = appSchemaName(long);
  assert.ok(out.length <= 63, `got ${out.length}`);
  assert.ok(out.startsWith("app_"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/fc && node --import tsx --test test/provisioning/pg-name.test.ts`
Expected: FAIL — `Cannot find module '.../pg-name.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// services/fc/src/lib/provisioning/pg-name.ts

// Postgres identifiers are max 63 bytes. We prefix to guarantee a valid leading
// character and a stable namespace, lowercase, and replace every char outside
// [a-z0-9_] with "_". These names are ALSO interpolated into DDL (CREATE SCHEMA
// cannot be parameterized), so the sanitizer is the security boundary: the
// output is guaranteed to match /^[a-z0-9_]+$/ and is asserted again before use.
const MAX_LEN = 63;

function sanitize(input: string, prefix: string): string {
  const body = input.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${prefix}${body}`.slice(0, MAX_LEN);
}

export function appSchemaName(slug: string): string {
  return sanitize(slug, "app_");
}

export function appRoleName(appId: string): string {
  return sanitize(appId, "app_");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/fc && node --import tsx --test test/provisioning/pg-name.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/provisioning/pg-name.ts services/fc/test/provisioning/pg-name.test.ts
git commit -m "feat(apps): pg identifier sanitizer for per-app schema/role names"
```

### Task 4: SQL builder — assert it rejects unsafe identifiers

**Files:**
- Create: `services/fc/src/lib/provisioning/app-postgres.ts`
- Test: `services/fc/test/provisioning/app-postgres.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/fc/test/provisioning/app-postgres.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProvisionStatements } from "../../src/lib/provisioning/app-postgres.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// services/fc/src/lib/provisioning/app-postgres.ts

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
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${role}') then
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/provisioning/app-postgres.ts services/fc/test/provisioning/app-postgres.test.ts
git commit -m "feat(apps): idempotent per-app schema/role SQL builder with ident guard"
```

### Task 5: SQL builder — assert the statement set is correct

**Files:**
- Modify: `services/fc/test/provisioning/app-postgres.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
test("buildProvisionStatements emits idempotent, schema-scoped DDL in order", () => {
  const stmts = buildProvisionStatements({ schema: "app_demo", role: "app_demo", password: "s3cret" });
  assert.equal(stmts[0], "create schema if not exists app_demo");
  // role created only if absent
  assert.match(stmts[1], /if not exists \(select 1 from pg_roles where rolname = 'app_demo'\)/);
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
```

- [ ] **Step 2: Run tests**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: PASS (4 tests total). If the order/wording assertions fail, adjust the test to match Task 4's exact strings — do not weaken the "no amux/public" or "search_path pinned" assertions.

- [ ] **Step 3: Commit**

```bash
git add services/fc/test/provisioning/app-postgres.test.ts
git commit -m "test(apps): assert per-app provisioning DDL is scoped + idempotent"
```

### Task 6: `ensureAppSchema` executes against a connection (pglite happy path)

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-postgres.ts`
- Modify: `services/fc/test/provisioning/app-postgres.test.ts`

- [ ] **Step 1: Write the failing test (runs DDL on in-process pglite)**

```typescript
import { PGlite } from "@electric-sql/pglite";
import { ensureAppSchema } from "../../src/lib/provisioning/app-postgres.js";

// Adapter: ensureAppSchema takes an async (sql:string)=>Promise<void> executor,
// so it is driver-agnostic (pglite in tests, postgres() in prod).
test("ensureAppSchema creates the schema and a scoped role on a real PG (pglite)", async () => {
  const pg = new PGlite();
  const exec = async (sql: string) => { await pg.exec(sql); };
  const conn = await ensureAppSchema(exec, {
    appId: "3f1c9a2e-0000-4000-8000-000000000abc",
    slug: "Demo App",
    password: "p@ss'1",
    baseUrl: "postgres://app_user@host:5432/teamclu_apps",
  });
  // schema exists
  const schemas = await pg.query<{ schema_name: string }>(
    "select schema_name from information_schema.schemata where schema_name = 'app_demo_app'",
  );
  assert.equal(schemas.rows.length, 1);
  // role exists
  const roles = await pg.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'",
  );
  assert.equal(roles.rows.length, 1);
  // returns a connection string carrying the role + schema search_path
  assert.match(conn.connectionString, /app_3f1c9a2e_0000_4000_8000_000000000abc/);
  assert.match(conn.connectionString, /[?&]options=.*search_path%3Dapp_demo_app/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: FAIL — `ensureAppSchema is not a function`.

- [ ] **Step 3: Implement `ensureAppSchema`**

```typescript
// append to services/fc/src/lib/provisioning/app-postgres.ts
import { appSchemaName, appRoleName } from "./pg-name.js";

export type SqlExecutor = (sql: string) => Promise<void>;

export interface EnsureAppSchemaParams {
  appId: string;
  slug: string;
  password: string;
  // The teamclu_apps base URL WITHOUT credentials/db-specific role, e.g.
  // postgres://host:5432/teamclu_apps — used to compose the app's own
  // connection string (role + password + pinned search_path).
  baseUrl: string;
}

export interface AppConnection {
  schema: string;
  role: string;
  connectionString: string;
}

export async function ensureAppSchema(
  exec: SqlExecutor,
  { appId, slug, password, baseUrl }: EnsureAppSchemaParams,
): Promise<AppConnection> {
  const schema = appSchemaName(slug);
  const role = appRoleName(appId);
  for (const stmt of buildProvisionStatements({ schema, role, password })) {
    await exec(stmt);
  }
  const u = new URL(baseUrl);
  u.username = role;
  u.password = password;
  u.searchParams.set("options", `-c search_path=${schema}`);
  return { schema, role, connectionString: u.toString() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: PASS. If the `options` encoding assertion fails, log `conn.connectionString` and align the regex to `URL`'s actual percent-encoding (`%3D` for `=`, `+`/`%20` for space) — keep the assertion, fix the expectation.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/provisioning/app-postgres.ts services/fc/test/provisioning/app-postgres.test.ts
git commit -m "feat(apps): ensureAppSchema executor + scoped app connection string"
```

### Task 7: `ensureAppSchema` is idempotent (re-run is a no-op)

**Files:**
- Modify: `services/fc/test/provisioning/app-postgres.test.ts`

- [ ] **Step 1: Add the failing test**

```typescript
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
  // second run must NOT throw (schema/role already exist)
  await ensureAppSchema(exec, params);
  const roles = await pg.query<{ n: number }>(
    "select count(*)::int as n from pg_roles where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'",
  );
  assert.equal(roles.rows[0].n, 1);
});
```

- [ ] **Step 2: Run tests**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: PASS — the `create schema if not exists` + `do $$ ... if not exists ... $$` guards make the second run a no-op. If pglite errors on the second `create role`, the guard block is wrong; fix the `do $$` block, not the test.

- [ ] **Step 3: Commit**

```bash
git add services/fc/test/provisioning/app-postgres.test.ts
git commit -m "test(apps): ensureAppSchema idempotent re-run"
```

### Task 8: Admin connection factory (`getAppsAdminExecutor`)

**Files:**
- Modify: `services/fc/src/lib/provisioning/app-postgres.ts`
- Modify: `services/fc/test/provisioning/app-postgres.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { getAppsAdminExecutor } from "../../src/lib/provisioning/app-postgres.js";

test("getAppsAdminExecutor throws a clear error when APPS_DB_ADMIN_URL is unset", () => {
  const prev = process.env.APPS_DB_ADMIN_URL;
  delete process.env.APPS_DB_ADMIN_URL;
  try {
    assert.throws(() => getAppsAdminExecutor(), /APPS_DB_ADMIN_URL is not set/);
  } finally {
    if (prev !== undefined) process.env.APPS_DB_ADMIN_URL = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: FAIL — `getAppsAdminExecutor is not a function`.

- [ ] **Step 3: Implement the factory (separate pool from the control-plane drizzle pool)**

```typescript
// append to services/fc/src/lib/provisioning/app-postgres.ts
import postgres from "postgres";

let _adminSql: ReturnType<typeof postgres> | null = null;

// Dedicated admin connection to the teamclu_apps database (NOT supabase_db).
// Mirrors db/client.ts serverless-safe defaults. Separate singleton so app
// provisioning never shares the control-plane pool.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/fc && node --import tsx --test test/provisioning/app-postgres.test.ts`
Expected: PASS (all app-postgres tests).

- [ ] **Step 5: Run the whole FC suite to confirm no regressions**

Run: `cd services/fc && pnpm test`
Expected: PASS — existing suite plus the new provisioning tests. If the runner glob doesn't pick up `test/provisioning/**`, check `services/fc/package.json`'s test script and add the glob in the same style it already uses (do not change the runner).

- [ ] **Step 6: Commit**

```bash
git add services/fc/src/lib/provisioning/app-postgres.ts services/fc/test/provisioning/app-postgres.test.ts
git commit -m "feat(apps): teamclu_apps admin connection factory for provisioning"
```

### Task 9: Wire `APPS_DB_ADMIN_URL` into the function env + deploy secrets

> There is no `.env.example` in `services/fc`; env vars reach the function via
> `s.yaml`'s `environmentVariables` block (mapped from process env at deploy) and
> are stored in each deployment's secret store. Wire both container targets.

**Files:**
- Modify: `deploy/belayo/cloud-api.env.keys`
- Modify: `.github/workflows/belayo-cloud-api.yml` only if the deployment contract changes

- [ ] **Step 1: Map the var into the function in `s.yaml`**

After the `CODEUP_BOT_USERNAME` line in the `environmentVariables:` block, add (match the existing 8-space indentation + `${env(...)}` style; default to empty so non-apps deploys are unaffected):

```yaml
        # Admin connection to the shared per-app Postgres DB (teamclu_apps),
        # same RDS instance as the control plane but a DIFFERENT database. Used
        # only by apps provisioning (CREATE SCHEMA / CREATE ROLE). Never sent
        # to clients.
        APPS_DB_ADMIN_URL: ${env('APPS_DB_ADMIN_URL', '')}
```

- [ ] **Step 2: Source it from a repo secret in `fc-deploy.yml`**

In the workflow `env:` block (alongside `ROLE_ARN`, `SUPABASE_URL`, …), add:

```yaml
      APPS_DB_ADMIN_URL: ${{ secrets.APPS_DB_ADMIN_URL }}
```

- [ ] **Step 3: Verify the only code reader is the provisioning module**

Run: `cd services/fc && grep -rn "APPS_DB_ADMIN_URL" src/ test/`
Expected: only `src/lib/provisioning/app-postgres.ts` (+ the unset-guard test from T8).

- [ ] **Step 4: Confirm `s.yaml` still parses (YAML lint)**

Run: `cd services/fc && node -e "require('yaml') ? 0 : 0" 2>/dev/null; npx --yes yaml-lint s.yaml 2>/dev/null || node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('s.yaml','utf8'));console.log('s.yaml OK')"`
Expected: no parse error (prints `s.yaml OK` or the linter passes). If neither yaml tool is available, eyeball the indentation matches the surrounding `${env(...)}` lines.

- [ ] **Step 5: Commit**

```bash
git add deploy/belayo/cloud-api.env.keys .github/workflows/belayo-cloud-api.yml
git commit -m "chore(apps): wire APPS_DB_ADMIN_URL into FC function env + deploy"
```

---

## Out of band (operator follow-up, not code — track before M2)

These are infra prerequisites the deploy pipeline will need; they are **not** part of M0/M1 code but must be done by an operator before M2 finalize can run live:

- [ ] Create database `teamclu_apps` on each env's RDS instance (test/dev already host `supabase_db`; dev also hosts `litellm`). Owner = `supabase_admin`.
- [ ] Set `APPS_DB_ADMIN_URL` in FC env via repo secrets (GitHub Action only — never local deploy).
- [ ] Confirm/extend the production AK/SK RAM permissions per the M0 Task-2 spike findings (`fc:*Function`, `fc:CreateTrigger`, `ram:PassRole`).

---

## Self-Review

- **Spec coverage:** §2.1 (fc_* semantics) → consumed in M2–M5 (separate plan). §2.2 (RLS recursion) → already shipped (`ad48f38c`); regression test belongs to M1's test domain but lives in `services/supabase` migration tests — tracked as a follow-up in the M2 plan since it needs the migration test harness, not the FC provisioning module. §3.1 `app-postgres.ts` → T3–T9. §5 security (scoped role, no amux/public grants, password not stored) → asserted in T5/T6. §3.1 `app-fc-function.ts`, §3.2 daemon, §3.3 template, §3.4 desktop, §4 state machine → M2–M5 (gated on M0, separate plan, called out in Scope note).
- **Placeholder scan:** no TBD/TODO; every code step has full code; spike tasks have concrete questions + commands + a committed deliverable.
- **Type consistency:** `SqlExecutor`, `ProvisionParams`, `EnsureAppSchemaParams`, `AppConnection`, `buildProvisionStatements`, `ensureAppSchema`, `getAppsAdminExecutor`, `appSchemaName`, `appRoleName` are used consistently across T3–T9.
- **Gap intentionally deferred:** M2–M5 are not planned here by design (gated on M0 findings); this is stated in the Scope note and the design's §9 milestones.
