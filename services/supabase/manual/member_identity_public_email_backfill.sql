-- ============================================================================
-- member_identity_public_email — backfill public.users.email for member identities
--
-- Pairs with services/supabase/migrations/20261009010000_member_identity_public_email.sql,
-- which writes the email for NEW member identities. This fills staff-grade rows
-- minted before that. Run member_identity_public_email_precheck.sql FIRST; the
-- candidate rule below is the same, so its list is exactly what changes here.
--
--     psql "$TARGET_URL" -v ON_ERROR_STOP=1 -1 \
--       -f services/supabase/manual/member_identity_public_email_backfill.sql
--
-- Idempotent: only rows whose email is still '' are touched. admin_type 1 rows
-- and phone users are left alone. Connect as a role allowed to UPDATE
-- public.users (prevent_admin_type_change only concerns admin_type).
-- ============================================================================

update public.users u
   set email = c.new_email
  from (
    select u2.id, coalesce(l.email, lower(btrim(au.email))) as new_email
      from public.users u2
      left join public.email_users_links l on l.user_id = u2.id
      left join auth.users au on au.id = u2.id
     where u2.admin_type >= 2
       and u2.email = ''
       and (l.email is not null
            or (coalesce(btrim(au.email), '') <> ''
                and split_part(lower(au.email), '@', 2) not in ('teamclu.email', 'teamclu.mobile', 'amuxd.run')))
  ) c
 where c.id = u.id
   and u.email = '';
