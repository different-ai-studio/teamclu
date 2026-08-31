-- Credits ledger for the team AI gateway (services/ai-gateway).
--
-- Replaces LiteLLM's USD `max_budget` with a prepaid credits wallet: a team has
-- a BALANCE, a member has a per-period QUOTA, and every request writes a usage
-- row. See docs/specs/2026-08-28-team-ai-gateway-design.md §5.
--
-- Why these tables live in `amux` and not in their own database (which is what
-- LiteLLM needed): the gateway resolves membership with
--   select id from amux.actors where team_id = $1 and user_id = $2
-- on every request, and FC joins teams/actors for the billing screen. Both are
-- impossible across databases. LiteLLM needed isolation because prisma owned
-- ~20 generically-named tables; four purpose-named tables do not.
--
-- Phase 0/1 only WRITE ai_usage_logs (metering, no enforcement). The balance /
-- reservation / quota machinery goes live in Phase 2, after existing teams are
-- back-filled with a starting grant — turning enforcement on before that would
-- 402 every team at once (§4.8.1).

-- ── team wallet ─────────────────────────────────────────────────────────────
-- Balance is materialised rather than summed from the ledger on demand: the
-- reservation path takes `select ... for update` on this row (§4.6), which an
-- aggregate cannot do, and the ledger is append-only so the sum gets slower
-- forever. Invariant `balance = sum(ledger)` is checked by a daily job.
--
-- Deliberately NO `check (balance_credits >= 0)`: a refund after the credits
-- were spent legitimately drives the balance negative (§4.9.5), and that check
-- would roll the refund back. Spending is gated by `balance - reserved >= hold`
-- in the reservation path, which already refuses at zero. The safety net that
-- the check would have provided is the daily negative-balance alert instead.
create table if not exists amux.team_credit_balance (
  team_id         uuid primary key references amux.teams(id) on delete cascade,
  balance_credits bigint      not null default 0,
  updated_at      timestamptz not null default now()
);

