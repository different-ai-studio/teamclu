-- Two gaps in 20260828120000_ai_gateway_credits.sql that only showed up when
-- the operator jobs were written against the least-privilege role.
--
-- Both failed SILENTLY rather than loudly, which is why they get their own
-- migration and their own tests rather than a quiet edit:
--   * the signup-grant backfill enumerated zero teams and reported success
--   * the retention job could not delete and returned zero rows pruned

-- ── 1. enumerating teams past RLS ───────────────────────────────────────────
-- amux.teams carries RLS, and the gateway is neither service_role nor a
-- JWT-bearing connection, so `select ... from amux.teams` returns nothing for
-- it. The backfill is the gate on enabling enforcement (design §4.8.1): a
-- version of it that grants nothing and exits 0 is worse than one that errors,
-- because the next step is flipping enforcement on.
--
-- Same shape as ai_gateway_resolve_actor: security definer, pinned search_path,
-- revoked from everyone, granted to the roles that need it. Narrower than
-- BYPASSRLS, which would open every table.
--
-- Returns only teams with no signup grant yet, so the caller cannot use it as a
-- general "list every team" bypass.
create or replace function amux.ai_gateway_teams_missing_signup_grant()
returns table (team_id uuid)
language sql
stable
security definer
set search_path = amux, public
as $$
  select t.id
    from amux.teams t
   where not exists (
     select 1 from amux.credit_ledger l
      where l.team_id = t.id
        and l.idempotency_key = 'signup_grant:' || t.id::text
   )
$$;

comment on function amux.ai_gateway_teams_missing_signup_grant() is
  'Teams that have never received their signup grant. Scoped deliberately: not a general team listing.';

revoke all on function amux.ai_gateway_teams_missing_signup_grant() from public, anon, authenticated;
grant execute on function amux.ai_gateway_teams_missing_signup_grant() to ai_gateway, service_role;

-- ── 2. retention ────────────────────────────────────────────────────────────
-- ai_usage_logs is append-only in the request path, which is why the original
-- grant was select+insert. Enforcing the 13-month retention window is also the
-- gateway's job, and that needs delete.
grant delete on amux.ai_usage_logs to ai_gateway;
