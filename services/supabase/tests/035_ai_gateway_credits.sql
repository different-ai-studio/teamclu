-- Schema guards for the AI gateway credits ledger (20260828120000).
--
-- These assert the properties the billing design actually depends on, not the
-- shape of the DDL: getting any of them wrong produces wrong money, silently.
begin;

select plan(11);

-- The reservation path takes `select ... for update` on this row, so it has to
-- be one row per team.
select has_column('amux', 'team_credit_balance', 'balance_credits',
  'team wallet carries a materialised balance');

-- A refund issued after the credits were spent legitimately drives the balance
-- negative. A `check (balance_credits >= 0)` would roll that refund back, so it
-- must NOT exist -- spending is gated by `balance - reserved >= hold` instead.
-- See design §4.9.5. This is the assertion that stops someone "tidying up" by
-- adding the constraint that looks obviously missing.
select is_empty($$
  select conname from pg_constraint
   where conrelid = 'amux.team_credit_balance'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%balance_credits%>=%0%'
$$, 'balance has NO non-negative check (refunds must be able to go negative)');

-- Payment webhooks retry, and one purchase can arrive under two different
-- provider event ids. Without this unique index the same top-up credits twice.
select has_index('amux', 'credit_ledger', 'credit_ledger_idem_uniq',
  'ledger dedupes top-ups on (team_id, idempotency_key)');

-- Concurrent agent requests each reserve before calling upstream; summing held
-- rows is on every request's hot path.
select has_index('amux', 'credit_reservation', 'credit_reservation_held_idx',
  'held reservations are indexed for the per-request sum');
select has_index('amux', 'credit_reservation', 'credit_reservation_expiry_idx',
  'expired reservations can be swept without a full scan');

-- `period` is team-level. If it lived on member_credit_quota, members could run
-- on different periods and "used this period" would not be comparable across
-- the roster (design §4.5).
select has_column('amux', 'team_credit_settings', 'period',
  'settlement period is a TEAM-level setting');
select hasnt_column('amux', 'member_credit_quota', 'period',
  'period is NOT per-member');

-- Billing charges input+output at the tier price; cached_input_tokens is a
-- subset kept only for margin analysis. Both must exist for the usage report
-- and the cost report to be separable.
select has_column('amux', 'ai_usage_logs', 'cached_input_tokens',
  'usage log records the cache-hit subset for margin analysis');

-- Quota accrual scans this every request: team + actor + period window.
select has_index('amux', 'ai_usage_logs', 'ai_usage_logs_team_actor_created_idx',
  'usage log supports per-member period accrual');

-- The gateway is not service_role and never sets a request JWT, so it cannot
-- satisfy the RLS policies on amux.actors. Without this security-definer
-- function every legitimate member gets 403 -- which is exactly how it failed
-- the first time the e2e suite ran against the least-privilege role.
select has_function('amux', 'ai_gateway_resolve_actor', array['uuid','uuid'],
  'gateway can resolve membership past RLS on amux.actors');

-- Billing rows carry no RLS, so a grant to `authenticated` would let any
-- logged-in user read every team's spend.
select ok(
  not has_table_privilege('authenticated', 'amux.credit_ledger', 'SELECT'),
  'the authenticated role cannot read the credit ledger directly'
);

select * from finish();
rollback;
