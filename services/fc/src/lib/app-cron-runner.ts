import { computeNextRun } from "./app-cron-schedule.js";
import { appPublicUrl } from "./apps-public-host.js";

/**
 * The tick: claim every job that is due, send its request, record what happened.
 *
 * Driven from outside on a one-minute heartbeat — a compose sidecar on
 * self-host, a timer trigger on Alibaba FC — because neither target offers a
 * scheduler we could rely on from inside the request path: the container is
 * long-lived but restarts, and the function only exists while a request is in
 * flight. One endpoint with two callers keeps the behaviour identical on both.
 *
 * Nothing here is transactional. It does not need to be: the only state that
 * must not be applied twice is the claim, and that is a compare-and-set on
 * `next_run_at` (see the migration). Everything after the claim is a request
 * and a log row, and both are safe to lose.
 */

/** How many due jobs one tick will claim. */
const MAX_JOBS_PER_TICK = 50;
/**
 * How many of them it sends at once.
 *
 * Sequential execution made the bound above meaningless: 50 jobs against a hung
 * app, each with a 60s timeout, is fifty minutes in one request — while the
 * heartbeat that started it gave up after 55 seconds and the NEXT tick was
 * already running. Worse, one slow job at the head of `next_run_at asc` delayed
 * every other app's job on the box behind it.
 */
const TICK_CONCURRENCY = 8;
/**
 * The tick's own wall clock.
 *
 * Whatever is left when this runs out is simply not claimed this minute; its
 * `next_run_at` is untouched, so the following tick picks it up. Overrunning
 * would stack ticks on top of each other, which is the one thing the
 * compare-and-set cannot make safe — it stops double EXECUTION, not pile-up.
 */
const MAX_TICK_MS = 45_000;
/** Execution rows kept per job. Trimmed on write; there is no sweeper. */
const RUNS_KEPT_PER_JOB = 20;

export type CronRunStatus = "success" | "failed" | "timeout";

export interface AppCronTickOutcome {
  jobId: string;
  status: CronRunStatus;
  responseStatus: number | null;
  error: string | null;
}

export interface AppCronTickResult {
  due: number;
  ran: number;
  outcomes: AppCronTickOutcome[];
}

export interface JobRow {
  id: string;
  app_id: string;
  name: string;
  schedule_expr: string;
  timezone: string;
  method: string;
  path: string;
  headers: Record<string, unknown> | null;
  body: string | null;
  timeout_ms: number;
  next_run_at: string;
}

export const JOB_COLUMNS =
  "id, app_id, name, schedule_expr, timezone, method, path, headers, body, timeout_ms, next_run_at";

export interface AppCronDeps {
  /** Service-role Supabase client. Injected so tests need no database. */
  client: any;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  limit?: number;
  /** Wall-clock budget for the whole tick. Tests use it to hit the deadline. */
  maxTickMs?: number;
}

/**
 * A header map the app is allowed to be sent.
 *
 * Hop-by-hop headers and `host` are dropped rather than rejected: they are
 * meaningless on a request this process constructs, and letting `host` through
 * would let a job address a different app on the same gateway.
 */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
]);

export function sanitizeCronHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim().toLowerCase();
    if (!name || FORBIDDEN_HEADERS.has(name)) continue;
    // A header name with a control character or separator would be rejected by
    // undici anyway, and throwing there would abort the whole tick.
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (typeof value !== "string") continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Whether this response is the login wall turning the job away.
 *
 * Worth telling apart from any other redirect: an app's own `/` → `/home` is a
 * perfectly good outcome, while a bounce to the login service means the job can
 * never succeed as configured and the fix is one tab away.
 */
function loginWallRedirect(status: number, location: string | null, env: NodeJS.ProcessEnv): boolean {
  if (status < 300 || status >= 400 || !location) return false;
  const domain = env.LOGIN_DOMAIN?.trim();
  if (!domain) return false;
  try {
    return new URL(location).host.toLowerCase() === domain.toLowerCase();
  } catch {
    return false;
  }
}

const LOGIN_WALL_ERROR =
  "该路径需要登录，而定时任务没有会话。去「应用权限」把它设为公开，再用自定义 header 自己校验。";

export async function runDueAppCronJobs(deps: AppCronDeps): Promise<AppCronTickResult> {
  const db = deps.client;
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  const limit = Math.min(deps.limit ?? MAX_JOBS_PER_TICK, MAX_JOBS_PER_TICK);

  const { data, error } = await db
    .from("app_cron_jobs")
    .select(JOB_COLUMNS)
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const jobs: JobRow[] = data ?? [];
  const outcomes: AppCronTickOutcome[] = [];
  const deadline = Date.now() + (deps.maxTickMs ?? MAX_TICK_MS);

  // A fixed-size pool over a shared cursor: each worker takes the next job and
  // runs it, so a slow one occupies one lane instead of the whole tick.
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const job = jobs[cursor++];
      if (!job) return;
      const claimed = await claimJob(db, job, now);
      if (!claimed) continue; // Another tick took it. Not an error, not a run.
      outcomes.push(await executeJob(db, job, { env, doFetch }));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TICK_CONCURRENCY, jobs.length) }, () => worker()),
  );

  return { due: jobs.length, ran: outcomes.length, outcomes };
}

/**
 * Move the job's `next_run_at` forward, and only proceed if this process is the
 * one that moved it. The `eq("next_run_at", …)` is the whole concurrency story.
 */
