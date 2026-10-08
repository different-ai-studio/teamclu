-- TeamClu admits staff only, at team switch as well as at sign-in.
--
-- Where `public.users` is the partner's membership register (belayo), an
-- admin_type 1 row in a tenant org is a gym card, not a TeamClu account. Phone
-- login stopped offering those under PHONE_LOGIN_STAFF_ONLY, but sign-in was
-- only half of it: switch_active_team resolves ANY same-phone actor and mints a
-- session for the identity that holds it, and list_teams_for_picker lists every
-- same-phone identity's teams. Signing in as your staff record and then picking
-- a team that a card of yours once joined handed the card's session straight
-- back. On the live box 16 people hold an actor on a card row.
--
-- Both functions take `p_staff_only` (FC passes it from PHONE_LOGIN_STAFF_ONLY)
-- and then accept an identity only when amux.is_teamclu_identity() says so —
-- the same rule phone login applies (services/fc/src/lib/supabase-repo/
-- phone-auth.ts, isTeamCluIdentity). The caller's own identity is not exempt:
-- a card session from before the switch loses its teams too, and has to sign in
-- again as staff.
--
-- Off by default, and must stay off on self-host: there claim_team_invite moves
-- a phone sign-up into the team's org at admin_type 1, so the rule would read
-- every invited user as a card.
--
-- Adding a parameter changes the signature, so both functions are dropped and
-- recreated (CREATE OR REPLACE cannot), and their grants are restated. Callers
-- passing named arguments without `p_staff_only` keep resolving to the new
-- function through the default. Bodies are otherwise carried forward verbatim
-- from 20260802120000_switch_active_team_no_org_id_update.sql and
-- 20260909010000_shared_org_not_self_joinable.sql.

create or replace function amux.is_teamclu_identity(p_user_id uuid, p_default_org_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  -- A live employee record (admin_type >= 2, the partner's own test), or the
  -- phone's platform identity, which phone sign-up writes into the shared
  -- tenant (DEFAULT_ORG) at admin_type 1. An auth account with no
  -- public.users row at all is not a card, so it passes.
  select coalesce(
    (select u.deleted_at is null
            and (u.admin_type >= 2 or u.org_id = p_default_org_id)
       from public.users u
      where u.id = p_user_id),
    true
  );
$function$;

comment on function amux.is_teamclu_identity(uuid, uuid) is
  'Staff-only rule (PHONE_LOGIN_STAFF_ONLY): may TeamClu act as this identity? True for a live employee record (admin_type >= 2), for a row in p_default_org_id (a phone sign-up''s platform identity), and for an account with no public.users row; false for a partner membership card. Keep in step with isTeamCluIdentity in services/fc/src/lib/supabase-repo/phone-auth.ts.';

grant execute on function amux.is_teamclu_identity(uuid, uuid) to authenticated, service_role;

drop function if exists amux.switch_active_team(uuid);

create function amux.switch_active_team(
  p_team_id uuid,
  p_default_org_id uuid default null,
  p_staff_only boolean default false
)
returns table(actor_id uuid, team_id uuid, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_caller_id uuid := auth.uid();
  v_mobile text;
  v_actor uuid;
  v_member_user_id uuid;
  v_rt text;
begin
  if v_caller_id is null then
    raise exception 'switch requires authentication' using errcode = '42501';
  end if;

  select nullif(btrim(u.mobile), '') into v_mobile
    from public.users u
   where u.id = v_caller_id
   limit 1;

  select a.id, a.user_id into v_actor, v_member_user_id
    from amux.actors a
   where a.team_id = p_team_id
     and (
       a.user_id = v_caller_id
       or (
         v_mobile is not null
         and exists (
           select 1
             from public.users u
            where u.id = a.user_id
              and u.mobile = v_mobile
         )
       )
     )
     -- Staff-only: never mint a session for a membership card, the caller's
     -- own included.
     and (not p_staff_only or amux.is_teamclu_identity(a.user_id, p_default_org_id))
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

grant execute on function amux.switch_active_team(uuid, uuid, boolean) to authenticated, service_role;

drop function if exists amux.list_teams_for_picker(uuid, boolean);

create function amux.list_teams_for_picker(
  p_default_org_id uuid default null,
  p_include_empty_orgs boolean default false,
  p_staff_only boolean default false
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
    -- a phone sign-up's own record is customer-grade, and the teams it created
    -- hang off exactly that record. Retain the caller even with no phone.
    select r.id from (
      select auth.uid() as id
       where auth.uid() is not null
      union
      select u.id
        from public.users u
        join current_identity c on c.mobile is not null and u.mobile = c.mobile
    ) r
    -- Staff-only: a membership card is not one of the identities I sign in as.
    where not p_staff_only or amux.is_teamclu_identity(r.id, p_default_org_id)
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
       and (not p_staff_only or amux.is_teamclu_identity(u.id, p_default_org_id))
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

comment on function amux.list_teams_for_picker(uuid, boolean, boolean) is
  'Cross-org team picker source: teams the caller holds an actor in, plus public teams they could join in the orgs they belong to. Membership is resolved phone-wide (any same-phone identity''s actor counts, as in switch_active_team) — except under p_staff_only, where only identities amux.is_teamclu_identity() accepts count, the caller''s own included; the ORG set is caller_employee_orgs() plus the caller''s own org, and the own-org arm drops out when that org is p_default_org_id, the shared tenant every phone sign-up is stamped with. Also returns created_at / member_count / owner_name so the client can disambiguate teams that share a name.';

grant execute on function amux.list_teams_for_picker(uuid, boolean, boolean) to authenticated, service_role;
