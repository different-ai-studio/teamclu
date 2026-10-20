-- One person, one identity per org — and TeamClu acts only as staff.
--
-- docs/plans/2026-10-08-staff-only-identity-model.md (T1, T2, T7).
--
-- Where `public.users` is the partner's membership register (belayo), an
-- admin_type 1 row in a tenant org is a gym card, not a TeamClu account.
-- TeamClu now acts only as identities with admin_type >= 2: a partner employee
-- record, a tenant creator (3) or an invited member (2). Each identity has its
-- own auth account, because saas-mono resolves people by
-- `public.users.id = auth uid`.
--
-- What ties one person's identities together:
--   * phone users — the shared `mobile`, as before;
--   * email users — public.email_users_links (email → user_id), new here. The
--     first identity of an email user is the account they sign in with; later
--     ones sit on synthetic `<id>@teamclu.email` accounts and are reachable only
--     through this table.
--
-- switch_active_team / list_teams_for_picker resolve "this person" through
-- amux.person_identities(), and when amux.staff_only() is on keep only
-- identities amux.is_teamclu_identity() accepts — the caller's own included, so
-- a card session from before the switch loses its teams and has to sign in
-- again as staff.
--
-- Staff-only is a DATABASE setting (amux.deployment_settings, key
-- 'staff_only'), not an RPC argument: the Supabase gateway is publicly
-- reachable, and a rule a caller can opt out of by omitting a parameter is no
-- rule — least of all the invite rule built on it (20261008020000), where
-- opting out would mint back-office accounts. FC reads the same setting for
-- phone login. Off unless an operator sets it, and it stays off until existing
-- admin_type 1 identities are migrated (T11): on self-host claim_team_invite
-- moved invited phone sign-ups into the team's org at admin_type 1.
--
-- Both functions keep their signatures (CREATE OR REPLACE, grants untouched).

-- ── Email identity links ───────────────────────────────────────────────────
create table if not exists public.email_users_links (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and email <> ''),
  user_id uuid not null unique references public.users(id) on delete cascade,
  org_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists email_users_links_email_idx on public.email_users_links (email);

comment on table public.email_users_links is
  'TeamClu: which identities (public.users rows) belong to the person who signs in with this email. One row per identity; the person is the email. Phone users need no row — their identities share `mobile`. Written only by TeamClu SECURITY DEFINER functions.';

-- Exposed schema: no policy at all, so only SECURITY DEFINER code and
-- service_role reach it.
alter table public.email_users_links enable row level security;
revoke all on public.email_users_links from anon, authenticated;

-- ── Deployment setting ─────────────────────────────────────────────────────
create table if not exists amux.deployment_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table amux.deployment_settings is
  'Per-deployment switches an operator sets by hand (service_role / owner). Not reachable from client roles. Keys: staff_only (boolean) — see 20261008000000_staff_only_team_identities.sql.';
alter table amux.deployment_settings enable row level security;
revoke all on amux.deployment_settings from anon, authenticated;

create or replace function amux.staff_only()
returns boolean
language sql
stable security definer
set search_path to 'amux'
as $function$
  select coalesce((select (value)::text::boolean from amux.deployment_settings where key = 'staff_only'), false);
$function$;

comment on function amux.staff_only() is
  'TeamClu acts only as admin_type >= 2 identities (login, team switch, picker, member invites). Set per deployment: insert into amux.deployment_settings values (''staff_only'', ''true'').';

grant execute on function amux.staff_only() to authenticated, service_role;

-- ── Who TeamClu may act as ─────────────────────────────────────────────────

