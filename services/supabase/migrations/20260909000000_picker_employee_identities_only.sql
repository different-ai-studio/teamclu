-- The picker's cross-tenant phone key answers two different questions, and only
-- one of them may be answered phone-wide.
--
-- 20260801060000_phone_linked_org_team_picker.sql stated the rule as "the
-- current employee user's mobile is the cross-tenant key for all employee
-- identities" and then matched on the mobile alone, using that one set both to
-- find the caller's memberships AND to decide which orgs are theirs. On a
-- deployment that shares `public.users` with the partner SaaS, that table is the
-- CUSTOMER register (599k rows at admin_type = 1 on the live box, alongside
-- height / birthday / membership-card columns), so "same mobile" resolves to
-- every gym the person has ever bought a membership at — not to the tenants
-- they work for.
--
-- What that produced: someone who is staff at three orgs saw eight, the five
-- extras being gyms they hold a membership card at. Every extra org contributed
-- its org-named default team — public since #959 — rendered as a joinable row
-- carrying that tenant's team name, member count and owner's real name.
-- Clicking one is a dead end (join_public_team's org guard from CS-4 rejects
-- it), so this is disclosure rather than an access path; but what it discloses
-- is one tenant's roster metadata to another tenant. On the live deployment 50
-- of the 54 phone-carrying users saw at least one org that was not theirs, and
-- the worst case saw 20 where 6 were real.
--
-- So split the two questions:
--
--   related_users  — WHO AM I. Stays phone-wide, and must: a phone sign-up
--                    mints its `public.users` row in DEFAULT_ORG at the default
--                    admin_type 1, and the teams that identity created are held
--                    by exactly that customer-grade row. Narrowing this set is
--                    what an earlier draft of this migration did, and it drops
--                    five live memberships — e.g. a person signed in through
--                    their 香蕉攀岩 staff account loses the teams their own
--                    phone-signup identity owns. It also stays consistent with
--                    switch_active_team, which accepts any same-phone actor.
--
--   employee_orgs  — WHOSE TENANT AM I IN. Employee identities only, resolved
--                    the way the partner SaaS resolves them in its own account
--                    picker (apps/api/src/routes/api/admin/auth/admin-accounts.ts):
--
--                        .eq('mobile', mobile)
--                        .in('admin_type', [ADMIN, SUPER_ADMIN, SYSTEM_ADMIN])
--                        .is('deleted_at', null)
--
--                    `admin_type >= 2` is the employee test — offboarding resets
--                    it to 1 (NORMAL), which is why leaving a company also drops
--                    its teams from the picker.
--
-- Only `public_teams` and `empty_orgs` read the org set, so this narrows exactly
-- the is_member = false rows — the ones that were leaking — and leaves every
-- actual membership alone. The caller's own org stays in the set unconditionally,
-- as it is today: a phone sign-up landing in DEFAULT_ORG still sees that org's
-- public default team, which is a separate question from this one.
--
-- Everything else is carried forward verbatim from
-- 20260817010000_picker_disambiguation_fields.sql. The signature and return
-- type are unchanged, so CREATE OR REPLACE keeps the grants this time.

-- `deleted_at` is on the partner's table but not on the subset mirror the
-- self-host baseline creates, and the predicate below has to resolve on both.
--
-- Guarded by a lookup rather than written as ADD COLUMN IF NOT EXISTS, because
-- that form still demands ownership of the table before it notices there is
-- nothing to do: as the self-host `migrate` service's role, `alter table
-- public.users add column if not exists deleted_at` fails with "must be owner of
-- table users" on a database where the column is already there. Where the column
-- exists — every deployment sharing the partner's table — this issues no DDL at
-- all and needs no privilege on it.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'users' and column_name = 'deleted_at'
  ) then
    alter table public.users add column deleted_at timestamptz;
  end if;
end $$;

create or replace function amux.list_teams_for_picker(
  p_default_org_id uuid default null,
  p_include_empty_orgs boolean default false
)
returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text,
              visibility text, is_member boolean, item_type text,
              created_at timestamptz, member_count integer, owner_name text)
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  with current_identity as (
    select u.id, nullif(btrim(u.mobile), '') as mobile
      from public.users u
     where u.id = auth.uid()
     limit 1
  ), related_users as (
    -- WHO AM I: every identity this person signs in as. Phone-wide on purpose —
    -- see the header. Retain the caller even when a legacy record has no phone.
    select auth.uid() as id
     where auth.uid() is not null
    union
    select u.id
      from public.users u
      join current_identity c on c.mobile is not null and u.mobile = c.mobile
  ), employee_orgs as (
    -- WHOSE TENANT AM I IN: the caller's own org, plus the orgs they hold an
    -- EMPLOYEE record in. A customer record sharing the phone does not count.
    select u.org_id
      from public.users u
     where u.id = auth.uid()
       and u.org_id is not null
    union
    select u.org_id
      from public.users u
      join current_identity c on c.mobile is not null and u.mobile = c.mobile
     where u.admin_type >= 2
       and u.deleted_at is null
       and u.org_id is not null
  ), member_teams as (
    -- No org filter: an actor in the team is the membership.
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member, 'team'::text as item_type,
           t.created_at
      from amux.teams t
     where exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), public_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member, 'team'::text as item_type,
           t.created_at
      from amux.teams t
     where t.oid in (select org_id from employee_orgs)
       and t.visibility = 'public'
       and not exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), empty_orgs as (
    select null::uuid as id, null::text as name, null::text as slug, o.id as oid,
           'private'::text as visibility, true as is_member, 'org'::text as item_type,
           null::timestamptz as created_at
      from public.orgs o
      join employee_orgs eo on eo.org_id = o.id
     where p_include_empty_orgs
       and not exists (select 1 from amux.teams t where t.oid = o.id)
  )
  select * from (
    select t.id as team_id, t.name as team_name, t.slug as team_slug, t.oid as org_id,
           o.name as org_name, t.visibility, t.is_member, t.item_type,
           t.created_at,
           -- Counted here rather than client-side: the picker runs before the
           -- caller has switched into the team, so a per-team member listing
           -- would be blocked by RLS for exactly the rows worth disambiguating.
           -- This function is SECURITY DEFINER, so the count is accurate even
           -- for a public team the caller has not joined.
           (select count(*)::int
              from amux.actors a
             where a.team_id = t.id and a.actor_type = 'member') as member_count,
           (select a.display_name
              from amux.team_members tm
              join amux.actors a on a.id = tm.member_id
             where tm.team_id = t.id and tm.role = 'owner'
             order by a.created_at asc, a.id asc
             limit 1) as owner_name
      from (
        select * from member_teams
        union all
        select * from public_teams
      ) t
      join public.orgs o on o.id = t.oid
    union all
    select e.id, e.name, e.slug, e.oid, o.name, e.visibility, e.is_member, e.item_type,
           e.created_at, null::int, null::text
      from empty_orgs e
      join public.orgs o on o.id = e.oid
  ) picker_items
  order by org_name nulls last, item_type, team_name, created_at nulls last, team_id;
$function$;

comment on function amux.list_teams_for_picker(uuid, boolean) is
  'Cross-org team picker source: teams the caller holds an actor in, plus public teams they could join in their own org and the orgs they hold an EMPLOYEE record in. Membership is resolved phone-wide (any same-phone identity''s actor counts, as in switch_active_team); the ORG set is not, and follows the partner SaaS rule — same mobile, admin_type >= 2, not soft-deleted — so a customer record sharing the caller''s phone number does not pull its tenant into the picker. Also returns created_at / member_count / owner_name so the client can disambiguate teams that share a name (an org''s teams are all named after the org).';