-- ── append-only ledger ──────────────────────────────────────────────────────
create table if not exists amux.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references amux.teams(id) on delete cascade,
  -- Usage rows attribute to an actor; top-ups and grants do not.
  actor_id        uuid references amux.actors(id) on delete set null,
  kind            text not null
                  check (kind in ('top_up','grant','adjustment','usage','refund')),
  amount_credits  bigint not null,          -- signed: usage is negative
  -- Dedupe key. Payment webhooks retry and can deliver the same purchase under
  -- two different event ids, so this keys on the PURCHASE (checkout session),
  -- not the event — see §4.9.4. Signup grants use 'signup_grant:<team_id>'.
  idempotency_key text,
  usage_log_id    uuid,                     -- set when kind = 'usage'
  note            text,
  created_at      timestamptz not null default now()
);
create unique index if not exists credit_ledger_idem_uniq
  on amux.credit_ledger (team_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists credit_ledger_team_created_idx
  on amux.credit_ledger (team_id, created_at desc);

-- ── in-flight reservations ──────────────────────────────────────────────────
-- Without these, N concurrent requests all read a healthy balance and each
-- spends it. Agent traffic is concurrent by nature (parallel tool calls), so
-- this is the common case, not an edge case (§4.6).
create table if not exists amux.credit_reservation (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid not null references amux.teams(id) on delete cascade,
  actor_id       uuid not null references amux.actors(id) on delete cascade,
  amount_credits bigint not null check (amount_credits >= 0),
  state          text   not null default 'held'
                 check (state in ('held','settled','expired')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);
-- Summing held rows is on every request's hot path; both indexes are partial so
-- they stay small as settled rows accumulate.
create index if not exists credit_reservation_held_idx
  on amux.credit_reservation (team_id, actor_id) where state = 'held';
create index if not exists credit_reservation_expiry_idx
  on amux.credit_reservation (expires_at) where state = 'held';

-- ── team-level limit settings ───────────────────────────────────────────────
-- `period` is TEAM-level, not per-member: if members ran on different periods
-- the "used this period" column would not be comparable across the roster and
-- the report would not add up (§4.5).
create table if not exists amux.team_credit_settings (
  team_id               uuid primary key references amux.teams(id) on delete cascade,
  period                text not null default 'month' check (period in ('week','month')),
  default_limit_credits bigint check (default_limit_credits is null or default_limit_credits >= 0),
  low_balance_credits   bigint,   -- alert threshold; null = no alert
  updated_at            timestamptz not null default now()
);

-- ── per-member limit ────────────────────────────────────────────────────────
-- null limit_credits = unlimited, constrained only by the team balance.
-- An `agent` actor with no row here skips the quota check entirely: cron and
-- unattended agents must not stall waiting for someone to raise a limit
-- (§6.2.2).
create table if not exists amux.member_credit_quota (
  team_id       uuid not null references amux.teams(id) on delete cascade,
  actor_id      uuid not null references amux.actors(id) on delete cascade,
  limit_credits bigint check (limit_credits is null or limit_credits >= 0),
  updated_at    timestamptz not null default now(),
  primary key (team_id, actor_id)
);

-- ── per-request usage ───────────────────────────────────────────────────────
create table if not exists amux.ai_usage_logs (
  id                  uuid primary key default gen_random_uuid(),
  team_id             uuid not null references amux.teams(id) on delete cascade,
  actor_id            uuid references amux.actors(id) on delete set null,
  public_model_id     text not null,   -- the tier the client asked for; BILLING basis
  backend_model_id    text not null,   -- where it actually landed; COST basis only
  provider_id         text not null,
  -- Billing uses input + output against the tier price (§4.4). cached_input_tokens
  -- is the subset of input_tokens that hit the upstream prompt cache and is NOT
  -- billed separately — it is kept purely for margin analysis. Measured 99.4%
  -- hit rate on a repeated prefix, at roughly 1/30 the cost of a miss, so this
  -- column is the early warning when upstream cost moves.
  input_tokens        bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  output_tokens       bigint not null default 0,
  credits             bigint not null default 0,
  -- 'upstream' = the provider returned usage; 'estimated' = charged against the
  -- max_tokens ceiling because it did not. DeepSeek returns usage unconditionally,
  -- so 'estimated' should only appear when an upstream misbehaves.
  usage_source        text not null default 'upstream'
                      check (usage_source in ('upstream','estimated')),
  status_code         int,
  stream              boolean not null default false,
  latency_ms          int,
  request_id          text,
  created_at          timestamptz not null default now()
);
-- Quota accrual: where team_id = ? and actor_id = ? and created_at >= period start.
create index if not exists ai_usage_logs_team_actor_created_idx
  on amux.ai_usage_logs (team_id, actor_id, created_at desc);
create index if not exists ai_usage_logs_team_created_idx
  on amux.ai_usage_logs (team_id, created_at desc);

-- ── gateway role ────────────────────────────────────────────────────────────
-- Created NOLOGIN and without a password: secrets never live in this repo. The
-- operator grants login out of band, e.g.
--   alter role ai_gateway login password '…';
-- The gateway gets exactly these tables plus read-only access to the three it
-- needs for authorization and config. It does NOT reuse FC's connection.
--
-- No RLS on these tables: the gateway does its own authorization and never
-- forwards an end-user JWT to PostgREST, so RLS has no attachment point here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_gateway') then
    create role ai_gateway nologin;
  end if;
end
$$;

grant usage on schema amux to ai_gateway;
grant select, insert, update on
  amux.team_credit_balance, amux.credit_reservation to ai_gateway;
grant select, insert on
  amux.credit_ledger, amux.ai_usage_logs to ai_gateway;
grant select on
  amux.member_credit_quota, amux.team_credit_settings,
  amux.actors, amux.teams, amux.team_workspace_config to ai_gateway;

-- FC reads the balance/ledger for the billing screen and writes quota settings,
-- and it connects as service_role like every other amux table (see the grants
-- on team_skills / marketplace_skills).
grant select, insert, update, delete on
  amux.team_credit_balance, amux.credit_ledger, amux.credit_reservation,
  amux.team_credit_settings, amux.member_credit_quota, amux.ai_usage_logs
  to service_role;

-- DELIBERATELY no grant to `authenticated` / `anon`. These tables carry no RLS
-- (the gateway authorizes in application code and never forwards an end-user
-- JWT to PostgREST), so exposing them to the authenticated role would let any
-- logged-in user read every team's spend. Billing data reaches clients only
-- through FC.

-- ── membership lookup ───────────────────────────────────────────────────────
-- amux.actors carries RLS, and the gateway is not service_role, so a plain
-- select returns zero rows and every legitimate member gets 403. The gateway
-- cannot satisfy those policies either: it authorizes in application code and
-- never sets a request JWT on the connection.
--
-- Same shape as amux.amuxc_team_live_bytes: security definer, pinned
-- search_path, revoked from everyone, granted to exactly the roles that need
-- it. Narrower than granting the role BYPASSRLS, which would open every table.
--
-- Returning actor_type matters: an `agent` actor with no explicit quota row
-- skips the quota check entirely, because cron and unattended agents must not
-- stall waiting for someone to raise a limit (design §6.2.2).
create or replace function amux.ai_gateway_resolve_actor(p_team_id uuid, p_user_id uuid)
returns table (id uuid, actor_type text)
language sql
stable
security definer
set search_path = amux, public
as $$
  select a.id, a.actor_type
    from amux.actors a
   where a.team_id = p_team_id
     and a.user_id = p_user_id
   limit 1
$$;

comment on function amux.ai_gateway_resolve_actor(uuid, uuid) is
  'Resolves a caller to their actor within one team. Proves membership at the same time: the :teamId in a gateway request path is untrusted.';

revoke all on function amux.ai_gateway_resolve_actor(uuid, uuid) from public, anon, authenticated;
grant execute on function amux.ai_gateway_resolve_actor(uuid, uuid) to ai_gateway, service_role;
