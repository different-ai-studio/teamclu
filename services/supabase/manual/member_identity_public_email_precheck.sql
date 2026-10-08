-- ============================================================================
-- member_identity_public_email — pre-check before the backfill (read-only)
--
-- Run BEFORE member_identity_public_email_backfill.sql. Nothing here writes.
--
--     psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f \
--       services/supabase/manual/member_identity_public_email_precheck.sql
--
-- Candidates are the rows the backfill would fill: staff-grade (admin_type >= 2)
-- public.users rows whose email is '' and for which a person email is known —
--   * link: public.email_users_links (written only by TeamClu), else
--   * auth: the account with the row's own id signs in with a real email (not
--     <id>@teamclu.email / <phone>@teamclu.mobile / an agent's
--     daemon.<id>@amuxd.run — agents are agent_account_public_email_*.sql).
-- admin_type 1 rows (customers, membership cards) are saas-mono's and are
-- never touched. Phone users have no email and stay blank.
--
-- What to look at: the per-org list. A row the partner created and left blank
-- on purpose would show up under source `auth`; check those with the partner.
-- ============================================================================

create temp table _member_email_candidates as
select u.id, u.org_id, u.admin_type, u.mobile,
       coalesce(l.email, lower(btrim(au.email))) as new_email,
       case when l.email is not null then 'link' else 'auth' end as source
  from public.users u
  left join public.email_users_links l on l.user_id = u.id
  left join auth.users au on au.id = u.id
 where u.admin_type >= 2
   and u.email = ''
   and (l.email is not null
        or (coalesce(btrim(au.email), '') <> ''
            and split_part(lower(au.email), '@', 2) not in ('teamclu.email', 'teamclu.mobile', 'amuxd.run')));

\echo '== 1) rows the backfill will touch, by source and admin_type'
select source, admin_type, count(*) from _member_email_candidates group by 1, 2 order by 1, 2;

\echo '== 2) per row'
select (select o.name from public.orgs o where o.id = c.org_id) as org_name,
       c.id, c.admin_type, c.mobile, c.source, c.new_email
  from _member_email_candidates c
 order by org_name, c.source, c.new_email;
