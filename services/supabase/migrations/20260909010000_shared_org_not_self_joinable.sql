-- The shared tenant is an account namespace, not an org you belong to.
--
-- Phone sign-up stamps every account it mints with DEFAULT_ORG_ID: the login
-- lookup itself is `(org_id = DEFAULT_ORG_ID, mobile = phone)`, so a teamclu
-- phone account IS a `public.users` row in that one org. On belayo that org is
-- also a real tenant with a real team, and the two roles collide — every person
-- who has ever signed up reads as "in this company's org", which is how a random
-- sign-up (user_ra3n_0232, 2026-09-01) ended up sitting in the company's own
-- team alongside its staff.
--
-- The database already knows this org is special. bootstrap_login_team takes
-- `p_shared_org` and routes it down a separate branch — a private team of your
-- own instead of the org's default team — precisely so phone users are not all
-- funnelled into one team. The picker and join_public_team simply never learned
-- the same thing, so what bootstrap refuses to do automatically, the picker
-- offered as a button.
--
-- Teach them, with one exception that has to survive: an EMPLOYEE of that org
-- still belongs to it. Under the shared-org branch bootstrap gives staff a
-- private team rather than joining them to the company team, so the picker's
-- public row is their only self-serve way in — it is how the org's own admin
-- joined on 2026-08-22. Blocking everyone would take that path with it.
--
-- Employee-ness is the same test both functions have to apply, and the failure
-- mode of them disagreeing is the dead-end row this whole area keeps producing:
-- the picker offers a team join_public_team then refuses. So it lives in one
-- place, amux.caller_employee_orgs(), and both read it.
--
-- `p_default_org_id` is revived rather than renamed to `p_shared_org` (which is
-- what bootstrap_login_team calls the same value). PostgREST binds RPC arguments
-- by NAME, so renaming would break every call from an FC container that has not
-- been redeployed yet, in both directions across the rollout window. The
-- parameter has carried this deployment's DEFAULT_ORG_ID all along; only the use
-- it is put to is new.

-- One definition of "employee of this org", read by both functions below.
-- SECURITY DEFINER because it reads public.users, and its callers are definers
-- themselves; it only ever discloses the caller's own tenancy.
create or replace function amux.caller_employee_orgs()
returns setof uuid
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  -- Same rule the partner SaaS applies in its own account picker
  -- (apps/api/src/routes/api/admin/auth/admin-accounts.ts): the caller's own
  -- record, plus every same-phone record, kept only where it is a live employee.
  select distinct u.org_id
    from public.users u
   where u.org_id is not null
     and u.admin_type >= 2
     and u.deleted_at is null
     and (
       u.id = auth.uid()
       or u.mobile = (select nullif(btrim(x.mobile), '') from public.users x where x.id = auth.uid() limit 1)
     );
$function$;

comment on function amux.caller_employee_orgs() is
  'The orgs the caller holds a live employee record in (own record or any record sharing their phone; admin_type >= 2, not soft-deleted). The single definition of employee-ness for list_teams_for_picker and join_public_team — they must not drift, or the picker offers teams the join refuses.';

grant execute on function amux.caller_employee_orgs() to authenticated, service_role;

-- Picker: the caller's own org no longer counts when it is the shared tenant.
-- Body otherwise verbatim from 20260909000000_picker_employee_identities_only.sql.
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
    -- a phone sign-up's own record is customer-grade, and the teams it created
    -- hang off exactly that record. Retain the caller even with no phone.
    select auth.uid() as id
     where auth.uid() is not null
    union
    select u.id
      from public.users u
      join current_identity c on c.mobile is not null and u.mobile = c.mobile
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
  'Cross-org team picker source: teams the caller holds an actor in, plus public teams they could join in the orgs they belong to. Membership is resolved phone-wide (any same-phone identity''s actor counts, as in switch_active_team); the ORG set is not — it is caller_employee_orgs() plus the caller''s own org, and the own-org arm drops out when that org is p_default_org_id, the shared tenant every phone sign-up is stamped with. Also returns created_at / member_count / owner_name so the client can disambiguate teams that share a name.';

-- Join: the interface-layer half of the same rule. The picker will no longer
-- offer these rows, but CS-4 established that the org check belongs here too —
-- a stale client still holds the team ids it was offered yesterday.
-- Body otherwise verbatim from 20260817040000_join_public_team_org_scope.sql.
create or replace function amux.join_public_team(
  p_team_id uuid,
  p_default_org_id uuid default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_team amux.teams%rowtype;
  v_member_id uuid;
  v_workspace_id uuid;
  v_workspace_name text;
  v_nickname text;
  v_display_name text;
  v_is_anonymous boolean;
  v_caller_org uuid;
begin
  if v_user_id is null then
    raise exception 'join_public_team requires an authenticated user' using errcode = '42501';
  end if;
  select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;
  if coalesce(v_is_anonymous, false) then
    raise exception 'anonymous users cannot join a team' using errcode = '42501';
  end if;
  select * into v_team from amux.teams where id = p_team_id;
  if not found then raise exception 'team not found' using errcode = 'P0002'; end if;
  if v_team.visibility is distinct from 'public' then
    raise exception 'team is not a joinable public team' using errcode = '42501';
  end if;

  -- 已经是成员就放行（幂等），否则必须同 org。
  select a.id into v_member_id from amux.actors a where a.user_id = v_user_id and a.team_id = p_team_id limit 1;
  if v_member_id is null then
    v_caller_org := amux.current_org_id();
    if v_team.oid is null or v_caller_org is null or v_team.oid is distinct from v_caller_org then
      raise exception 'team belongs to another organization' using errcode = '42501';
    end if;

    -- 共享租户：所有手机号注册的账号都落在这个 org，"同 org" 因此不构成归属。
    -- 只有它的员工才能自助入队；其他人走邀请。
    if p_default_org_id is not null
       and v_team.oid = p_default_org_id
       and not exists (select 1 from amux.caller_employee_orgs() as eo(org_id) where eo.org_id = v_team.oid)
    then
      raise exception 'the shared tenant''s teams are not self-joinable' using errcode = '42501';
    end if;

    select nickname into v_nickname from public.users where id = v_user_id limit 1;
    v_member_id := gen_random_uuid();
    v_display_name := coalesce(
      nullif(btrim(v_nickname), ''),
      amux.resolve_caller_display_name(v_member_id)
    );
    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
      values (v_member_id, p_team_id, 'member', v_user_id, v_display_name, now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (p_team_id, v_member_id, 'member');
  end if;

  select w.id, w.name into v_workspace_id, v_workspace_name from amux.workspaces w
    where w.team_id = p_team_id order by w.created_at asc, w.id asc limit 1;
  return query select v_team.id, v_team.name, v_team.slug, v_member_id,
    case when exists (select 1 from amux.team_members tm where tm.team_id = p_team_id and tm.member_id = v_member_id and tm.role = 'owner') then 'owner' else 'member' end,
    v_workspace_id, v_workspace_name;
end;
$function$;

comment on function amux.join_public_team(uuid, uuid) is
  'Self-service join of a PUBLIC team in the caller''s own org. p_default_org_id names the shared tenant (this deployment''s DEFAULT_ORG_ID): every phone sign-up is stamped with that org, so same-org is not belonging there — only an employee of it, per caller_employee_orgs(), may self-join its teams.';
