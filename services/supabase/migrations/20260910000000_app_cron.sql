-- Cloud-side scheduled tasks for a deployed app.
--
-- Design: docs/specs/2026-09-10-app-control-panel-design.md §5
--
-- Distinct from the desktop's cron (apps/desktop/src/commands/cron/), which
-- schedules AGENT turns against a workspace directory and therefore needs the
-- machine to be awake. These run in the cloud and do exactly one thing: at the
-- scheduled minute, send one HTTP request to the app's own public URL.
--
-- `next_run_at` is both the schedule and the lock. Claiming a due job is
-- `update ... where id = $1 and next_run_at = $2` with the value that was read,
-- so two ticks racing on the same job leave exactly one of them with a row
-- affected. PostgREST cannot open an explicit transaction, so `for update skip
-- locked` is not available here — and a compare-and-set on a column that has to
-- be written anyway costs nothing extra.

create table if not exists amux.app_cron_jobs (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references amux.apps(id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  -- Five fields: minute hour day-of-month month day-of-week. Parsed in FC
  -- (services/fc/src/lib/app-cron-schedule.ts), not by Postgres — pg_cron is
  -- not installed on either deploy target and this must run on both.
  schedule_expr text not null,
  -- IANA name. DST is handled by matching the expression against the LOCAL
  -- wall clock of each candidate instant, which has two accepted consequences:
  -- a time inside the spring-forward gap never matches (skipped that day), and
  -- a time inside the autumn overlap matches twice (runs twice that day).
  timezone text not null default 'UTC',
  method text not null default 'GET',
  -- Path only. The host is derived from the app row at fire time, so an app
  -- that is renamed or re-slugged keeps working and a job can never be pointed
  -- at somebody else's origin.
  path text not null default '/',
  headers jsonb not null default '{}'::jsonb,
  body text,
  timeout_ms integer not null default 30000,
  last_run_at timestamptz,
  -- NULL means "never again": either the job is disabled, or the expression is
  -- one no instant satisfies (Feb 30). Both are ordinary states, not errors.
  next_run_at timestamptz,
  created_by_member_id uuid references amux.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_cron_jobs_name_check
    check (char_length(name) between 1 and 120),
  constraint app_cron_jobs_method_check
    check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD')),
  constraint app_cron_jobs_path_check
    check (path like '/%' and char_length(path) <= 512),
  constraint app_cron_jobs_headers_is_object
    check (jsonb_typeof(headers) = 'object'),
  -- Floor and ceiling both matter: under a second is a busy loop against the
  -- app, over a minute holds the tick open past its own interval.
  constraint app_cron_jobs_timeout_check
    check (timeout_ms between 1000 and 60000)
);

-- The tick's only query: due, enabled, oldest first. Partial on `enabled` so a
-- disabled job costs nothing to skip.
create index if not exists app_cron_jobs_due_idx
  on amux.app_cron_jobs (next_run_at)
  where enabled;

create index if not exists app_cron_jobs_app_idx
  on amux.app_cron_jobs (app_id, created_at);

create table if not exists amux.app_cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references amux.app_cron_jobs(id) on delete cascade,
  -- Denormalised from the job so the retention trim and the per-app listing
  -- never have to join, and so a run row survives long enough to be read even
  -- while its job is being deleted.
  app_id uuid not null references amux.apps(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  response_status integer,
  duration_ms integer,
  error text,
  constraint app_cron_runs_status_check
    check (status in ('success', 'failed', 'timeout'))
);

create index if not exists app_cron_runs_job_idx
  on amux.app_cron_runs (job_id, started_at desc);

comment on table amux.app_cron_jobs is
  'Cloud-scheduled HTTP requests against a deployed app. Fired by POST /v1/internal/app-cron/tick, which every deploy target drives on a one-minute heartbeat. next_run_at is the schedule AND the claim: a due job is taken with a compare-and-set on the value that was read.';

comment on column amux.app_cron_jobs.next_run_at is
  'When this job fires next, in UTC. NULL means never again (disabled, or an expression no instant satisfies). Written by the tick as part of claiming the job, so it doubles as the concurrency guard.';

comment on column amux.app_cron_jobs.headers is
  'Extra request headers, as a flat JSON object. This is where a job carries its OWN shared secret: a scheduled request has no session, so a path behind the login wall bounces to the login page — the supported answer is to make that path public and check a header here.';

comment on table amux.app_cron_runs is
  'Execution history, trimmed to the newest 20 rows per job on insert. Retention is a trim rather than a TTL sweep because there is no scheduled DB job on either deploy target to run a sweep with.';

-- ---------------------------------------------------------------------------
-- RLS. Same split app_member_access uses: the policies are creator-only for
-- writes, and an `admin` grantee's writes go through the service role after
-- the repository has checked the permission level. Reads are open to anyone
-- the app has named, so a `view` member can see the schedule without the
-- repository escalating.
-- ---------------------------------------------------------------------------

alter table amux.app_cron_jobs enable row level security;
alter table amux.app_cron_runs enable row level security;

drop policy if exists app_cron_jobs_select on amux.app_cron_jobs;
create policy app_cron_jobs_select on amux.app_cron_jobs
for select to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_cron_jobs.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
  or exists (
    select 1
      from amux.app_member_access ama
     where ama.app_id = app_cron_jobs.app_id
       and ama.member_id = amux.current_member_id()
  )
);

drop policy if exists app_cron_jobs_manage on amux.app_cron_jobs;
create policy app_cron_jobs_manage on amux.app_cron_jobs
for all to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_cron_jobs.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
) with check (
  exists (
    select 1
      from amux.apps a
     where a.id = app_cron_jobs.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
);

drop policy if exists app_cron_runs_select on amux.app_cron_runs;
create policy app_cron_runs_select on amux.app_cron_runs
for select to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_cron_runs.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
  or exists (
    select 1
      from amux.app_member_access ama
     where ama.app_id = app_cron_runs.app_id
       and ama.member_id = amux.current_member_id()
  )
);

-- Run rows are written by the tick only, which holds the service role. No
-- INSERT/UPDATE/DELETE policy for `authenticated` on purpose: a person editing
-- their own execution history has no use case, and the absence of a policy is
-- a denial.

-- ---------------------------------------------------------------------------
-- PostgREST needs table privileges before RLS is consulted; tables created
-- directly in amux inherit none.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on amux.app_cron_jobs to authenticated;
grant select on amux.app_cron_runs to authenticated;
grant all on amux.app_cron_jobs to service_role;
grant all on amux.app_cron_runs to service_role;

-- ---------------------------------------------------------------------------
-- Per-path audience (design §4). No schema change: auth_rules is jsonb and the
-- key is optional. Only the documentation of what a rule may hold changes.
--
-- The default for a rule WITHOUT the key is the app-level auth_audience, not
-- 'org'. Reading a missing key as 'org' would tighten the wall on every app
-- that is set to "any signed-in user" today — a UI change silently altering a
-- live access boundary, in the direction hardest to notice.
-- ---------------------------------------------------------------------------
comment on column amux.apps.auth_rules is
  'Exceptions to auth_scope, as [{"path","auth","audience"}] with auth in (required, public) and audience in (any, org). Longest matching path PREFIX wins; matching is case-insensitive. `audience` is optional and only meaningful with auth=required — absent means "inherit the app-level auth_audience", never a hard-coded default. Only read when auth_mode = ''platform''.';

notify pgrst, 'reload schema';