async function claimJob(db: any, job: JobRow, now: Date): Promise<boolean> {
  let next: Date | null = null;
  let scheduleError: string | null = null;
  try {
    next = computeNextRun(job.schedule_expr, job.timezone, now);
  } catch (e) {
    // A stored expression that no longer parses (hand-edited row, or a field
    // this version stopped accepting). Park the job rather than retrying it
    // every minute forever; the null next_run_at reads as "never again" and the
    // failed run row says why.
    scheduleError = e instanceof Error ? e.message : String(e);
  }

  const { data, error } = await db
    .from("app_cron_jobs")
    .update({
      next_run_at: next ? next.toISOString() : null,
      last_run_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", job.id)
    .eq("next_run_at", job.next_run_at)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return false;

  if (scheduleError) {
    await recordRun(db, job, {
      startedAt: now,
      finishedAt: now,
      status: "failed",
      responseStatus: null,
      error: `schedule is not valid: ${scheduleError}`,
    });
    return false;
  }
  return true;
}

/**
 * Send one job's request and write its history row.
 *
 * Exported because "run it now" from the control panel is the same thing minus
 * the schedule: same URL construction, same login-wall detection, same record.
 * Sharing it is what keeps a manual run from succeeding in a way the scheduled
 * one would not.
 */
export async function executeAppCronJob(
  db: any,
  job: JobRow,
  ctx: { env?: NodeJS.ProcessEnv; doFetch?: typeof fetch },
): Promise<AppCronTickOutcome> {
  return executeJob(db, job, {
    env: ctx.env ?? process.env,
    doFetch: ctx.doFetch ?? fetch,
  });
}

async function executeJob(
  db: any,
  job: JobRow,
  ctx: { env: NodeJS.ProcessEnv; doFetch: typeof fetch },
): Promise<AppCronTickOutcome> {
  const startedAt = new Date();

  const { data: app, error } = await db
    .from("apps")
    .select("id, slug")
    .eq("id", job.app_id)
    .maybeSingle();
  if (error) throw error;

  const base = app ? appPublicUrl(app.slug, app.id, ctx.env) : null;
  if (!base) {
    return finish(db, job, {
      startedAt,
      finishedAt: new Date(),
      status: "failed",
      responseStatus: null,
      error: app
        ? "这个部署没有配置应用域名（APPS_PUBLIC_DOMAIN），定时任务没有可以请求的地址。"
        : "应用不存在",
    });
  }

  const url = `${base}${job.path.startsWith("/") ? job.path : `/${job.path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), job.timeout_ms);
  try {
    const method = job.method.toUpperCase();
    const res = await ctx.doFetch(url, {
      method,
      headers: sanitizeCronHeaders(job.headers),
      // A body on GET/HEAD is not a request undici will send, and asking for
      // one is a configuration mistake rather than something to fail on.
      body: method === "GET" || method === "HEAD" ? undefined : (job.body ?? undefined),
      // Manual, so the login wall's 302 is visible instead of being followed to
      // a login page that answers 200.
      redirect: "manual",
      signal: controller.signal,
    });

    const location = res.headers.get("location");
    if (loginWallRedirect(res.status, location, ctx.env)) {
      return finish(db, job, {
        startedAt,
        finishedAt: new Date(),
        status: "failed",
        responseStatus: res.status,
        error: LOGIN_WALL_ERROR,
      });
    }

    const ok = res.status >= 200 && res.status < 400;
    return finish(db, job, {
      startedAt,
      finishedAt: new Date(),
      status: ok ? "success" : "failed",
      responseStatus: res.status,
      error: ok ? null : `应用返回 ${res.status}`,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return finish(db, job, {
      startedAt,
      finishedAt: new Date(),
      status: aborted ? "timeout" : "failed",
      responseStatus: null,
      error: aborted
        ? `超过 ${job.timeout_ms}ms 没有响应`
        : e instanceof Error
          ? e.message
          : String(e),
    });
  } finally {
    clearTimeout(timer);
  }
}

interface RunRecord {
  startedAt: Date;
  finishedAt: Date;
  status: CronRunStatus;
  responseStatus: number | null;
  error: string | null;
}

async function finish(db: any, job: JobRow, record: RunRecord): Promise<AppCronTickOutcome> {
  await recordRun(db, job, record);
  return {
    jobId: job.id,
    status: record.status,
    responseStatus: record.responseStatus,
    error: record.error,
  };
}

async function recordRun(db: any, job: JobRow, record: RunRecord): Promise<void> {
  const { error } = await db.from("app_cron_runs").insert({
    job_id: job.id,
    app_id: job.app_id,
    started_at: record.startedAt.toISOString(),
    finished_at: record.finishedAt.toISOString(),
    status: record.status,
    response_status: record.responseStatus,
    duration_ms: record.finishedAt.getTime() - record.startedAt.getTime(),
    // Long stack traces and HTML error pages are not what a history row is
    // for, and an unbounded column is how one job's failure fills the table.
    error: record.error ? record.error.slice(0, 1000) : null,
  });
  if (error) throw error;
  await trimRuns(db, job.id);
}

/**
 * Keep the newest N rows for this job.
 *
 * A trim on write rather than a scheduled sweep: the sweep would need a
 * scheduler, and the only scheduler in this system is the thing being trimmed.
 * Failure is swallowed — a history row too many is not worth turning a
 * successful run into a failed tick.
 */
async function trimRuns(db: any, jobId: string): Promise<void> {
  try {
    const { data, error } = await db
      .from("app_cron_runs")
      .select("id")
      .eq("job_id", jobId)
      .order("started_at", { ascending: false })
      .range(RUNS_KEPT_PER_JOB, RUNS_KEPT_PER_JOB + 200);
    if (error || !data || data.length === 0) return;
    await db
      .from("app_cron_runs")
      .delete()
      .in("id", data.map((r: { id: string }) => r.id));
  } catch {
    // Retention is best effort.
  }
}
