-- ============================================================================
-- agent_account_public_email — backfill public.users.email for agent accounts
--
-- Pairs with services/supabase/migrations/20261009000000_agent_account_public_email.sql,
-- which writes the email for NEW agent rows (and fills a blank one on credential
-- rotation). This fills the rows minted before that, which are never rotated.
--
-- Run agent_account_public_email_precheck.sql FIRST and go through its second
-- result set with the partner: the staff-grade agents (belayo: 4 of 116) are
-- already in saas-mono's staff list; this only gives them an email.
--
--     psql "$TARGET_URL" -v ON_ERROR_STOP=1 -1 \
--       -f services/supabase/manual/agent_account_public_email_backfill.sql
--
-- Idempotent: only rows whose email is still '' are touched; an email someone
-- set is left alone. Connect as a role allowed to UPDATE public.users (the
-- partner deployment's prevent_admin_type_change guard only concerns
-- admin_type, which this does not touch).
-- ============================================================================

update public.users u
   set email = au.email
  from auth.users au
 where au.id = u.id
   and au.email like 'daemon.%@amuxd.run'
   and u.email = '';

-- What is left blank afterwards (expect 0 rows).
select u.id, u.org_id, u.admin_type
  from public.users u
  join auth.users au on au.id = u.id
 where au.email like 'daemon.%@amuxd.run'
   and u.email = '';
