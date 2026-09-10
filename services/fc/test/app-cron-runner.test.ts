import assert from "node:assert/strict";
import test from "node:test";
import {
  executeAppCronJob,
  runDueAppCronJobs,
  sanitizeCronHeaders,
} from "../src/lib/app-cron-runner.js";

/**
 * A tiny in-memory stand-in for the service-role client.
 *
 * Purpose-built rather than borrowed from supabase-repo.test.ts: the behaviour
 * under test here is the compare-and-set claim and the retention trim, and both
 * need the fake to actually APPLY filters to rows rather than replay a scripted
 * answer. Everything it supports is something the runner calls.
 */
function makeDb(tables: Record<string, any[]>) {
  const applied: string[] = [];

  function query(table: string, copy = false) {
    const filters: Array<(r: any) => boolean> = [];
    let sortKey: string | null = null;
    let sortAsc = true;
    let take: number | null = null;
    let skip = 0;

    const rows = () => {
      let out = tables[table].filter((r) => filters.every((f) => f(r)));
      if (sortKey) {
        const key = sortKey;
        out = [...out].sort((a, b) =>
          String(a[key] ?? "").localeCompare(String(b[key] ?? "")) * (sortAsc ? 1 : -1),
        );
      }
      out = out.slice(skip);
      if (take !== null) out = out.slice(0, take);
      // Reads hand back copies. Sharing the row objects would let a test that
      // mutates the store also mutate the value the runner read a moment
      // earlier — which is exactly the compare-and-set being tested.
      return copy ? out.map((r) => ({ ...r })) : out;
    };

    const builder: any = {
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      lte(col: string, val: any) {
        filters.push((r) => r[col] !== null && r[col] <= val);
        return builder;
      },
      not(col: string, op: string, val: any) {
        assert.equal(op, "is");
        assert.equal(val, null);
        filters.push((r) => r[col] !== null && r[col] !== undefined);
        return builder;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order(col: string, opts: any = {}) {
        sortKey = col;
        sortAsc = opts.ascending !== false;
        return builder;
      },
      limit(n: number) {
        take = n;
        return builder;
      },
      range(from: number, to: number) {
        skip = from;
        take = to - from + 1;
        return builder;
      },
      select() {
        return builder;
      },
      async maybeSingle() {
        return { data: rows()[0] ?? null, error: null };
      },
      async single() {
        return { data: rows()[0] ?? null, error: null };
      },
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      },
    };
    return { builder, rows, filters };
  }

  return {
    applied,
    tables,
    from(table: string) {
      return {
        select() {
          return query(table, true).builder;
        },
        update(patch: Record<string, any>) {
          const q = query(table);
          const wrapped: any = {
            ...q.builder,
            select() {
              const matched = q.rows();
              for (const row of matched) Object.assign(row, patch);
              applied.push(`${table}.update:${matched.length}`);
              return {
                then: (resolve: any, reject: any) =>
                  Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null })
                    .then(resolve, reject),
              };
            },
          };
          // The filter methods must return `wrapped`, not the inner builder, or
          // `.eq().eq().select()` would fall back to a plain select.
          for (const m of ["eq", "lte", "not", "in", "order", "limit", "range"]) {
            wrapped[m] = (...args: any[]) => {
              (q.builder as any)[m](...args);
              return wrapped;
            };
          }
          return wrapped;
        },
        async insert(row: Record<string, any>) {
          tables[table].push({ id: `row-${tables[table].length + 1}`, ...row });
          applied.push(`${table}.insert`);
          return { data: null, error: null };
        },
        delete() {
          const q = query(table);
          const wrapped: any = {
            in(col: string, vals: any[]) {
              const gone = tables[table].filter((r) => vals.includes(r[col]));
              tables[table] = tables[table].filter((r) => !vals.includes(r[col]));
              applied.push(`${table}.delete:${gone.length}`);
              return Promise.resolve({ data: null, error: null });
            },
          };
          void q;
          return wrapped;
        },
      };
    },
  };
}

const ENV = { APPS_PUBLIC_DOMAIN: "apps.example.com", LOGIN_DOMAIN: "login.example.com" };
const APP_ID = "11111111-2222-3333-4444-555555555555";

function job(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "job-1",
    app_id: APP_ID,
    name: "daily",
    enabled: true,
    schedule_expr: "0 9 * * *",
    timezone: "UTC",
    method: "GET",
    path: "/api/daily",
    headers: {},
    body: null,
    timeout_ms: 5000,
    next_run_at: "2026-09-10T09:00:00.000Z",
    ...over,
  };
}

const apps = () => [{ id: APP_ID, slug: "report" }];

// --- header hygiene ---------------------------------------------------------

test("hop-by-hop and host headers never reach the app", () => {
  const out = sanitizeCronHeaders({
    Host: "someone-elses-app.example.com",
    "Content-Length": "9",
    Connection: "close",
    "X-Job-Secret": "s3cret",
  });
  assert.deepEqual(out, { "x-job-secret": "s3cret" });
});