create or replace function amux.is_teamclu_identity(p_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  -- A live identity with admin_type >= 2. An auth account with no
  -- public.users row at all (a fresh sign-up before it creates a tenant) is not
  -- a card, so it passes; it holds no actor anyway.
  select coalesce(
    (select u.deleted_at is null and u.admin_type >= 2
       from public.users u
      where u.id = p_user_id),
    true
  );
$function$;

comment on function amux.is_teamclu_identity(uuid) is
  'Staff-only rule (amux.staff_only()): may TeamClu act as this identity? True for a live row with admin_type >= 2 and for an account with no public.users row; false for a partner membership card. Keep in step with isTeamCluIdentity in services/fc/src/lib/supabase-repo/phone-auth.ts.';

grant execute on function amux.is_teamclu_identity(uuid) to authenticated, service_role;

-- ── Who "this person" is ───────────────────────────────────────────────────
create or replace function amux.person_identities(p_user_id uuid)
returns setof uuid
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  with me as (
    select nullif(btrim(u.mobile), '') as mobile
      from public.users u
     where u.id = p_user_id
  ), my_emails as (
    select l.email from public.email_users_links l where l.user_id = p_user_id
    union
    select lower(btrim(au.email)) from auth.users au
     where au.id = p_user_id and coalesce(btrim(au.email), '') <> ''
  )
  select p_user_id where p_user_id is not null
  union
  select u.id
    from public.users u
    join me on me.mobile is not null and u.mobile = me.mobile
   where u.deleted_at is null
  union
  select l.user_id
    from public.email_users_links l
    join my_emails e on e.email = l.email;
$function$;

comment on function amux.person_identities(uuid) is
  'Every identity of the person behind p_user_id: itself, every live row sharing its mobile, and every row linked through public.email_users_links to one of its emails. Not filtered by admin_type — callers apply amux.is_teamclu_identity() when staff-only.';

revoke all on function amux.person_identities(uuid) from public;
grant execute on function amux.person_identities(uuid) to authenticated, service_role;

-- ── Team switch ────────────────────────────────────────────────────────────
create or replace function amux.switch_active_team(p_team_id uuid)
returns table(actor_id uuid, team_id uuid, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_caller_id uuid := auth.uid();
  v_staff_only boolean := amux.staff_only();
  v_actor uuid;
  v_member_user_id uuid;
  v_rt text;
begin
  if v_caller_id is null then
    raise exception 'switch requires authentication' using errcode = '42501';
  end if;

  select a.id, a.user_id into v_actor, v_member_user_id
    from amux.actors a
   where a.team_id = p_team_id
     and a.user_id in (select p.id from amux.person_identities(v_caller_id) as p(id))
     -- Staff-only: never mint a session for a membership card, the caller's
     -- own included.
     and (not v_staff_only or amux.is_teamclu_identity(a.user_id))
   order by case when a.user_id = v_caller_id then 0 else 1 end, a.created_at asc
   limit 1;
  if v_actor is null then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users where id = v_member_user_id) then
    raise exception 'linked team identity not found' using errcode = '42501';
  end if;

  v_rt := auth._mint_session(v_member_user_id);
  update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;
  return query select v_actor, p_team_id, v_rt;
end;
$function$;


-- ── Team picker ────────────────────────────────────────────────────────────
-- Body carried forward from 20260909010000_shared_org_not_self_joinable.sql;
-- related_users now comes from amux.person_identities().

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
  with related_users as (
    -- WHO AM I: every identity of this person (same phone, or linked through
    -- public.email_users_links), the caller included. Under staff-only only
    -- the ones TeamClu may act as.
    select p.id
      from amux.person_identities(auth.uid()) as p(id)
     where not amux.staff_only() or amux.is_teamclu_identity(p.id)
  ), employee_orgs as (
    -- WHOSE TENANT AM I IN: the orgs I hold an employee record in, plus my own
    -- org — unless my own org is the shared tenant, which every phone sign-up
    -- is stamped with and which therefore says nothing about belonging. Being
    -- an employee of the shared tenant still counts: that arrives through
    -- caller_employee_orgs() above.
    select eo.org_id from amux.caller_employee_orgs() as eo(org_id)
    union
    select u.org_id
      from public.users u
     where u.id = auth.uid()
       and u.org_id is not null
       and (p_default_org_id is null or u.org_id is distinct from p_default_org_id)
       and (not amux.staff_only() or amux.is_teamclu_identity(u.id))
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
  'Cross-org team picker source: teams any identity of the caller (amux.person_identities: same phone or linked email) holds an actor in, plus public teams they could join in the orgs they belong to. Under amux.staff_only() only identities amux.is_teamclu_identity() accepts count, the caller''s own included. The ORG set is caller_employee_orgs() plus the caller''s own org; the own-org arm drops out when that org is p_default_org_id. Also returns created_at / member_count / owner_name so the client can disambiguate teams that share a name.';