test("a header that would smuggle a second request is dropped", () => {
  assert.deepEqual(sanitizeCronHeaders({ "X-A": "ok\r\nX-Injected: yes" }), {});
  assert.deepEqual(sanitizeCronHeaders({ "bad header": "v" }), {});
  assert.deepEqual(sanitizeCronHeaders({ "X-N": 42 }), {});
  assert.deepEqual(sanitizeCronHeaders(["x"]), {});
  assert.deepEqual(sanitizeCronHeaders(null), {});
});

// --- the tick ---------------------------------------------------------------

test("a due job is fired at its app's public URL and recorded", async () => {
  const db = makeDb({ app_cron_jobs: [job()], apps: apps(), app_cron_runs: [] });
  let seen: any = null;
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async (url: any, init: any) => {
      seen = { url, init };
      return new Response("", { status: 200 });
    }) as any,
  });

  assert.equal(out.due, 1);
  assert.equal(out.ran, 1);
  assert.equal(out.outcomes[0].status, "success");
  assert.equal(seen.url, "https://report-11111111.apps.example.com/api/daily");
  assert.equal(seen.init.redirect, "manual", "the login wall's 302 must stay visible");
  assert.equal(db.tables.app_cron_runs.length, 1);
  assert.equal(db.tables.app_cron_runs[0].status, "success");
  assert.equal(db.tables.app_cron_runs[0].response_status, 200);
});

test("claiming moves next_run_at forward before the request goes out", async () => {
  const rows = [job()];
  const db = makeDb({ app_cron_jobs: rows, apps: apps(), app_cron_runs: [] });
  await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => new Response("", { status: 200 })) as any,
  });
  assert.equal(rows[0].next_run_at, "2026-09-11T09:00:00.000Z");
  assert.equal(rows[0].last_run_at, "2026-09-10T09:00:30.000Z");
});

test("a job another tick already claimed is not run twice", async () => {
  // The claim is `where next_run_at = <the value we read>`. Simulate the loser
  // of the race by moving the row on before the update lands.
  const rows = [job()];
  const db = makeDb({ app_cron_jobs: rows, apps: apps(), app_cron_runs: [] });
  const realFrom = db.from.bind(db);
  let fired = 0;
  db.from = ((table: string) => {
    const t = realFrom(table);
    if (table === "app_cron_jobs") {
      const realUpdate = t.update.bind(t);
      t.update = (patch: any) => {
        rows[0].next_run_at = "2099-01-01T00:00:00.000Z"; // the other tick won
        return realUpdate(patch);
      };
    }
    return t;
  }) as any;

  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => {
      fired += 1;
      return new Response("", { status: 200 });
    }) as any,
  });
  assert.equal(out.due, 1);
  assert.equal(out.ran, 0, "the losing tick must not send the request");
  assert.equal(fired, 0);
  assert.equal(db.tables.app_cron_runs.length, 0);
});

test("a bounce to the login service is a failure that names the fix", async () => {
  const db = makeDb({ app_cron_jobs: [job()], apps: apps(), app_cron_runs: [] });
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://login.example.com/?app=x" },
      })) as any,
  });
  assert.equal(out.outcomes[0].status, "failed");
  assert.match(out.outcomes[0].error!, /应用权限/);
});

test("the app's own redirect is a success, not a login bounce", async () => {
  const db = makeDb({ app_cron_jobs: [job()], apps: apps(), app_cron_runs: [] });
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://report-11111111.apps.example.com/home" },
      })) as any,
  });
  assert.equal(out.outcomes[0].status, "success");
});

test("a 500 from the app is recorded as failed with its status", async () => {
  const db = makeDb({ app_cron_jobs: [job()], apps: apps(), app_cron_runs: [] });
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => new Response("boom", { status: 500 })) as any,
  });
  assert.equal(out.outcomes[0].status, "failed");
  assert.equal(out.outcomes[0].responseStatus, 500);
});

test("an aborted request is a timeout, told apart from a failure", async () => {
  const db = makeDb({ app_cron_jobs: [job({ timeout_ms: 1000 })], apps: apps(), app_cron_runs: [] });
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as any,
  });
  assert.equal(out.outcomes[0].status, "timeout");
  assert.match(out.outcomes[0].error!, /1000ms/);
});

test("a stored expression that no longer parses parks the job instead of spinning", async () => {
  const rows = [job({ schedule_expr: "not a cron" })];
  const db = makeDb({ app_cron_jobs: rows, apps: apps(), app_cron_runs: [] });
  let fired = 0;
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => {
      fired += 1;
      return new Response("", { status: 200 });
    }) as any,
  });
  assert.equal(fired, 0);
  assert.equal(out.ran, 0);
  assert.equal(rows[0].next_run_at, null, "never again, rather than every minute forever");
  assert.equal(db.tables.app_cron_runs[0].status, "failed");
  assert.match(db.tables.app_cron_runs[0].error, /schedule is not valid/);
});

test("a deployment with no apps domain says so instead of requesting nothing", async () => {
  const db = makeDb({ app_cron_jobs: [job()], apps: apps(), app_cron_runs: [] });
  let fired = 0;
  const out = await runDueAppCronJobs({
    client: db,
    env: { LOGIN_DOMAIN: "login.example.com" } as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => {
      fired += 1;
      return new Response("", { status: 200 });
    }) as any,
  });
  assert.equal(fired, 0);
  assert.equal(out.outcomes[0].status, "failed");
  assert.match(out.outcomes[0].error!, /APPS_PUBLIC_DOMAIN/);
});

test("a disabled job is never due", async () => {
  const db = makeDb({
    app_cron_jobs: [job({ enabled: false, next_run_at: null })],
    apps: apps(),
    app_cron_runs: [],
  });
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => new Response("", { status: 200 })) as any,
  });
  assert.equal(out.due, 0);
});

test("history is trimmed to the newest 20 rows per job", async () => {
  const runs = Array.from({ length: 25 }, (_, i) => ({
    id: `old-${String(i).padStart(2, "0")}`,
    job_id: "job-1",
    app_id: APP_ID,
    started_at: `2026-09-0${1 + (i % 9)}T00:00:${String(i).padStart(2, "0")}.000Z`,
    status: "success",
  }));
  const db = makeDb({ app_cron_jobs: [job()], apps: apps(), app_cron_runs: runs });
  await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => new Response("", { status: 200 })) as any,
  });
  assert.equal(db.tables.app_cron_runs.length, 20);
});

// --- run it now -------------------------------------------------------------

test("running a job by hand does not move its schedule", async () => {
  const row = job();
  const db = makeDb({ app_cron_jobs: [row], apps: apps(), app_cron_runs: [] });
  const out = await executeAppCronJob(db, row as any, {
    env: ENV as any,
    doFetch: (async () => new Response(null, { status: 204 })) as any,
  });
  assert.equal(out.status, "success");
  assert.equal(out.responseStatus, 204);
  assert.equal(row.next_run_at, "2026-09-10T09:00:00.000Z", "the schedule is untouched");
  assert.equal(db.tables.app_cron_runs.length, 1);
});

test("a POST job sends its body and a GET job does not", async () => {
  const db = makeDb({ app_cron_jobs: [], apps: apps(), app_cron_runs: [] });
  const seen: any[] = [];
  const doFetch = (async (_url: any, init: any) => {
    seen.push(init);
    return new Response("", { status: 200 });
  }) as any;

  await executeAppCronJob(db, job({ method: "POST", body: '{"a":1}' }) as any, {
    env: ENV as any,
    doFetch,
  });
  await executeAppCronJob(db, job({ method: "GET", body: '{"a":1}' }) as any, {
    env: ENV as any,
    doFetch,
  });

  assert.equal(seen[0].body, '{"a":1}');
  assert.equal(seen[1].body, undefined, "undici will not send a body on GET");
});

// --- the tick's own bounds ---------------------------------------------------

test("a slow job occupies one lane, not the whole tick", async () => {
  // Sequentially this was 12 x 100ms; the pool has to overlap them.
  const rows = Array.from({ length: 12 }, (_, i) =>
    job({ id: `job-${i}`, next_run_at: "2026-09-10T09:00:00.000Z" }),
  );
  const db = makeDb({ app_cron_jobs: rows, apps: apps(), app_cron_runs: [] });
  let inFlight = 0;
  let peak = 0;
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    fetchImpl: (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return new Response("", { status: 200 });
    }) as any,
  });
  assert.equal(out.ran, 12);
  assert.ok(peak > 1, `expected overlapping requests, peak was ${peak}`);
});

test("the tick stops claiming when its own clock runs out", async () => {
  // What is left keeps its next_run_at, so the following tick takes it. The
  // alternative is ticks piling up on each other, which the compare-and-set
  // cannot fix — it prevents double execution, not overlap.
  const rows = Array.from({ length: 20 }, (_, i) =>
    job({ id: `job-${i}`, next_run_at: "2026-09-10T09:00:00.000Z" }),
  );
  const db = makeDb({ app_cron_jobs: rows, apps: apps(), app_cron_runs: [] });
  const out = await runDueAppCronJobs({
    client: db,
    env: ENV as any,
    now: new Date("2026-09-10T09:00:30.000Z"),
    maxTickMs: 40,
    fetchImpl: (async () => {
      await new Promise((r) => setTimeout(r, 25));
      return new Response("", { status: 200 });
    }) as any,
  });
  assert.equal(out.due, 20);
  assert.ok(out.ran < 20, `expected the deadline to cut it short, ran ${out.ran}`);
  const untouched = rows.filter((r) => r.next_run_at === "2026-09-10T09:00:00.000Z");
  assert.ok(untouched.length > 0, "unclaimed jobs must keep their schedule");
});

